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
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT",
    mode: "on-demand",
    logo: "openai.svg",
  },
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
  codex: { id: "codex", name: "Codex", mode: "on-demand", logo: "openai.svg" },
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
  return clientPlatform(clientId?.toLowerCase()) ?? "other"
}

/** Own entries only: a client named like `constructor` is no platform. */
function clientPlatform(
  client: string | null | undefined
): AgentPlatformId | null {
  return client && Object.hasOwn(CLIENT_PLATFORMS, client)
    ? CLIENT_PLATFORMS[client]!
    : null
}

/** The token label `worktable mcp setup` shares among one computer's agents. */
export const SHARED_LOCAL_AGENT_LABEL = "managed"

/**
 * The MCP client an agent token's label names: `codex`, `manual-codex`,
 * `managed:codex`, or `codex@laptop`. Null for any other label.
 */
export function clientIdForAgentLabel(label: string | null): string | null {
  if (!label) return null
  const client = label
    .replace(/^managed:/, "")
    .replace(/^manual-/, "")
    .replace(/@.*$/, "")
    .toLowerCase()
  return clientPlatform(client) ? client : null
}

/** A readable default name for an agent known only by its token label. */
export function defaultAgentNameForLabel(label: string | null): string | null {
  if (!label) return null
  if (label === SHARED_LOCAL_AGENT_LABEL) return "Local agents"
  const client = clientIdForAgentLabel(label)
  return client ? AGENT_PLATFORMS[platformForClient(client)].name : null
}

/**
 * The platform an app's name points to, for sign-ins that carry only a name
 * (Worktable Cloud's OAuth apps: "Claude", "ChatGPT", "Claude Code").
 */
export function platformForName(
  name: string | null | undefined
): AgentPlatformId {
  if (!name) return "other"
  const slug = name.trim().toLowerCase().replace(/\s+/g, "-")
  const client = clientPlatform(slug)
  if (client) return client
  // "Hermes Agent", "OpenClaw Studio": a platform's id followed by more words.
  return (
    AGENT_PLATFORM_IDS.find(
      (id) => id !== "other" && (slug === id || slug.startsWith(`${id}-`))
    ) ?? "other"
  )
}
