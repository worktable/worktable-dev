import type {
  AgentAccess,
  AgentConnection,
  AgentConnectionInventory,
} from "@worktable/types"
import { fetchJSON } from "./http"

export function listAgentConnections(): Promise<AgentConnectionInventory> {
  return fetchJSON("/api/agent-connections")
}

export function disconnectAgentConnection(
  connectionId: string
): Promise<{ ok: true }> {
  return fetchJSON(
    `/api/agent-connections/${encodeURIComponent(connectionId)}`,
    { method: "DELETE" }
  )
}

export function renameAgentConnection(
  connectionId: string,
  displayName: string
): Promise<{ ok: true }> {
  return fetchJSON(
    `/api/agent-connections/${encodeURIComponent(connectionId)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ displayName }),
    }
  )
}

/** The owner's changes to an agent: its name, its icon (null for its platform's logo), and its access. */
export function updateAgentConnection(
  connectionId: string,
  changes: {
    displayName?: string
    icon?: string | null
    access?: AgentAccess
  }
): Promise<{ ok: true; connection: AgentConnection }> {
  return fetchJSON(
    `/api/agent-connections/${encodeURIComponent(connectionId)}`,
    { method: "PATCH", body: JSON.stringify(changes) }
  )
}
