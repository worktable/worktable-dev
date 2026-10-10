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
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
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
 * `onStream` sees each streamed (SSE) response as soon as the server opens it,
 * which happens once the tool handler is running.
 */
async function bridgeClient(
  responses: Response[],
  onStream: (response: Response) => void = () => {}
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
        if (response.headers.get("content-type")?.includes("text/event-stream")) {
          onStream(response)
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

async function postToAtlas(): Promise<{ threadId: string; cursor: number }> {
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
    const { threadId, cursor } = await postToAtlas()
    const bridge = await bridgeClient([])
    const progress: Array<{ progress: number; message?: string }> = []
    const waiting = bridge.callTool(
      {
        name: "worktable_threads_read",
        arguments: {
          request: { action: "wait", threadId, after: cursor, waitSeconds: 10 },
        },
      },
      CallToolResultSchema,
      { onprogress: (update) => void progress.push(update) }
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
    const responses: Response[] = []
    let streamOpened!: () => void
    const opened = new Promise<void>((resolve) => {
      streamOpened = resolve
    })
    const bridge = await bridgeClient(responses, () => streamOpened())
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
    await opened
    abort.abort()
    await expect(waiting).rejects.toThrow()

    // The response to the tool call is the one still streaming; it must end
    // well before the 20 s wait would have.
    const callResponse = responses.find((response) =>
      response.headers.get("content-type")?.includes("text/event-stream")
    )
    expect(callResponse).toBeDefined()
    await callResponse!.text()
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })
})
