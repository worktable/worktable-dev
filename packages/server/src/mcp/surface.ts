import { filesEnabled } from "../files-enabled.ts"
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
  const override = mcpPreviewEnvOverride()
  if (override !== null) return override ? "preview" : "released"
  if (isHosted()) return "released"
  return getServerSettings().agents.previewTools ? "preview" : "released"
}

/** WORKTABLE_MCP_PREVIEW when it is set to on or off, else null. */
export function mcpPreviewEnvOverride(): boolean | null {
  return envSwitch("WORKTABLE_MCP_PREVIEW")
}

/**
 * Whether the HTTP endpoint also serves MCP 2026-07-28, the stateless
 * revision that carries its version and capabilities on every request,
 * beside the initialize-based revisions. Released tasks and events use it.
 * WORKTABLE_MCP_MODERN=0 remains an off switch for the process.
 */
export function mcpModernEraEnabled(): boolean {
  return envSwitch("WORKTABLE_MCP_MODERN") ?? true
}

/**
 * Whether Link also serves MCP 2026-07-28, so a chat app reaching this
 * device through Cloud gets events and tasks.
 */
export function mcpModernEraOverLink(): boolean {
  return mcpModernEraEnabled()
}

/**
 * Whether HTML Docs show the Space images they name with <img src>, placed
 * in the page when it is served (html-space-images.ts). They follow the file
 * features, with the warnings and guidance that teach them.
 */
export function htmlSpaceImagesEnabled(): boolean {
  return filesEnabled()
}

/**
 * Whether HTML Docs draw the library icons they name with
 * <svg data-icon="..."> (html-icons.ts), with the warnings and guidance that
 * teach it.
 */
export function htmlIconsEnabled(): boolean {
  return true
}

/**
 * Whether HTML Docs also draw the library icons their own code adds, from
 * the names their scripts write out (html-icons.ts). Held behind the
 * preview, with the guidance that teaches it.
 */
export function htmlCodeIconsEnabled(): boolean {
  return configuredMcpSurface() === "preview"
}

function envSwitch(name: string): boolean | null {
  const env = process.env[name]?.trim().toLowerCase()
  if (env === "1" || env === "true") return true
  if (env === "0" || env === "false") return false
  return null
}
