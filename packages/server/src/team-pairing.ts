import type { TokenIdentity } from "./token-store.ts"
import {
  advanceTeamPolicy,
  currentTeamWorktable,
  requireTeamDatabase,
} from "./team-database.ts"
import { findTeamMemberById } from "./team-members.ts"
import { identityForTeamMember } from "./team-identity.ts"
import {
  bindTeamAgentCredential,
  createTeamAgent,
  requireTeamAgentAdministrator,
  requireTeamHuman,
  TeamAccessError,
} from "./team-policy.ts"

export function registerTeamPairing(
  sessionId: string,
  input: {
    name: string
    platform: string
    agentId?: string
    mode?: "on-demand" | "always-on"
    expiresAt: string
  },
  identity: TokenIdentity
): void {
  const member = requireTeamHuman(identity)
  if (input.agentId) requireTeamAgentAdministrator(input.agentId, identity)
  const db = requireTeamDatabase()
  db.transaction(() => {
    db.query("DELETE FROM wt_pairing_authorizations WHERE expires_at <= ?").run(
      Date.now()
    )
    db.query(
      "INSERT INTO wt_pairing_authorizations(session_id, worktable_id, member_id, name, platform, agent_id, mode, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      sessionId,
      currentTeamWorktable()!.id,
      member.id,
      input.name,
      input.platform,
      input.agentId ?? null,
      input.mode ?? null,
      Date.parse(input.expiresAt)
    )
  })()
}

export function bindTeamPairingCredential(
  sessionId: string,
  credentialKey: string
): { agentId: string; createdAgent: boolean } {
  const db = requireTeamDatabase()
  const worktableId = currentTeamWorktable()!.id
  return db.transaction(() => {
    const pending = db
      .query<
        {
          member_id: string
          name: string
          platform: string
          agent_id: string | null
          mode: string | null
          expires_at: number
        },
        [string, string]
      >(
        "SELECT * FROM wt_pairing_authorizations WHERE session_id = ? AND worktable_id = ?"
      )
      .get(sessionId, worktableId)
    const existing = db
      .query<
        { agent_id: string; member_id: string },
        [string, string]
      >("SELECT agent_id, member_id FROM wt_pairings WHERE session_id = ? AND worktable_id = ?")
      .get(sessionId, worktableId)
    const member = findTeamMemberById(
      pending?.member_id ?? existing?.member_id ?? ""
    )
    if (
      !member ||
      (!existing && (!pending || pending.expires_at <= Date.now()))
    )
      throw new TeamAccessError(
        "The member who authorized this connection is no longer available"
      )
    const identity = identityForTeamMember(member)
    const agentId =
      existing?.agent_id ??
      pending!.agent_id ??
      createTeamAgent(
        {
          name: pending!.name,
          platform: pending!.platform,
          ownership: "personal",
        },
        identity
      ).id
    requireTeamAgentAdministrator(agentId, identity)
    if (pending?.mode)
      db.query(
        "UPDATE wt_agents SET mode = ? WHERE id = ? AND worktable_id = ?"
      ).run(pending.mode, agentId, worktableId)
    bindTeamAgentCredential(agentId, credentialKey, identity)
    db.query(
      "INSERT OR IGNORE INTO wt_pairings(session_id, worktable_id, agent_id, member_id) VALUES (?, ?, ?, ?)"
    ).run(sessionId, worktableId, agentId, member.id)
    db.query("DELETE FROM wt_pairing_authorizations WHERE session_id = ?").run(
      sessionId
    )
    return { agentId, createdAgent: !existing?.agent_id && !pending?.agent_id }
  })()
}

export function requireTeamPairingAdministrator(
  sessionId: string,
  identity: TokenIdentity
): void {
  const member = requireTeamHuman(identity)
  const db = requireTeamDatabase()
  const worktableId = currentTeamWorktable()!.id
  const pending = db
    .query<
      { member_id: string; agent_id: string | null },
      [string, string]
    >("SELECT member_id, agent_id FROM wt_pairing_authorizations WHERE session_id = ? AND worktable_id = ?")
    .get(sessionId, worktableId)
  if (pending) {
    if (pending.member_id !== member.id && member.role !== "owner")
      throw new TeamAccessError()
    if (pending.agent_id)
      requireTeamAgentAdministrator(pending.agent_id, identity)
    return
  }
  const row = db
    .query<
      { agent_id: string; member_id: string },
      [string, string]
    >("SELECT agent_id, member_id FROM wt_pairings WHERE session_id = ? AND worktable_id = ?")
    .get(sessionId, worktableId)
  if (!row) throw new TeamAccessError("This connection is no longer available")
  if (row.member_id !== member.id && member.role !== "owner")
    throw new TeamAccessError()
}

/** A failed redemption must not leave an undelivered credential or an empty connection. */
export function retireFailedTeamPairingCredential(
  binding: { agentId: string; createdAgent: boolean },
  credentialKey: string
): void {
  const db = requireTeamDatabase()
  db.transaction(() => {
    db.query(
      "UPDATE wt_agent_credentials SET active = 0 WHERE credential_key = ? AND agent_id = ?"
    ).run(credentialKey, binding.agentId)
    if (
      binding.createdAgent &&
      !db
        .query(
          "SELECT credential_key FROM wt_agent_credentials WHERE agent_id = ? AND active = 1"
        )
        .get(binding.agentId)
    )
      db.query(
        "UPDATE wt_agents SET active = 0 WHERE id = ? AND ownership = 'personal'"
      ).run(binding.agentId)
    advanceTeamPolicy(currentTeamWorktable()!.id)
  })()
}
