/** Someone a comment or message can go to. */
interface Recipient {
  kind: "human" | "agent" | "system"
  name: string
}

/** A comment box's placeholder, by who the comment goes to. */
export function commentPlaceholder(recipient: Recipient | undefined): string {
  if (recipient?.kind === "agent") return `Ask ${recipient.name}…`
  if (recipient?.kind === "human") return `Write to ${recipient.name}…`
  return "Leave a note…"
}

/**
 * A thread composer's placeholder. Just you and one agent: that agent.
 * With more in the thread, a reply comes from the agent you @mention.
 */
export function threadPlaceholder(
  memberCount: number,
  directAgentName: string | undefined
): string {
  if (directAgentName) return `Message ${directAgentName}…`
  if (memberCount > 2) return "@mention an agent to get a reply"
  return "Reply in this thread…"
}
