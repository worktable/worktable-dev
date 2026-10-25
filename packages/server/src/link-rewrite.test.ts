import { writeManagedFixtureDoc as writeDoc } from "./fixtures/managed-content.ts"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SpaceFile } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import { renameDocAndSync, renameDocsByPrefixAndSync } from "./doc-rename.ts"
import { invalidateLinkGraph } from "./link-graph.ts"
import {
  settleLinkRewrites,
  rewriteBlockLinks,
  rewriteMarkdownLinks,
  rewrittenTarget,
} from "./link-rewrite.ts"
import { readDoc, writeSpace } from "./store.ts"
import {
  moveRegisteredDocument,
  readRegisteredDocumentSource,
} from "./document-write-service.ts"
import {
  buildRecordCollectionSchema,
  createRecord,
  readRecord,
  RECORD_CHANGED,
  updateRecord,
  writeRecordCollectionSchema,
} from "./record-store.ts"
import { peekDocReferrers, settleDocReferrers } from "./doc-referrers.ts"
import { noteSpaceChanged } from "./workspace-read-model.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

describe("rewriting links after a move", () => {
  it("rewrites only targets the move affected, in the style they were written", () => {
    const moved = new Map([
      ["onboarding/spec", "flows/signup"],
      ["onboarding/spec/error.png", "flows/signup/error.png"],
    ])
    // A Doc that didn't move, linking to what did.
    const from = (target: string) =>
      rewrittenTarget(target, "research/bug", "research/bug", moved)
    expect(from("../onboarding/spec")).toBe("../flows/signup")
    expect(from("../onboarding/spec.md#steps")).toBe("../flows/signup.md#steps")
    expect(from("/onboarding/spec/error.png?v=2")).toBe(
      "/flows/signup/error.png?v=2"
    )
    expect(from("../notes/other")).toBeNull()
    expect(from("https://example.com/onboarding/spec")).toBeNull()

    // The Doc that moved: relative targets follow it, rooted ones stay.
    const inMoved = (target: string) =>
      rewrittenTarget(target, "onboarding/spec", "flows/signup", moved)
    expect(inMoved("spec/error.png")).toBe("signup/error.png")
    expect(inMoved("./intro")).toBe("../onboarding/intro")
    expect(inMoved("/brand/logo.svg")).toBeNull()

    // A name holding "#" keeps it as part of the path.
    expect(
      rewrittenTarget("/old#intro", "notes/a", "notes/a", new Map([["old", "new#part"]]))
    ).toBe("/new%23part#intro")
    expect(
      rewrittenTarget("/old", "notes/a", "notes/a", new Map([["old", "new)"]]))
    ).toBe("/new%29")
    // A Doc moved into the folder of the Doc it links to still names it.
    expect(rewrittenTarget("b#section", "a", "b/a", new Map([["a", "b/a"]]))).toBe(
      "../b#section"
    )
  })

  it("rewrites Markdown links, images and media tags, never code", () => {
    const rewrite = (target: string) =>
      target === "old.png"
        ? "new.png"
        : target === "a&b.png"
          ? "c&d.png"
          : target === "shot(1).png"
            ? "shots/shot(1).png"
            : null
    const markdown = [
      "![Shot](old.png) and [the file](old.png).",
      '[Shot](shot(1).png "Title") and ![x](<old.png>)',
      '<img data-src="old.png" title=\'src="old.png"\' alt="x" src="old.png">',
      "<video src=old.png></video> <img src='a&amp;b.png'>",
      "`![Shot](old.png)`",
      "```",
      "![Shot](old.png)",
      "```",
      "~~~html",
      '<img src="old.png">',
      "~~~",
      "",
      "    ![Shot](old.png)",
      "",
      "\\[not a link](old.png) and ```npm install``` then [a link](old.png)",
      "```",
      "~~~",
      "[in code](old.png)",
      "```",
    ].join("\n")
    expect(rewriteMarkdownLinks(markdown, rewrite)).toBe(
      [
        "![Shot](new.png) and [the file](new.png).",
        '[Shot](shots/shot(1).png "Title") and ![x](<new.png>)',
        '<img data-src="old.png" title=\'src="old.png"\' alt="x" src="new.png">',
        "<video src=new.png></video> <img src='c&amp;d.png'>",
        "`![Shot](old.png)`",
        "```",
        "![Shot](old.png)",
        "```",
        "~~~html",
        '<img src="old.png">',
        "~~~",
        "",
        "    ![Shot](old.png)",
        "",
        "\\[not a link](old.png) and ```npm install``` then [a link](new.png)",
        "```",
        "~~~",
        "[in code](old.png)",
        "```",
      ].join("\n")
    )
  })

  it("rewrites reference-style links and images where they are defined", () => {
    const rewrite = (target: string) => (target === "old.png" ? "new.png" : null)
    const markdown = [
      "![Shot][shot] and [the file][file], and a footnote[^1].",
      "",
      '[shot]: old.png "The screen"',
      "[File]: <old.png>",
      "[^1]: old.png",
      "",
      "```",
      "[code]: old.png",
      "```",
    ].join("\n")
    expect(rewriteMarkdownLinks(markdown, rewrite)).toBe(
      [
        "![Shot][shot] and [the file][file], and a footnote[^1].",
        "",
        '[shot]: new.png "The screen"',
        "[File]: <new.png>",
        "[^1]: old.png",
        "",
        "```",
        "[code]: old.png",
        "```",
      ].join("\n")
    )
    // Only the definition an image uses counts as an image's.
    const seen: string[] = []
    rewriteMarkdownLinks(
      "![Shot][shot] [doc][spec]\n\n[shot]: a.png\n[spec]: b.md\n",
      (target) => {
        seen.push(target)
        return null
      },
      { imagesOnly: true }
    )
    expect(seen).toEqual(["a.png"])
  })

  it("skips fenced code in a very large Doc", () => {
    const filler = "Words.\n\n".repeat(40_000)
    const markdown = `${filler}~~~\n[a](old.png)\n~~~\n[b](old.png)\n`
    expect(
      rewriteMarkdownLinks(markdown, (target) => (target === "old.png" ? "new.png" : null))
    ).toBe(`${filler}~~~\n[a](old.png)\n~~~\n[b](new.png)\n`)
  })

  it("rewrites rich-text links, media blocks and table links, and names the blocks it changed", () => {
    const rewrite = (target: string) => (target === "old" ? "new" : null)
    const blocks = [
      { id: "a", type: "paragraph", content: [{ type: "text", text: "plain" }] },
      { id: "b", type: "image", props: { url: "old", caption: "" }, children: [] },
      {
        id: "c",
        type: "table",
        content: {
          type: "tableContent",
          rows: [{ cells: [{ type: "tableCell", content: [{ type: "link", href: "old", content: [] }] }] }],
        },
        children: [],
      },
    ]
    const { changed } = rewriteBlockLinks(blocks, rewrite)
    expect(changed.map((block) => block.id)).toEqual(["b", "c"])
    expect(JSON.stringify(changed)).not.toContain('"old"')
  })

  describe("in a Space", () => {
    let root = ""
    const SPACE = "space"
    const space = (): SpaceFile => {
      const now = new Date().toISOString()
      return {
        type: "worktable.space",
        version: 1,
        id: SPACE,
        name: SPACE,
        createdAt: now,
        updatedAt: now,
        createdBy: "test",
        settings: {},
      }
    }
    const previous = process.env["WORKTABLE_FILES_PREVIEW"]

    beforeEach(async () => {
      root = mkdtempSync(join(tmpdir(), "worktable-link-rewrite-"))
      setWorkspaceRootOverride(join(root, "workspace"))
      setAppDirOverride(join(root, "app"))
      mkdirSync(join(root, "workspace"), { recursive: true })
      ensureWorkspaceManifest()
      await writeSpace(space())
      invalidateLinkGraph()
    })

    afterEach(async () => {
      await settleLinkRewrites()
      if (previous === undefined) delete process.env["WORKTABLE_FILES_PREVIEW"]
      else process.env["WORKTABLE_FILES_PREVIEW"] = previous
      setWorkspaceRootOverride(null)
      setAppDirOverride(null)
      rmSync(root, { recursive: true, force: true })
    })

    const seed = async () => {
      const docs = join(root, "workspace", "spaces", SPACE, "docs")
      mkdirSync(join(docs, "onboarding", "spec"), { recursive: true })
      writeFileSync(join(docs, "onboarding", "spec", "error.png"), "png")
      const options = { updatedBy: "test", source: "rest-api" as const }
      await writeDoc(SPACE, "onboarding/spec", "# Spec\n\n![Error](spec/error.png)\n", options)
      await writeDoc(
        SPACE,
        "research/bug",
        "# Bug\n\nSee [the spec](../onboarding/spec) and ![it](/onboarding/spec/error.png).\n",
        options
      )
      noteSpaceChanged(SPACE)
    }

    it("keeps the links in every affected Doc true on disk, once files are on", async () => {
      process.env["WORKTABLE_FILES_PREVIEW"] = "1"
      await seed()
      expect(
        (await renameDocAndSync(SPACE, "onboarding/spec", "flows/signup")).error
      ).toBeNull()
      // Docs elsewhere are rewritten after the move returns.
      await settleLinkRewrites()
      expect((await readDoc(SPACE, "flows/signup")).data).toBe(
        "# Spec\n\n![Error](signup/error.png)\n"
      )
      expect((await readDoc(SPACE, "research/bug")).data).toBe(
        "# Bug\n\nSee [the spec](../flows/signup) and ![it](/flows/signup/error.png).\n"
      )
    })

    it("rewrites links when a folder is renamed as a folder", async () => {
      process.env["WORKTABLE_FILES_PREVIEW"] = "1"
      await seed()
      expect(
        (await renameDocsByPrefixAndSync(SPACE, "research", "archive/research")).error
      ).toBeNull()
      await settleLinkRewrites()
      expect((await readDoc(SPACE, "archive/research/bug")).data).toBe(
        "# Bug\n\nSee [the spec](../../onboarding/spec) and ![it](/onboarding/spec/error.png).\n"
      )
    })

    it("answers a move with the revision the moved Doc has once its links are rewritten", async () => {
      process.env["WORKTABLE_FILES_PREVIEW"] = "1"
      await seed()
      const moved = await moveRegisteredDocument({
        spaceId: SPACE,
        path: "research/bug",
        to: "research/deep/bug",
      })
      const current = await readRegisteredDocumentSource({
        spaceId: SPACE,
        path: "research/deep/bug",
      })
      expect(new TextDecoder().decode(current.bytes)).toContain("../../onboarding/spec")
      expect(moved.sourceRevision).toBe(current.sourceRevision)
    })

    it("keeps records' file fields pointing at a file that moved, and lists them as its uses", async () => {
      process.env["WORKTABLE_FILES_PREVIEW"] = "1"
      await seed()
      await writeRecordCollectionSchema(
        SPACE,
        buildRecordCollectionSchema({
          id: "shots",
          fields: { shot: { type: "file" } },
          createdBy: "test",
        })
      )
      expect(
        (await createRecord(SPACE, "shots", { id: "bad", data: { shot: "../x.png" } })).error
      ).toContain("must be a file path")
      expect(
        (await createRecord(SPACE, "shots", { id: "error", data: { shot: "onboarding/spec/error.png" } }))
          .error
      ).toBeNull()

      // The first look starts reading the Space's records.
      peekDocReferrers(SPACE, "onboarding/spec/error.png")
      await settleDocReferrers(SPACE)
      expect(
        peekDocReferrers(SPACE, "onboarding/spec/error.png")?.map((referrer) =>
          referrer.kind === "record" ? referrer.recordId : referrer.kind
        )
      ).toEqual(["error"])

      expect(
        (await renameDocAndSync(SPACE, "onboarding/spec", "flows/signup")).error
      ).toBeNull()
      await settleLinkRewrites()
      expect((await readRecord(SPACE, "shots", "error")).data?.data).toEqual({
        shot: "flows/signup/error.png",
      })
      // A rewrite applies only while the field still holds what it read, so
      // an edit made in between stands.
      expect(
        (
          await updateRecord(SPACE, "shots", "error", {
            data: { shot: "elsewhere/error.png" },
            ifData: { shot: "onboarding/spec/error.png" },
          })
        ).error
      ).toBe(RECORD_CHANGED)
      expect((await readRecord(SPACE, "shots", "error")).data?.data).toEqual({
        shot: "flows/signup/error.png",
      })
    })

    it("leaves Docs' text alone with files off, as aliases keep links working", async () => {
      process.env["WORKTABLE_FILES_PREVIEW"] = "0"
      await seed()
      expect(
        (await renameDocAndSync(SPACE, "onboarding/spec", "flows/signup")).error
      ).toBeNull()
      // Docs elsewhere are rewritten after the move returns.
      await settleLinkRewrites()
      expect((await readDoc(SPACE, "research/bug")).data).toBe(
        "# Bug\n\nSee [the spec](../onboarding/spec) and ![it](/onboarding/spec/error.png).\n"
      )
    })
  })
})
