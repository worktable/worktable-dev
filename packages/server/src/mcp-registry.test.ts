import { afterEach, describe, expect, it } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorktableMcpServer } from "./mcp/server.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import {
  OPERATION_DEFINITIONS,
  type OperationId,
  WORKTABLE_TOOL_ROUTES,
} from "./mcp/operations.ts"
import { PUBLIC_TOOL_NAMES } from "./mcp/catalog.ts"
import {
  assertPublicOperationOutput,
  PUBLIC_OPERATION_OUTPUT_VARIANTS,
} from "./mcp/output-schemas.ts"
import {
  AnnotationsWriteInput,
  DocsWriteInput,
  GuidanceInput,
  HtmlReadInput,
  HtmlWriteInput,
} from "./mcp/schemas.ts"

const openClients: Client[] = []

afterEach(async () => {
  await Promise.all(openClients.splice(0).map((client) => client.close()))
})

async function listTools(surface?: "released" | "preview") {
  const server = createWorktableMcpServer({ version: "test", surface })
  const client = new Client({ name: "registry-test", version: "1" })
  openClients.push(client)
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return client.listTools()
}

async function listToolsOnWire(): Promise<
  Array<{
    name: string
    securitySchemes?: unknown
    _meta?: Record<string, unknown>
  }>
> {
  const server = createWorktableMcpServer({ version: "wire-test" })
  const client = new Client({ name: "wire-registry-test", version: "1" })
  openClients.push(client)
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  let wireTools: Array<{
    name: string
    securitySchemes?: unknown
    _meta?: Record<string, unknown>
  }> = []
  const mutableTransport = serverTransport as unknown as {
    send: (message: unknown, options?: unknown) => Promise<void>
  }
  const originalSend = mutableTransport.send.bind(mutableTransport)
  mutableTransport.send = async (message, options) => {
    const result = (message as { result?: { tools?: unknown } }).result
    if (Array.isArray(result?.tools)) {
      wireTools = result.tools as typeof wireTools
    }
    await originalSend(message, options)
  }
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  await client.listTools()
  return wireTools
}

async function connectedClient(scopes: string[]) {
  const server = createWorktableMcpServer({
    version: "test",
    scopes,
    urlOrigin: "http://127.0.0.1:7480",
  })
  const client = new Client({ name: "call-test", version: "1" })
  openClients.push(client)
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return client
}

function actionsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) actionsIn(item, found)
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const properties = record.properties as Record<string, unknown> | undefined
    const action = properties?.action as Record<string, unknown> | undefined
    if (typeof action?.const === "string") found.add(action.const)
    for (const nested of Object.values(record)) actionsIn(nested, found)
  }
  return found
}

describe("consolidated MCP registry", () => {
  it("advertises the complete capability registry with useful schemas", async () => {
    const { tools } = await listTools()
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    const companySearch = tools.find((tool) => tool.name === "search")
    const companyFetch = tools.find((tool) => tool.name === "fetch")
    expect(companySearch?.inputSchema.required).toEqual(["query"])
    expect(companySearch?.outputSchema?.required).toEqual(["results"])
    expect(companyFetch?.inputSchema.required).toEqual(["id"])
    expect(companyFetch?.outputSchema?.required).toEqual([
      "id",
      "title",
      "text",
      "url",
    ])
    for (const tool of tools) {
      expect(tool.title).toBeTruthy()
      expect(tool.outputSchema?.type).toBe("object")
      expect(
        Object.keys(tool.outputSchema?.properties ?? {}).length
      ).toBeGreaterThan(0)
    }
    for (const name of PUBLIC_TOOL_NAMES) {
      const tool = byName[name]
      expect(tool).toBeDefined()
      expect(tool.inputSchema.type).toBe("object")
      // One operation per tool: no request wrapper or action selector.
      expect(tool.inputSchema.properties ?? {}).not.toHaveProperty("request")
      expect(actionsIn(tool.inputSchema).size).toBe(0)
    }
  })

  it("keeps every routed operation covered by an exact output contract", () => {
    const operations = (
      Object.keys(OPERATION_DEFINITIONS) as OperationId[]
    ).sort()
    expect(Object.keys(PUBLIC_OPERATION_OUTPUT_VARIANTS).sort()).toEqual(
      operations
    )
    const routed = Object.values(WORKTABLE_TOOL_ROUTES)
      .flatMap((routes) => Object.values(routes))
      .sort()
    expect(routed).toEqual(operations)
    for (const variants of Object.values(PUBLIC_OPERATION_OUTPUT_VARIANTS)) {
      expect(variants.length).toBeGreaterThan(0)
    }
  })

  it("validates exact outputs while allowing additive fields", () => {
    expect(() =>
      assertPublicOperationOutput("records.delete", {
        ok: true,
        futureField: "preserved",
      })
    ).not.toThrow()
    expect(() => assertPublicOperationOutput("records.delete", {})).toThrow(
      "ok:invalid_value"
    )

    const record = {
      version: 1,
      kind: "worktable.record",
      id: "ship-plugin",
      collectionId: "tasks",
      createdAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
      createdBy: "test",
      metadata: {},
      data: { title: "Ship plugin" },
      futurePortableField: { accepted: true },
    }
    expect(() =>
      assertPublicOperationOutput("records.read", { record })
    ).not.toThrow()
    expect(() =>
      assertPublicOperationOutput("records.read", {
        record: { ...record, data: [] },
      })
    ).toThrow("record.data:invalid_type")
    expect(() =>
      assertPublicOperationOutput("mermaid.validate", {
        ok: true,
        diagramType: 42,
      })
    ).toThrow("diagramType:invalid_type")
  })

  it("keeps MCP safety hints truthful", async () => {
    const { tools } = await listTools()
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]))
    for (const tool of tools) {
      expect(tool.title).toBeTruthy()
      // Directory listings read the display name from the annotations.
      expect(tool.annotations?.title).toBe(tool.title)
      expect(tool._meta?.securitySchemes).toEqual([
        {
          type: "oauth2",
          scopes: [],
        },
      ])
    }
    expect(byName.search?.annotations).toEqual({
      title: "Search Worktable",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    })
    expect(byName.worktable_spaces_write?.annotations).toEqual({
      title: "Write a Worktable Space",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    })
    for (const name of [
      "worktable_docs_write",
      "worktable_files_write",
      "worktable_files_update",
      "worktable_threads_update",
      "worktable_delete",
    ])
      expect(byName[name]?.annotations?.destructiveHint).toBe(true)
    expect(byName.worktable_threads_post?.annotations).toMatchObject({
      destructiveHint: false,
      openWorldHint: true,
    })
    expect(byName.worktable_pending?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    })
  })

  it("publishes OAuth schemes in current and compatibility wire fields", async () => {
    const tools = await listToolsOnWire()
    for (const tool of tools) {
      expect(tool.securitySchemes).toEqual(tool._meta?.securitySchemes)
      expect(tool.securitySchemes).toEqual([{ type: "oauth2", scopes: [] }])
    }
  })

  it("returns compact machine-readable content alongside the text fallback", async () => {
    const client = await connectedClient(["*"])
    const result = await client.callTool({
      name: "worktable_guidance",
      arguments: { topic: "format_spec" },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toBeDefined()
    const content = result.content as Array<{ type: string; text: string }>
    expect(content[0]!.text).toBe(JSON.stringify(result.structuredContent))
    expect(JSON.parse(content[0]!.text)).toEqual(result.structuredContent)
  })

  it("returns the technical HTML runtime contract", async () => {
    const client = await connectedClient(["*"])
    const result = await client.callTool({
      name: "worktable_guidance",
      arguments: { topic: "html", profile: "runtime" },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({
      profile: "runtime",
    })
    const guide = String(
      (result.structuredContent as { guide?: unknown }).guide ?? ""
    )
    expect(guide.trim().length).toBeGreaterThan(0)
  })

  it("validates structured guidance and Mermaid results", async () => {
    const client = await connectedClient(["*"])
    const guidance = await client.callTool({
      name: "worktable_guidance",
      arguments: { topic: "format_spec" },
    })
    expect(guidance.isError).not.toBe(true)
    expect(guidance.structuredContent).toMatchObject({
      spec: expect.any(String),
    })

    const validation = await client.callTool({
      name: "worktable_mermaid",
      arguments: { source: "flowchart TD\nA-->B" },
    })
    expect(validation.isError).not.toBe(true)
    expect(validation.structuredContent).toMatchObject({
      ok: true,
      diagramType: "flowchart-v2",
    })

    const preview = await client.callTool({
      name: "worktable_mermaid",
      arguments: { source: "flowchart TD\nA-->B", preview: true },
    })
    expect(preview.isError).not.toBe(true)
    expect(preview.structuredContent).toMatchObject({
      ok: true,
      svg: expect.stringContaining("<svg"),
    })
  })

  it("enforces the scope of the operation a call resolves to", async () => {
    const client = await connectedClient(["docs:read"])
    const denied = await client.callTool({
      name: "worktable_docs_write",
      arguments: { spaceId: "s", docPath: "d", content: "# D" },
    })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain("docs:write")
  })

  it("uses strict action schemas and the public HTML vocabulary", () => {
    expect(
      HtmlReadInput.safeParse({
        request: { action: "guide", profile: "runtime" },
      }).success
    ).toBe(true)
    expect(
      HtmlWriteInput.safeParse({
        request: {
          action: "update",
          spaceId: "s",
          htmlId: "h",
          html: "<!doctype html><html></html>",
        },
      }).success
    ).toBe(true)
    expect(
      HtmlWriteInput.safeParse({
        request: {
          action: "update",
          spaceId: "s",
          widgetId: "h",
          html: "<!doctype html><html></html>",
        },
      }).success
    ).toBe(false)
    expect(
      AnnotationsWriteInput.safeParse({
        request: {
          action: "reply",
          spaceId: "s",
          annotationId: "a",
          body: "done",
          author: { id: "spoofed" },
        },
      }).success
    ).toBe(false)
    expect(
      DocsWriteInput.safeParse({
        request: {
          action: "edit",
          spaceId: "s",
          docPath: "d",
          edits: [],
        },
      }).success
    ).toBe(false)
    expect(
      GuidanceInput.safeParse({
        request: { action: "format_spec", section: "block_types" },
      }).success
    ).toBe(false)
  })
})

describe("released tool surface", () => {
  it("names the Worktable on both surfaces and omits owner names on Teams", async () => {
    const root = mkdtempSync(join(tmpdir(), "worktable-mcp-name-"))
    const manifest = join(root, "worktable.workspace.json")
    setWorkspaceRootOverride(root)
    try {
      writeFileSync(manifest, JSON.stringify({ name: "Studio Notes" }))
      const instructions = async (surface?: "preview") => {
        const server = createWorktableMcpServer({ version: "test", surface })
        const client = new Client({ name: "instructions-test", version: "1" })
        openClients.push(client)
        const [clientTransport, serverTransport] =
          InMemoryTransport.createLinkedPair()
        await Promise.all([
          server.connect(serverTransport),
          client.connect(clientTransport),
        ])
        return client.getInstructions() ?? ""
      }
      expect(await instructions("preview")).toStartWith(
        'You are connected to the Worktable "Studio Notes".\n\n'
      )
      expect(await instructions()).toContain("Studio Notes")
      // A rename shows on the next connection.
      writeFileSync(manifest, JSON.stringify({ name: "Field Notes" }))
      utimesSync(manifest, new Date(), new Date(Date.now() + 5_000))
      expect(await instructions("preview")).toContain('"Field Notes"')
      // On a team Worktable the owner's name for it doesn't reach members'
      // agents as instructions.
      writeFileSync(
        manifest,
        JSON.stringify({ name: "Field Notes", teamAccessRequired: true })
      )
      utimesSync(manifest, new Date(), new Date(Date.now() + 10_000))
      expect(await instructions("preview")).not.toContain("Field Notes")
    } finally {
      setWorkspaceRootOverride(null)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("lists the same flat tools on both surfaces", async () => {
    const released = (await listTools()).tools
    expect((await listTools("preview")).tools).toEqual(released)
    expect(released.map((tool) => tool.name)).toEqual([...PUBLIC_TOOL_NAMES])
    const byName = Object.fromEntries(released.map((tool) => [tool.name, tool]))
    // ChatGPT passes a file the user attached as a link to it.
    expect(byName.worktable_files_write?._meta?.["openai/fileParams"]).toEqual([
      "file",
    ])
    expect(byName.worktable_files_write?.inputSchema.properties).toHaveProperty(
      "file"
    )
    expect(byName.worktable_files_read?.outputSchema?.properties).toHaveProperty(
      "source"
    )
    expect(byName.worktable_records_create?.description).toContain(
      "Never overwrites"
    )
  })
})
