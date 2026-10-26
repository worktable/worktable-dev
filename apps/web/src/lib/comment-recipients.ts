import { useMemo } from "react"
import type { ActivityActor } from "@worktable/types"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import { useWorkspace } from "@/lib/queries"
import { useSpaceParticipants } from "@/lib/threads-queries"
import type { ThreadParticipant } from "@/lib/threads-api"

export const NO_RECIPIENT = "none"

/** Who a comment in this Space can go to, and who it goes to unless changed. */
export interface CommentRecipients {
  options: ThreadParticipant[]
  /** The agent that most recently changed the Doc, when it can be sent to. */
  suggested: string
}

/**
 * The people and agents a comment can be sent to. It suggests the agent that
 * last changed the Doc, since that is usually who the comment is for.
 */
export function useCommentRecipients(
  spaceId: string | undefined,
  contributors: readonly ActivityActor[] | undefined,
  open: boolean
): CommentRecipients | null {
  const enabled =
    useDeploymentInfo().data?.capabilities.commentRecipients === true
  const participants = useSpaceParticipants(
    spaceId ?? "",
    enabled && open && Boolean(spaceId)
  )
  const presentations = useWorkspace().data?.presentations
  return useMemo(() => {
    if (!enabled || !participants.data) return null
    const options = participants.data.participants.filter(
      (participant) => participant.kind !== "system"
    )
    const offered = new Set(options.map((participant) => participant.id))
    const suggested =
      (contributors ?? [])
        .filter((actor) => actor.kind === "agent")
        .map(
          (actor) => presentations?.[actor.id]?.participantId ?? actor.id
        )
        .find((id) => offered.has(id)) ?? NO_RECIPIENT
    return { options, suggested }
  }, [enabled, participants.data, presentations, contributors])
}
