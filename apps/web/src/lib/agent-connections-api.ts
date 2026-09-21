import type { AgentConnectionInventory } from "@worktable/types"
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
