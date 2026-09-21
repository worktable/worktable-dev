import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

export interface OAuthSecurityScheme {
  type: "oauth2"
  scopes: string[]
}

export function oauthToolMetadata() {
  // The hosted authorization server owns its external OAuth vocabulary. The
  // gateway maps a valid resource token to Worktable's internal permissions,
  // which each tool still enforces at call time. Advertising those internal
  // names here would make OAuth clients request scopes the provider rejects.
  const securitySchemes: OAuthSecurityScheme[] = [
    { type: "oauth2", scopes: [] },
  ]
  return {
    // OpenAI's current tool descriptor field. The MCP TypeScript SDK types do
    // not expose it yet, so installOpenAiToolDescriptorCompatibility ensures it
    // survives the SDK's tools/list serializer.
    securitySchemes,
    // Backward-compatible mirror for clients that still read descriptor _meta.
    _meta: { securitySchemes },
  }
}

type ToolListHandler = (
  request: unknown,
  extra: unknown
) => unknown | Promise<unknown>

interface MutableRequestHandlerServer {
  setRequestHandler: (requestSchema: unknown, handler: ToolListHandler) => void
}

/**
 * Preserve OpenAI's top-level `securitySchemes` field on the wire until the MCP
 * TypeScript SDK includes that Apps extension in its own Tool serializer.
 *
 * This wraps the public low-level request-handler registration hook before the
 * high-level server installs tools/list. Tool calls, validation, and every
 * other MCP handler remain owned by the SDK.
 */
export function installOpenAiToolDescriptorCompatibility(
  server: McpServer
): () => void {
  const raw = (server as unknown as { server?: MutableRequestHandlerServer })
    .server
  // Some focused tests use the documented high-level registerTool surface as a
  // lightweight structural fake. There is no SDK serializer to patch there.
  if (!raw || typeof raw.setRequestHandler !== "function") return () => {}
  const originalSetRequestHandler = raw.setRequestHandler.bind(raw)

  raw.setRequestHandler = (requestSchema, handler) => {
    if (requestSchema !== ListToolsRequestSchema) {
      originalSetRequestHandler(requestSchema, handler)
      return
    }
    originalSetRequestHandler(requestSchema, async (request, extra) => {
      const result = (await handler(request, extra)) as {
        tools?: Array<{
          _meta?: { securitySchemes?: unknown }
          [key: string]: unknown
        }>
        [key: string]: unknown
      }
      if (!Array.isArray(result.tools)) return result
      return {
        ...result,
        tools: result.tools.map((tool) => ({
          ...tool,
          ...(Array.isArray(tool._meta?.securitySchemes)
            ? { securitySchemes: tool._meta.securitySchemes }
            : {}),
        })),
      }
    })
  }

  return () => {
    raw.setRequestHandler = originalSetRequestHandler
  }
}
