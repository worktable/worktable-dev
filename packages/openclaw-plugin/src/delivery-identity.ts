export function worktableConversationId(
  spaceId: string,
  threadId: string
): string {
  return `${spaceId}/${threadId}`
}

export function worktableDeliveryEventId(
  spaceId: string,
  threadId: string,
  messageId: string
): string {
  return `${worktableConversationId(spaceId, threadId)}/${messageId}`
}

export function worktableThreadTarget(
  spaceId: string,
  threadId: string
): string {
  return `thread:${worktableConversationId(spaceId, threadId)}`
}
