import type { Context } from "hono"
import { authRequired, canManageUserSettings } from "./auth.ts"
import { isHosted } from "./hosted.ts"
import { cachedParticipantForKey, participantKey } from "./participant-store.ts"
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

export interface PersonSummary {
  /** Their participant id where they have one, which Threads also show. */
  id: string
  name: string
  role: "owner" | "member"
  /** How Activity names them as its actor, so it can say "You". */
  activityId: string
  /** How this person signs out here, or null when there is no session. */
  signOut: "team" | "cloud" | "password" | null
}

/** Who is using this Worktable, for the sidebar. */
export function personSummary(c: Context): PersonSummary | null {
  if (!personalPreferencesKey(c)) return null
  const identity = c.get("identity")!
  const participant = cachedParticipantForKey(participantKey(identity))
  const member = teamsEnabled() ? teamMemberForIdentity(identity) : null
  if (member) {
    return {
      id: participant?.id ?? member.actorId,
      name: member.name,
      role: member.role,
      activityId: identity.principal.id,
      signOut: isHosted() ? "cloud" : "team",
    }
  }
  return {
    id: participant?.id ?? identity.principal.id,
    name: participant?.name ?? "Owner",
    role: "owner",
    activityId: identity.principal.id,
    signOut: isHosted() ? "cloud" : authRequired() ? "password" : null,
  }
}
