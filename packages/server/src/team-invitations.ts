import type { InvitationEmailStatus } from "@worktable/hosted-contract"
import type { TeamMember } from "@worktable/types"
import {
  advanceTeamPolicy,
  currentTeamWorktable,
  requireTeamDatabase,
} from "./team-database.ts"
import {
  accessSnapshot,
  levelAtLeast,
  memberLevel,
  spaceInventory,
} from "./team-access.ts"
import { findTeamMember } from "./team-members.ts"
import { TeamAccessError } from "./team-policy.ts"
import { GETTING_STARTED_SPACE_ID } from "@worktable/types/setup"
import { gettingStartedOpen, spaceOpen } from "./getting-started.ts"

/** A sent invitation waits this long before another email, and is emailed at most this often. */
export const INVITATION_EMAIL_COOLDOWN_MS = 10 * 60_000
export const MAX_INVITATION_EMAILS = 3
/** Any attempt, sent or not, briefly holds off the next one. */
export const INVITATION_EMAIL_ATTEMPT_MS = 30_000

export interface InvitationDetails {
  startSpaceId: string | null
  /** The most recent attempt's result; `emailSends` says whether any arrived. */
  emailStatus: InvitationEmailStatus | null
  emailSends: number
  lastEmailedAt: number | null
}

interface DetailsRow {
  invitation_id: string
  start_space_id: string | null
  email_status: InvitationEmailStatus | null
  email_sends: number
  last_emailed_at: number | null
}

const DETAILS =
  "SELECT invitation_id, start_space_id, email_status, email_sends, last_emailed_at FROM wt_invitation_details"

function details(row: DetailsRow): InvitationDetails {
  return {
    startSpaceId: row.start_space_id,
    emailStatus: row.email_status,
    emailSends: row.email_sends,
    lastEmailedAt: row.last_emailed_at,
  }
}

export function recordInvitationDetails(
  invitationId: string,
  startSpaceId: string | null
): void {
  const worktable = currentTeamWorktable()
  if (!worktable) return
  requireTeamDatabase()
    .query(
      "INSERT OR IGNORE INTO wt_invitation_details(worktable_id, invitation_id, start_space_id) VALUES (?, ?, ?)"
    )
    .run(worktable.id, invitationId, startSpaceId)
}

export function invitationDetails(
  invitationId: string
): InvitationDetails | null {
  const worktable = currentTeamWorktable()
  if (!worktable) return null
  const row = requireTeamDatabase()
    .query<DetailsRow, [string, string]>(
      `${DETAILS} WHERE worktable_id = ? AND invitation_id = ?`
    )
    .get(worktable.id, invitationId)
  return row ? details(row) : null
}

export function allInvitationDetails(): Map<string, InvitationDetails> {
  const worktable = currentTeamWorktable()
  if (!worktable) return new Map()
  return new Map(
    requireTeamDatabase()
      .query<DetailsRow, [string]>(
        `${DETAILS} WHERE worktable_id = ?`
      )
      .all(worktable.id)
      .map((row) => [row.invitation_id, details(row)])
  )
}

export function recordInvitationEmail(
  invitationId: string,
  status: InvitationEmailStatus,
  at = Date.now()
): void {
  const worktable = currentTeamWorktable()
  if (!worktable) return
  // Only a send the provider accepted counts toward the re-send limit.
  requireTeamDatabase()
    .query(
      `INSERT INTO wt_invitation_details(worktable_id, invitation_id, email_status, email_sends, last_emailed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(worktable_id, invitation_id) DO UPDATE SET
         email_status = excluded.email_status,
         email_sends = email_sends + excluded.email_sends,
         last_emailed_at = CASE WHEN excluded.email_sends > 0 THEN excluded.last_emailed_at ELSE last_emailed_at END`
    )
    .run(
      worktable.id,
      invitationId,
      status,
      status === "sent" ? 1 : 0,
      status === "sent" ? at : null
    )
}

/**
 * Claims the next email for an invitation, or says why it must wait. The
 * claim is one conditional write, so concurrent requests can't both pass
 * the limits.
 */
export function claimInvitationEmail(
  invitationId: string,
  now = Date.now()
): string | null {
  const worktable = currentTeamWorktable()
  if (!worktable) return "This invitation can't be emailed"
  const db = requireTeamDatabase()
  db.query(
    "INSERT OR IGNORE INTO wt_invitation_details(worktable_id, invitation_id) VALUES (?, ?)"
  ).run(worktable.id, invitationId)
  const claimed = db
    .query(
      `UPDATE wt_invitation_details SET last_attempt_at = ?
       WHERE worktable_id = ? AND invitation_id = ?
         AND email_sends < ?
         AND (last_emailed_at IS NULL OR last_emailed_at <= ?)
         AND (last_attempt_at IS NULL OR last_attempt_at <= ?)`
    )
    .run(
      now,
      worktable.id,
      invitationId,
      MAX_INVITATION_EMAILS,
      now - INVITATION_EMAIL_COOLDOWN_MS,
      now - INVITATION_EMAIL_ATTEMPT_MS
    )
  if (claimed.changes === 1) return null
  const current = invitationDetails(invitationId)
  if ((current?.emailSends ?? 0) >= MAX_INVITATION_EMAILS)
    return "This invitation has been emailed as often as it can be. Copy the link instead."
  // A failed attempt holds off the next one briefly, so a retry loop can't
  // keep calling out; only a delivered email waits the full cooldown.
  return current?.lastEmailedAt != null &&
    now - current.lastEmailedAt < INVITATION_EMAIL_COOLDOWN_MS
    ? "This invitation was just emailed. Try again in a few minutes."
    : "Try again in a moment."
}

function spaceVisibility(spaceId: string): "shared" | "restricted" {
  return accessSnapshot()?.visibility.get(spaceId) ?? "restricted"
}

/**
 * An inviter may name any Space they can see. A restricted Space also needs
 * them to manage it, because accepting the invitation grants access to it.
 */
export function assertInvitationStartSpace(
  inviter: TeamMember,
  spaceId: string
): void {
  const current = accessSnapshot()
  if (!current) throw new TeamAccessError()
  const level = memberLevel(current, inviter, spaceId)
  if (!levelAtLeast(level, "read"))
    throw new TeamAccessError("Space not found", "SPACE_NOT_FOUND")
  if (spaceVisibility(spaceId) === "restricted" && !levelAtLeast(level, "manage"))
    throw new TeamAccessError(
      "Only people who manage this Space can invite someone into it",
      "SPACE_MANAGE_REQUIRED"
    )
}

/**
 * Runs inside the acceptance lifecycle, after enrollment. A restricted
 * starting Space is granted only if it still exists and the inviter still
 * manages it, read inside the same write as the grant, so an invitation can
 * never give more access than its inviter holds at that moment.
 */
export function applyInvitationStartSpace(
  invitation: { id: string; inviterId: string; organizationId: string },
  memberId: string
): void {
  const worktable = currentTeamWorktable()
  const spaceId = invitationDetails(invitation.id)?.startSpaceId
  if (!worktable || !spaceId || !spaceInventory().ids.includes(spaceId)) return
  const db = requireTeamDatabase()
  db.transaction(() => {
    const visibility = db
      .query<{ visibility: string }, [string, string]>(
        "SELECT visibility FROM wt_space_policy WHERE worktable_id = ? AND space_id = ?"
      )
      .get(worktable.id, spaceId)?.visibility
    if (visibility === "shared") return
    const inviter = db
      .query<{ id: string; role: string }, [string, string]>(
        "SELECT id, role FROM member WHERE userId = ? AND organizationId = ?"
      )
      .get(invitation.inviterId, invitation.organizationId)
    if (!inviter) return
    const manages =
      inviter.role === "owner" ||
      db
        .query<{ access: string }, [string, string, string]>(
          "SELECT access FROM wt_space_grants WHERE worktable_id = ? AND space_id = ? AND subject_type = 'member' AND subject_id = ?"
        )
        .get(worktable.id, spaceId, inviter.id)?.access === "manage"
    if (!manages) return
    db.query(
      `INSERT INTO wt_space_grants(worktable_id, space_id, subject_type, subject_id, access)
       VALUES (?, ?, 'member', ?, 'edit')
       ON CONFLICT(worktable_id, space_id, subject_type, subject_id)
       DO UPDATE SET access = CASE WHEN access = 'manage' THEN 'manage' ELSE 'edit' END`
    ).run(worktable.id, spaceId, memberId)
    advanceTeamPolicy(worktable.id)
  }).immediate()
}

/**
 * The Space a newly joined member should open: the invitation's, if they can
 * see it now, or else Getting Started, where their own first steps are.
 * Never an archived Space.
 */
export function invitationLandingSpace(
  invitationId: string,
  userId: string
): string | null {
  const member = findTeamMember(userId)
  const current = accessSnapshot()
  if (!member || !current) return null
  const visible = (spaceId: string) =>
    spaceInventory().ids.includes(spaceId) &&
    levelAtLeast(memberLevel(current, member, spaceId), "read")
  const spaceId = invitationDetails(invitationId)?.startSpaceId
  if (spaceId && visible(spaceId) && spaceOpen(spaceId)) return spaceId
  return gettingStartedOpen() && visible(GETTING_STARTED_SPACE_ID)
    ? GETTING_STARTED_SPACE_ID
    : null
}

/** Enough of an address for its owner to recognize it, not to harvest it. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@")
  if (at <= 0) return "•••"
  return `${email[0]}•••${email.slice(at)}`
}

/** A specific reason an invitation can't be accepted, for the person holding it. */
export function unavailableInvitation(invitation: {
  status: string
  expiresAt: number | string
} | null): TeamAccessError | null {
  if (!invitation)
    return new TeamAccessError(
      "This invitation is no longer available",
      "INVITATION_UNAVAILABLE"
    )
  if (invitation.status === "accepted")
    return new TeamAccessError(
      "This invitation has already been used",
      "INVITATION_USED"
    )
  if (invitation.status !== "pending")
    return new TeamAccessError(
      "This invitation was canceled",
      "INVITATION_CANCELED"
    )
  const expiresAt =
    typeof invitation.expiresAt === "number"
      ? invitation.expiresAt
      : Date.parse(invitation.expiresAt)
  if (!(expiresAt > Date.now()))
    return new TeamAccessError(
      "This invitation has expired",
      "INVITATION_EXPIRED"
    )
  return null
}

