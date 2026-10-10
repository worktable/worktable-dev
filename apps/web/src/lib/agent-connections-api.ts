import {
  isAgentPlatformId,
  platformForAdapter,
  platformForClient,
  platformForName,
  type AgentAccess,
  type AgentConnection,
  type DirectAgentLabel,
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

/** The agent an app already is here, if it was connected before. */
export function getAppAgent(
  label: DirectAgentLabel
): Promise<{ connection: AgentConnection | null }> {
  return fetchJSON(`/api/agent-connections/apps/${encodeURIComponent(label)}`)
}

/**
 * Connect an app with a credential made here, named and with the access its
 * owner chose. The token is returned once.
 */
export function connectAgentApp(input: {
  client: DirectAgentLabel
  displayName?: string
  icon?: string | null
  access: AgentAccess
}): Promise<{ token: string; connection: AgentConnection }> {
  return fetchJSON("/api/agent-connections", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

function sameAccess(a: AgentAccess | null, b: AgentAccess | null): boolean {
  return a?.threads === b?.threads && a?.read === b?.read && a?.edit === b?.edit
}

/**
 * Save an owner's changes to an agent. A sign-in agent on Cloud also appears
 * in this workspace's threads: its name and icon go there first, so if Cloud
 * then fails, saving again completes both, and its Threads access only once
 * Cloud has accepted it, so a refused change never hides an agent that can
 * still take part.
 */
export async function saveAgentChanges(
  connection: AgentConnection,
  changes: { name: string; icon: string | null; access: AgentAccess | null }
): Promise<void> {
  const name = changes.name.trim()
  const renamed = name !== connection.displayName
  const iconChanged = changes.icon !== (connection.icon ?? null)
  const shownPlatform = agentConnectionPlatform(connection)
  const signInClient =
    connection.authKind === "oauth" && connection.target.kind === "mcp-client"
      ? connection.target.clientId
      : null
  if (signInClient) {
    await updateSignInAgent(signInClient, {
      displayName: name,
      icon: changes.icon,
      // Never record "other" over a platform the workspace already knows.
      platform: shownPlatform === "other" ? undefined : shownPlatform,
    })
  }
  // A connection reports access only where it can be changed.
  const accessChanged =
    changes.access !== null &&
    connection.access != null &&
    !sameAccess(changes.access, connection.access)
  if (renamed || iconChanged || accessChanged) {
    await updateAgentConnection(connection.id, {
      ...(renamed ? { displayName: name } : {}),
      ...(iconChanged ? { icon: changes.icon } : {}),
      ...(accessChanged && changes.access ? { access: changes.access } : {}),
    })
  }
  if (signInClient) {
    await updateSignInAgent(signInClient, {
      threads: (changes.access ?? connection.access)?.threads ?? true,
    })
  }
}
