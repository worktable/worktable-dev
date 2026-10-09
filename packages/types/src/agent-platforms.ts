// The platforms a connected agent can come from. One list for the server,
// the web app, and Cloud, so names, logos, and always-on behavior agree.

export const AGENT_PLATFORM_IDS = [
  "openclaw",
  "hermes",
  "chatgpt",
  "claude",
  "claude-code",
  "codex",
  "cursor",
  "opencode",
  "vscode",
  "goose",
  "other",
] as const

export type AgentPlatformId = (typeof AGENT_PLATFORM_IDS)[number]

export interface AgentPlatform {
  id: AgentPlatformId
  name: string
  /** Always-on agents answer thread messages themselves; on-demand agents act when someone uses them. */
  mode: "always-on" | "on-demand"
  /** File in the web app's `/agent-logos/` directory, when the platform has an official mark. */
  logo: string | null
}

export const AGENT_PLATFORMS: Record<AgentPlatformId, AgentPlatform> = {
  openclaw: {
    id: "openclaw",
    name: "OpenClaw",
    mode: "always-on",
    logo: "openclaw.svg",
  },
  hermes: {
    id: "hermes",
    name: "Hermes",
    mode: "always-on",
    logo: "hermes.png",
  },
  chatgpt: { id: "chatgpt", name: "ChatGPT", mode: "on-demand", logo: null },
  claude: {
    id: "claude",
    name: "Claude",
    mode: "on-demand",
    logo: "claude.svg",
  },
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    mode: "on-demand",
    logo: "claude.svg",
  },
  codex: { id: "codex", name: "Codex", mode: "on-demand", logo: null },
  cursor: { id: "cursor", name: "Cursor", mode: "on-demand", logo: null },
  opencode: { id: "opencode", name: "opencode", mode: "on-demand", logo: null },
  vscode: { id: "vscode", name: "VS Code", mode: "on-demand", logo: null },
  goose: { id: "goose", name: "Goose", mode: "on-demand", logo: null },
  other: { id: "other", name: "Agent", mode: "on-demand", logo: null },
}

export function isAgentPlatformId(value: unknown): value is AgentPlatformId {
  return (
    typeof value === "string" &&
    (AGENT_PLATFORM_IDS as readonly string[]).includes(value)
  )
}

const CLIENT_PLATFORMS: Record<string, AgentPlatformId> = {
  "claude-code": "claude-code",
  "claude-desktop": "claude",
  claude: "claude",
  "chatgpt-desktop": "chatgpt",
  chatgpt: "chatgpt",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  vscode: "vscode",
  goose: "goose",
}

/** The platform of an always-on adapter, such as `openclaw` or `hermes`. */
export function platformForAdapter(adapter: string): AgentPlatformId {
  return isAgentPlatformId(adapter) &&
    AGENT_PLATFORMS[adapter].mode === "always-on"
    ? adapter
    : "other"
}

/** The platform of an MCP client id, such as `claude-code` or `codex`. */
export function platformForClient(
  clientId: string | null | undefined
): AgentPlatformId {
  return (clientId && CLIENT_PLATFORMS[clientId.toLowerCase()]) || "other"
}
