/**
 * Addresses someone was inviting when they left to pay for a plan. Payment
 * returns to Home, not to where they typed them, so they wait here and go
 * out once the plan has room.
 */
const PREFIX = "worktable-invitees-after-payment:"
/** Long enough to pay, short enough that an abandoned payment is forgotten. */
const KEEP_MS = 60 * 60 * 1000

interface Kept {
  emails: string[]
  at: number
}

export function keepInviteesForPayment(
  workspaceId: string,
  emails: string[]
): void {
  try {
    localStorage.setItem(
      PREFIX + workspaceId,
      JSON.stringify({ emails, at: Date.now() } satisfies Kept)
    )
  } catch {
    // Without storage the addresses are typed again; nothing else is lost.
  }
}

/** The addresses kept for this Worktable, if still fresh. */
export function keptInvitees(workspaceId: string): string[] | null {
  try {
    const raw = localStorage.getItem(PREFIX + workspaceId)
    if (!raw) return null
    const kept = JSON.parse(raw) as Partial<Kept>
    if (
      typeof kept.at !== "number" ||
      Date.now() - kept.at > KEEP_MS ||
      !Array.isArray(kept.emails) ||
      !kept.emails.every((email) => typeof email === "string")
    ) {
      localStorage.removeItem(PREFIX + workspaceId)
      return null
    }
    return kept.emails
  } catch {
    return null
  }
}

export function forgetKeptInvitees(workspaceId: string): void {
  try {
    localStorage.removeItem(PREFIX + workspaceId)
  } catch {
    // Nothing to forget.
  }
}

/** Whether any Worktable has addresses waiting, without reading them. */
export function anyKeptInvitees(): boolean {
  try {
    for (let index = 0; index < localStorage.length; index++) {
      if (localStorage.key(index)?.startsWith(PREFIX)) return true
    }
  } catch {
    // No storage, nothing waiting.
  }
  return false
}
