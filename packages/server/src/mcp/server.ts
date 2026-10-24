import { readFileSync, statSync } from "node:fs"
import { SOURCE_URL } from "../release-info.ts"
import { getWorkspaceManifestPath } from "../workspace.ts"
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

let namedWorktable: { path: string; mtimeMs: number; name: string } | null =
  null

/**
 * The Worktable's own name, re-read only when its manifest changes. Null when
 * the manifest can't be read, so instructions then just leave the name out.
 */
function worktableName(): string | null {
  const path = getWorkspaceManifestPath()
  try {
    const { mtimeMs } = statSync(path)
    if (namedWorktable?.path !== path || namedWorktable.mtimeMs !== mtimeMs) {
      const { name } = JSON.parse(readFileSync(path, "utf8")) as {
        name?: unknown
      }
      if (typeof name !== "string" || !name.trim()) return null
      namedWorktable = { path, mtimeMs, name: name.trim() }
    }
    return namedWorktable.name
  } catch {
    return null
  }
}

/**
 * Instructions an agent reads on connecting. The preview surface also names
 * the Worktable, so an agent connected to several can tell them apart.
 */
export function serverInstructions(surface: McpSurface = "released"): string {
  const name = surface === "preview" ? worktableName() : null
  return [
    name ? `You are connected to the Worktable ${JSON.stringify(name)}.` : null,
    SERVER_INSTRUCTIONS,
    SOURCE_URL ? `Worktable source code: ${SOURCE_URL}` : null,
  ]
    .filter(Boolean)
    .join("\n\n")
}

export function createWorktableMcpServer(
  options: WorktableMcpServerOptions
): McpServer {
  const server = new McpServer(
    { name: "worktable", version: options.version },
    {
      capabilities: { tools: {} },
      instructions: serverInstructions(options.surface),
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
