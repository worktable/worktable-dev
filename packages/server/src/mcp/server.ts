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
  /** On Cloud, where the gateway forwards this workspace's file links. */
  fileLinkBase?: string | null
}

let namedWorktable: {
  path: string
  mtimeMs: number
  name: string | null
} | null = null

/**
 * The Worktable's own name, re-read only when its manifest changes. Null when
 * the manifest can't be read, and on a team Worktable: there the owner names
 * it and members' agents would read that name as instructions.
 */
function worktableName(): string | null {
  const path = getWorkspaceManifestPath()
  try {
    const { mtimeMs } = statSync(path)
    if (namedWorktable?.path !== path || namedWorktable.mtimeMs !== mtimeMs) {
      const { name, teamAccessRequired } = JSON.parse(
        readFileSync(path, "utf8")
      ) as { name?: unknown; teamAccessRequired?: unknown }
      namedWorktable = {
        path,
        mtimeMs,
        name:
          typeof name === "string" && name.trim() && teamAccessRequired !== true
            ? name.trim()
            : null,
      }
    }
    return namedWorktable.name
  } catch {
    return null
  }
}

/**
 * Instructions an agent reads on connecting, naming the Worktable so an agent
 * connected to several can tell them apart.
 */
export function serverInstructions(): string {
  const name = worktableName()
  return [
    name ? `You are connected to the Worktable ${JSON.stringify(name)}.` : null,
    SERVER_INSTRUCTIONS,
    SOURCE_URL ? `Worktable source code: ${SOURCE_URL}` : null,
  ]
    .filter(Boolean)
    .join("\n\n")
}

/** The name, version and instructions the server gives agents in either era. */
export function serverIdentity(
  options: Pick<WorktableMcpServerOptions, "version" | "surface">
) {
  return {
    info: { name: "worktable", version: options.version },
    instructions: serverInstructions(),
  }
}

export function createWorktableMcpServer(
  options: WorktableMcpServerOptions
): McpServer {
  const { info, instructions } = serverIdentity(options)
  const server = new McpServer(info, {
    capabilities: { tools: {} },
    instructions,
  })
  registerTools(server, {
    scopes: options.scopes,
    urlOrigin: options.urlOrigin,
    principal: options.principal,
    identity: options.identity,
    surface: options.surface,
    fileLinkBase: options.fileLinkBase,
  })
  return server
}
