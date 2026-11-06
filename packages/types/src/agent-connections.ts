import {
  isAgentPlatformId,
  platformForAdapter,
  platformForClient,
  platformForName,
  type AgentPlatformId,
} from "./agent-platforms"
import type { ParticipantRef } from "./threads"
import type { GrokBotCandidate, GrokBotConnection } from "./grok-bot"

export type AgentConnectionTarget =
  | { kind: "mcp-client"; clientId: string | null }
  | {
      kind: "agent-adapter"
      adapter: string
      installationId: string
      /** Stable participant name reported by the adapter, independent of an owner label. */
      participantName?: string
    }

export type AgentConnectionAuthKind =
  | "local-token"
  | "oauth"
  | "agent-registration"

export type AgentPermissionGroup =
  | "workspace-read"
  | "workspace-write"
  | "conversations"
  | "export"

/**
 * Scopes each access group grants. Read includes export: an agent that can read everything can already copy it.
 *
 * Agents hold groups, and every Worktable expands them with this table on each
 * request, so a scope added here reaches every connected agent with the group.
 * Add a scope to a group only when it fits what the group's checkbox promises.
 * A new kind of authority gets a new group, which no existing agent has until
 * someone turns it on. `agent-connections.test.ts` pins this table.
 */
export const AGENT_PERMISSION_GROUP_SCOPES: Record<
  AgentPermissionGroup,
  readonly string[]
> = {
  conversations: ["threads:read", "threads:write", "threads:participate"],
  "workspace-read": [
    "annotations:read",
    "documents:read",
    "docs:read",
    "records:read",
    "search:read",
    "widgets:read",
  ],
  "workspace-write": [
    "annotations:read",
    "annotations:write",
    "documents:read",
    "documents:write",
    "docs:read",
    "docs:write",
    "records:read",
    "records:write",
    "search:read",
    "widgets:read",
    "widgets:write",
  ],
  export: ["workspace:export"],
}

/** What an agent may do, as the owner chooses it: the three access checkboxes. */
export interface AgentAccess {
  threads: boolean
  read: boolean
  edit: boolean
}

export const DEFAULT_AGENT_ACCESS: AgentAccess = {
  threads: true,
  read: true,
  edit: true,
}

export function permissionGroupsForAccess(
  access: AgentAccess
): AgentPermissionGroup[] {
  const groups: AgentPermissionGroup[] = []
  if (access.threads) groups.push("conversations")
  if (access.read || access.edit) groups.push("workspace-read", "export")
  if (access.edit) groups.push("workspace-write")
  return groups
}

type PermissionGroupTable = Readonly<
  Record<AgentPermissionGroup, readonly string[]>
>

/**
 * The table as it stood before each change, newest first. When a scope joins a
 * group, add the table from before the change here: access stored as a scope
 * list is then still recognized as the access it was made from.
 */
const EARLIER_AGENT_PERMISSION_GROUP_SCOPES: readonly PermissionGroupTable[] = [
  // Before 28 Aug 2026, when documents:* joined the read and edit groups.
  {
    conversations: ["threads:read", "threads:write", "threads:participate"],
    "workspace-read": [
      "annotations:read",
      "docs:read",
      "records:read",
      "search:read",
      "widgets:read",
    ],
    "workspace-write": [
      "annotations:read",
      "annotations:write",
      "docs:read",
      "docs:write",
      "records:read",
      "records:write",
      "search:read",
      "widgets:read",
      "widgets:write",
    ],
    export: ["workspace:export"],
  },
]

function scopesForAccessIn(
  table: PermissionGroupTable,
  access: AgentAccess
): string[] {
  return [
    ...new Set(
      permissionGroupsForAccess(access).flatMap((group) => table[group])
    ),
  ]
}

export function scopesForAccess(access: AgentAccess): string[] {
  return scopesForAccessIn(AGENT_PERMISSION_GROUP_SCOPES, access)
}

/** The access checkbox that grants a scope, or null for a scope no access grants. */
export function accessForScope(scope: string): keyof AgentAccess | null {
  if (AGENT_PERMISSION_GROUP_SCOPES.conversations.includes(scope))
    return "threads"
  if (
    AGENT_PERMISSION_GROUP_SCOPES["workspace-read"].includes(scope) ||
    AGENT_PERMISSION_GROUP_SCOPES.export.includes(scope)
  )
    return "read"
  if (AGENT_PERMISSION_GROUP_SCOPES["workspace-write"].includes(scope))
    return "edit"
  return null
}

/** Every access an owner can choose that grants anything. */
const ACCESS_CHOICES: readonly AgentAccess[] = [false, true].flatMap(
  (threads) =>
    [
      { read: false, edit: false },
      { read: true, edit: false },
      { read: true, edit: true },
    ]
      .map((choice) => ({ threads, ...choice }))
      .filter((access) => access.threads || access.read)
)

function sameScopes(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a)
  const right = new Set(b)
  return left.size === right.size && [...left].every((scope) => right.has(scope))
}

/**
 * The access a stored scope list was made from: the list is exactly what one
 * choice of access granted under this table or an earlier one. Null for any
 * other list, such as a token minted with chosen scopes.
 */
export function accessForStoredScopes(
  scopes: readonly string[]
): AgentAccess | null {
  for (const table of [
    AGENT_PERMISSION_GROUP_SCOPES,
    ...EARLIER_AGENT_PERMISSION_GROUP_SCOPES,
  ])
    for (const access of ACCESS_CHOICES)
      if (sameScopes(scopes, scopesForAccessIn(table, access))) return access
  return null
}

/**
 * What a stored scope list grants now. A list made from a choice of access
 * grants that access as the table defines it today, so a scope added to a
 * group reaches agents connected before it. Any other list grants exactly
 * what it names.
 */
export function currentScopesForStored(scopes: readonly string[]): string[] {
  const access = accessForStoredScopes(scopes)
  return access ? scopesForAccess(access) : [...scopes]
}

function grants(scopes: readonly string[], required: string): boolean {
  const [resource] = required.split(":")
  return scopes.some(
    (scope) => scope === "*" || scope === required || scope === `${resource}:*`
  )
}

/** The access a credential's scopes amount to. A group counts only when every scope in it is granted. */
export function accessFromScopes(scopes: readonly string[]): AgentAccess {
  const has = (group: AgentPermissionGroup) =>
    AGENT_PERMISSION_GROUP_SCOPES[group].every((scope) => grants(scopes, scope))
  const edit = has("workspace-write")
  return {
    // Reading and replying is what the checkbox promises; claiming deliveries
    // (threads:participate) comes with it when the owner grants it again.
    threads: grants(scopes, "threads:read") && grants(scopes, "threads:write"),
    read: edit || has("workspace-read"),
    edit,
  }
}

/**
 * Whether an agent answers what's sent to it on its own. `kind` is how its app
 * does it: a chat that watches Worktable, a session waiting for it, an
 * agent Worktable calls, or a cloud task Worktable fires. Absent when the
 * agent picks things up only the next time someone uses it.
 */
export interface AutoReply {
  kind: "chat" | "session" | "called" | "task"
  state: "on" | "off" | "attention"
  /** What a watching chat covers; absent means every Space. */
  spaceIds?: string[]
  /** A task's test fire is out, waiting for the agent to check in. */
  testing?: boolean
  /** What needs attention, in a line for the owner. */
  error?: string
}

export interface AgentConnection {
  ownership?: "personal" | "team"
  memberId?: string | null
  /** null follows current and future member Space access; an array narrows it. */
  spaceIds?: string[] | null
  canManage?: boolean
  canReconnect?: boolean
  id: string
  authKind: AgentConnectionAuthKind
  /** The agent's name, which is also its name in threads. The owner can change it. */
  displayName: string
  platform: AgentPlatformId
  /** A Lucide icon name chosen by the owner, or null for the platform's logo. */
  icon: string | null
  /** Null when the owner cannot change this agent's access here. */
  access: AgentAccess | null
  target: AgentConnectionTarget
  mode: "on-demand" | "always-on"
  participant: ParticipantRef | null
  machine: string | null
  scopes: string[]
  /**
   * OAuth grants can be inventoried before their first successful MCP call.
   * WorkOS does not expose the grant timestamp, so this is null until the
   * gateway records first use.
   */
  connectedAt: string | null
  lastSeenAt: string | null
  /**
   * Null means the provider owns the grant shape (local tokens and today's
   * OAuth clients). Hosted managed agents expose editable permission groups.
   */
  permissionGroups: AgentPermissionGroup[] | null
  /**
   * An app that reaches this Worktable through Worktable Link. Cloud holds
   * its sign-in and access, and manages it at `manageUrl`.
   */
  link?: { manageUrl: string }
  autoReply?: AutoReply
}

export interface AgentConnectionInventory {
  connections: AgentConnection[]
  grokBots?: GrokBotConnection[]
  grokBotCandidates?: GrokBotCandidate[]
  /** OAuth resource for the Grok connector, including a Worktable Link resource. */
  grokBotMcpUrl?: string | null
  /**
   * Provider inventories that could not be loaded. Connections from other
   * auth kinds remain complete and actionable.
   */
  unavailableAuthKinds?: AgentConnectionAuthKind[]
}

/**
 * The platform an agent is. A client id that names an app decides: a label
 * made here, or a vendor's signed client metadata URL. Otherwise the recorded
 * platform, else the name, which is all some sign-ins carry.
 */
export function agentConnectionPlatform(
  connection: Pick<AgentConnection, "platform" | "target" | "displayName">
): AgentPlatformId {
  const fromClient =
    connection.target.kind === "mcp-client"
      ? platformForClient(connection.target.clientId)
      : "other"
  if (fromClient !== "other") return fromClient
  if (isAgentPlatformId(connection.platform) && connection.platform !== "other")
    return connection.platform
  if (connection.target.kind === "agent-adapter")
    return platformForAdapter(connection.target.adapter)
  return platformForName(connection.displayName)
}

/**
 * Whether an agent connects from a Codex host: Codex CLI, or ChatGPT Desktop's
 * own MCP servers, which run on Codex. These connect without MCP Events, so
 * they answer only while a chat keeps waiting.
 */
export function agentConnectionOnCodexHost(
  connection: Pick<AgentConnection, "platform" | "target" | "displayName">
): boolean {
  const platform = agentConnectionPlatform(connection)
  return platform === "codex" || platform === "chatgpt-desktop"
}
