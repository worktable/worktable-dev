import { inviteTeamMember, type InvitationEmailStatus } from "./team-api"

export interface Invited {
  email: string
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
      results.push({ email, url: result.url, status: result.email })
    } catch (error) {
      results.push({
        email,
        error: error instanceof Error ? error.message : "Couldn’t invite",
      })
    }
  }
  return results
}

/** Newer results replace earlier ones for the same address. */
export function mergeInvited(
  earlier: Invited[] | undefined,
  results: Invited[]
): Invited[] {
  return [
    ...(earlier ?? []).filter(
      (item) => !results.some((result) => result.email === item.email)
    ),
    ...results,
  ]
}

export const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
