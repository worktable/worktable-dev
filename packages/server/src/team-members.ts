import { randomUUID } from "node:crypto"
import type { TeamMember, TeamRole } from "@worktable/types"
import { advanceTeamPolicy, requireTeamDatabase } from "./team-database.ts"
import { accessSnapshot } from "./team-access.ts"

function withoutOperator(
  member: TeamMember & { operator: boolean }
): TeamMember {
  return {
    id: member.id,
    userId: member.userId,
    actorId: member.actorId,
    name: member.name,
    email: member.email,
    role: member.role,
  }
}

export function findTeamMember(userId: string): TeamMember | null {
  const current = accessSnapshot()
  const memberId = current?.byUser.get(userId)
  const member = memberId ? current!.members.get(memberId) : undefined
  return member ? withoutOperator(member) : null
}

export function findTeamMemberById(memberId: string): TeamMember | null {
  const member = accessSnapshot()?.members.get(memberId)
  return member ? withoutOperator(member) : null
}

export function listTeamMembers(): TeamMember[] {
  const current = accessSnapshot()
  if (!current) return []
  return current.memberOrder.map((id) => ({ ...current.members.get(id)! }))
}

/** Called by the library lifecycle, never from a browser-supplied membership ID. */
export function recordTeamEnrollment(
  member: { id: string; userId: string; organizationId: string },
  name: string
): void {
  const db = requireTeamDatabase()
  const worktable = db
    .query<
      { id: string },
      [string]
    >("SELECT id FROM wt_worktables WHERE organization_id = ?")
    .get(member.organizationId)
  if (!worktable) return // Initial owner is recorded with the Worktable transaction.
  db.transaction(() => {
    const previous = db
      .query<
        { id: string },
        [string, string, string]
      >("SELECT id FROM wt_enrollments WHERE worktable_id = ? AND user_id = ? AND id <> ?")
      .all(worktable.id, member.userId, member.id)
    for (const old of previous)
      retireTeamEnrollment(old.id, member.organizationId)
    const actorId = `human:${randomUUID()}`
    db.query(
      "INSERT OR IGNORE INTO wt_actors(id, worktable_id, user_id, name, participant_key) VALUES (?, ?, ?, ?, ?)"
    ).run(actorId, worktable.id, member.userId, name, `principal:${actorId}`)
    const actor = db
      .query<
        { id: string },
        [string, string]
      >("SELECT id FROM wt_actors WHERE worktable_id = ? AND user_id = ?")
      .get(worktable.id, member.userId)!
    db.query(
      "INSERT OR IGNORE INTO wt_enrollments(id, worktable_id, user_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(member.id, worktable.id, member.userId, actor.id, Date.now())
    advanceTeamPolicy(worktable.id)
  })()
}

export function retireTeamEnrollment(
  memberId: string,
  organizationId: string
): void {
  const db = requireTeamDatabase()
  const worktable = db
    .query<
      { id: string },
      [string]
    >("SELECT id FROM wt_worktables WHERE organization_id = ?")
    .get(organizationId)
  if (!worktable) return
  db.transaction(() => {
    const enrollment = db
      .query<
        { user_id: string; active: number },
        [string, string]
      >("SELECT user_id, active FROM wt_enrollments WHERE id = ? AND worktable_id = ?")
      .get(memberId, worktable.id)
    if (enrollment?.active === 1)
      db.query("DELETE FROM session WHERE userId = ?").run(enrollment.user_id)
    if (enrollment) {
      // A removed person keeps no way back in: unused reset links and machine
      // operation end with membership. Re-inviting restores neither.
      db.query("DELETE FROM verification WHERE value = ?").run(enrollment.user_id)
      db.query(
        "DELETE FROM wt_operators WHERE worktable_id = ? AND user_id = ?"
      ).run(worktable.id, enrollment.user_id)
    }
    db.query(
      "UPDATE wt_enrollments SET active = 0 WHERE id = ? AND worktable_id = ?"
    ).run(memberId, worktable.id)
    db.query(
      "UPDATE wt_agents SET active = 0 WHERE member_id = ? AND worktable_id = ? AND ownership = 'personal'"
    ).run(memberId, worktable.id)
    db.query(
      "UPDATE wt_agent_credentials SET active = 0, disconnected_at = NULL WHERE sponsor_member_id = ? OR agent_id IN (SELECT id FROM wt_agents WHERE member_id = ? AND worktable_id = ?)"
    ).run(memberId, memberId, worktable.id)
    db.query(
      "DELETE FROM wt_space_grants WHERE worktable_id = ? AND subject_type = 'member' AND subject_id = ?"
    ).run(worktable.id, memberId)
    if (enrollment)
      db.query(
        "UPDATE invitation SET status = 'canceled' WHERE organizationId = ? AND inviterId = ? AND status = 'pending'"
      ).run(organizationId, enrollment.user_id)
    advanceTeamPolicy(worktable.id)
  })()
}

export function hasTeamOperatorAuthority(userId: string): boolean {
  const current = accessSnapshot()
  const memberId = current?.byUser.get(userId)
  return Boolean(memberId && current!.members.get(memberId)?.operator)
}

export function isTeamRole(value: unknown): value is TeamRole {
  return value === "owner" || value === "member"
}
