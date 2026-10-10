import type { AgentPlatformId } from "./agent-platforms"
import type { ParticipantRef } from "./threads"

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

/** Scopes each access group grants. Read includes export: an agent that can read everything can already copy it. */
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

export function scopesForAccess(access: AgentAccess): string[] {
  return [
    ...new Set(
      permissionGroupsForAccess(access).flatMap(
        (group) => AGENT_PERMISSION_GROUP_SCOPES[group]
      )
    ),
  ]
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

export interface AgentConnection {
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
}

export interface AgentConnectionInventory {
  connections: AgentConnection[]
  /**
   * Provider inventories that could not be loaded. Connections from other
   * auth kinds remain complete and actionable.
   */
  unavailableAuthKinds?: AgentConnectionAuthKind[]
}
