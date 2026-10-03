import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { SpaceFile } from "@worktable/types"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dispatchOperation } from "./mcp/dispatcher.ts"
import { createWorktableMcpServer } from "./mcp/server.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { readDoc, writeSpace } from "./store.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

const spaceId = "edits"
const DAY = 86_400_000
let root = ""
let client: Client | null = null

function space(): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: "Edits",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

type ToolResult = { ok: boolean; data: Record<string, any>; error: Record<string, any> }

async function tool(name: string, request: Record<string, unknown>): Promise<ToolResult> {
  const result = await client!.callTool({ name, arguments: { request } })
  const text = (result.content as Array<{ type: string; text?: string }>)
    .map((part) => part.text ?? "")
    .join("\n")
  let error: Record<string, any> = {}
  if (result.isError) {
    try {
      error = JSON.parse(text)
    } catch {
      error = { error: text }
    }
  }
  return {
    ok: result.isError !== true,
    data: (result.structuredContent ?? {}) as Record<string, any>,
    error,
  }
}

const read = (docPath: string, extra: Record<string, unknown> = {}) =>
  tool("worktable_docs_read", { action: "read", spaceId, docPath, ...extra })
const edit = (docPath: string, edits: unknown[], extra: Record<string, unknown> = {}) =>
  tool("worktable_docs_write", { action: "edit", spaceId, docPath, edits, ...extra })
const write = (docPath: string, content: unknown, extra: Record<string, unknown> = {}) =>
  tool("worktable_docs_write", { action: "write", spaceId, docPath, content, ...extra })

const text = (value: string, styles: Record<string, unknown> = {}) => ({ type: "text", text: value, styles })
const paragraph = (value: string, extra: Record<string, unknown> = {}) => ({
  type: "paragraph",
  content: [text(value)],
  ...extra,
})

async function storedBlocks(docPath: string): Promise<any[]> {
  return (await readDoc(spaceId, docPath)).data as any[]
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-mcp-doc-edit-"))
  setWorkspaceRootOverride(root)
  ensureWorkspaceManifest()
  invalidateSearchIndex()
  await writeSpace(space())
  const server = createWorktableMcpServer({ version: "test", scopes: ["*"] })
  client = new Client({ name: "doc-edit-test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

afterEach(async () => {
  await client?.close()
  client = null
  setWorkspaceRootOverride(null)
  invalidateSearchIndex()
  await rm(root, { recursive: true, force: true })
})

describe("worktable_docs_write action edit", () => {
  it("applies dependent edits in order and replaces every occurrence on request", async () => {
    await write(
      "plan",
      [paragraph("Alpha item one."), paragraph("Second item."), paragraph("Third item.", { props: { textColor: "red" } })],
      { lifetime: "durable" }
    )
    const ids = (await storedBlocks("plan")).map((block) => block.id)
    const before = await read("plan")
    expect(before.data.content).toBe("Alpha item one.\n\nSecond item.\n\nThird item.\n")
    expect(before.data.lossyFields).toEqual(["textColor"])

    const result = await edit(
      "plan",
      [
        { oldText: "Alpha", newText: "Beta" },
        { oldText: "Beta item one.", newText: "Beta item first." },
        { oldText: "item", newText: "entry", replaceAll: true },
      ],
      { expectedRevision: before.data.revision }
    )
    expect(result.ok).toBe(true)
    expect(result.data.snippet).toContain("1: Beta entry first.")
    expect(result.data.changed).toMatchObject({ kept: 0, inserted: 0, removed: 0 })
    expect(result.data.changed.modified).toHaveLength(3)
    expect(result.data.revision).not.toBe(before.data.revision)

    const after = await read("plan")
    expect(after.data.content).toBe("Beta entry first.\n\nSecond entry.\n\nThird entry.\n")
    expect(after.data.revision).toBe(result.data.revision)
    const blocks = await storedBlocks("plan")
    expect(blocks[2].props.textColor).toBe("red")
    expect(blocks.map((block) => block.id)).toEqual(ids)
  })

  it("refuses ambiguous, missing, and empty matches without writing anything", async () => {
    await write("notes", "# Notes\n\nShip the draft.\n\nReview the draft.\n", { lifetime: "durable" })
    const before = await read("notes")

    const ambiguous = await edit("notes", [{ oldText: "the draft", newText: "the plan" }])
    expect(ambiguous.ok).toBe(false)
    expect(ambiguous.error).toMatchObject({ code: "ambiguous", editIndex: 0, matchCount: 2, lines: [3, 5] })

    // Edit 1 is valid; edit 2 does not match. Nothing is applied.
    const missing = await edit("notes", [
      { oldText: "Ship the draft.", newText: "Ship the final draft." },
      { oldText: "Reveiw the draft", newText: "Approve the draft" },
    ])
    expect(missing.ok).toBe(false)
    expect(missing.error.code).toBe("no_match")
    expect(missing.error.editIndex).toBe(1)
    expect(missing.error.closest[0]).toEqual({ line: 5, text: "Review the draft." })

    const empty = await edit("notes", [{ oldText: "", newText: "x" }])
    expect(empty.error.code).toBe("empty_old_text")
    const unchanged = await edit("notes", [{ oldText: "Notes", newText: "Notes" }])
    expect(unchanged.error.code).toBe("no_change")

    const after = await read("notes")
    expect(after.data.revision).toBe(before.data.revision)
    expect(after.data.content).toBe(before.data.content)
  })

  it("refuses a stale revision and reports the current one", async () => {
    await write("status", "Status: green.\n", { lifetime: "durable" })
    const first = await read("status")
    const changed = await edit("status", [{ oldText: "green", newText: "amber" }], {
      expectedRevision: first.data.revision,
    })
    expect(changed.ok).toBe(true)

    const stale = await edit("status", [{ oldText: "amber", newText: "red" }], {
      expectedRevision: first.data.revision,
    })
    expect(stale.ok).toBe(false)
    expect(stale.error).toMatchObject({ code: "revision_conflict", currentRevision: changed.data.revision })
    expect((await readDoc(spaceId, "status")).data).toBe("Status: amber.\n")
  })

  it("changes only the edited bytes of a Markdown file", async () => {
    const source = [
      "Release notes",
      "=============",
      "",
      "Some __strong__ words and a hard  ",
      "break.",
      "",
      "<!-- reviewers: keep this comment -->",
      "",
      "1) First",
      "2) Second",
      "",
      "| Left | Center | Right |",
      "|:-----|:------:|------:|",
      "| a    |   b    |     c |",
      "",
      "Setext two",
      "----------",
      "",
    ].join("\n")
    await writeFile(join(root, "spaces", spaceId, "docs", "release.md"), source)

    const before = await read("release")
    expect(before.data.content).toBe(source)
    const result = await edit("release", [{ oldText: "2) Second", newText: "2) Second, revised" }], {
      expectedRevision: before.data.revision,
    })
    expect(result.ok).toBe(true)
    expect(result.data.storedAs).toBe("md")
    expect(result.data.snippet).toContain("10: 2) Second, revised")
    expect(await readFile(join(root, "spaces", spaceId, "docs", "release.md"), "utf8")).toBe(
      source.replace("2) Second", "2) Second, revised")
    )
  })

  it("reports annotations on edited text and keeps others exact", async () => {
    await write("review", [paragraph("Keep this sentence."), paragraph("Rewrite this claim.")], {
      lifetime: "durable",
    })
    const [kept, rewritten] = await storedBlocks("review")
    const annotate = async (blockId: string, quote: string) =>
      (
        (await dispatchOperation("annotations.create", {
          spaceId,
          target: { type: "text", docPath: "review", blockId, quote },
          category: "comment",
          body: `About ${quote}`,
        })) as { annotationId: string }
      ).annotationId
    const keptId = await annotate(kept.id, "this sentence")
    const rewrittenId = await annotate(rewritten.id, "this claim")

    const result = await edit("review", [{ oldText: "Rewrite this claim.", newText: "A revised statement." }])
    expect(result.data.annotationsAffected).toEqual([{ annotationId: rewrittenId, quoteStillPresent: false }])

    const context = (await dispatchOperation("annotations.context", {
      spaceId,
      annotationId: keptId,
    })) as { context: { selectorMatch: string } }
    expect(context.context.selectorMatch).toBe("exact")
    expect((await storedBlocks("review")).map((block) => block.id)).toEqual([kept.id, rewritten.id])
  })

  it("keeps a temporary Doc active after an edit", async () => {
    const soon = new Date(Date.now() + DAY).toISOString().slice(0, 10)
    const created = await write("handoff", "# Handoff\n\nNext steps.\n", { lifetime: "temporary", archiveOn: soon })
    expect(Date.parse(created.data.archiveOn)).toBeLessThan(Date.now() + 2 * DAY)

    expect((await edit("handoff", [{ oldText: "Next steps.", newText: "Next steps: review." }])).ok).toBe(true)
    const after = await read("handoff")
    expect(Date.parse(after.data.archiveOn)).toBeGreaterThan(Date.now() + 6 * DAY)
  })
})

describe("worktable_docs_write action write on an existing Doc", () => {
  it("requires the current revision and keeps ids and formatting of unchanged blocks", async () => {
    await write(
      "brief",
      [
        { type: "heading", props: { level: 1 }, content: [text("Brief")] },
        paragraph("Unchanged and centered.", { props: { textAlignment: "center" } }),
        paragraph("Old conclusion."),
      ],
      { lifetime: "durable" }
    )
    const before = await storedBlocks("brief")
    const unrevised = await write("brief", "# Brief\n\nReplaced.\n")
    expect(unrevised.error.code).toBe("revision_required")

    const current = await read("brief")
    expect(current.data.content).toBe("# Brief\n\nUnchanged and centered.\n\nOld conclusion.\n")
    const result = await write("brief", "# Brief\n\nUnchanged and centered.\n\nNew conclusion.\n\nAppendix.\n", {
      expectedRevision: current.data.revision,
    })
    expect(result.ok).toBe(true)
    const after = await storedBlocks("brief")
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2))
    expect(after[2]).toMatchObject({ id: before[2].id, content: [{ text: "New conclusion." }] })
    expect(after).toHaveLength(4)

    const blocknote = await read("brief", { format: "blocknote" })
    expect(blocknote.data.format).toBe("blocknote")
    expect(blocknote.data.content).toEqual(after)
  })

  it("refuses to drop formatting Markdown cannot show unless forced", async () => {
    await write("colors", [{ type: "paragraph", content: [text("Red", { textColor: "red" }), text(" note.")] }], {
      lifetime: "durable",
    })
    const current = await read("colors")
    const refused = await write("colors", "Plain note.\n", { expectedRevision: current.data.revision })
    expect(refused.error).toMatchObject({ code: "formatting_dropped" })
    expect(refused.error.formattingDropped[0].fields).toEqual(["style:textColor"])

    const forced = await write("colors", "Plain note.\n", { expectedRevision: current.data.revision, force: true })
    expect(forced.ok).toBe(true)
    expect(forced.data.formattingDropped).toHaveLength(1)
  })
})
