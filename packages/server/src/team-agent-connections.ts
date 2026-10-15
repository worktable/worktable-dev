import { APIError } from "better-auth/api"
import {
  accessFromScopes,
  clientIdForAgentLabel,
  isAgentPlatformId,
  scopesForAccess,
  type AgentAccess,
  type AgentConnection,
  type DirectAgentLabel,
} from "@worktable/types"
import { currentTeamWorktable, requireTeamDatabase } from "./team-database.ts"
import {
  bindTeamAgentCredential,
  createTeamAgent,
  currentRequestIdentity,
  listTeamAgents,
  requireTeamAgentAdministrator,
  requireTeamHuman,
  resolveTeamAgentCredential,
  teamMemberForIdentity,
  updateTeamAgent,
} from "./team-policy.ts"
import {
  createToken,
  listTokens,
  revokeToken,
  setTokenScopes,
} from "./token-store.ts"
import { participantsByKey, resolveParticipant } from "./participant-store.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { teamDatabasePath } from "./team-database.ts"
import { getWorkspaceRoot } from "./workspace.ts"

function credentialAgentId(key: string): string | null {
  const worktable = currentTeamWorktable()!
  return (
    requireTeamDatabase()
      .query<{ agent_id: string }, [string, string]>(
        `
    SELECT c.agent_id FROM wt_agent_credentials c JOIN wt_agents a ON a.id = c.agent_id
    WHERE c.credential_key = ? AND a.worktable_id = ? AND c.active = 1 AND a.active = 1
  `
      )
      .get(key, worktable.id)?.agent_id ?? null
  )
}

export async function listTeamAgentConnections(): Promise<AgentConnection[]> {
  const identity = currentRequestIdentity()
  // The management UI uses a human context. Internal name/delivery catalogs
  // read the same durable agents without inventing label-based identities.
  const db = requireTeamDatabase()
  const worktable = currentTeamWorktable()!
  const member = identity ? teamMemberForIdentity(identity) : null
  const allowed =
    identity?.principal.type === "human"
      ? new Set(listTeamAgents(identity).map((agent) => agent.id))
      : null
  const rows = db
    .query<
      {
        id: string
        actor_id: string
        participant_key: string
        name: string
        platform: string
        ownership: "personal" | "team"
        member_id: string | null
        owner_user_id: string | null
        active: number
        scope_ceiling: string | null
        space_ids: string | null
        mode: "on-demand" | "always-on"
        icon: string | null
      },
      [string]
    >(
      `SELECT a.*, e.user_id AS owner_user_id FROM wt_agents a
       LEFT JOIN wt_enrollments e ON e.id = a.member_id AND e.worktable_id = a.worktable_id
       WHERE a.worktable_id = ? ORDER BY a.name, a.id`
    )
    .all(worktable.id)
  const [tokens, participants] = await Promise.all([
    listTokens(),
    participantsByKey(),
  ])
  return rows
    .filter((row) =>
      row.active === 1
        ? !allowed || allowed.has(row.id)
        : Boolean(
            member &&
            row.ownership === "personal" &&
            row.owner_user_id === member.userId &&
            db
              .query(
                "SELECT credential_key FROM wt_agent_credentials WHERE agent_id = ? AND (credential_key LIKE 'oauth:%' OR credential_key LIKE 'workos-agent:%')"
              )
              .get(row.id)
          )
    )
    .map<AgentConnection>((row) => {
      const credentials = tokens.filter(
        (token) =>
          token.workspace === getWorkspaceRoot() &&
          !token.revokedAt &&
          credentialAgentId(token.principal.id) === row.id
      )
      const resource = db
        .query<
          { credential_key: string; active: number },
          [string]
        >("SELECT credential_key, active FROM wt_agent_credentials WHERE agent_id = ? AND (credential_key LIKE 'oauth:%' OR credential_key LIKE 'workos-agent:%') ORDER BY active DESC LIMIT 1")
        .get(row.id)
      const rawScopes = [
        ...new Set(credentials.flatMap((token) => token.scopes)),
      ]
      const scopes: string[] =
        row.scope_ceiling === null ? rawScopes : JSON.parse(row.scope_ceiling)
      return {
        id: row.id,
        displayName: row.name,
        platform: isAgentPlatformId(row.platform) ? row.platform : "other",
        icon: row.icon,
        ownership: row.ownership,
        memberId: row.member_id,
        spaceIds: row.space_ids === null ? null : JSON.parse(row.space_ids),
        canManage: Boolean(
          row.active === 1 &&
          member &&
          (row.ownership === "personal"
            ? row.member_id === member.id
            : member.role === "owner")
        ),
        authKind: resource
          ? resource.credential_key.startsWith("oauth:")
            ? "oauth"
            : "agent-registration"
          : "local-token",
        canReconnect: Boolean(
          resource &&
          (!resource.active || !row.active) &&
          row.ownership === "personal" &&
          row.owner_user_id === member?.userId
        ),
        access: accessFromScopes(scopes),
        target: {
          kind: "mcp-client",
          clientId: clientIdForAgentLabel(row.platform),
        },
        mode: row.mode,
        participant: participants.get(row.participant_key) ?? null,
        machine: null,
        scopes,
        connectedAt: credentials[0]?.createdAt ?? null,
        lastSeenAt: credentials.at(-1)?.lastUsedAt ?? null,
        permissionGroups: null,
      }
    })
}

export async function createTeamAgentConnection(input: {
  label: DirectAgentLabel
  displayName?: string
  icon?: string | null
  access: AgentAccess
}): Promise<{ token: string; connection: AgentConnection }> {
  const identity = currentRequestIdentity()!
  const member = requireTeamHuman(identity)
  const scopes = scopesForAccess(input.access)
  if (!scopes.length)
    throw new APIError("BAD_REQUEST", {
      message: "Choose at least one kind of access",
    })
  return withCrossProcessLock(
    `${teamDatabasePath()}.agent-connections.lock`,
    { label: "Agent connection" },
    async () => {
      const previous = listTeamAgents(identity).find(
        (agent) =>
          agent.active &&
          agent.ownership === "personal" &&
          agent.memberId === member.id &&
          agent.platform === input.label
      )
      const agent =
        previous ??
        createTeamAgent(
          {
            name: input.displayName ?? input.label,
            platform: input.label,
            ownership: "personal",
          },
          identity
        )
      let minted: Awaited<ReturnType<typeof createToken>> | undefined
      try {
        minted = await createToken({
          agent: input.label,
          scopes,
          user: member.userId,
        })
        bindTeamAgentCredential(
          agent.id,
          minted.metadata.principal.id,
          identity
        )
        updateTeamAgent(
          agent.id,
          {
            ...(input.displayName ? { name: input.displayName } : {}),
            ...(input.icon !== undefined ? { icon: input.icon } : {}),
            scopeCeiling: scopesForAccess(input.access),
          },
          identity
        )
        const resolved = resolveTeamAgentCredential(minted.metadata)!
        await resolveParticipant(resolved, {
          name: resolved.principal.displayName,
        })
        const connection = (await listTeamAgentConnections()).find(
          (item) => item.id === agent.id
        )!
        return { token: minted.token, connection }
      } catch (error) {
        if (minted) await revokeToken(minted.metadata.id)
        if (!previous) updateTeamAgent(agent.id, { active: false }, identity)
        throw error
      }
    }
  )
}

export async function updateTeamAgentConnection(
  id: string,
  changes: {
    displayName?: string
    icon?: string | null
    access?: AgentAccess
    spaceIds?: string[] | null
  }
): Promise<AgentConnection | null> {
  const identity = currentRequestIdentity()!
  requireTeamAgentAdministrator(id, identity)
  const tokens = (await listTokens()).filter(
    (token) =>
      token.workspace === getWorkspaceRoot() &&
      !token.revokedAt &&
      credentialAgentId(token.principal.id) === id
  )
  const previousScopes: Array<{ id: string; scopes: string[] }> = []
  let agent: ReturnType<typeof updateTeamAgent>
  try {
    if (changes.access)
      for (const token of tokens) {
        if (await setTokenScopes(token.id, scopesForAccess(changes.access)))
          previousScopes.push({ id: token.id, scopes: token.scopes })
      }
    agent = updateTeamAgent(
      id,
      {
        ...(changes.displayName ? { name: changes.displayName } : {}),
        ...(changes.icon !== undefined ? { icon: changes.icon } : {}),
        ...(changes.spaceIds !== undefined
          ? { spaceIds: changes.spaceIds }
          : {}),
        ...(changes.access
          ? { scopeCeiling: scopesForAccess(changes.access) }
          : {}),
      },
      identity
    )
  } catch (error) {
    for (const token of previousScopes)
      await setTokenScopes(token.id, token.scopes).catch(() => false)
    throw error
  }
  if (changes.displayName) {
    const binding = requireTeamDatabase()
      .query<
        { participant_key: string },
        [string]
      >("SELECT participant_key FROM wt_agents WHERE id = ?")
      .get(agent.id)!
    await resolveParticipant(
      {
        agent: agent.platform,
        principal: {
          id: agent.actorId,
          type: "agent",
          displayName: agent.name,
          participantKey: binding.participant_key,
        },
      },
      { name: agent.name }
    )
  }
  return (
    (await listTeamAgentConnections()).find((item) => item.id === id) ?? null
  )
}

export function disconnectTeamAgentConnection(id: string): boolean {
  updateTeamAgent(id, { active: false }, currentRequestIdentity()!)
  return true
}
