/**
 * How a mark sits in a round avatar. `pad` insets artwork drawn to its
 * edges; `inset` is artwork with its own margin, drawn a little larger;
 * `fill` covers the circle.
 */
export type AgentLogoFit = "pad" | "inset" | "fill"

const FITS: Record<string, AgentLogoFit> = {
  "hermes.png": "fill",
  "openai.svg": "inset",
  // Its own white tile, like the app icon, so it covers the circle.
  "codex.svg": "fill",
  "goose.png": "inset",
}

export function agentLogoFit(file: string): AgentLogoFit {
  return FITS[file] ?? "pad"
}

/** Stored as an agent's icon to show a logo; also a valid icon name. */
export const AGENT_LOGO_PREFIX = "logo-"
const PNG_LOGOS = new Set(["gemini", "goose", "hermes"])

/**
 * The file in the web app's `/agent-logos/` directory that an agent's
 * stored icon names, if it names a logo. The picker's names live in
 * agent-logo-choices, so every page that draws an avatar skips them.
 */
export function agentLogoFileForIcon(
  icon: string | null | undefined
): string | null {
  if (!icon?.startsWith(AGENT_LOGO_PREFIX)) return null
  const id = icon.slice(AGENT_LOGO_PREFIX.length)
  return `${id}.${PNG_LOGOS.has(id) ? "png" : "svg"}`
}
