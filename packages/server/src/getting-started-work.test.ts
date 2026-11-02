import { afterEach, beforeEach, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { DEFAULT_AGENT_TOKEN_SCOPES } from "@worktable/types"
import { mkdirSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorktableMcpServer } from "./mcp/server.ts"
import { listRecentDocuments } from "./recent-documents.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { seedStarterWorkspace } from "./seed.ts"
import { listDocs } from "./store.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

// A new Worktable starts with Getting Started, which holds Worktable's
// guides. A person's own work belongs in a Space of its own, where the
// sidebar and Home show it apart from the guides.

let root = ""
let client: Client | null = null

async function tool(name: string, args: Record<string, unknown>) {
  const result = await client!.callTool({ name, arguments: args })
  const text = (result.content as Array<{ text?: string }>)
    .map((part) => part.text ?? "")
    .join("\n")
  return {
    ok: result.isError !== true,
    data: (result.structuredContent ?? {}) as Record<string, unknown>,
    text,
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-getting-started-work-"))
  setWorkspaceRootOverride(root)
  ensureWorkspaceManifest()
  mkdirSync(join(root, "spaces"), { recursive: true })
  invalidateSearchIndex()
  expect(await seedStarterWorkspace()).toBe(true)
  const server = createWorktableMcpServer({
    version: "test",
    scopes: [...DEFAULT_AGENT_TOKEN_SCOPES],
  })
  client = new Client({ name: "getting-started-test", version: "1" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
})

afterEach(async () => {
  await client?.close()
  client = null
  setWorkspaceRootOverride(null)
  await rm(root, { recursive: true, force: true })
})

it("sends an agent's first work to a Space of its own, never into Getting Started", async () => {
  // With only Getting Started, orienting tells the agent to make a Space.
  const first = await tool("worktable_state", {})
  expect(first.data["hint"]).toContain("worktable_spaces_write")

  // Nothing new can be added to Getting Started, and each refusal says what
  // to do instead.
  const attempts = [
    tool("worktable_docs_write", {
      spaceId: "welcome",
      docPath: "lisbon-trip",
      content: "# Lisbon Trip\n",
      lifetime: "durable",
    }),
    tool("worktable_html_write", {
      spaceId: "welcome",
      name: "Trip Budget",
      lifetime: "durable",
      html: "<!doctype html><title>Trip Budget</title><p>Budget</p>",
    }),
    tool("worktable_files_write", {
      spaceId: "welcome",
      path: "packing.csv",
      format: { id: "worktable.file", sourceVersion: 1 },
      lifetime: "durable",
      source: "item\nPassport\n",
    }),
    tool("worktable_records_upsert_collection", {
      spaceId: "welcome",
      collectionId: "trips",
      name: "Trips",
      fields: { title: { type: "string", name: "Trip" } },
    }),
  ]
  for (const refused of await Promise.all(attempts)) {
    expect(refused.ok).toBe(false)
    expect(refused.text).toContain("worktable_spaces_write")
  }
  expect(await listDocs("welcome")).not.toContain("lisbon-trip")

  // The guides themselves stay editable.
  const guide = await tool("worktable_docs_read", {
    spaceId: "welcome",
    docPath: "prompts-to-try",
  })
  const edited = await tool("worktable_docs_write", {
    spaceId: "welcome",
    docPath: "prompts-to-try",
    expectedRevision: guide.data["revision"],
    edits: [{ oldText: "# Prompts to Try", newText: "# My Prompts" }],
  })
  expect(edited.ok).toBe(true)

  // Following the advice works, and the hint goes back to orientation.
  const created = await tool("worktable_spaces_write", { name: "Lisbon Trip" })
  const spaceId = created.data["spaceId"] as string
  const saved = await tool("worktable_docs_write", {
    spaceId,
    docPath: "plan",
    content: "# Lisbon Trip Plan\n",
    lifetime: "durable",
  })
  expect(saved.ok).toBe(true)
  expect((await tool("worktable_state", {})).data["hint"]).not.toContain(
    "worktable_spaces_write"
  )

  // Home's Recent shows the person's work, not the guides, unless Getting
  // Started is asked for.
  const recent = await listRecentDocuments({})
  expect(recent.items.map((item) => item.spaceId)).toEqual([spaceId])
  const guides = await listRecentDocuments({ spaceId: "welcome" })
  expect(guides.items.map((item) => item.document.path)).toContain("prompts-to-try")
})
