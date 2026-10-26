import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { setAppDirOverride } from "./app-storage.ts"
import { createWorktableMcpServer } from "./mcp/server.ts"
import { resolveParticipant } from "./participant-store.ts"
import { mcpRouter } from "./routes/mcp.ts"
import { writeSpace } from "./store.ts"
import type { RequestPrincipal } from "./token-store.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"

// The local MCP bridge (stdio forwarding, Claude Desktop) reaches this
// stateless route over HTTP. These tests drive the route the way the bridge
// does: one client tagged with a bridge id on a loopback URL.

let workspaceDir: string
let appDir: string
const clients: Client[] = []

const finn: RequestPrincipal = {
  id: "token:finn",
  type: "agent",
  displayName: "Finn",
  authorizedBy: "local:owner",
}
const atlas: RequestPrincipal = {
  id: "token:atlas",
  type: "agent",
  displayName: "Atlas",
  authorizedBy: "local:owner",
}

async function inMemoryAgent(
  agent: string,
  principal: RequestPrincipal,
  scopes: string[]
): Promise<Client> {
  const server = createWorktableMcpServer({
    version: "test",
    scopes,
    identity: { agent, principal },
    principal,
  })
  const client = new Client({ name: agent, version: "1" })
  clients.push(client)
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ])
  return client
}

async function call(
  client: Client,
  name: string,
  request: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await client.callTool({ name, arguments: { request } })
  const item = (response as { content: Array<{ text?: string }> }).content[0]
  return JSON.parse(item?.text ?? "{}") as Record<string, unknown>
}

/**
 * A bridge-shaped client: loopback URL, bridge id header, in-process fetch.
 * `onCallStream` sees each tool call's streamed (SSE) response as soon as the
 * server opens it, which happens once the tool handler is running.
 */
async function bridgeClient(
  responses: Response[],
  onCallStream: (response: Response) => void = () => {}
): Promise<Client> {
  const app = new Hono()
  app.route("/mcp", mcpRouter)
  const transport = new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1/mcp"),
    {
      requestInit: {
        headers: { "x-worktable-mcp-bridge": crypto.randomUUID() },
      },
      fetch: async (input, init) => {
        const response = await app.fetch(new Request(input, init))
        responses.push(response.clone())
        const toolCall =
          typeof init?.body === "string" && init.body.includes('"tools/call"')
        if (
          toolCall &&
          response.headers.get("content-type")?.includes("text/event-stream")
        ) {
          onCallStream(response.clone())
        }
        return response
      },
    }
  )
  const client = new Client({ name: "bridge", version: "1" })
  clients.push(client)
  await client.connect(transport)
  return client
}

async function postToAtlas(): Promise<{
  threadId: string
  cursor: number
  activityRevision: number
}> {
  const finnClient = await inMemoryAgent("claude-code@work", finn, [
    "threads:read",
    "threads:write",
  ])
  const posted = await call(finnClient, "worktable_threads_write", {
    action: "post",
    to: "Atlas",
    body: "Please look at the bridge.",
    idempotencyKey: `bridge-${crypto.randomUUID()}`,
    waitSeconds: 0,
  })
  return {
    threadId: posted.threadId as string,
    cursor: posted.cursor as number,
    activityRevision: (posted.activity as { revision: number }).revision,
  }
}

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "worktable-mcp-bridge-ws-"))
  appDir = await mkdtemp(join(tmpdir(), "worktable-mcp-bridge-app-"))
  setWorkspaceRootOverride(workspaceDir)
  setAppDirOverride(appDir)
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: "connected-agents",
    name: "Connected Agents",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  })
  await resolveParticipant(
    { agent: "openclaw@personal", principal: atlas },
    { name: "Atlas", defaultSpaceId: "connected-agents" }
  )
  await resolveParticipant(
    { agent: "claude-code@work", principal: finn },
    { name: "Finn", defaultSpaceId: "connected-agents" }
  )
})

afterEach(async () => {
  delete process.env["WORKTABLE_MCP_MODERN"]
  await Promise.all(clients.splice(0).map((client) => client.close()))
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await Promise.all([
    rm(workspaceDir, { recursive: true, force: true }),
    rm(appDir, { recursive: true, force: true }),
  ])
})

describe("MCP bridge over HTTP", () => {
  it("streams progress while a thread wait is open", async () => {
    const { threadId, cursor, activityRevision } = await postToAtlas()
    const bridge = await bridgeClient([])
    const progress: Array<{ progress: number; message?: string }> = []
    let progressed!: () => void
    const firstProgress = new Promise<void>((resolve) => {
      progressed = resolve
    })
    // From the activity the post returned, so the wait reports Atlas's work
    // however late it starts.
    const waiting = bridge.callTool(
      {
        name: "worktable_threads_read",
        arguments: {
          request: {
            action: "wait",
            threadId,
            after: cursor,
            activityRevision,
            waitSeconds: 10,
          },
        },
      },
      CallToolResultSchema,
      {
        onprogress: (update) => {
          progress.push(update)
          progressed()
        },
      }
    )

    const atlasClient = await inMemoryAgent("openclaw@personal", atlas, [
      "threads:read",
      "threads:write",
      "threads:participate",
    ])
    const claimed = await call(atlasClient, "worktable_thread_delivery", {
      action: "claim",
      waitSeconds: 0,
    })
    const delivery = claimed.delivery as Record<string, unknown>
    await call(atlasClient, "worktable_thread_delivery", {
      action: "accept",
      messageId: delivery.messageId,
      leaseId: delivery.leaseId,
    })
    await call(atlasClient, "worktable_thread_delivery", {
      action: "progress",
      messageId: delivery.messageId,
      leaseId: delivery.leaseId,
      phase: "receiving",
      receivedCharacters: 42,
    })
    // A reply that lands first ends the wait before it reports anything.
    await Promise.race([firstProgress, waiting])
    await call(atlasClient, "worktable_threads_write", {
      action: "post",
      threadId,
      inReplyTo: delivery.messageId,
      responseTo: delivery.messageId,
      body: "Looked.",
      idempotencyKey: `atlas-${crypto.randomUUID()}`,
      expectsReply: false,
    })

    await waiting
    expect(progress.length).toBeGreaterThan(0)
  })

  it("ends a cancelled call instead of letting it run on", async () => {
    const { threadId, cursor } = await postToAtlas()
    let callStreamOpened!: (response: Response) => void
    const callStream = new Promise<Response>((resolve) => {
      callStreamOpened = resolve
    })
    const bridge = await bridgeClient([], (response) =>
      callStreamOpened(response)
    )
    const abort = new AbortController()
    const startedAt = Date.now()
    const waiting = bridge.callTool(
      {
        name: "worktable_threads_read",
        arguments: {
          request: { action: "wait", threadId, after: cursor, waitSeconds: 20 },
        },
      },
      CallToolResultSchema,
      { signal: abort.signal }
    )
    const callResponse = await callStream
    abort.abort()
    await expect(waiting).rejects.toThrow()

    // The wait's own stream must end well before its 20 s would have.
    await callResponse.text()
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })
})

// A 2026-07-28 client carries its version and capabilities in every request's
// _meta, mirrored in headers, instead of opening with initialize. The same
// endpoint serves both eras while the modern one is on.

const MODERN_META = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "modern", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": {},
}

interface JsonRpcReply {
  result?: Record<string, unknown>
  error?: { code: number; data?: Record<string, unknown> }
}

async function modernPost(
  method: string,
  params: Record<string, unknown> = {},
  { version = "2026-07-28", mcpName = params.name } = {}
): Promise<{ status: number; reply: JsonRpcReply }> {
  const app = new Hono()
  app.route("/mcp", mcpRouter)
  const response = await app.fetch(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": version,
        "mcp-method": method,
        ...(typeof mcpName === "string" ? { "mcp-name": mcpName } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            ...MODERN_META,
            "io.modelcontextprotocol/protocolVersion": version,
          },
        },
      }),
    })
  )
  return { status: response.status, reply: (await response.json()) as JsonRpcReply }
}

/** A legacy (initialize) client over HTTP; `replies` gets each JSON reply. */
async function legacyClient(replies: JsonRpcReply[]): Promise<Client> {
  const app = new Hono()
  app.route("/mcp", mcpRouter)
  const transport = new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1/mcp"),
    {
      fetch: async (input, init) => {
        const response = await app.fetch(new Request(input, init))
        if (response.headers.get("content-type")?.includes("application/json"))
          replies.push((await response.clone().json()) as JsonRpcReply)
        return response
      },
    }
  )
  const client = new Client({ name: "legacy", version: "1" })
  clients.push(client)
  await client.connect(transport)
  return client
}

const formatSpec = {
  name: "worktable_guidance",
  arguments: { request: { action: "format_spec" } },
}

describe("MCP 2026-07-28 beside the legacy revisions", () => {
  it("serves legacy and modern clients the same tools and results", async () => {
    process.env["WORKTABLE_MCP_MODERN"] = "1"
    const replies: JsonRpcReply[] = []
    const legacy = await legacyClient(replies)
    await legacy.listTools()
    const legacyTools = replies.find((reply) => reply.result?.tools)?.result
    const legacyCall = await legacy.callTool(formatSpec)
    expect(JSON.stringify(legacyCall.structuredContent)).toContain(
      "Worktable format"
    )

    const discover = await modernPost("server/discover")
    expect(discover.status).toBe(200)
    expect(discover.reply.result).toMatchObject({
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      instructions: legacy.getInstructions(),
      resultType: "complete",
    })
    // The same tools; only execution.taskSupport, which 2026-07-28 deleted
    // (its tasks extension declares no per-tool support), stays legacy.
    const tools = await modernPost("tools/list")
    expect(tools.reply.result?.tools).toEqual(
      (legacyTools?.tools as Array<Record<string, unknown>>).map(
        ({ execution, ...tool }) => {
          expect(execution).toEqual({ taskSupport: "forbidden" })
          return tool
        }
      )
    )
    const modernCall = await modernPost("tools/call", formatSpec)
    expect(modernCall.status).toBe(200)
    expect(modernCall.reply.result).toEqual({
      ...legacyCall,
      resultType: "complete",
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "worktable",
          version: "0.0.1",
        },
      },
    })
  })

  it("answers with modern errors a modern client can act on", async () => {
    process.env["WORKTABLE_MCP_MODERN"] = "1"
    const mismatch = await modernPost("tools/call", formatSpec, {
      mcpName: "worktable_delete",
    })
    expect(mismatch.status).toBe(400)
    expect(mismatch.reply.error?.code).toBe(-32020)

    const unsupported = await modernPost("tools/list", {}, {
      version: "2099-01-01",
    })
    expect(unsupported.status).toBe(400)
    expect(unsupported.reply.error?.code).toBe(-32022)
    expect(unsupported.reply.error?.data?.supported).toEqual(["2026-07-28"])
  })

  it("answers modern requests as a legacy-only server while the era is off", async () => {
    // A 400 without a modern error code: a dual-era client falls back to
    // initialize, as against any server from before this revision.
    for (const method of ["server/discover", "tools/list"]) {
      const { status, reply } = await modernPost(method)
      expect(status).toBe(400)
      expect(reply.error?.code).toBe(-32000)
    }
  })
})
