import { writeManagedFixtureDoc as writeDoc } from "./fixtures/managed-content.ts"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SpaceFile } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import { renameDocAndSync } from "./doc-rename.ts"
import { invalidateLinkGraph } from "./link-graph.ts"
import {
  rewriteBlockLinks,
  rewriteMarkdownLinks,
  rewrittenTarget,
} from "./link-rewrite.ts"
import { readDoc, writeSpace } from "./store.ts"
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
  })

  it("rewrites Markdown links, images and media tags, never code", () => {
    const rewrite = (target: string) =>
      target === "old.png" ? "new.png" : null
    const markdown = [
      "![Shot](old.png) and [the file](old.png).",
      '<img alt="x" src="old.png">',
      "`![Shot](old.png)`",
      "```",
      "![Shot](old.png)",
      "```",
    ].join("\n")
    expect(rewriteMarkdownLinks(markdown, rewrite)).toBe(
      [
        "![Shot](new.png) and [the file](new.png).",
        '<img alt="x" src="new.png">',
        "`![Shot](old.png)`",
        "```",
        "![Shot](old.png)",
        "```",
      ].join("\n")
    )
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

    afterEach(() => {
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
      expect((await readDoc(SPACE, "flows/signup")).data).toBe(
        "# Spec\n\n![Error](signup/error.png)\n"
      )
      expect((await readDoc(SPACE, "research/bug")).data).toBe(
        "# Bug\n\nSee [the spec](../flows/signup) and ![it](/flows/signup/error.png).\n"
      )
    })

    it("leaves Docs' text alone with files off, as aliases keep links working", async () => {
      process.env["WORKTABLE_FILES_PREVIEW"] = "0"
      await seed()
      expect(
        (await renameDocAndSync(SPACE, "onboarding/spec", "flows/signup")).error
      ).toBeNull()
      expect((await readDoc(SPACE, "research/bug")).data).toBe(
        "# Bug\n\nSee [the spec](../onboarding/spec) and ![it](/onboarding/spec/error.png).\n"
      )
    })
  })
})
