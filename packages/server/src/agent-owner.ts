import { isHosted } from "./hosted.ts"
import { participantsByKey, resolveParticipant } from "./participant-store.ts"
import { teamsEnabled } from "./team-database.ts"
import { identityForTeamMember } from "./team-identity.ts"
import { findTeamMemberById } from "./team-members.ts"
import { teamAgentForParticipantKey } from "./team-policy.ts"

/**
 * Who connected the agents in a delivery, for an adapter that acts on its own
 * machine: it takes direction from the person who connected it, and by
 * default from the other agents that person connected.
 */
export interface ConnectedBy {
  /**
   * This Worktable has one person. Every person it lists is that person,
   * under whichever credential they post, and every agent is theirs.
   */
  onePerson: boolean
  /** The person who connected the agent the delivery is for. */
  recipient: string | null
  /** The person who connected the author, when the author is an agent. */
  author: string | null
}

/**
 * The person who connected an agent on a Team Worktable, as the thread member
 * that person posts as: a personal agent's member. An agent the team owns has
 * nobody on record.
 */
async function teamAgentConnectedBy(
  agentParticipantId: string
): Promise<string | null> {
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

export async function deliveryConnectedBy(
  recipientParticipantId: string,
  authorAgentParticipantId: string | null
): Promise<ConnectedBy> {
  if (!teamsEnabled()) {
    // A self-hosted Worktable without Teams has one person, who may post as
    // more than one thread member (the owner, or a bearer token of their
    // own). A hosted one that is not yet a Team has no owner to speak of.
    return { onePerson: !isHosted(), recipient: null, author: null }
  }
  return {
    onePerson: false,
    recipient: await teamAgentConnectedBy(recipientParticipantId),
    author: authorAgentParticipantId
      ? await teamAgentConnectedBy(authorAgentParticipantId)
      : null,
  }
}
