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
import * as decoding from "lib0/decoding"
import * as encoding from "lib0/encoding"
import * as syncProtocol from "y-protocols/sync"
import * as Y from "yjs"
import { getServerEditor } from "./blocknote.ts"
import { readDoc, writeSpace } from "./store.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"
import { yjsManager } from "./yjs-manager.ts"

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
  }, 20_000)

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
  }, 20_000)

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
  }, 20_000)

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
  }, 20_000)

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
    // Anchored to a block that no longer exists: only its quote locates it.
    const quoteOnlyId = await annotate("block-removed-earlier", "Rewrite")

    const result = await edit("review", [{ oldText: "Rewrite this claim.", newText: "A revised statement." }])
    expect(result.data.annotationsAffected).toEqual(
      expect.arrayContaining([
        { annotationId: rewrittenId, quoteStillPresent: false },
        { annotationId: quoteOnlyId, quoteStillPresent: false },
      ])
    )
    expect(result.data.annotationsAffected).toHaveLength(2)

    const context = (await dispatchOperation("annotations.context", {
      spaceId,
      annotationId: keptId,
    })) as { context: { selectorMatch: string } }
    expect(context.context.selectorMatch).toBe("exact")
    expect((await storedBlocks("review")).map((block) => block.id)).toEqual([kept.id, rewritten.id])
  }, 20_000)

  it("numbers the snippet by the stored text, even when Worktable normalizes the edit", async () => {
    await write("list", [paragraph("Intro."), { type: "bulletListItem", content: [text("one")] }], {
      lifetime: "durable",
    })
    const result = await edit("list", [{ oldText: "* one", newText: "* one\n- two" }])
    expect(result.data.snippet).toBe("2: \n3: * one\n4: * two")
    expect(result.data.warnings.map((warning: { code: string }) => warning.code)).toContain("markdown_normalized")
    expect((await read("list")).data.content).toBe("Intro.\n\n* one\n* two\n")
  }, 20_000)

  it("keeps a temporary Doc active after an edit", async () => {
    const soon = new Date(Date.now() + DAY).toISOString().slice(0, 10)
    const created = await write("handoff", "# Handoff\n\nNext steps.\n", { lifetime: "temporary", archiveOn: soon })
    expect(Date.parse(created.data.archiveOn)).toBeLessThan(Date.now() + 2 * DAY)

    expect((await edit("handoff", [{ oldText: "Next steps.", newText: "Next steps: review." }])).ok).toBe(true)
    const after = await read("handoff")
    expect(Date.parse(after.data.archiveOn)).toBeGreaterThan(Date.now() + 6 * DAY)
  }, 20_000)
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
  }, 20_000)

  it("lets only one of two concurrent creates of the same path succeed", async () => {
    const [first, second] = await Promise.all([
      write("race", "# First\n", { lifetime: "durable" }),
      write("race", "# Second\n", { lifetime: "durable" }),
    ])
    expect([first.ok, second.ok].sort()).toEqual([false, true])
    const loser = first.ok ? second : first
    const winner = first.ok ? first : second
    expect(loser.error.code).toBe("revision_conflict")
    expect(loser.error.currentRevision).toBe(winner.data.revision)
    expect((await read("race")).data.revision).toBe(winner.data.revision)
  }, 20_000)

  it("refuses to drop formatting Markdown cannot show unless forced", async () => {
    await write("colors", [{ type: "paragraph", content: [text("Red", { textColor: "red" }), text(" note.")] }], {
      lifetime: "durable",
    })
    const current = await read("colors")
    const refused = await write("colors", "note.\n", { expectedRevision: current.data.revision })
    expect(refused.error).toMatchObject({ code: "formatting_dropped" })
    expect(refused.error.formattingDropped[0].fields).toEqual(["style:textColor"])

    const forced = await write("colors", "note.\n", { expectedRevision: current.data.revision, force: true })
    expect(forced.ok).toBe(true)
    expect(forced.data.formattingDropped).toHaveLength(1)
  }, 20_000)

  it("keeps properties Worktable does not recognize until their own block changes", async () => {
    await write(
      "foreign",
      [paragraph("Flagged by another tool.", { props: { reviewState: "flagged" } }), paragraph("Plain.")],
      { lifetime: "durable" }
    )
    expect((await storedBlocks("foreign"))[0].props.reviewState).toBe("flagged")

    expect((await edit("foreign", [{ oldText: "Plain.", newText: "Plain, edited." }])).ok).toBe(true)
    const current = await read("foreign")
    expect((await storedBlocks("foreign"))[0].props.reviewState).toBe("flagged")
    expect(
      (await write("foreign", "Flagged by another tool.\n\nRewritten.\n", { expectedRevision: current.data.revision })).ok
    ).toBe(true)
    expect((await storedBlocks("foreign"))[0].props.reviewState).toBe("flagged")

    const refused = await write("foreign", "Changed.\n\nRewritten.\n", {
      expectedRevision: (await read("foreign")).data.revision,
    })
    expect(refused.error.formattingDropped[0].fields).toEqual(["prop:reviewState"])
    const forced = await write("foreign", "Changed.\n\nRewritten.\n", {
      expectedRevision: (await read("foreign")).data.revision,
      force: true,
    })
    expect(forced.ok).toBe(true)
    expect((await storedBlocks("foreign"))[0].props).not.toHaveProperty("reviewState")
  }, 20_000)
})

// ── Docs open in Worktable ──────────────────────────────────

const MESSAGE_SYNC = 0
const MESSAGE_INTENT = 43

class FakeWs {
  sent: Uint8Array[] = []
  send(data: string | ArrayBuffer | Uint8Array) {
    if (data instanceof Uint8Array) this.sent.push(data)
  }
  close() {}
}

function syncFrame(write: (encoder: encoding.Encoder) => void): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  write(encoder)
  return encoding.toUint8Array(encoder)
}

/** A browser editor connected to the Doc, whose own typing is sent only on `send`. */
async function openInBrowser(docPath: string) {
  const ws = new FakeWs()
  const doc = new Y.Doc()
  const unsent: Uint8Array[] = []
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "person") unsent.push(update)
  })
  await yjsManager.handleConnection(ws, spaceId, docPath)
  yjsManager.handleMessage(ws, spaceId, docPath, syncFrame((encoder) => syncProtocol.writeSyncStep1(encoder, doc)))
  let received = 0
  const browser = {
    doc,
    /** Apply what the server sent since the last call; returns its size in bytes. */
    receive(): number {
      let bytes = 0
      for (const frame of ws.sent.slice(received)) {
        const decoder = decoding.createDecoder(frame)
        if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) continue
        bytes += frame.byteLength
        syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), doc, "server")
      }
      received = ws.sent.length
      return bytes
    },
    type(blockId: string, typed: string): void {
      const group = doc.getXmlFragment("document-store").get(0) as Y.XmlElement
      const container = group
        .toArray()
        .find((item) => item instanceof Y.XmlElement && item.getAttribute("id") === blockId) as Y.XmlElement
      const run = (container.get(0) as Y.XmlElement).get(0) as Y.XmlText
      doc.transact(() => run.insert(run.length, typed), "person")
    },
    /** Send the typing, and that a person typed it, as the editor does. */
    send(): void {
      for (const update of unsent.splice(0)) {
        yjsManager.handleMessage(ws, spaceId, docPath, syncFrame((encoder) => syncProtocol.writeUpdate(encoder, update)))
      }
      yjsManager.handleMessage(ws, spaceId, docPath, new Uint8Array([MESSAGE_INTENT]))
    },
    async blocks(): Promise<any[]> {
      return (await getServerEditor()).yDocToBlocks(doc, "document-store")
    },
  }
  browser.receive()
  return browser
}

const plainText = (blocks: any[]) => blocks.map((block) => block.content?.map((run: any) => run.text).join("") ?? "")

describe("edits to a Doc open in Worktable", () => {
  afterEach(async () => {
    await yjsManager.shutdown()
  })

  it("replaces only the edited block, so a person's unsent typing survives and both sides converge", async () => {
    const filler = Array.from({ length: 40 }, (_, index) =>
      paragraph(`Background paragraph ${index + 1} with enough words to give the document some weight.`)
    )
    await write("live", [paragraph("Alpha notes."), ...filler, paragraph("Beta notes.")], { lifetime: "durable" })
    const before = await storedBlocks("live")
    const browser = await openInBrowser("live")
    const wholeDocumentBytes = Y.encodeStateAsUpdate(browser.doc).byteLength

    browser.type(before[0].id, " Typed by a person.")
    const result = await edit("live", [{ oldText: "Beta notes.", newText: "Beta notes, revised by an agent." }], {
      expectedRevision: (await read("live")).data.revision,
    })
    expect(result.ok).toBe(true)
    expect(result.data.changed.modified).toEqual([before.at(-1).id])

    const agentBytes = browser.receive()
    expect(agentBytes).toBeGreaterThan(0)
    expect(agentBytes).toBeLessThan(wholeDocumentBytes / 10)
    browser.send()

    const live = (await yjsManager.liveBlocks(spaceId, "live")) as any[]
    expect(await browser.blocks()).toEqual(live)
    expect(live.map((block) => block.id)).toEqual(before.map((block) => block.id))
    expect(plainText(live)[0]).toBe("Alpha notes. Typed by a person.")
    expect(plainText(live).at(-1)).toBe("Beta notes, revised by an agent.")

    // Without a revision, an edit matches what people see now.
    const followUp = await edit("live", [{ oldText: "Typed by a person.", newText: "Typed, then tidied." }])
    expect(followUp.ok).toBe(true)
    browser.receive()
    expect(plainText(await browser.blocks())[0]).toBe("Alpha notes. Typed, then tidied.")
    await yjsManager.flushPersist(spaceId, "live")
    expect(plainText(await storedBlocks("live"))).toEqual(plainText(await browser.blocks()))
  }, 20_000)

  it("applies a stale revision only where the open Doc has not changed since", async () => {
    await write("shared", [paragraph("Alpha notes."), paragraph("Beta notes.")], { lifetime: "durable" })
    const [alpha, beta] = await storedBlocks("shared")
    const seen = await read("shared")
    const browser = await openInBrowser("shared")
    browser.type(alpha.id, " Typed by a person.")
    browser.send()

    const conflict = await edit("shared", [{ oldText: "Alpha notes.", newText: "Alpha, rewritten." }], {
      expectedRevision: seen.data.revision,
    })
    expect(conflict.ok).toBe(false)
    expect(conflict.error).toMatchObject({ code: "revision_conflict", blockId: alpha.id })
    expect(conflict.error.currentRevision).toBe((await read("shared")).data.revision)

    const elsewhere = await edit("shared", [{ oldText: "Beta notes.", newText: "Beta, revised." }], {
      expectedRevision: seen.data.revision,
    })
    expect(elsewhere.ok).toBe(true)
    browser.receive()
    expect(plainText(await browser.blocks())).toEqual(["Alpha notes. Typed by a person.", "Beta, revised."])
    expect(plainText(await storedBlocks("shared"))).toEqual(["Alpha notes. Typed by a person.", "Beta, revised."])
    expect((await storedBlocks("shared")).map((block) => block.id)).toEqual([alpha.id, beta.id])

    // A whole-Doc write from the old revision is held to the same rule.
    const overwrite = await write("shared", "Alpha, replaced.\n\nBeta notes.\n", { expectedRevision: seen.data.revision })
    expect(overwrite.error.code).toBe("revision_conflict")
  }, 20_000)

  it("keeps a change made on disk that the open Doc has not loaded yet", async () => {
    await write("synced", [paragraph("Alpha."), paragraph("Beta.")], { lifetime: "durable" })
    const browser = await openInBrowser("synced")
    // Another program edits the file; the change has not reached the room.
    const onDisk = await storedBlocks("synced")
    onDisk[0].content[0].text = "Alpha, changed on disk."
    await writeFile(join(root, "spaces", spaceId, "docs", "synced.json"), JSON.stringify(onDisk, null, 2))

    expect((await edit("synced", [{ oldText: "Beta.", newText: "Beta, by an agent." }])).ok).toBe(true)
    browser.receive()
    expect(plainText(await storedBlocks("synced"))).toEqual(["Alpha, changed on disk.", "Beta, by an agent."])
    expect(plainText(await browser.blocks())).toEqual(["Alpha, changed on disk.", "Beta, by an agent."])
  }, 20_000)

  it("replaces only the changed blocks when a write sends minimal blocks", async () => {
    await write("blocks", [paragraph("Alpha notes."), paragraph("Beta notes.")], { lifetime: "durable" })
    const [alpha] = await storedBlocks("blocks")
    const browser = await openInBrowser("blocks")
    browser.type(alpha.id, " Typed by a person.")

    const result = await write("blocks", [paragraph("Alpha notes."), paragraph("Beta notes, rewritten.")], {
      expectedRevision: (await read("blocks")).data.revision,
    })
    expect(result.ok).toBe(true)
    expect(browser.receive()).toBeLessThan(600)
    browser.send()
    expect(plainText(await browser.blocks())).toEqual(["Alpha notes. Typed by a person.", "Beta notes, rewritten."])
    expect((await browser.blocks())[0].id).toBe(alpha.id)
  }, 20_000)
})
