import { SOURCE_URL } from "../release-info.ts"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { RequestPrincipal, TokenIdentity } from "../token-store.ts"
import { SERVER_INSTRUCTIONS } from "./instructions.ts"
import type { McpSurface } from "./surface.ts"
import { registerTools } from "./tools.ts"

export interface WorktableMcpServerOptions {
  version: string
  scopes?: string[]
  urlOrigin?: string
  principal?: RequestPrincipal
  identity?: Pick<TokenIdentity, "agent" | "credentialClass" | "principal">
  /** Defaults to the released surface; runtime callers pass configuredMcpSurface(). */
  surface?: McpSurface
}

export function createWorktableMcpServer(
  options: WorktableMcpServerOptions
): McpServer {
  const server = new McpServer(
    { name: "worktable", version: options.version },
    {
      capabilities: { tools: {} },
      instructions: SOURCE_URL
        ? `${SERVER_INSTRUCTIONS}\n\nWorktable source code: ${SOURCE_URL}`
        : SERVER_INSTRUCTIONS,
    }
  )
  registerTools(server, {
    scopes: options.scopes,
    urlOrigin: options.urlOrigin,
    principal: options.principal,
    identity: options.identity,
    surface: options.surface,
  })
  return server
}
