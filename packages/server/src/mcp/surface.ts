import { isHosted } from "../hosted.ts"
import { getServerSettings } from "../settings-store.ts"

/**
 * Which MCP tool surface a server lists. "released" is the surface the agent
 * directories reviewed and mcp-tools.json records; "preview" adds the changes
 * held back until they approve it (mcp-tools.preview.json).
 */
export type McpSurface = "released" | "preview"

/**
 * The surface this Worktable serves agents. Owners turn previews on in
 * Settings → Agents (machine-local); WORKTABLE_MCP_PREVIEW=1 or 0 overrides
 * that for the process. Cloud ignores the setting and stays on the released
 * surface unless its environment says otherwise.
 */
export function configuredMcpSurface(): McpSurface {
  const env = process.env["WORKTABLE_MCP_PREVIEW"]?.trim().toLowerCase()
  if (env === "1" || env === "true") return "preview"
  if (env === "0" || env === "false") return "released"
  if (isHosted()) return "released"
  return getServerSettings().agents.previewTools ? "preview" : "released"
}
