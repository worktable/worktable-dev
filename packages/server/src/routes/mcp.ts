import { Hono } from "hono"
import { cors } from "hono/cors"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { implicitLoopbackRequestAllowed, requireIdentity } from "../auth.ts"
import { isHosted } from "../hosted.ts"
import { createWorktableMcpServer } from "../mcp/server.ts"
import { resolveWorkspaceOriginForRequest } from "../workspace-origin.ts"
import type { TokenIdentity } from "../token-store.ts"

// ============================================================
// Server factory — creates a fresh server per request (stateless)
// ============================================================

function createRemoteMcpServer(identity: TokenIdentity, urlOrigin: string) {
  return createWorktableMcpServer({
    version: "0.0.1",
    scopes: identity.scopes,
    urlOrigin,
    // The implicit loopback bridge and legacy WORKTABLE_MCP_TOKEN both use
    // ownerIdentity() for authorization, but the caller is still an MCP agent.
    // Preserve the historical agent attribution for those compatibility modes;
    // minted/OAuth/gateway identities carry a real actor principal and retain it.
    principal:
      identity.principal.id === "local:owner" ? undefined : identity.principal,
    identity:
      identity.principal.id === "local:owner"
        ? undefined
        : {
            agent: identity.agent,
            credentialClass: identity.credentialClass,
            principal: identity.principal,
          },
  })
}

// ============================================================
// Hono router
// ============================================================

export const mcpRouter = new Hono()

// CORS for MCP-specific headers
mcpRouter.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "mcp-session-id",
      "Last-Event-ID",
      "mcp-protocol-version",
    ],
    exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
  })
)

// Auth: bare literal-loopback requests may act as local owner while deployment
// policy is local. Scoped minted tokens can coexist with that path and resolve
// their own principal when presented; exposed/public/AS/explicit-credential
// postures require a valid bearer. Invalid presented credentials always fail.
mcpRouter.use("*", requireIdentity())

/**
 * Set by Worktable's own MCP bridge (`@worktable/mcp-connect`, which defines
 * the same name), one id per bridge process.
 */
const MCP_BRIDGE_HEADER = "x-worktable-mcp-bridge"

/**
 * Per-request servers handling a bridge's tool calls, keyed by bridge id and
 * JSON-RPC id. The server is stateless, so a bridge's `notifications/cancelled`
 * arrives in a later POST; this is how it reaches the call it cancels.
 */
const bridgeCalls = new Map<string, McpServer>()

function bridgeCallKey(bridgeId: string, id: unknown): string {
  return `${bridgeId}\u0000${typeof id}:${String(id)}`
}

interface JsonRpcMessage {
  id?: unknown
  method?: unknown
  params?: { requestId?: unknown }
}

async function jsonRpcMessages(request: Request): Promise<JsonRpcMessage[]> {
  try {
    const body = (await request.clone().json()) as unknown
    const list = Array.isArray(body) ? body : [body]
    return list.filter(
      (message): message is JsonRpcMessage =>
        Boolean(message) && typeof message === "object"
    )
  } catch {
    return []
  }
}

export interface RemoteMcpRequestOptions {
  /** The calling bridge's id, enabling cancellation across requests. */
  bridgeId?: string
  /**
   * Stream the response (SSE) instead of answering with JSON, so progress
   * notifications reach the caller. Only for local connections: buffering
   * proxies in front of Cloud break streamed POST responses.
   */
  stream?: boolean
}

// MCP endpoint — stateless: new server + transport per request
export async function handleRemoteMcpRequest(
  request: Request,
  identity: TokenIdentity,
  origin: string,
  options: RemoteMcpRequestOptions = {}
): Promise<Response> {
  const { bridgeId } = options
  const callKeys: string[] = []
  if (bridgeId && request.method === "POST") {
    const messages = await jsonRpcMessages(request)
    const cancels = messages.filter(
      (message) => message.method === "notifications/cancelled"
    )
    if (cancels.length > 0 && cancels.length === messages.length) {
      for (const cancel of cancels) {
        const call = bridgeCalls.get(
          bridgeCallKey(bridgeId, cancel.params?.requestId)
        )
        // Closing a per-request server aborts its in-flight handler.
        if (call) void call.close()
      }
      return new Response(null, { status: 202 })
    }
    for (const message of messages) {
      if (message.id !== undefined && typeof message.method === "string") {
        callKeys.push(bridgeCallKey(bridgeId, message.id))
      }
    }
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
    // Answer POSTs with plain application/json instead of SSE (spec-legal:
    // the server chooses) unless the caller is a local bridge. Worktable
    // tools are strict request/response apart from progress, and SSE
    // responses break behind buffering proxies: the Fly Sprites wake proxy
    // delivered NOTHING of a text/event-stream POST response (not even
    // headers) while the origin closed the stream in 3ms, which real MCP
    // clients (Claude, ChatGPT) surfaced as the whole server being
    // unreachable.
    enableJsonResponse: !options.stream,
  })
  const server = createRemoteMcpServer(identity, origin)
  await server.connect(transport)
  for (const key of callKeys) bridgeCalls.set(key, server)
  const release = () => {
    for (const key of callKeys) {
      if (bridgeCalls.get(key) === server) bridgeCalls.delete(key)
    }
  }

  let response: Response
  try {
    response = await transport.handleRequest(request)
  } catch (error) {
    release()
    throw error
  }
  if (callKeys.length === 0) return response
  if (!response.body || !options.stream) {
    release()
    return response
  }
  // A streamed response stays open until the call finishes; release it then,
  // and cancel the call if the caller goes away first.
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          release()
          controller.close()
        } else {
          controller.enqueue(value)
        }
      } catch (error) {
        release()
        void server.close()
        controller.error(error)
      }
    },
    cancel(reason) {
      release()
      void server.close()
      return reader.cancel(reason)
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

mcpRouter.all("/", async (c) => {
  const { origin } = resolveWorkspaceOriginForRequest(c.req.raw)
  const bridgeId = c.req.header(MCP_BRIDGE_HEADER)?.trim() || undefined
  return handleRemoteMcpRequest(c.req.raw, c.get("identity"), origin, {
    bridgeId,
    stream:
      Boolean(bridgeId) && !isHosted() && implicitLoopbackRequestAllowed(c.req.raw),
  })
})
