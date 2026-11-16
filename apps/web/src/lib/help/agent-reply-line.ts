/** The agent's own line under Agent Replies, by its app. */
export function agentReplyLine(agentName: string, kind: string): string | null {
  switch (kind) {
    case "session":
      return `${agentName} answers here while you have it open.`
    case "called":
      return `${agentName} answers any time.`
    case "chat":
    case "task":
      return `${agentName} answers while Auto-reply is on.`
    default:
      return null
  }
}
