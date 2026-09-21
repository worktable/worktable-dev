import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  decodeCompanyKnowledgeId,
  encodeCompanyKnowledgeId,
} from "./mcp/company-knowledge.ts"
import { dispatchOperation } from "./mcp/dispatcher.ts"
import { createWorktableMcpServer } from "./mcp/server.ts"
import { buildRecordFile, writeRecord } from "./record-store.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import { writeDoc } from "./store.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"

let workspaceDir: string
const openClients: Client[] = []

beforeEach(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), "worktable-company-knowledge-"))
  mkdirSync(join(workspaceDir, "spaces"), { recursive: true })
  setWorkspaceRootOverride(workspaceDir)
  invalidateSearchIndex()
  await dispatchOperation("spaces.create", { name: "Product" })
  await writeDoc(
    "product",
    "research/überblick",
    "# Launch Research\n\nThe cobalt launch depends on the Atlas partner."
  )
  // Invalid legacy claims remain visible to generic discovery, but Company
  // Knowledge can return only entries with safe, fetchable opaque IDs.
  writeFileSync(
    join(workspaceDir, "spaces", "product", "docs", "heliograph\\bad.md"),
    "# Retained invalid claim\n\nAtlas heliograph"
  )
  await dispatchOperation("html.create", {
    spaceId: "product",
    id: "dashboards/launch",
    name: "Launch dashboard",
    html: "<main><h1>Launch status</h1><p>The heliograph signal is ready.</p><script>runtimephantom</script></main>",
  })
  await dispatchOperation("records.upsert_collection", {
    spaceId: "product",
    collectionId: "companies",
    name: "Companies",
    fields: { name: { type: "string", required: true } },
  })
  await writeRecord(
    "product",
    buildRecordFile({
      id: "atlas",
      collectionId: "companies",
      data: { name: "Atlas", status: "partner" },
      metadata: { privateIndexNote: "must-not-leak" },
    })
  )
})

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()))
  setWorkspaceRootOverride(null)
  invalidateSearchIndex()
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true })
  }
})

async function connectedClient(scopes: string[]): Promise<Client> {
  const server = createWorktableMcpServer({
    version: "test",
    scopes,
    urlOrigin: "https://app.worktable.cloud",
  })
  const client = new Client({ name: "company-knowledge-test", version: "1" })
  openClients.push(client)
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return client
}

function textResult(result: unknown): unknown {
  const content = (result as { content: unknown }).content as Array<{
    type: string
    text: string
  }>
  return JSON.parse(content[0]!.text)
}

describe("ChatGPT Company Knowledge tools", () => {
  it("searches Docs and Records with opaque ids and absolute URLs", async () => {
    const client = await connectedClient(["search:read"])
    const result = await client.callTool({
      name: "search",
      arguments: { query: "Atlas" },
    })

    expect(result.isError).not.toBe(true)
    expect(textResult(result)).toEqual(result.structuredContent)
    const output = result.structuredContent as {
      results: Array<{ id: string; title: string; url: string }>
    }
    expect(output.results.map((entry) => entry.title).sort()).toEqual([
      "Atlas",
      "Launch Research",
    ])
    expect(output.results.every((entry) => entry.id.startsWith("wt1."))).toBe(
      true
    )
    expect(
      output.results.every((entry) => entry.url.startsWith("https://"))
    ).toBe(true)

    const html = await client.callTool({
      name: "search",
      arguments: { query: "heliograph" },
    })
    expect(html.structuredContent).toEqual({ results: [] })
  })

  it("fetches full Doc and Record text without internal file metadata", async () => {
    const client = await connectedClient([
      "search:read",
      "docs:read",
      "records:read",
    ])
    const searched = await client.callTool({
      name: "search",
      arguments: { query: "Atlas" },
    })
    const results = (
      searched.structuredContent as {
        results: Array<{ id: string; title: string }>
      }
    ).results

    for (const searchResult of results) {
      const fetched = await client.callTool({
        name: "fetch",
        arguments: { id: searchResult.id },
      })
      expect(fetched.isError).not.toBe(true)
      expect(textResult(fetched)).toEqual(fetched.structuredContent)
      const output = fetched.structuredContent as Record<string, unknown>
      expect(output.title).toBe(searchResult.title)
      expect(output.url).toMatch(/^https:\/\/app\.worktable\.cloud\//)
      expect(output).not.toHaveProperty("metadata")
      expect(JSON.stringify(output)).not.toContain("must-not-leak")
      expect(JSON.stringify(output)).not.toContain("createdBy")
    }
  })

  it("searches and fetches common documents through the bounded projection", async () => {
    const client = await connectedClient(["search:read", "documents:read"])
    const searched = await client.callTool({
      name: "search",
      arguments: { query: "heliograph" },
    })
    expect(searched.isError).not.toBe(true)
    const results = (
      searched.structuredContent as {
        results: Array<{ id: string; title: string; url: string }>
      }
    ).results
    expect(results).toEqual([
      expect.objectContaining({
        title: "Launch dashboard",
        url: "https://app.worktable.cloud/spaces/product/documents/dashboards/launch",
      }),
    ])

    const fetched = await client.callTool({
      name: "fetch",
      arguments: { id: results[0]!.id },
    })
    expect(fetched.isError).not.toBe(true)
    expect(fetched.structuredContent).toMatchObject({
      title: "Launch dashboard",
      text: expect.stringContaining("heliograph signal"),
      metadata: {
        documentKind: "document",
        format: { id: "worktable.html", sourceVersion: 1 },
        health: "supported",
      },
    })
    expect(JSON.stringify(fetched.structuredContent)).not.toContain(
      "runtimephantom"
    )

    writeFileSync(
      join(
        workspaceDir,
        "spaces",
        "product",
        "docs",
        "research",
        "draft..v2.md"
      ),
      "# Draft V2\n\nThe amberglass review is complete."
    )
    invalidateSearchIndex()
    const dottedSearch = await client.callTool({
      name: "search",
      arguments: { query: "amberglass" },
    })
    expect(dottedSearch.isError).not.toBe(true)
    const dottedResult = (
      dottedSearch.structuredContent as {
        results: Array<{ id: string; title: string; url: string }>
      }
    ).results[0]!
    expect(dottedResult).toMatchObject({
      title: "Draft V2",
      url: "https://app.worktable.cloud/spaces/product/documents/research/draft..v2",
    })
    expect(decodeCompanyKnowledgeId(dottedResult.id)).toEqual({
      kind: "document",
      spaceId: "product",
      path: "research/draft..v2",
    })

    const dottedFetch = await client.callTool({
      name: "fetch",
      arguments: { id: dottedResult.id },
    })
    expect(dottedFetch.isError).not.toBe(true)
    expect(dottedFetch.structuredContent).toMatchObject({
      title: "Draft V2",
      text: expect.stringContaining("amberglass review"),
    })
  })

  it("enforces the fetched item's scope with an OAuth challenge", async () => {
    const client = await connectedClient(["records:read"])
    const id = encodeCompanyKnowledgeId({
      kind: "doc",
      spaceId: "product",
      docPath: "research/überblick",
    })
    const result = await client.callTool({
      name: "fetch",
      arguments: { id },
    })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain("docs:read")
    expect(JSON.stringify(result._meta?.["mcp/www_authenticate"])).toContain(
      "/.well-known/oauth-protected-resource"
    )
    expect(JSON.stringify(result._meta?.["mcp/www_authenticate"])).toContain(
      'error=\\"insufficient_scope\\"'
    )

    const common = await client.callTool({
      name: "fetch",
      arguments: {
        id: encodeCompanyKnowledgeId({
          kind: "document",
          spaceId: "product",
          path: "dashboards/launch",
        }),
      },
    })
    expect(common.isError).toBe(true)
    expect(JSON.stringify(common.content)).toContain("documents:read")
  })

  it("round-trips Unicode paths and rejects malformed or unsafe ids", () => {
    const target = {
      kind: "doc" as const,
      spaceId: "product",
      docPath: "research/überblick",
    }
    expect(decodeCompanyKnowledgeId(encodeCompanyKnowledgeId(target))).toEqual(
      target
    )
    expect(() => decodeCompanyKnowledgeId("not-a-worktable-id")).toThrow()

    const unsafe = `wt1.${Buffer.from(
      JSON.stringify({
        kind: "doc",
        spaceId: "product",
        docPath: "../../secret",
      })
    ).toString("base64url")}`
    expect(() => decodeCompanyKnowledgeId(unsafe)).toThrow()
  })
})
