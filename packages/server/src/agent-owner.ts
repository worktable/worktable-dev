import { ownerIdentity } from "./auth.ts"
import { isHosted } from "./hosted.ts"
import { participantsByKey, resolveParticipant } from "./participant-store.ts"
import { teamsEnabled } from "./team-database.ts"
import { identityForTeamMember } from "./team-identity.ts"
import { findTeamMemberById } from "./team-members.ts"
import { teamAgentForParticipantKey } from "./team-policy.ts"

/**
 * The person who connected an agent, as the thread member that person posts
 * as. An adapter that acts on its own machine takes direction from this
 * person, and by default from the other agents this person connected.
 *
 * With Teams that is a personal agent's member; an agent the team owns has
 * nobody. A one-person Worktable has its owner. A hosted Worktable that is
 * not yet a Team has no local owner to name.
 */
export async function agentConnectedBy(
  agentParticipantId: string
): Promise<string | null> {
  if (teamsEnabled()) {
    let key: string | undefined
    for (const [candidate, participant] of await participantsByKey()) {
      if (participant.id === agentParticipantId) {
        key = candidate
        break
      }
    }
    const agent = key ? teamAgentForParticipantKey(key) : null
    const member =
      agent?.ownership === "personal" && agent.memberId
        ? findTeamMemberById(agent.memberId)
        : null
    if (!member) return null
    return (
      await resolveParticipant(identityForTeamMember(member), {
        initialName: member.name,
      })
    ).participant.id
  }
  if (isHosted()) return null
  return (await resolveParticipant(ownerIdentity())).participant.id
}
