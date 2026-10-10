import {
  isAgentPlatformId,
  platformForAdapter,
  platformForClient,
  platformForName,
  type AgentAccess,
  type AgentConnection,
  type AgentPlatformId,
  type AgentConnectionInventory,
} from "@worktable/types"
import { fetchJSON } from "./http"

/**
 * Every agent connected to this Worktable. On Cloud, sign-ins such as Claude
 * and ChatGPT come from the gateway, and agents paired with the workspace from
 * the workspace itself (`scope=workspace`), so the two lists are merged.
 */
export async function listAgentConnections(
  options: { workspaceAgentsOnCloud?: boolean } = {}
): Promise<AgentConnectionInventory> {
  if (!options.workspaceAgentsOnCloud) {
    return fetchJSON("/api/agent-connections")
  }
  const [signIns, paired] = await Promise.all([
    fetchJSON<AgentConnectionInventory>("/api/agent-connections"),
    fetchJSON<AgentConnectionInventory>(
      "/api/agent-connections?scope=workspace"
    ).catch(() => null),
  ])
  return {
    connections: [...(paired?.connections ?? []), ...signIns.connections],
    unavailableAuthKinds: [
      ...(signIns.unavailableAuthKinds ?? []),
      ...(paired ? [] : (["local-token"] as const)),
    ],
  }
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

/** On Cloud, how a sign-in agent such as Claude or ChatGPT appears in threads. */
export function updateSignInAgent(
  clientId: string,
  changes: {
    displayName?: string
    icon?: string | null
    platform?: AgentPlatformId
    threads?: boolean
  }
): Promise<{ ok: true }> {
  return fetchJSON(
    `/api/agent-connections/sign-ins/${encodeURIComponent(clientId)}`,
    { method: "PUT", body: JSON.stringify(changes) }
  )
}

/** The platform an agent is shown with: recorded, else inferred. */
export function agentConnectionPlatform(
  connection: AgentConnection
): AgentPlatformId {
  if (isAgentPlatformId(connection.platform)) return connection.platform
  if (connection.target.kind === "agent-adapter") {
    return platformForAdapter(connection.target.adapter)
  }
  const fromClient = platformForClient(connection.target.clientId)
  // Cloud's sign-ins carry an opaque client id, so their name decides.
  return fromClient === "other"
    ? platformForName(connection.displayName)
    : fromClient
}
