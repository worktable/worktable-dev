import {
  emailTeamInvitation,
  inviteTeamMember,
  type InvitationEmailStatus,
} from "./team-api"

export interface Invited {
  email: string
  /** Missing on results saved before invitations could be emailed again. */
  id?: string
  url?: string
  status?: InvitationEmailStatus | null
  error?: string
}

/** Invite each address; one that fails doesn't stop the rest. */
export async function invitePeople(emails: string[]): Promise<Invited[]> {
  const results: Invited[] = []
  for (const email of emails) {
    try {
      const result = await inviteTeamMember(email)
      results.push({
        email,
        id: result.invitation.id,
        url: result.url,
        status: result.email,
      })
    } catch (error) {
      results.push({
        email,
        error: error instanceof Error ? error.message : "Couldn’t invite",
      })
    }
  }
  return results
}

/** Newer results replace earlier ones for the same address, in place. */
export function mergeInvited(
  earlier: Invited[] | undefined,
  results: Invited[]
): Invited[] {
  const kept = (earlier ?? []).map(
    (item) => results.find((result) => result.email === item.email) ?? item
  )
  return [
    ...kept,
    ...results.filter(
      (result) => !earlier?.some((item) => item.email === result.email)
    ),
  ]
}

/** Emails the invitation again; the result says how that went. */
export async function sendInvitationAgain(invited: Invited): Promise<Invited> {
  const result = await emailTeamInvitation(invited.id!)
  return { ...invited, status: result.email }
}

/**
 * Why an invitation wasn't emailed, and whether sending it again can help.
 * Nothing to say when it was sent or this Worktable doesn't email.
 */
export function invitationEmailNote(
  status: InvitationEmailStatus | null | undefined
): { reason: string; retry: boolean } | null {
  switch (status) {
    case "failed":
      return { reason: "Email didn’t send", retry: true }
    case "unavailable":
      return { reason: "Email unavailable right now", retry: true }
    case "limited":
      return { reason: "Email limit reached", retry: false }
    case "not_allowed":
      return { reason: "Can’t email this address here", retry: false }
    default:
      return null
  }
}

/**
 * A pending invitation in Settings: its detail line and the email action,
 * both from how its latest email went.
 */
export function pendingInvitationEmail(
  invitation: { emailed: boolean; emailStatus: InvitationEmailStatus | null },
  emailing: boolean
): { detail: string; send: string | null } {
  if (!emailing) return { detail: "Invited", send: null }
  const note = invitationEmailNote(invitation.emailStatus)
  return {
    detail: note
      ? `Invited · ${note.reason}`
      : invitation.emailed
        ? "Invited"
        : "Invited · Not emailed yet",
    send:
      note && !note.retry
        ? null
        : invitation.emailed || invitation.emailStatus
          ? "Send again"
          : "Send email",
  }
}

export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
