import {
  createMcpHandler,
  isLegacyRequest,
  ProtocolError,
  Server,
  type ServerContext,
} from "@modelcontextprotocol/server"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import {
  createWorktableMcpServer,
  serverIdentity,
  type WorktableMcpServerOptions,
} from "./server.ts"

// ============================================================
// MCP 2026-07-28 ("modern" era) beside the initialize-based revisions
// ============================================================
//
// The SDK v2 handler owns the modern wire: server/discover, the per-request
// _meta envelope, header checks (-32020), unsupported versions (-32022) and
// resultType. The tools stay on the one server both eras share
// (createWorktableMcpServer): a modern tools/list or tools/call is handed to
// it as the same JSON-RPC request a legacy client sends, so both eras list
// and answer identically. Methods only the modern era has, such as the tasks
// extension's tasks/get or events/*, register on the modern Server below.

export interface ModernMcpExchange {
  /** The options the shared server is built with for this request. */
  server: WorktableMcpServerOptions
  /**
   * Relay progress notifications, which streams the response (SSE). Only for
   * local connections, as on the legacy path.
   */
  stream: boolean
}

/** Per-request exchanges, keyed by the request the handler hands its factory. */
const exchanges = new WeakMap<Request, ModernMcpExchange>()

// Stateless: a fresh Server per request, from the factory. "auto" answers
// with JSON unless a handler sends progress first, which only a streaming
// exchange relays.
const handler = createMcpHandler(
  ({ requestInfo }) => {
    const exchange = requestInfo && exchanges.get(requestInfo)
    if (!exchange) throw new Error("No MCP exchange for this request")
    return createModernServer(exchange)
  },
  { legacy: "reject", responseMode: "auto" }
)

/**
 * The parsed body of a modern-era request, or undefined when the request is
 * legacy: no JSON body, or no per-request _meta claim (initialize and every
 * 2025-era message). Classification is the SDK's own, so a request with a
 * malformed or mismatched claim still goes to the modern path, which answers
 * it with the right error.
 */
export async function modernMcpRequestBody(
  request: Request
): Promise<{ body: unknown } | undefined> {
  if (request.method !== "POST") return undefined
  let body: unknown
  try {
    body = await request.clone().json()
  } catch {
    return undefined
  }
  // Passing the parsed body also keeps the SDK's 4 MiB read limit, which the
  // legacy path doesn't have, from classifying a large legacy call modern.
  return (await isLegacyRequest(request, body)) ? undefined : { body }
}

export async function handleModernMcpRequest(
  request: Request,
  body: unknown,
  exchange: ModernMcpExchange
): Promise<Response> {
  exchanges.set(request, exchange)
  try {
    return await handler.fetch(request, { parsedBody: body })
  } finally {
    exchanges.delete(request)
  }
}

function createModernServer(exchange: ModernMcpExchange): Server {
  const { info, instructions } = serverIdentity(exchange.server)
  const server = new Server(info, { capabilities: { tools: {} }, instructions })
  server.setRequestHandler("tools/list", (request, ctx) =>
    relay(exchange, request, ctx)
  )
  server.setRequestHandler("tools/call", (request, ctx) =>
    relay(exchange, request, ctx)
  )
  return server
}

/**
 * Hand one modern request to a fresh shared server as its legacy form and
 * resolve with that server's result. Its progress goes to the modern client
 * when the exchange streams; a cancelled modern request closes the server,
 * which aborts the call.
 */
async function relay<T>(
  exchange: ModernMcpExchange,
  request: { method: string; params?: Record<string, unknown> },
  ctx: ServerContext
): Promise<T> {
  const { id, signal } = ctx.mcpReq
  const server = createWorktableMcpServer(exchange.server)
  let transport!: Transport
  const response = new Promise<JSONRPCMessage>((resolve, reject) => {
    transport = {
      async start() {},
      async send(message) {
        if ("id" in message && message.id === id) {
          if ("result" in message || "error" in message) resolve(message)
        } else if (exchange.stream && "method" in message && !("id" in message)) {
          await ctx.mcpReq.notify(message)
        }
      },
      async close() {
        reject(new Error("The MCP request was cancelled"))
        transport.onclose?.()
      },
    }
  })
  const cancel = () => void server.close()
  signal.addEventListener("abort", cancel, { once: true })
  try {
    await server.connect(transport)
    transport.onmessage?.({
      jsonrpc: "2.0",
      id,
      method: request.method,
      // The envelope's io.modelcontextprotocol/* keys are lifted out of
      // ctx.mcpReq._meta; what remains (progressToken) is legacy-shaped.
      params: { ...request.params, _meta: ctx.mcpReq._meta },
    })
    const message = await response
    if ("error" in message) {
      throw new ProtocolError(
        message.error.code,
        message.error.message,
        message.error.data
      )
    }
    return (message as { result: T }).result
  } finally {
    signal.removeEventListener("abort", cancel)
    void server.close()
  }
}
