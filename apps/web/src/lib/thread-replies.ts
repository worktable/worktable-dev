import type { ParticipantRef, Thread, ThreadActivity } from "@worktable/types"

export function availableParticipantSelection(
  participants: ParticipantRef[],
  selectedId: string
): string {
  return participants.some((participant) => participant.id === selectedId)
    ? selectedId
    : (participants[0]?.id ?? "")
}

export function pendingHumanReplyTarget(
  thread: Thread,
  _activities: ThreadActivity[],
  viewerMemberId: string
): string | undefined {
  const viewer = thread.members.find((member) => member.id === viewerMemberId)
  if (viewer?.kind !== "human") return undefined
  const viewerIdentityIds = new Set(
    thread.identities
      .filter((identity) => identity.memberId === viewerMemberId)
      .map((identity) => identity.id)
  )
  return [...thread.messages].reverse().find((message) => {
    return (
      message.responseRequest?.status === "open" &&
      viewerIdentityIds.has(message.responseRequest.identityId)
    )
  })?.id
}
