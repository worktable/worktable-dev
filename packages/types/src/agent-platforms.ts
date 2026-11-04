import { MCP_SNIPPET_CLIENT_IDS } from "./mcp-clients"

// The platforms a connected agent can come from. One list for the server,
// the web app, and Cloud, so names, logos, and always-on behavior agree.

export const AGENT_PLATFORM_IDS = [
  "openclaw",
  "hermes",
  "grok-bot",
  "chatgpt",
  "chatgpt-desktop",
  "claude",
  "claude-desktop",
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
  "grok-bot": {
    id: "grok-bot",
    name: "Grok Bot",
    mode: "always-on",
    logo: "grok-bot.svg",
  },
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
  // The desktop app's own MCP servers, which it shares with Codex CLI. In the
  // app with Cloud selected, ChatGPT uses the account's apps, so it is ChatGPT.
  "chatgpt-desktop": {
    id: "chatgpt-desktop",
    name: "ChatGPT Desktop",
    mode: "on-demand",
    logo: "openai.svg",
  },
  claude: {
    id: "claude",
    name: "Claude",
    mode: "on-demand",
    logo: "claude.svg",
  },
  // Claude Desktop's local extension; its connectors are Claude's.
  "claude-desktop": {
    id: "claude-desktop",
    name: "Claude Desktop",
    mode: "on-demand",
    logo: "claude.svg",
  },
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    mode: "on-demand",
    logo: "claude-code.svg",
  },
  codex: {
    id: "codex",
    name: "Codex CLI",
    mode: "on-demand",
    logo: "openai.svg",
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    mode: "on-demand",
    logo: "cursor.svg",
  },
  opencode: {
    id: "opencode",
    name: "opencode",
    mode: "on-demand",
    logo: "opencode.svg",
  },
  vscode: {
    id: "vscode",
    name: "VS Code",
    mode: "on-demand",
    logo: "vscode.svg",
  },
  goose: { id: "goose", name: "Goose", mode: "on-demand", logo: "goose.png" },
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
  "claude-desktop": "claude-desktop",
  claude: "claude",
  "chatgpt-desktop": "chatgpt-desktop",
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

/**
 * The platform of an MCP client id: a label such as `claude-code` or `codex`,
 * or a vendor's signed client metadata URL.
 */
export function platformForClient(
  clientId: string | null | undefined
): AgentPlatformId {
  return (
    clientPlatform(clientId?.toLowerCase()) ??
    platformForClientMetadata(clientId) ??
    "other"
  )
}

/**
 * Apps that sign in with a client metadata document on their maker's domain.
 * The authorization server fetches that document and signs its URL as the
 * client id, so these ids say which app it is; names can say anything.
 * The desktop app's MCP servers sign in through Codex, as Codex CLI does.
 */
const CLIENT_METADATA: readonly {
  origin: string
  path: string
  platform: AgentPlatformId
}[] = [
  {
    origin: "https://chatgpt.com",
    path: "/oauth/codex/",
    platform: "chatgpt-desktop",
  },
  { origin: "https://chatgpt.com", path: "/oauth/", platform: "chatgpt" },
  {
    origin: "https://claude.ai",
    path: "/oauth/claude-code-client-metadata",
    platform: "claude-code",
  },
  {
    origin: "https://claude.ai",
    path: "/oauth/mcp-oauth-client-metadata",
    platform: "claude",
  },
  {
    origin: "https://nousresearch.github.io",
    path: "/hermes-agent/",
    platform: "hermes",
  },
]

function platformForClientMetadata(
  clientId: string | null | undefined
): AgentPlatformId | null {
  if (!clientId?.startsWith("https://")) return null
  let url: URL
  try {
    url = new URL(clientId)
  } catch {
    return null
  }
  return (
    CLIENT_METADATA.find(
      (entry) =>
        url.origin === entry.origin && url.pathname.startsWith(entry.path)
    )?.platform ?? null
  )
}

/**
 * What a Cloud or Worktable Link sign-in is called until its owner renames it:
 * its app's name when its signed client id says which app it is, else the
 * name the client gave itself.
 */
export function signInAgentName(principalId: string, clientName: string) {
  const platform = platformForClient(clientIdForSignInPrincipal(principalId))
  return platform === "other" ? clientName : AGENT_PLATFORMS[platform].name
}

/**
 * The client id inside a Cloud or Worktable Link sign-in's principal,
 * `oauth:<client id>:<account>`. Null for any other principal.
 */
export function clientIdForSignInPrincipal(principalId: string): string | null {
  if (!principalId.startsWith("oauth:")) return null
  const rest = principalId.slice("oauth:".length)
  const end = rest.lastIndexOf(":")
  return end > 0 ? rest.slice(0, end) : null
}

/** Own entries only: a client named like `constructor` is no platform. */
function clientPlatform(
  client: string | null | undefined
): AgentPlatformId | null {
  return client && Object.hasOwn(CLIENT_PLATFORMS, client)
    ? CLIENT_PLATFORMS[client]!
    : null
}

/**
 * Apps connected with a credential made in Worktable rather than by pairing.
 * The label is the agent: connecting the same app again is the same agent.
 */
export const DIRECT_AGENT_LABELS = [
  "claude-desktop",
  "chatgpt-desktop",
  ...MCP_SNIPPET_CLIENT_IDS,
] as const
export type DirectAgentLabel = (typeof DIRECT_AGENT_LABELS)[number]

export function isDirectAgentLabel(value: unknown): value is DirectAgentLabel {
  return (
    typeof value === "string" &&
    (DIRECT_AGENT_LABELS as readonly string[]).includes(value)
  )
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
