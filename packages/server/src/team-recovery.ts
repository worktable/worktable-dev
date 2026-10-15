import { randomBytes } from "node:crypto"
import { getTeamAuth } from "./team-auth.ts"
import {
  advanceTeamPolicy,
  currentTeamWorktable,
  requireTeamDatabase,
  TeamStateError,
} from "./team-database.ts"
import {
  findTeamMember,
  findTeamMemberById,
  hasTeamOperatorAuthority,
} from "./team-members.ts"
import { requireTeamOwner, TeamAccessError } from "./team-policy.ts"
import type { TokenIdentity } from "./token-store.ts"

const RESET_LINK_LIFETIME_MS = 24 * 60 * 60 * 1000

/** Who asks: a signed-in member, or someone with access to the machine. */
export type TeamRecoveryIssuer = TokenIdentity | "machine"

export type PasswordResetTarget =
  | { memberId: string }
  | { invitationId: string }
  | { email: string }

function requireWorktable() {
  const worktable = currentTeamWorktable()
  if (!worktable) throw new TeamStateError("Teams is not enabled")
  return worktable
}

/** Remove a person's unused reset links, e.g. when they leave or a new one is issued. */
export function retirePasswordResets(userId: string): void {
  // Reset tokens are stored hashed, so they are found by the user they reset.
  requireTeamDatabase().query("DELETE FROM verification WHERE value = ?").run(userId)
}

async function resolveResetUser(
  target: PasswordResetTarget,
  issuer: TeamRecoveryIssuer
): Promise<string> {
  const worktable = requireWorktable()
  const owner = issuer === "machine" ? null : requireTeamOwner(issuer)
  if ("memberId" in target) {
    const member = findTeamMemberById(target.memberId)
    if (!member) throw new TeamAccessError("This person is no longer a member")
    if (owner && member.id === owner.id)
      throw new TeamAccessError("Change your own password in Settings")
    // One owner must not be able to take over another owner's account.
    if (owner && member.role === "owner")
      throw new TeamAccessError(
        "Reset an owner's password from the Worktable's machine"
      )
    return member.userId
  }
  if ("invitationId" in target) {
    // A person invited back may have forgotten the password of their earlier
    // account; the invitation names that account by email.
    const invitation = requireTeamDatabase()
      .query<{ email: string }, [string, string]>(
        "SELECT email FROM invitation WHERE id = ? AND organizationId = ? AND status = 'pending'"
      )
      .get(target.invitationId, worktable.organizationId)
    if (!invitation)
      throw new TeamAccessError("This invitation is no longer available")
    const user = requireTeamDatabase()
      .query<{ id: string }, [string]>(
        "SELECT id FROM user WHERE lower(email) = lower(?)"
      )
      .get(invitation.email)
    if (!user) throw new TeamAccessError("This person has no account yet")
    if (findTeamMember(user.id))
      throw new TeamAccessError("This person is already a member")
    return user.id
  }
  if (owner) throw new TeamAccessError("Choose a member or an invitation")
  const user = requireTeamDatabase()
    .query<{ id: string }, [string]>(
      "SELECT id FROM user WHERE lower(email) = lower(?)"
    )
    .get(target.email)
  if (!user) throw new TeamAccessError("No account uses that email")
  return user.id
}

/**
 * Issue a single-use link that lets a person choose a new password. There is
 * no email: the issuer passes the link on, as with invitations. Using it signs
 * the person out everywhere.
 */
export async function issueTeamPasswordReset(
  origin: string,
  target: PasswordResetTarget,
  issuer: TeamRecoveryIssuer
): Promise<{ url: string; expiresAt: string }> {
  const userId = await resolveResetUser(target, issuer)
  const auth = await getTeamAuth(origin)
  const context = await auth.$context
  const token = randomBytes(32).toString("base64url")
  const expiresAt = new Date(Date.now() + RESET_LINK_LIFETIME_MS)
  retirePasswordResets(userId)
  await context.internalAdapter.createVerificationValue({
    identifier: `reset-password:${token}`,
    value: userId,
    expiresAt,
  })
  return {
    url: `${origin}/login?reset=${encodeURIComponent(token)}`,
    expiresAt: expiresAt.toISOString(),
  }
}

/**
 * Grant or remove machine-operation authority. Only existing operators can do
 * this from the app; the machine itself (the CLI) always can. The app never
 * removes the last operator.
 */
export function setTeamOperator(
  target: { memberId: string } | { email: string },
  operator: boolean,
  issuer: TeamRecoveryIssuer
): void {
  const worktable = requireWorktable()
  const db = requireTeamDatabase()
  if (issuer !== "machine") {
    const userId = issuer.team?.userId
    if (!userId || !hasTeamOperatorAuthority(userId))
      throw new TeamAccessError("Only an operator can change operators")
  }
  const member =
    "memberId" in target
      ? findTeamMemberById(target.memberId)
      : (() => {
          const user = db
            .query<{ id: string }, [string]>(
              "SELECT id FROM user WHERE lower(email) = lower(?)"
            )
            .get(target.email)
          return user ? findTeamMember(user.id) : null
        })()
  if (!member) throw new TeamAccessError("This person is not a member")
  db.transaction(() => {
    if (operator) {
      db.query(
        "INSERT OR IGNORE INTO wt_operators(worktable_id, user_id) VALUES (?, ?)"
      ).run(worktable.id, member.userId)
    } else {
      const remaining = db
        .query<{ count: number }, [string, string]>(
          "SELECT COUNT(*) AS count FROM wt_operators WHERE worktable_id = ? AND user_id <> ?"
        )
        .get(worktable.id, member.userId)!.count
      if (issuer !== "machine" && remaining === 0)
        throw new TeamAccessError(
          "The Worktable must keep an operator; remove the last one from its machine"
        )
      db.query(
        "DELETE FROM wt_operators WHERE worktable_id = ? AND user_id = ?"
      ).run(worktable.id, member.userId)
    }
    advanceTeamPolicy(worktable.id)
  })()
}
