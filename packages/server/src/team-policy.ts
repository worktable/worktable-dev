import { workspaceCacheKey } from "./workspace.ts"
import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import type {
  SpaceAccessGrant,
  SpaceAccessLevel,
  SpaceAccessPolicy,
  TeamAgent,
  TeamMember,
  WorktableThreadAccess,
} from "@worktable/types"
import { hasScope, type TokenIdentity } from "./token-store.ts"
import {
  advanceTeamPolicy,
  currentTeamWorktable,
  requireTeamDatabase,
  openTeamDatabase,
  TeamStateError,
  teamRequestMemo,
} from "./team-database.ts"
import { findTeamMemberById } from "./team-members.ts"
import {
  accessSnapshot,
  grantedLevel,
  levelAtLeast,
  memberLevel,
  spaceInventory,
} from "./team-access.ts"

export class TeamAccessError extends Error {
  readonly code: string
  constructor(
    message = "You do not have access to this resource",
    code = "FORBIDDEN"
  ) {
    super(message)
    this.name = "TeamAccessError"
    this.code = code
  }
}

const requestIdentity = new AsyncLocalStorage<TokenIdentity>()
const levels: Record<SpaceAccessLevel, number> = { read: 1, edit: 2, manage: 3 }

export function runWithTeamIdentity<T>(
  identity: TokenIdentity,
  action: () => T
): T {
  return requestIdentity.run(identity, action)
}

/** Used only by trusted catalog/background work; outgoing results still require policy. */
export function runWithoutTeamIdentity<T>(action: () => T): T {
  return requestIdentity.exit(action)
}

export function currentRequestIdentity(): TokenIdentity | undefined {
  return requestIdentity.getStore()
}

interface SessionRow {
  userId: string
  expiresAt: number | string
}

function sessionMemoKey(sessionId: string): string {
  return `session:${sessionId}`
}

/** The session Better Auth just verified stands for the rest of this request. */
export function noteVerifiedTeamSession(
  sessionId: string,
  userId: string,
  expiresAt: Date
): void {
  teamRequestMemo<SessionRow | null>(sessionMemoKey(sessionId), () => ({
    userId,
    expiresAt: expiresAt.getTime(),
  }))
}

export function teamMemberForIdentity(
  identity: TokenIdentity
): TeamMember | null {
  const worktable = currentTeamWorktable()
  if (
    !worktable ||
    identity.team?.worktableId !== worktable.id ||
    identity.principal.type !== "human" ||
    !identity.team.memberId
  )
    return null
  if (identity.sessionId) {
    const sessionId = identity.sessionId
    // Sign-out removes the row without moving the policy revision, so the
    // session is read directly: once per request, or per turn on sockets.
    const session = teamRequestMemo(sessionMemoKey(sessionId), () =>
      requireTeamDatabase()
        .query<SessionRow, [string]>(
          "SELECT userId, expiresAt FROM session WHERE id = ?"
        )
        .get(sessionId)
    )
    const expiresAt = session
      ? typeof session.expiresAt === "number"
        ? session.expiresAt
        : Date.parse(session.expiresAt)
      : 0
    if (
      !session ||
      session.userId !== identity.team.userId ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= Date.now()
    )
      return null
  }
  const member = findTeamMemberById(identity.team.memberId)
  return member &&
    member.userId === identity.team.userId &&
    member.actorId === identity.principal.id
    ? member
    : null
}

interface AgentRow {
  id: string
  actor_id: string
  participant_key: string
  name: string
  platform: string
  ownership: "personal" | "team"
  member_id: string | null
  space_ids: string | null
  mode: "on-demand" | "always-on"
  active: number
  scope_ceiling: string | null
  icon: string | null
  worktable_threads: WorktableThreadAccess
}

function parseAgent(row: AgentRow): TeamAgent {
  let spaceIds: string[] | null = null
  if (row.space_ids !== null) {
    const value: unknown = JSON.parse(row.space_ids)
    if (!Array.isArray(value) || value.some((id) => typeof id !== "string"))
      throw new TeamAccessError()
    spaceIds = value
  }
  return {
    id: row.id,
    actorId: row.actor_id,
    name: row.name,
    platform: row.platform,
    ownership: row.ownership,
    memberId: row.member_id,
    spaceIds,
    active: row.active === 1,
    mode: row.mode,
    scopeCeiling:
      row.scope_ceiling === null ? null : JSON.parse(row.scope_ceiling),
    icon: row.icon,
    worktableThreads: row.worktable_threads ?? "none",
  }
}

export function teamAgentForIdentity(
  identity: TokenIdentity
): TeamAgent | null {
  const worktable = currentTeamWorktable()
  if (
    !worktable ||
    identity.principal.type !== "agent" ||
    identity.team?.worktableId !== worktable.id ||
    !identity.team.agentId
  )
    return null
  const current = accessSnapshot()!
  const row = current.agents.get(identity.team.agentId)
  if (!row || row.active !== 1 || row.actor_id !== identity.principal.id)
    return null
  if (!identity.team.credentialKey) return null
  const credential = current.credentials.get(identity.team.credentialKey)
  if (
    !credential ||
    !credential.active ||
    credential.agentId !== identity.team.agentId ||
    (credential.sponsorMemberId &&
      !current.members.has(credential.sponsorMemberId)) ||
    (credential.minimumIssuedAt > 0 &&
      (identity.credentialIssuedAt ?? 0) < credential.minimumIssuedAt)
  )
    return null
  const agent = parseAgent(row)
  if (
    agent.scopeCeiling !== null &&
    identity.scopes.some((scope) => !hasScope(agent.scopeCeiling!, scope))
  )
    return null
  if (
    agent.ownership === "personal" &&
    (!agent.memberId || !findTeamMemberById(agent.memberId))
  )
    return null
  return agent
}

export function assertCurrentTeamIdentity(identity: TokenIdentity): void {
  if (!currentTeamWorktable() || identity.operatorVerification) return
  if (
    identity.credentialExpiresAt !== undefined &&
    identity.credentialExpiresAt <= Date.now()
  )
    throw new TeamAccessError("The connection has expired")
  if (!teamMemberForIdentity(identity) && !teamAgentForIdentity(identity))
    throw new TeamAccessError("Worktable membership is required")
}

export function requireTeamHuman(identity: TokenIdentity): TeamMember {
  const member = teamMemberForIdentity(identity)
  if (!member)
    throw new TeamAccessError("A human member must perform this action")
  return member
}

export function requireTeamOwner(identity: TokenIdentity): TeamMember {
  const member = requireTeamHuman(identity)
  if (member.role !== "owner")
    throw new TeamAccessError("A Worktable owner must perform this action")
  return member
}

function subjectGrant(
  spaceId: string,
  subjectType: "member" | "agent",
  subjectId: string
): SpaceAccessLevel | null {
  return grantedLevel(accessSnapshot()!, spaceId, subjectType, subjectId)
}

function memberHasSpaceAccess(
  member: TeamMember,
  spaceId: string,
  access: SpaceAccessLevel
): boolean {
  if (member.role === "owner") return true
  return levelAtLeast(memberLevel(accessSnapshot()!, member, spaceId), access)
}

/** With no external request context, filesystem/catalog work remains trusted internal work. */
export function canAccessSpace(
  spaceId: string,
  access: SpaceAccessLevel = "read",
  identity = currentRequestIdentity()
): boolean {
  if (!currentTeamWorktable() || !identity) return true
  if (
    !spaceId ||
    spaceId === "." ||
    spaceId === ".." ||
    /[\\/\0]/.test(spaceId)
  )
    return false
  if (identity.operatorVerification) return access === "read"
  const member = teamMemberForIdentity(identity)
  if (member) return memberHasSpaceAccess(member, spaceId, access)
  const agent = teamAgentForIdentity(identity)
  if (!agent || access === "manage") return false
  return teamAgentHasSpaceAccess(agent, spaceId, access)
}

/** Catalog eligibility uses the same grants; requests additionally require a live credential. */
export function teamAgentHasSpaceAccess(
  agent: Pick<TeamAgent, "id" | "ownership" | "memberId" | "spaceIds">,
  spaceId: string,
  access: "read" | "edit"
): boolean {
  if (agent.ownership === "personal") {
    if (agent.spaceIds !== null && !agent.spaceIds.includes(spaceId))
      return false
    const owner = agent.memberId ? findTeamMemberById(agent.memberId) : null
    return owner !== null && memberHasSpaceAccess(owner, spaceId, access)
  }
  const granted = subjectGrant(spaceId, "agent", agent.id)
  return granted !== null && levels[granted] >= levels[access]
}

/** A personal agent follows its member unless narrowed to some Spaces. */
export function agentWorktableThreadAccess(
  agent: Pick<TeamAgent, "ownership" | "spaceIds" | "worktableThreads">
): WorktableThreadAccess {
  if (agent.ownership === "personal")
    return agent.spaceIds === null ? "edit" : "none"
  return agent.worktableThreads
}

/** Threads outside every Space: all members, and agents granted them. */
export function canAccessWorktableThreads(
  access: "read" | "edit" = "read",
  identity = currentRequestIdentity()
): boolean {
  if (!currentTeamWorktable() || !identity) return true
  if (identity.operatorVerification) return access === "read"
  if (teamMemberForIdentity(identity)) return true
  const agent = teamAgentForIdentity(identity)
  if (!agent) return false
  const level = agentWorktableThreadAccess(agent)
  return level !== "none" && levels[level] >= levels[access]
}

/** Spaces this identity may read, or null when it may read every Space. */
export function readableSpaceIds(
  identity = currentRequestIdentity()
): string[] | null {
  if (!currentTeamWorktable() || !identity) return null
  if (teamMemberForIdentity(identity)?.role === "owner") return null
  return spaceInventory().ids.filter((spaceId) =>
    canAccessSpace(spaceId, "read", identity)
  )
}

export function assertWorktableThreadAccess(
  access: "read" | "edit" = "read",
  identity = currentRequestIdentity()
): void {
  if (!canAccessWorktableThreads(access, identity)) throw new TeamAccessError()
}

export function assertSpaceAccess(
  spaceId: string,
  access: SpaceAccessLevel = "read",
  identity = currentRequestIdentity()
): void {
  if (!canAccessSpace(spaceId, access, identity)) throw new TeamAccessError()
}

export function canCreateTeamSpace(
  identity = currentRequestIdentity()
): boolean {
  if (!currentTeamWorktable() || !identity) return true
  if (!hasScope(identity.scopes, "docs:write")) return false
  if (teamMemberForIdentity(identity)) return true
  const agent = teamAgentForIdentity(identity)
  return Boolean(agent?.ownership === "personal" && agent.spaceIds === null)
}

export function registerTeamSpace(spaceId: string, existing = false): boolean {
  const worktable = currentTeamWorktable()
  if (!worktable) return false
  const db = requireTeamDatabase()
  const identity = currentRequestIdentity()
  const human = identity ? teamMemberForIdentity(identity) : null
  const agent = identity ? teamAgentForIdentity(identity) : null
  return db.transaction(() => {
    const added = db
      .query(
        "INSERT OR IGNORE INTO wt_space_policy(worktable_id, space_id, visibility) VALUES (?, ?, ?)"
      )
      .run(
        worktable.id,
        spaceId,
        existing || !identity ? "restricted" : "shared"
      )
    if (!added.changes) return false
    const managerId =
      human?.id ?? (agent?.ownership === "personal" ? agent.memberId : null)
    if (managerId)
      db.query(
        "INSERT INTO wt_space_grants(worktable_id, space_id, subject_type, subject_id, access) VALUES (?, ?, 'member', ?, 'manage')"
      ).run(worktable.id, spaceId, managerId)
    if (agent?.ownership === "team")
      db.query(
        "INSERT INTO wt_space_grants(worktable_id, space_id, subject_type, subject_id, access) VALUES (?, ?, 'agent', ?, 'edit')"
      ).run(worktable.id, spaceId, agent.id)
    advanceTeamPolicy(worktable.id)
    return true
  })()
}

/** Content-only replacement keeps people, but new content needs new grants. */
function resetTeamSpacePolicyRows(worktableId: string): void {
  const db = requireTeamDatabase()
  db.transaction(() => {
    db.query("DELETE FROM wt_space_grants WHERE worktable_id = ?").run(
      worktableId
    )
    db.query("DELETE FROM wt_space_policy WHERE worktable_id = ?").run(
      worktableId
    )
    db.query(
      "DELETE FROM wt_config WHERE key = 'content-policy-reset' AND value = ?"
    ).run(worktableId)
    advanceTeamPolicy(worktableId)
  })()
}

export function resetTeamSpacePoliciesAfterContentReplacement(): void {
  const worktable = currentTeamWorktable()
  if (worktable) resetTeamSpacePolicyRows(worktable.id)
}

/** Record the reset before publishing a restored root, so crash recovery can finish it. */
export function prepareTeamSpacePolicyResetForMissingRootRecovery(
  worktableId: string
): void {
  const db = openTeamDatabase()
  if (!db) {
    currentTeamWorktable()
    return
  }
  const worktable = db
    .query<
      { id: string },
      [string]
    >("SELECT id FROM wt_worktables WHERE root_key = ?")
    .get(workspaceCacheKey())
  if (!worktable) {
    currentTeamWorktable()
    return
  }
  if (worktable.id !== worktableId)
    throw new TeamStateError("Recovery belongs to another Worktable")
  db.query(
    "INSERT INTO wt_config(key, value) VALUES ('content-policy-reset', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(worktable.id)
}

export function finalizePendingTeamSpacePolicyReset(): void {
  const db = openTeamDatabase()
  const pending = db
    ?.query<
      { value: string },
      []
    >("SELECT value FROM wt_config WHERE key = 'content-policy-reset'")
    .get()
  if (!pending) return
  const worktable = currentTeamWorktable()
  if (!worktable || worktable.id !== pending.value)
    throw new TeamStateError("Content recovery belongs to another Worktable")
  resetTeamSpacePolicyRows(worktable.id)
}

export function retireTeamSpacePolicy(spaceId: string): void {
  const worktable = currentTeamWorktable()
  if (!worktable) return
  const db = requireTeamDatabase()
  db.transaction(() => {
    db.query(
      "DELETE FROM wt_space_grants WHERE worktable_id = ? AND space_id = ?"
    ).run(worktable.id, spaceId)
    db.query(
      "DELETE FROM wt_space_policy WHERE worktable_id = ? AND space_id = ?"
    ).run(worktable.id, spaceId)
    advanceTeamPolicy(worktable.id)
  })()
}

export function getSpaceAccessPolicy(spaceId: string): SpaceAccessPolicy {
  assertSpaceAccess(spaceId, "manage")
  const worktable = currentTeamWorktable()
  if (!worktable)
    throw new TeamAccessError("Enable Teams before managing Space access")
  const db = requireTeamDatabase()
  const visibility =
    db
      .query<
        { visibility: "shared" | "restricted" },
        [string, string]
      >("SELECT visibility FROM wt_space_policy WHERE worktable_id = ? AND space_id = ?")
      .get(worktable.id, spaceId)?.visibility ?? "restricted"
  const grants = db
    .query<SpaceAccessGrant, [string, string]>(
      `
    SELECT subject_type AS subjectType, subject_id AS subjectId, access FROM wt_space_grants
    WHERE worktable_id = ? AND space_id = ? ORDER BY subject_type, subject_id
  `
    )
    .all(worktable.id, spaceId)
  return { spaceId, visibility, grants }
}

export function setSpaceAccessPolicy(
  policy: SpaceAccessPolicy,
  identity: TokenIdentity
): void {
  requireTeamHuman(identity)
  assertSpaceAccess(policy.spaceId, "manage", identity)
  const worktable = currentTeamWorktable()!
  for (const grant of policy.grants) {
    if (!(grant.access in levels))
      throw new TeamAccessError("Invalid Space permission")
    if (grant.subjectType === "member") {
      if (!findTeamMemberById(grant.subjectId))
        throw new TeamAccessError("Unknown member")
    } else {
      const target = requireTeamDatabase()
        .query<
          { id: string },
          [string, string]
        >("SELECT id FROM wt_agents WHERE worktable_id = ? AND id = ? AND ownership = 'team' AND active = 1")
        .get(worktable.id, grant.subjectId)
      if (!target || grant.access === "manage")
        throw new TeamAccessError(
          "Unknown team agent or invalid agent permission"
        )
    }
  }
  const db = requireTeamDatabase()
  db.transaction(() => {
    db.query(
      "INSERT INTO wt_space_policy(worktable_id, space_id, visibility) VALUES (?, ?, ?) ON CONFLICT(worktable_id, space_id) DO UPDATE SET visibility = excluded.visibility"
    ).run(worktable.id, policy.spaceId, policy.visibility)
    db.query(
      "DELETE FROM wt_space_grants WHERE worktable_id = ? AND space_id = ?"
    ).run(worktable.id, policy.spaceId)
    for (const grant of policy.grants)
      db.query(
        "INSERT INTO wt_space_grants(worktable_id, space_id, subject_type, subject_id, access) VALUES (?, ?, ?, ?, ?)"
      ).run(
        worktable.id,
        policy.spaceId,
        grant.subjectType,
        grant.subjectId,
        grant.access
      )
    advanceTeamPolicy(worktable.id)
  })()
}

export function createTeamAgent(
  input: Pick<TeamAgent, "name" | "platform" | "ownership">,
  identity: TokenIdentity
): TeamAgent {
  const member =
    input.ownership === "team"
      ? requireTeamOwner(identity)
      : requireTeamHuman(identity)
  const worktable = currentTeamWorktable()!
  const agent: TeamAgent = {
    ...input,
    id: `agt_${randomUUID()}`,
    actorId: `agent:${randomUUID()}`,
    memberId: input.ownership === "personal" ? member.id : null,
    spaceIds: null,
    active: true,
    mode: "on-demand",
    scopeCeiling: null,
    icon: null,
    worktableThreads: "none",
  }
  requireTeamDatabase()
    .query(
      "INSERT INTO wt_agents(id, worktable_id, actor_id, participant_key, name, platform, ownership, member_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      agent.id,
      worktable.id,
      agent.actorId,
      `principal:${agent.actorId}`,
      agent.name,
      agent.platform,
      agent.ownership,
      agent.memberId
    )
  advanceTeamPolicy(worktable.id)
  return agent
}

export function listTeamAgents(identity: TokenIdentity): TeamAgent[] {
  const member = requireTeamHuman(identity)
  const current = accessSnapshot()!
  const rows = current.agentOrder.map((id) => current.agents.get(id)!)
  return rows
    .filter(
      (row) =>
        member.role === "owner" ||
        row.ownership === "team" ||
        row.member_id === member.id
    )
    .map(parseAgent)
}

export function bindTeamAgentCredential(
  agentId: string,
  credentialKey: string,
  identity: TokenIdentity,
  dependsOnMember = false
): void {
  const member = requireTeamHuman(identity)
  const worktable = currentTeamWorktable()!
  const db = requireTeamDatabase()
  const agent = db
    .query<
      AgentRow,
      [string, string]
    >("SELECT * FROM wt_agents WHERE worktable_id = ? AND id = ? AND active = 1")
    .get(worktable.id, agentId)
  if (
    !agent ||
    (agent.ownership === "personal"
      ? agent.member_id !== member.id
      : member.role !== "owner")
  ) {
    throw new TeamAccessError("You cannot connect this agent")
  }
  const existing = db
    .query<
      { agent_id: string },
      [string]
    >("SELECT agent_id FROM wt_agent_credentials WHERE credential_key = ?")
    .get(credentialKey)
  if (existing && existing.agent_id !== agentId)
    throw new TeamAccessError(
      "This credential already belongs to another agent"
    )
  db.query(
    "INSERT INTO wt_agent_credentials(credential_key, agent_id, sponsor_member_id) VALUES (?, ?, ?) ON CONFLICT(credential_key) DO UPDATE SET active = 1, sponsor_member_id = excluded.sponsor_member_id"
  ).run(
    credentialKey,
    agentId,
    dependsOnMember || agent.ownership === "personal" ? member.id : null
  )
  advanceTeamPolicy(worktable.id)
}

export function resolveTeamAgentCredential(
  identity: TokenIdentity
): TokenIdentity | null {
  const worktable = currentTeamWorktable()
  if (!worktable) return identity
  const current = accessSnapshot()!
  const binding = current.credentials.get(identity.principal.id)
  const row = binding ? current.agents.get(binding.agentId) : undefined
  if (
    !binding ||
    !binding.active ||
    !row ||
    row.active !== 1 ||
    (binding.minimumIssuedAt > 0 &&
      (identity.credentialIssuedAt ?? 0) < binding.minimumIssuedAt) ||
    (binding.sponsorMemberId && !current.members.has(binding.sponsorMemberId))
  )
    return null
  const credential = row
  const agent = parseAgent(row)
  if (
    agent.ownership === "personal" &&
    (!agent.memberId || !findTeamMemberById(agent.memberId))
  )
    return null
  return {
    ...identity,
    user: agent.memberId ?? "team",
    agent: agent.platform,
    scopes:
      agent.scopeCeiling === null
        ? identity.scopes
        : agent.scopeCeiling.filter((scope) =>
            hasScope(identity.scopes, scope)
          ),
    principal: {
      id: agent.actorId,
      type: "agent",
      displayName: agent.name,
      participantKey: credential.participant_key,
    },
    team: {
      worktableId: worktable.id,
      agentId: agent.id,
      credentialKey: identity.principal.id,
      ...(agent.memberId ? { memberId: agent.memberId } : {}),
    },
  }
}

export function requireTeamAgentAdministrator(
  agentId: string,
  identity: TokenIdentity
): TeamAgent {
  const member = requireTeamHuman(identity)
  const worktable = currentTeamWorktable()!
  const row = requireTeamDatabase()
    .query<
      AgentRow,
      [string, string]
    >("SELECT * FROM wt_agents WHERE worktable_id = ? AND id = ? AND active = 1")
    .get(worktable.id, agentId)
  if (
    !row ||
    (row.ownership === "personal"
      ? row.member_id !== member.id
      : member.role !== "owner")
  ) {
    throw new TeamAccessError("You cannot administer this agent")
  }
  return parseAgent(row)
}

export function updateTeamAgent(
  agentId: string,
  patch: {
    name?: string
    spaceIds?: string[] | null
    scopeCeiling?: string[] | null
    icon?: string | null
    active?: false
    worktableThreads?: WorktableThreadAccess
  },
  identity: TokenIdentity
): TeamAgent {
  const agent = requireTeamAgentAdministrator(agentId, identity)
  const worktable = currentTeamWorktable()!
  if (patch.spaceIds !== undefined && agent.ownership !== "personal")
    throw new TeamAccessError("Team agents use explicit Space grants")
  if (patch.worktableThreads !== undefined && agent.ownership !== "team")
    throw new TeamAccessError("Personal agents follow their member's thread access")
  if (patch.spaceIds)
    for (const spaceId of patch.spaceIds)
      assertSpaceAccess(spaceId, "read", identity)
  const next = { ...agent, ...patch }
  const db = requireTeamDatabase()
  db.transaction(() => {
    db.query(
      "UPDATE wt_agents SET name = ?, space_ids = ?, scope_ceiling = ?, icon = ?, active = ?, worktable_threads = ? WHERE worktable_id = ? AND id = ?"
    ).run(
      next.name,
      next.spaceIds === null ? null : JSON.stringify(next.spaceIds),
      next.scopeCeiling === null ? null : JSON.stringify(next.scopeCeiling),
      next.icon,
      next.active ? 1 : 0,
      next.worktableThreads,
      worktable.id,
      agentId
    )
    if (!next.active) {
      db.query(
        "UPDATE wt_agent_credentials SET active = 0 WHERE agent_id = ?"
      ).run(agentId)
      db.query(
        "DELETE FROM wt_space_grants WHERE worktable_id = ? AND subject_type = 'agent' AND subject_id = ?"
      ).run(worktable.id, agentId)
    }
    advanceTeamPolicy(worktable.id)
  })()
  return next
}

export function teamAgentForCredentialAdministration(
  credentialKey: string,
  identity: TokenIdentity
): TeamAgent {
  const worktable = currentTeamWorktable()!
  const row = requireTeamDatabase()
    .query<{ agent_id: string }, [string, string]>(
      `
    SELECT c.agent_id FROM wt_agent_credentials c JOIN wt_agents a ON a.id = c.agent_id
    WHERE c.credential_key = ? AND a.worktable_id = ?
  `
    )
    .get(credentialKey, worktable.id)
  if (!row)
    throw new TeamAccessError("This credential does not belong to your agents")
  return requireTeamAgentAdministrator(row.agent_id, identity)
}

/** Only its human can reauthorize a Cloud credential. A new enrollment gets a new agent. */
export function reconnectCloudPersonalAgent(
  agentId: string,
  identity: TokenIdentity
): void {
  const member = requireTeamHuman(identity)
  const worktable = currentTeamWorktable()!
  const db = requireTeamDatabase()
  const row = db
    .query<AgentRow, [string, string, string]>(
      `
    SELECT a.* FROM wt_agents a JOIN wt_enrollments e
      ON e.id = a.member_id AND e.worktable_id = a.worktable_id
    WHERE a.worktable_id = ? AND a.id = ? AND a.ownership = 'personal' AND e.user_id = ?
  `
    )
    .get(worktable.id, agentId, member.userId)
  if (!row)
    throw new TeamAccessError("Reconnect this agent from its member's account")
  if (
    !db
      .query(
        "SELECT credential_key FROM wt_agent_credentials WHERE agent_id = ? AND (credential_key LIKE 'oauth:%' OR credential_key LIKE 'workos-agent:%')"
      )
      .get(agentId)
  )
    throw new TeamAccessError("Connect this agent again from Settings")
  db.transaction(() => {
    let destination = agentId
    if (row.member_id !== member.id) {
      const previous = parseAgent(row)
      const replacement = createTeamAgent(
        { name: row.name, platform: row.platform, ownership: "personal" },
        identity
      )
      destination = replacement.id
      updateTeamAgent(
        destination,
        {
          icon: row.icon,
          scopeCeiling: previous.scopeCeiling,
          spaceIds:
            previous.spaceIds?.filter((spaceId) =>
              canAccessSpace(spaceId, "read", identity)
            ) ?? null,
        },
        identity
      )
      db.query("UPDATE wt_agents SET mode = ? WHERE id = ?").run(
        row.mode,
        destination
      )
    } else {
      db.query("UPDATE wt_agents SET active = 1 WHERE id = ?").run(agentId)
    }
    db.query(
      "UPDATE wt_agent_credentials SET agent_id = ?, active = 1, minimum_issued_at = ?, sponsor_member_id = ? WHERE agent_id = ? AND (credential_key LIKE 'oauth:%' OR credential_key LIKE 'workos-agent:%')"
    ).run(destination, Math.ceil(Date.now() / 1000) * 1000, member.id, agentId)
    advanceTeamPolicy(worktable.id)
  })()
}
