import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { readPassageAuthor } from "@/lib/documents-api"
import type { ActivityActor, DocumentPage } from "@worktable/types"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import { useWorkspace } from "@/lib/queries"
import { useSpaceParticipants } from "@/lib/threads-queries"
import type { ThreadParticipant } from "@/lib/threads-api"

export const NO_RECIPIENT = "none"

/**
 * Who has changed a Doc, newest first. Until the Space's activity summary is
 * built (after a restart) the page has none, so the last writer stands in.
 */
export function docContributors(
  page: Pick<DocumentPage, "contributors" | "provenance"> | null | undefined
): readonly ActivityActor[] | undefined {
  if (page?.contributors) return page.contributors.recent
  const provenance = page?.provenance
  const writer = provenance?.updatedBy
  if (!writer) return undefined
  // MCP writes record the principal itself, which for a Teams agent starts
  // with "agent:"; REST writes add that prefix to the principal.
  if (provenance.source === "mcp") return [{ kind: "agent", id: writer }]
  return writer.startsWith("agent:")
    ? [{ kind: "agent", id: writer.slice("agent:".length) }]
    : undefined
}

/** Selected text a comment is about. */
export interface CommentPassage {
  docPath: string
  quote: string
  prefix?: string
  suffix?: string
}

/** Who a comment in this Space can go to, and who it goes to unless changed. */
export interface CommentRecipients {
  options: ThreadParticipant[]
  /** The agent that most recently changed the Doc, when it can be sent to. */
  suggested: string
}

/**
 * The people and agents a comment can be sent to. It suggests whoever wrote
 * the selected text, or else the agent that last changed the Doc, since that
 * is usually who the comment is for; and no one when the writer of the text
 * is the person commenting.
 */
export function useCommentRecipients(
  spaceId: string | undefined,
  contributors: readonly ActivityActor[] | undefined,
  open: boolean,
  passage?: CommentPassage
): CommentRecipients | null {
  const enabled =
    useDeploymentInfo().data?.capabilities.commentRecipients === true
  const active = enabled && open && Boolean(spaceId)
  const participants = useSpaceParticipants(spaceId ?? "", active)
  const author = useQuery({
    queryKey: [
      "passage-author",
      spaceId,
      passage?.docPath,
      passage?.quote,
      passage?.prefix,
      passage?.suffix,
    ],
    queryFn: () => readPassageAuthor(spaceId!, passage!.docPath, passage!),
    enabled: active && Boolean(passage?.quote.trim()),
    staleTime: 30_000,
  })
  const workspace = useWorkspace().data
  const presentations = workspace?.presentations
  return useMemo(() => {
    if (!enabled || !participants.data) return null
    const options = participants.data.participants.filter(
      (participant) => participant.kind !== "system"
    )
    const offered = new Set(options.map((participant) => participant.id))
    const participantOf = (id: string) =>
      presentations?.[id]?.participantId ?? presentations?.[id]?.id ?? id
    const writer = author.data?.author
    const writerId = writer ? participantOf(writer.by) : null
    const self =
      writer &&
      (writerId === workspace?.person?.id ||
        writer.by === workspace?.person?.activityId)
    const suggested = self
      ? NO_RECIPIENT
      : writerId && offered.has(writerId)
        ? writerId
        : ((contributors ?? [])
            .filter((actor) => actor.kind === "agent")
            .map((actor) => participantOf(actor.id))
            .find((id) => offered.has(id)) ?? NO_RECIPIENT)
    return { options, suggested }
  }, [enabled, participants.data, presentations, contributors, author.data, workspace?.person])
}
