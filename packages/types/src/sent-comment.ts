// Dependency-free, like constants.ts, but kept apart from it so the code
// that reads sent comments loads only with the screens that show them.
/** Annotation metadata naming the thread message a comment was sent in. */
export const ANNOTATION_SENT_TO_KEY = "worktable.sentTo"

/** Where a comment was last sent in a batch, and how far its recipient got. */
export interface SentCommentRef {
  threadId: string
  messageId: string
  to: { id: string; kind: "human" | "agent"; name: string }
  at: string
  state?: "queued" | "working" | "receiving" | "replied" | "failed"
}

/** Where a comment was last sent in a batch, if it was. No schema needed. */
export function annotationSentTo(annotation: {
  metadata?: Record<string, unknown>
}): SentCommentRef | null {
  const value = annotation.metadata?.[ANNOTATION_SENT_TO_KEY]
  if (!value || typeof value !== "object") return null
  const sent = value as Partial<SentCommentRef>
  const to = sent.to as Partial<SentCommentRef["to"]> | undefined
  return typeof sent.threadId === "string" &&
    typeof sent.messageId === "string" &&
    typeof sent.at === "string" &&
    typeof to?.id === "string" &&
    typeof to.name === "string" &&
    (to.kind === "human" || to.kind === "agent")
    ? (sent as SentCommentRef)
    : null
}
