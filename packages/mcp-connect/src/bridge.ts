import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { randomUUID } from "node:crypto"
import { PassThrough } from "node:stream"
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import {
  assertMcpBridgeToolsOnly,
  classifyMcpBridgeError,
  McpBridgeError,
  parseMcpBridgeEndpoint,
  sameOriginMcpFetch,
} from "./bridge-policy.ts"
export { McpBridgeError, type McpBridgeErrorCode } from "./bridge-policy.ts"

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000

/**
 * Names this bridge process to the server. A stateless HTTP MCP server answers
 * each POST with a fresh session, so a cancellation sent in a later POST can
 * only reach the request it cancels when both carry the same bridge id. On a
 * loopback connection the server also streams the response, which lets
 * progress notifications through.
 */
export const MCP_BRIDGE_HEADER = "x-worktable-mcp-bridge"

export interface McpBridgeOptions {
  endpoint: string
  token?: string
  clientName?: string
  clientVersion: string
  startupTimeoutMs?: number
}

/** A stable, credential-free message suitable for stderr. */
export function formatMcpBridgeError(error: unknown): string {
  const classified = classifyMcpBridgeError(error)
  return `worktable-mcp-bridge: ${classified.message}`
}

/**
 * Proxy one Streamable HTTP Worktable MCP server to this process' stdio.
 * stdout is reserved for MCP framing; callers report failures on stderr.
 */
export async function runMcpBridge(options: McpBridgeOptions): Promise<void> {
  const endpoint = parseMcpBridgeEndpoint(options.endpoint.trim())
  const token = options.token?.trim() || undefined
  const startupTimeoutMs =
    options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  if (!Number.isFinite(startupTimeoutMs) || startupTimeoutMs <= 0) {
    throw new McpBridgeError(
      "BAD_ENDPOINT",
      "Bridge startup timeout must be a positive number."
    )
  }

  const upstream = new Client(
    {
      name: options.clientName?.trim() || "worktable-mcp-bridge",
      version: options.clientVersion,
    },
    { capabilities: {} }
  )
  const headers: Record<string, string> = { [MCP_BRIDGE_HEADER]: randomUUID() }
  if (token) headers["Authorization"] = `Bearer ${token}`
  const upstreamTransport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers,
      redirect: "manual",
    },
    fetch: sameOriginMcpFetch(endpoint.origin),
  })

  const startupAbort = new AbortController()
  const startupTimer = setTimeout(() => startupAbort.abort(), startupTimeoutMs)
  // Read the local client's initialization while HTTP is pending. Do not
  // pause stdin on staging backpressure: that would hide EOF behind a large
  // frame. Like the SDK's own frame buffer, startup input is held in memory;
  // the existing startup deadline bounds how long it can remain pending.
  const input = new PassThrough()
  let downstream: Server | undefined
  let resolveClosed!: () => void
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  let closing = false
  const close = async (): Promise<void> => {
    if (closing) return closed
    closing = true
    startupAbort.abort()
    await Promise.allSettled([downstream?.close(), upstream.close()])
    resolveClosed()
  }
  let clientClosed = false
  const onClientClose = () => {
    clientClosed = true
    void close()
  }
  process.stdin.once("end", onClientClose)
  process.once("SIGINT", onClientClose)
  process.once("SIGTERM", onClientClose)
  const bufferStartupInput = (chunk: Buffer) => {
    if (!closing) input.write(chunk)
  }
  process.stdin.on("data", bufferStartupInput)
  try {
    try {
      await upstream.connect(upstreamTransport, {
        signal: startupAbort.signal,
        timeout: startupTimeoutMs,
      })
    } finally {
      clearTimeout(startupTimer)
    }
    if (closing) return await closed
    assertMcpBridgeToolsOnly(
      upstream.getServerCapabilities() as Record<string, unknown> | undefined
    )
    const upstreamInfo = upstream.getServerVersion()
    downstream = new Server(
      {
        name: upstreamInfo?.name || "worktable",
        version: upstreamInfo?.version || options.clientVersion,
      },
      {
        capabilities: { tools: {} },
        instructions: upstream.getInstructions(),
      }
    )
    downstream.setRequestHandler(ListToolsRequestSchema, (request, extra) =>
      upstream.listTools(request.params, { signal: extra.signal })
    )
    downstream.setRequestHandler(CallToolRequestSchema, (request, extra) => {
      // Relay progress under the client's own token; cancellation travels
      // upstream through the abort signal.
      const progressToken = request.params._meta?.progressToken
      return upstream.callTool(request.params, CallToolResultSchema, {
        signal: extra.signal,
        onprogress:
          progressToken === undefined
            ? undefined
            : (progress) =>
                void extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: { ...progress, progressToken },
                  })
                  .catch(() => undefined),
      })
    })
    const stdio = new StdioServerTransport(input)
    stdio.onclose = () => void close()
    // Client.onclose is the lifecycle seam; connect owns transport callbacks.
    upstream.onclose = () => void close()
    await downstream.connect(stdio)
    process.stdin.off("data", bufferStartupInput)
    process.stdin.pipe(input)
    await closed
  } catch (error) {
    await close()
    if (!clientClosed) throw classifyMcpBridgeError(error)
  } finally {
    process.stdin.off("data", bufferStartupInput)
    process.stdin.unpipe(input)
    if (process.stdin.listenerCount("data") === 0) process.stdin.pause()
    input.destroy()
    process.stdin.off("end", onClientClose)
    process.off("SIGINT", onClientClose)
    process.off("SIGTERM", onClientClose)
  }
}
