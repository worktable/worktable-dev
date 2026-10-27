// ============================================================
// Auto-reply: whether an agent answers what's sent to it on its own
// ============================================================
//
// One state per connected agent, from what already knows it: a chat's live
// subscription (mcp-events.ts), a session waiting right now (pending-wait.ts),
// or an agent Worktable calls (OpenClaw, Hermes). A Grok Bot's comes from its
// own status, which the list already carries. Agents with none of these see
// what's waiting the next time someone uses them.

import type { AgentConnection, AutoReply } from "@worktable/types"
import { mcpModernEraEnabled } from "./mcp/surface.ts"
import { onWatchingChange, watchingParticipants } from "./mcp-events.ts"
import { isWaiting, onWaitingChange } from "./pending-wait.ts"
import { notifyWorkspaceChange } from "./workspace-events.ts"

const CALLED: ReadonlySet<string> = new Set(["openclaw", "hermes"])

/** The connections, each with its auto-reply when it has one. */
export async function withAutoReply(
  connections: AgentConnection[]
): Promise<AgentConnection[]> {
  // Chats and sessions answer through MCP 2026-07-28, served with the preview.
  const modern = mcpModernEraEnabled()
  const watching = modern ? await watchingParticipants() : new Map()
  return connections.map((connection) => {
    const autoReply = autoReplyFor(connection, { modern, watching })
    return autoReply ? { ...connection, autoReply } : connection
  })
}

function autoReplyFor(
  connection: AgentConnection,
  known: {
    modern: boolean
    watching: Awaited<ReturnType<typeof watchingParticipants>>
  }
): AutoReply | undefined {
  if (connection.platform === "grok-bot") return undefined
  if (CALLED.has(connection.platform)) return { kind: "called", state: "on" }
  if (!known.modern) return undefined
  // An agent not used yet has no participant, and so nothing on.
  const id = connection.participant?.id
  const watched = id ? known.watching.get(id) : undefined
  const waiting = id ? isWaiting(id) : false
  if (connection.platform === "chatgpt" || watched)
    return watched
      ? {
          kind: "chat",
          state: "on",
          ...(watched.all ? {} : { spaceIds: watched.spaceIds }),
        }
      : { kind: "chat", state: "off" }
  if (connection.platform === "claude-code" || waiting)
    return { kind: "session", state: waiting ? "on" : "off" }
  return undefined
}

/** Tell open screens when an agent starts or stops answering on its own. */
export function startAutoReplyNotices(): () => void {
  const changed = () => notifyWorkspaceChange({ type: "participants" })
  const offWatching = onWatchingChange(changed)
  const offWaiting = onWaitingChange(changed)
  return () => {
    offWatching()
    offWaiting()
  }
}
