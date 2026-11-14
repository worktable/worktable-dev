import {
  linkedAnalyticsContext,
  mcpAnalyticsContext,
  reportedToGateway,
  withAnalyticsContext,
} from "../analytics.ts"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { implicitLoopbackRequestAllowed, requireIdentity } from "../auth.ts"
import { hostedFileLinkBase, isHosted } from "../hosted.ts"
import {
  handleModernMcpRequest,
  modernMcpRequestBody,
} from "../mcp/modern.ts"
import {
  createWorktableMcpServer,
  type WorktableMcpServerOptions,
} from "../mcp/server.ts"
import { configuredMcpSurface, mcpModernEraEnabled } from "../mcp/surface.ts"
import { PUBLIC_TOOL_NAMES } from "../mcp/catalog.ts"
import { earlierToolFor } from "../mcp/legacy-calls.ts"
import { resolveWorkspaceOriginForRequest } from "../workspace-origin.ts"
import type { TokenIdentity } from "../token-store.ts"
import type { AnalyticsGrant } from "@worktable/hosted-contract"
import { runWithTeamIdentity } from "../team-policy.ts"

// ============================================================
// Server factory — creates a fresh server per request (stateless)
// ============================================================

function remoteMcpServerOptions(
  request: Request,
  identity: TokenIdentity,
  urlOrigin: string
): WorktableMcpServerOptions {
  return {
    version: "0.0.1",
    scopes: identity.scopes,
    urlOrigin,
    fileLinkBase: hostedFileLinkBase(request),
    surface: configuredMcpSurface(),
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
  }
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
      "mcp-method",
      "mcp-name",
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
  /** Also serve MCP 2026-07-28 requests; without it they get the legacy answer. */
  modernEra?: boolean
  /** The Link destination the request came through, when it did. */
  link?: string
  /**
   * The analytics grant Cloud signed into a linked request: the answer
   * reports the request's calls and saves, and Cloud sends them.
   */
  analytics?: AnalyticsGrant
}

/** Tells the Cloud gateway which call it answered, for its request counts. */
export const MCP_CALL_HEADER = "x-worktable-mcp"
const LISTED_TOOLS: ReadonlySet<string> = new Set(PUBLIC_TOOL_NAMES)

function callName(message: unknown): string | null {
  const call = message as { method?: unknown; params?: { name?: unknown } } | null
  if (typeof call?.method !== "string" || !/^[a-z/_]{1,64}$/i.test(call.method)) return null
  // Only a tool Worktable answers is named; a caller's own string never is.
  const tool = call.method === "tools/call" && typeof call.params?.name === "string" && (LISTED_TOOLS.has(call.params.name) || earlierToolFor(call.params.name) !== null)
    ? call.params.name
    : ""
  return tool ? `${call.method} ${tool}` : call.method
}

function namedCall(response: Response, call: string | null): Response {
  if (!call || !isHosted()) return response
  try {
    response.headers.set(MCP_CALL_HEADER, call)
    return response
  } catch {
    const named = new Response(response.body, response)
    named.headers.set(MCP_CALL_HEADER, call)
    return named
  }
}

// MCP endpoint — stateless: new server + transport per request
export async function handleRemoteMcpRequest(
  request: Request,
  identity: TokenIdentity,
  origin: string,
  options: RemoteMcpRequestOptions = {}
): Promise<Response> {
  const modern = options.modernEra
    ? await modernMcpRequestBody(request)
    : undefined
  const analytics = options.analytics
    ? linkedAnalyticsContext(request, identity, options.analytics)
    : mcpAnalyticsContext(request, identity)
  if (modern) {
    const response = await withAnalyticsContext(analytics, () =>
      runWithTeamIdentity(identity, () =>
        handleModernMcpRequest(request, modern.body, {
          server: remoteMcpServerOptions(request, identity, origin),
          stream: options.stream ?? false,
          ...(options.link ? { link: options.link } : {}),
        })
      )
    )
    return reportedToGateway(
      namedCall(response, callName(Array.isArray(modern.body) ? modern.body[0] : modern.body)),
      analytics
    )
  }

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
  const server = createWorktableMcpServer(
    remoteMcpServerOptions(request, identity, origin)
  )
  await server.connect(transport)
  // Read the call from the message the transport already parsed.
  let call: string | null = null
  const deliver = transport.onmessage
  transport.onmessage = (message, extra) => {
    call ??= callName(message)
    deliver?.(message, extra)
  }
  for (const key of callKeys) bridgeCalls.set(key, server)
  const release = () => {
    for (const key of callKeys) {
      if (bridgeCalls.get(key) === server) bridgeCalls.delete(key)
    }
  }

  let response: Response
  try {
    response = await withAnalyticsContext(analytics, () =>
      runWithTeamIdentity(identity, () => transport.handleRequest(request))
    )
  } catch (error) {
    release()
    throw error
  }
  response = reportedToGateway(namedCall(response, call), analytics)
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
    modernEra: mcpModernEraEnabled(),
  })
})
