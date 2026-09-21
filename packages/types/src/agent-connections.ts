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

export interface AgentConnection {
  id: string
  authKind: AgentConnectionAuthKind
  displayName: string
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
