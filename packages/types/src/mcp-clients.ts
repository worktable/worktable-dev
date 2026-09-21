// MCP client registry + connection-config snippet generators.
//
// Single source of truth for "how does agent X connect to Worktable" — the
// CLI's `worktable mcp` adapters and the web Settings "Connect an agent" card
// both render from here. Pure data/functions only: no fs, env, or platform
// access (client config-file *paths* are resolved by the CLI, which layers
// env overrides and homedir on top of the hints below).

/**
 * Least-privilege resource scopes for agent connection tokens. Deliberately
 * not "*": a leaked agent bearer can read/write content but cannot mint
 * tokens or drive owner-only operations. Shared by the CLI's managed-config
 * token, the web connect card, and pairing-minted remote agent tokens so the
 * three surfaces can never drift.
 */
export const DEFAULT_AGENT_TOKEN_SCOPES: readonly string[] = [
  "documents:read",
  "documents:write",
  "docs:*",
  "widgets:*",
  "records:*",
  "annotations:*",
  "threads:read",
  "threads:write",
  // Agents need workspace discovery (worktable_discover).
  "search:read",
]

export const CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS = [
  "claude-code",
  "codex",
  "cursor",
  "opencode",
  "vscode",
] as const

export const MANUAL_MCP_CLIENT_IDS = ["goose"] as const
export const DESKTOP_EXTENSION_MCP_CLIENT_IDS = ["claude-desktop"] as const
export const MCP_SNIPPET_CLIENT_IDS = [
  ...CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS,
  ...MANUAL_MCP_CLIENT_IDS,
] as const

export const SUPPORTED_MCP_CLIENT_IDS = [
  ...CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS,
  ...MANUAL_MCP_CLIENT_IDS,
  ...DESKTOP_EXTENSION_MCP_CLIENT_IDS,
] as const

// Kept as an exported compatibility surface for callers that render a future
// roadmap. Every currently registered client now has a real supported path.
export const PLANNED_MCP_CLIENT_IDS = [] as const

export type ConnectorInstallableMcpClientId =
  (typeof CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS)[number]
export type ManualMcpClientId = (typeof MANUAL_MCP_CLIENT_IDS)[number]
export type DesktopExtensionMcpClientId =
  (typeof DESKTOP_EXTENSION_MCP_CLIENT_IDS)[number]
export type SupportedMcpClientId = (typeof SUPPORTED_MCP_CLIENT_IDS)[number]
export type PlannedMcpClientId = (typeof PLANNED_MCP_CLIENT_IDS)[number]
export type McpClientId = SupportedMcpClientId | PlannedMcpClientId
export type McpSnippetClientId = (typeof MCP_SNIPPET_CLIENT_IDS)[number]

export type McpClientMaturity = "supported" | "planned"
export type McpClientSetupKind = "connector" | "manual" | "desktop-extension"

export interface McpClientMeta {
  id: McpClientId
  label: string
  maturity: McpClientMaturity
  setupKind: McpClientSetupKind
  /** Where the snippet goes, for display ("~/.codex/config.toml"); null = a command, not a file. */
  configPathHint: string | null
}

export const SKILL_PROJECTION_TARGETS = {
  claude: {
    id: "claude",
    label: "Claude",
    physicalRoot: ".claude/skills",
  },
  agents: {
    id: "agents",
    label: "Other agents",
    physicalRoot: ".agents/skills",
  },
} as const

export type SkillProjectionTargetId = keyof typeof SKILL_PROJECTION_TARGETS

export const SKILL_PROJECTION_TARGET_IDS = Object.keys(
  SKILL_PROJECTION_TARGETS
) as SkillProjectionTargetId[]

export function isSkillProjectionTargetId(
  value: string
): value is SkillProjectionTargetId {
  return Object.hasOwn(SKILL_PROJECTION_TARGETS, value)
}

export const MCP_CLIENTS: Record<McpClientId, McpClientMeta> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    maturity: "supported",
    setupKind: "connector",
    configPathHint: null,
  },
  codex: {
    id: "codex",
    label: "ChatGPT / Codex",
    maturity: "supported",
    setupKind: "connector",
    configPathHint: "~/.codex/config.toml",
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    maturity: "supported",
    setupKind: "connector",
    configPathHint: "~/.cursor/mcp.json",
  },
  opencode: {
    id: "opencode",
    label: "opencode",
    maturity: "supported",
    setupKind: "connector",
    configPathHint: "~/.config/opencode/opencode.json",
  },
  vscode: {
    id: "vscode",
    label: "VS Code",
    maturity: "supported",
    setupKind: "connector",
    configPathHint: "mcp.json in the VS Code user profile",
  },
  goose: {
    id: "goose",
    label: "Goose",
    maturity: "supported",
    setupKind: "manual",
    configPathHint: "Goose extensions settings",
  },
  "claude-desktop": {
    id: "claude-desktop",
    label: "Claude Desktop",
    maturity: "supported",
    setupKind: "desktop-extension",
    configPathHint: null,
  },
}

export interface McpSnippetInput {
  /** Connectable MCP endpoint URL, e.g. http://127.0.0.1:7480/mcp */
  endpoint: string
  /** Bearer token to embed. Omit on loopback installs. */
  token?: string
  /**
   * Whether the install is bound reachable (non-loopback). Keyed off the bind
   * config, NOT the endpoint hostname: a reachable install binds 0.0.0.0 but
   * stores a connectable 127.0.0.1 endpoint, so the URL always looks loopback.
   */
  reachable?: boolean
}

export interface McpClientSnippet {
  id: McpSnippetClientId
  label: string
  language: "shell" | "toml" | "json"
  body: string
  configPathHint: string | null
  /**
   * Set when a usable snippet can't be emitted (reachable install, no token in
   * hand) — the body then carries guidance rather than pasteable config.
   */
  needsToken?: boolean
}

function bearerHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

function jsonBody(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/**
 * Render the connection config for one client. Bodies must stay byte-identical
 * to what `worktable mcp print-config` emits — golden tests pin this.
 */
export function mcpClientSnippet(
  id: McpSnippetClientId,
  input: McpSnippetInput
): McpClientSnippet {
  const meta = MCP_CLIENTS[id]
  const { endpoint, token, reachable } = input
  const base = {
    id,
    label: meta.label,
    configPathHint: meta.configPathHint,
  }

  // Goose is print-only (no config file the CLI can inject a token into), so a
  // reachable endpoint gets guidance instead of a snippet that would 401. Other
  // clients still emit their tokenless snippet — the CLI wrapper explains the
  // omitted bearer and how to inject it (`worktable mcp setup <client>`), and
  // the web card renders with a placeholder token instead of this body.
  if (id === "goose" && reachable && !token) {
    return {
      ...base,
      language: "shell",
      body: "# This Worktable endpoint requires a bearer token.\n# Run `worktable mcp print-config goose --with-token` to mint one and embed it.",
      needsToken: true,
    }
  }

  switch (id) {
    case "claude-code":
      // URL right after the name, --header last (claude's --header is variadic
      // and would otherwise eat a trailing URL).
      return {
        ...base,
        language: "shell",
        body: `claude mcp add --transport http worktable ${endpoint} --scope user${
          token ? ` --header "Authorization: Bearer ${token}"` : ""
        }`,
      }
    case "codex": {
      const header = token
        ? `http_headers = { Authorization = "Bearer ${token}" }\n`
        : ""
      return {
        ...base,
        language: "toml",
        body: `[mcp_servers.worktable]\nurl = "${endpoint}"\n${header}`.trimEnd(),
      }
    }
    case "cursor":
      return {
        ...base,
        language: "json",
        body: jsonBody({
          mcpServers: {
            worktable: {
              url: endpoint,
              ...(token ? { headers: bearerHeaders(token) } : {}),
            },
          },
        }),
      }
    case "opencode":
      return {
        ...base,
        language: "json",
        body: jsonBody({
          mcp: {
            worktable: {
              type: "remote",
              url: endpoint,
              enabled: true,
              ...(token ? { headers: bearerHeaders(token) } : {}),
            },
          },
        }),
      }
    case "vscode":
      return {
        ...base,
        language: "json",
        body: jsonBody({
          servers: {
            worktable: {
              type: "http",
              url: endpoint,
              ...(token ? { headers: bearerHeaders(token) } : {}),
            },
          },
        }),
      }
    case "goose":
      return {
        ...base,
        language: "json",
        body: jsonBody({
          name: "worktable",
          type: "remote",
          url: endpoint,
          enabled: true,
          ...(token ? { headers: bearerHeaders(token) } : {}),
        }),
      }
  }
}
