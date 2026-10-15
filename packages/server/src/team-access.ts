import { createHash } from "node:crypto"
import { readdirSync } from "node:fs"
import type {
  SpaceAccessLevel,
  TeamMember,
  WorktableThreadAccess,
} from "@worktable/types"
import {
  currentTeamWorktable,
  requireTeamDatabase,
  statIfPresent,
  teamStateGeneration,
  type TeamWorktable,
} from "./team-database.ts"
import { getSpacesDir } from "./workspace.ts"

export interface AgentRecord {
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

export interface CredentialRecord {
  agentId: string
  sponsorMemberId: string | null
  minimumIssuedAt: number
  active: boolean
}

export interface BindingRecord {
  userId: string
  companyId: string | null
  email: string | null
}

/**
 * Everything team authorization reads, for one policy revision. Triggers
 * advance the revision on every change to these rows, from any connection,
 * so a matching revision means the snapshot is current.
 */
export interface AccessSnapshot {
  key: string
  worktable: TeamWorktable
  members: Map<string, TeamMember & { operator: boolean }>
  /** Each member's thread participant key, by member ID. */
  participantKeys: Map<string, string>
  memberOrder: string[]
  byUser: Map<string, string>
  visibility: Map<string, "shared" | "restricted">
  grants: Map<string, Map<string, SpaceAccessLevel>>
  agents: Map<string, AgentRecord>
  agentOrder: string[]
  credentials: Map<string, CredentialRecord>
  bindings: Map<string, BindingRecord>
  memberAccess: Map<string, MemberAccess>
  accessKeys: Map<string, string>
}

export interface MemberAccess {
  memberId: string
  role: TeamMember["role"]
  /** This member's level in every Space that exists, keyed by Space ID. */
  levels: Map<string, SpaceAccessLevel>
  /** Changes only when this member's own access changes. */
  fingerprint: string
}

const LEVELS: Record<SpaceAccessLevel, number> = { read: 1, edit: 2, manage: 3 }

let snapshot: AccessSnapshot | null = null

function subjectKey(type: "member" | "agent", id: string): string {
  return `${type}:${id}`
}

function build(worktable: TeamWorktable, key: string): AccessSnapshot {
  const db = requireTeamDatabase()
  const members = new Map<string, TeamMember & { operator: boolean }>()
  const participantKeys = new Map<string, string>()
  const memberOrder: string[] = []
  const byUser = new Map<string, string>()
  const operators = new Set(
    db
      .query<{ user_id: string }, [string]>(
        "SELECT user_id FROM wt_operators WHERE worktable_id = ?"
      )
      .all(worktable.id)
      .map((row) => row.user_id)
  )
  for (const row of db
    .query<
      {
        id: string
        userId: string
        actorId: string
        name: string
        email: string
        role: string
        participantKey: string | null
      },
      [string, string]
    >(
      `SELECT m.id, m.userId, e.actor_id AS actorId, u.name, u.email, m.role,
         a.participant_key AS participantKey
       FROM member m JOIN wt_enrollments e ON e.id = m.id AND e.user_id = m.userId
       JOIN user u ON u.id = m.userId
       LEFT JOIN wt_actors a ON a.worktable_id = e.worktable_id AND a.id = e.actor_id
       WHERE m.organizationId = ? AND e.worktable_id = ? AND e.active = 1
       ORDER BY m.createdAt, m.id`
    )
    .all(worktable.organizationId, worktable.id)) {
    const { participantKey, ...member } = row
    if (member.role !== "owner" && member.role !== "member") continue
    members.set(row.id, {
      ...member,
      role: member.role,
      operator: operators.has(row.userId),
    })
    if (participantKey) participantKeys.set(row.id, participantKey)
    memberOrder.push(row.id)
    byUser.set(row.userId, row.id)
  }
  const visibility = new Map<string, "shared" | "restricted">()
  for (const row of db
    .query<{ space_id: string; visibility: "shared" | "restricted" }, [string]>(
      "SELECT space_id, visibility FROM wt_space_policy WHERE worktable_id = ?"
    )
    .all(worktable.id))
    visibility.set(row.space_id, row.visibility)
  const grants = new Map<string, Map<string, SpaceAccessLevel>>()
  for (const row of db
    .query<
      {
        space_id: string
        subject_type: "member" | "agent"
        subject_id: string
        access: SpaceAccessLevel
      },
      [string]
    >(
      "SELECT space_id, subject_type, subject_id, access FROM wt_space_grants WHERE worktable_id = ?"
    )
    .all(worktable.id)) {
    const subject = subjectKey(row.subject_type, row.subject_id)
    const spaces = grants.get(subject) ?? new Map<string, SpaceAccessLevel>()
    spaces.set(row.space_id, row.access)
    grants.set(subject, spaces)
  }
  const agents = new Map<string, AgentRecord>()
  const agentOrder: string[] = []
  for (const row of db
    .query<AgentRecord, [string]>(
      "SELECT * FROM wt_agents WHERE worktable_id = ? ORDER BY name, id"
    )
    .all(worktable.id)) {
    agents.set(row.id, row)
    agentOrder.push(row.id)
  }
  const credentials = new Map<string, CredentialRecord>()
  for (const row of db
    .query<
      {
        credential_key: string
        agent_id: string
        sponsor_member_id: string | null
        minimum_issued_at: number
        active: number
      },
      []
    >(
      "SELECT credential_key, agent_id, sponsor_member_id, minimum_issued_at, active FROM wt_agent_credentials"
    )
    .all())
    credentials.set(row.credential_key, {
      agentId: row.agent_id,
      sponsorMemberId: row.sponsor_member_id,
      minimumIssuedAt: row.minimum_issued_at,
      active: row.active === 1,
    })
  const bindings = new Map<string, BindingRecord>()
  for (const row of db
    .query<
      {
        issuer: string
        subject: string
        user_id: string
        company_id: string | null
        email: string | null
      },
      [string]
    >(
      `SELECT b.issuer, b.subject, b.user_id, b.company_id, u.email
       FROM wt_identity_bindings b LEFT JOIN user u ON u.id = b.user_id
       WHERE b.worktable_id = ?`
    )
    .all(worktable.id))
    bindings.set(`${row.issuer}\0${row.subject}`, {
      userId: row.user_id,
      companyId: row.company_id,
      email: row.email,
    })
  return {
    key,
    worktable,
    members,
    participantKeys,
    memberOrder,
    byUser,
    visibility,
    grants,
    agents,
    agentOrder,
    credentials,
    bindings,
    memberAccess: new Map(),
    accessKeys: new Map(),
  }
}

/** The current snapshot, rebuilt only when the policy revision moves. */
export function accessSnapshot(): AccessSnapshot | null {
  const worktable = currentTeamWorktable()
  if (!worktable) return null
  const key = `${worktable.id}:${worktable.policyRevision}:${teamStateGeneration()}`
  if (snapshot?.key !== key) snapshot = build(worktable, key)
  return snapshot
}

export function grantedLevel(
  current: AccessSnapshot,
  spaceId: string,
  subjectType: "member" | "agent",
  subjectId: string
): SpaceAccessLevel | null {
  return current.grants.get(subjectKey(subjectType, subjectId))?.get(spaceId) ?? null
}

export function memberLevel(
  current: AccessSnapshot,
  member: Pick<TeamMember, "id" | "role">,
  spaceId: string
): SpaceAccessLevel | null {
  if (member.role === "owner") return "manage"
  const granted = grantedLevel(current, spaceId, "member", member.id)
  if (current.visibility.get(spaceId) === "shared")
    return granted === "manage" ? "manage" : "edit"
  return granted
}

export function levelAtLeast(
  level: SpaceAccessLevel | null,
  access: SpaceAccessLevel
): boolean {
  return level !== null && LEVELS[level] >= LEVELS[access]
}

// The raw Space inventory: directory names, revalidated by one stat of the
// Spaces directory. Never the access-filtered listing, which depends on this.
let inventory: { key: string; ids: string[] } | null = null
export function spaceInventory(): { key: string; ids: string[] } {
  const dir = getSpacesDir()
  const stat = statIfPresent(dir)
  const key = stat
    ? `${dir}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`
    : `${dir}:absent`
  if (inventory?.key === key) return inventory
  const ids = stat
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
        .sort()
    : []
  inventory = { key, ids }
  return inventory
}

function hash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("base64url").slice(0, 22)
}

/** One member's access, computed on first use per revision and inventory. */
export function memberAccess(memberId: string): MemberAccess | null {
  const current = accessSnapshot()
  const member = current?.members.get(memberId)
  if (!current || !member) return null
  const spaces = spaceInventory()
  const cacheKey = `${memberId}\0${spaces.key}`
  const cached = current.memberAccess.get(cacheKey)
  if (cached) return cached
  const levels = new Map<string, SpaceAccessLevel>()
  for (const spaceId of spaces.ids) {
    const level = memberLevel(current, member, spaceId)
    if (level) levels.set(spaceId, level)
  }
  const access: MemberAccess = {
    memberId,
    role: member.role,
    levels,
    fingerprint: hash(
      current.worktable.id,
      memberId,
      member.role,
      ...[...levels].map(([spaceId, level]) => `${spaceId}=${level}`)
    ),
  }
  current.memberAccess.set(cacheKey, access)
  return access
}

/**
 * A member's cache key for one Space's content addresses; never an
 * authorization. Reads only the snapshot, so listing Spaces costs no I/O.
 */
export function spaceAccessKey(memberId: string, spaceId: string): string | null {
  const current = accessSnapshot()
  const member = current?.members.get(memberId)
  if (!current || !member) return null
  const level = memberLevel(current, member, spaceId)
  if (!level) return null
  const cacheKey = `${memberId}\0${spaceId}`
  let key = current.accessKeys.get(cacheKey)
  if (!key) {
    key = hash(current.worktable.id, memberId, spaceId, level)
    current.accessKeys.set(cacheKey, key)
  }
  return key
}
