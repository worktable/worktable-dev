import type { Context } from "hono"
import { canManageUserSettings } from "./auth.ts"
import { participantKey } from "./participant-store.ts"
import { teamsEnabled } from "./team-database.ts"
import { canAccessSpace, teamMemberForIdentity } from "./team-policy.ts"

/**
 * The person whose own preferences this request may read and change: a team
 * member, or the owner of a Worktable without Teams. Agents never qualify.
 */
export function personalPreferencesKey(c: Context): string | null {
  const identity = c.get("identity")
  if (!identity || identity.agent || identity.principal.type !== "human") {
    return null
  }
  if (teamsEnabled()) {
    return teamMemberForIdentity(identity) ? participantKey(identity) : null
  }
  return canManageUserSettings(c) ? participantKey(identity) : null
}

export function canReadSpaceFor(c: Context): (spaceId: string) => boolean {
  const identity = c.get("identity")
  return (spaceId) => canAccessSpace(spaceId, "read", identity)
}
