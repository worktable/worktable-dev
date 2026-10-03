import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { SpaceFile } from "@worktable/types"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setGrepTimeLimitForTests } from "./doc-markdown-projection.ts"
import { createWorktableMcpServer } from "./mcp/server.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { setDocArchived, writeSpace } from "./store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

const spaceId = "lines"
let root = ""
let client: Client | null = null

function space(): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: "Lines",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

async function connect(scopes: string[]): Promise<Client> {
  const server = createWorktableMcpServer({ version: "test", scopes })
  client = new Client({ name: "doc-lines-test", version: "1" })
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return client
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-mcp-doc-lines-"))
  setWorkspaceRootOverride(root)
  ensureWorkspaceManifest()
  invalidateSearchIndex()
  await writeSpace(space())
})

afterEach(async () => {
  await client?.close()
  client = null
  setWorkspaceRootOverride(null)
  invalidateSearchIndex()
  await rm(root, { recursive: true, force: true })
})

describe("line-addressed Doc reads", () => {
  type GrepMatch = {
    spaceId: string
    docPath: string
    revision: string
    line: number
    text: string
    before: string[]
    after: string[]
    lineTruncated?: true
  }
  const text = (value: string) => ({ type: "text", text: value, styles: {} })
  const richDoc = (closing: string) => [
    { type: "heading", props: { level: 1 }, content: [text("Launch brief")], children: [] },
    {
      type: "paragraph",
      content: [
        text("See "),
        { type: "link", href: "/plans/launch", content: [text("the plan")] },
        text(" for the beacon timeline."),
      ],
      children: [],
    },
    {
      type: "table",
      content: {
        type: "tableContent",
        rows: [
          { cells: [[text("Owner")], [text("Status")]] },
          { cells: [[text("beacon crew")], [text("Ready")]] },
        ],
      },
      children: [],
    },
    { type: "paragraph", content: [text(closing)], children: [] },
  ]

  async function call(
    connected: Client,
    name: string,
    request: Record<string, unknown>
  ) {
    const result = await connected.callTool({ name, arguments: { request } })
    const message = (result.content as Array<{ text?: string }>)
      .map((part) => part.text ?? "")
      .join("\n")
    return {
      isError: result.isError === true,
      message,
      data: (result.structuredContent ?? {}) as Record<string, unknown>,
    }
  }

  async function writeDocs() {
    const docs = join(root, "spaces", spaceId, "docs")
    await mkdir(join(docs, "plans"), { recursive: true })
    await mkdir(join(docs, "notes"), { recursive: true })
    await writeFile(
      join(docs, "plans", "launch.md"),
      "# Launch\n\nThe beacon ships Friday.\nOwners confirm the BEACON budget.\n\n## Risks\n\nNo beacon spares.\n"
    )
    await writeFile(
      join(docs, "plans", "brief.json"),
      JSON.stringify(richDoc("Closing note."))
    )
    await writeFile(join(docs, "plans", "broken.json"), "{")
    await writeFile(join(docs, "notes", "field.md"), "A beacon was sighted.")
    await writeFile(join(docs, "notes", "old.md"), "The old beacon log.")
    await setDocArchived(spaceId, "notes/old", true, "test")
  }

  it("greps Docs with the line numbers read returns", async () => {
    await writeDocs()
    const connected = await connect(["docs:read"])
    const grep = (request: Record<string, unknown>) =>
      call(connected, "worktable_docs_read", { action: "grep", ...request })
    const paths = (data: Record<string, unknown>) =>
      (data.matches as GrepMatch[]).map((match) => `${match.docPath}:${match.line}`)

    const scoped = await grep({ pattern: "beacon", spaceId, pathPrefix: "plans", context: 1 })
    expect(scoped.isError).toBe(false)
    expect(scoped.data).toMatchObject({
      total: 4,
      truncated: false,
      skipped: [{ spaceId, docPath: "plans/broken", reason: "unreadable" }],
      scope: { spaceId, pathPrefix: "plans", includeArchived: false },
    })
    const matches = scoped.data.matches as GrepMatch[]
    expect(new Set(matches.map((match) => match.docPath))).toEqual(
      new Set(["plans/brief", "plans/launch"])
    )
    for (const match of matches) {
      const read = await call(connected, "worktable_docs_read", {
        action: "read",
        spaceId,
        docPath: match.docPath,
      })
      expect(read.data.format).toBe("markdown")
      expect(read.data.revision).toBe(match.revision)
      const lines = (read.data.content as string).replace(/\n$/, "").split("\n")
      expect(read.data.totalLines).toBe(lines.length)
      expect(lines[match.line - 1]).toBe(match.text)
      expect(match.before).toEqual(lines.slice(Math.max(0, match.line - 2), match.line - 1))
      expect(match.after).toEqual(lines.slice(match.line, match.line + 1))
    }
    expect(matches.map((match) => match.text)).toContainEqual(
      expect.stringContaining("[the plan](/plans/launch)")
    )
    expect(matches.map((match) => match.text)).toContainEqual(
      expect.stringMatching(/^\|\s*beacon crew\s*\|\s*Ready\s*\|$/)
    )

    const everywhere = await grep({ pattern: "BEACON", caseSensitive: false })
    expect(paths(everywhere.data)).toEqual([
      "notes/field:1",
      "plans/brief:3",
      "plans/brief:8",
      "plans/launch:3",
      "plans/launch:4",
      "plans/launch:8",
    ])
    const archived = await grep({ pattern: "old beacon", includeArchived: true })
    expect(paths(archived.data)).toEqual(["notes/old:1"])

    const regex = await grep({ pattern: "^The beacon (ships|sails)", regex: true, spaceId })
    expect(paths(regex.data)).toEqual(["plans/launch:3"])
    const truncated = await grep({ pattern: "beacon", maxResults: 2 })
    expect(truncated.data).toMatchObject({ total: 5, truncated: true })
    expect(truncated.data.matches as GrepMatch[]).toHaveLength(2)

    const invalid = await grep({ pattern: "(beacon", regex: true })
    expect(invalid.isError).toBe(true)
    expect(invalid.message).toContain("Invalid regular expression")
  })

  it("bounds grep time and response size", async () => {
    const docs = join(root, "spaces", spaceId, "docs")
    await mkdir(docs, { recursive: true })
    await writeFile(join(docs, "runaway.md"), `${"a".repeat(10_000)}\n`)
    await writeFile(join(docs, "wide.md"), `needle ${"w".repeat(50_000)}\n`)
    await writeFile(
      join(docs, "many.md"),
      Array.from({ length: 200 }, () => `pin ${"p".repeat(1_500)}`).join("\n")
    )
    const connected = await connect(["docs:read"])
    const grep = (request: Record<string, unknown>) =>
      call(connected, "worktable_docs_read", { action: "grep", spaceId, ...request })

    // A backtracking regex is stopped at the limit while the server keeps running.
    setGrepTimeLimitForTests(500)
    try {
      let lastTick = performance.now()
      let longestPause = 0
      const ticker = setInterval(() => {
        const now = performance.now()
        longestPause = Math.max(longestPause, now - lastTick)
        lastTick = now
      }, 10)
      const started = performance.now()
      const runaway = await grep({ pattern: "^a*a*a*a*a*a*ab$", regex: true })
      const elapsed = performance.now() - started
      clearInterval(ticker)
      expect(runaway.isError).toBe(true)
      expect(runaway.message).toContain("grep stopped after 0.5 seconds")
      expect(elapsed).toBeLessThan(3_000)
      expect(longestPause).toBeLessThan(250)
    } finally {
      setGrepTimeLimitForTests(null)
    }
    const recovered = await grep({ pattern: "^needle", regex: true })
    expect(recovered.data).toMatchObject({ total: 1 })

    const wide = (recovered.data.matches as GrepMatch[])[0]
    expect(wide.lineTruncated).toBe(true)
    expect(wide.text.length).toBeLessThan(2_100)
    expect(wide.text.startsWith("needle www")).toBe(true)

    const many = await grep({ pattern: "pin", maxResults: 500 })
    const returned = many.data.matches as GrepMatch[]
    expect(many.data).toMatchObject({ total: 200, truncated: true })
    expect(returned.length).toBeGreaterThan(0)
    expect(returned.length).toBeLessThan(200)
    expect(JSON.stringify(returned).length).toBeLessThan(150_000)
  })

  it("reads long Docs in line ranges and greps the latest revision", async () => {
    await writeDocs()
    const connected = await connect(["docs:read", "docs:write"])
    const read = (docPath: string, range: Record<string, unknown> = {}) =>
      call(connected, "worktable_docs_read", { action: "read", spaceId, docPath, ...range })

    const full = await read("plans/launch")
    expect(full.data).toMatchObject({ totalLines: 8 })
    expect(full.data.startLine).toBeUndefined()
    const first = await read("plans/launch", { offset: 1, limit: 3 })
    const rest = await read("plans/launch", { offset: 4 })
    expect(first.data).toMatchObject({
      content: "# Launch\n\nThe beacon ships Friday.\n",
      totalLines: 8,
      startLine: 1,
      endLine: 3,
    })
    expect(rest.data).toMatchObject({ totalLines: 8, startLine: 4, endLine: 8 })
    expect(`${first.data.content}${rest.data.content}`).toBe(full.data.content as string)
    const past = await read("plans/launch", { offset: 9 })
    expect(past.isError).toBe(true)
    expect(past.message).toContain("past the end")

    const before = await read("plans/brief")
    const written = await call(connected, "worktable_docs_write", {
      action: "write",
      spaceId,
      docPath: "plans/brief",
      content: richDoc("The lighthouse replaces the old signal."),
      expectedRevision: before.data.revision,
    })
    expect(written.isError).toBe(false)
    const grep = await call(connected, "worktable_docs_read", {
      action: "grep",
      pattern: "lighthouse",
      spaceId,
    })
    const [match] = grep.data.matches as GrepMatch[]
    expect(grep.data.total).toBe(1)
    const after = await read("plans/brief", { offset: match.line, limit: 1 })
    expect(before.data.revision).not.toBe(match.revision)
    expect(after.data.revision).toBe(match.revision)
    expect(after.data.content).toBe(`${match.text}\n`)

    // Identical bytes stored as Markdown and as BlockNote are different revisions.
    const docs = join(root, "spaces", spaceId, "docs")
    await writeFile(join(docs, "same-markdown.md"), "[]")
    await writeFile(join(docs, "same-blocks.json"), "[]")
    const markdown = await read("same-markdown")
    const blocks = await read("same-blocks")
    expect(markdown.data.content).toBe("[]")
    expect(blocks.data.storedAs).toBe("json")
    expect(markdown.data.revision).not.toBe(blocks.data.revision)
  })
})
