// ============================================================
// Auto-reply: whether an agent answers what's sent to it on its own
// ============================================================
//
// One state per connected agent, from what already knows it: a chat's live
// subscription (mcp-events.ts), a session waiting right now (pending-wait.ts),
// or an agent Worktable calls (OpenClaw, Hermes), or a cloud task Worktable
// fires for Claude (cloud-task-runtime.ts). A Grok Bot's comes from its own
// status, which the list already carries. Agents with none of these see
// what's waiting the next time someone uses them.

import {
  agentConnectionPlatform,
  type AgentConnection,
  type AutoReply,
} from "@worktable/types"
import { readCloudTasks, type CloudTask } from "./cloud-task-store.ts"
import { configuredMcpSurface, mcpModernEraEnabled } from "./mcp/surface.ts"
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
  // Unreadable state leaves those agents unknown, never the list unloaded.
  const watching = modern
    ? await watchingParticipants().catch(() => {
        console.error("[Worktable] MCP event subscriptions could not be read")
        return null
      })
    : new Map()
  const tasks =
    configuredMcpSurface() === "preview" &&
    connections.some(
      (connection) => agentConnectionPlatform(connection) === "claude"
    )
      ? await readCloudTasks()
          .then((all) => new Map(all.map((t) => [t.participantId, t])))
          .catch(() => {
            console.error("[Worktable] Cloud tasks could not be read")
            return null
          })
      : null
  return connections.map((connection) => {
    const autoReply = autoReplyFor(connection, { modern, watching, tasks })
    return autoReply ? { ...connection, autoReply } : connection
  })
}

/** A cloud task is on once a test reached the agent, until it needs attention. */
function taskAutoReply(task: CloudTask | undefined): AutoReply {
  if (!task) return { kind: "task", state: "off" }
  if (task.error) return { kind: "task", state: "attention", error: task.error }
  if (task.testingSince !== undefined)
    return { kind: "task", state: "off", testing: true }
  return { kind: "task", state: task.enabled && task.verifiedAt ? "on" : "off" }
}

function autoReplyFor(
  connection: AgentConnection,
  known: {
    modern: boolean
    watching: Awaited<ReturnType<typeof watchingParticipants>> | null
    tasks: Map<string, CloudTask> | null
  }
): AutoReply | undefined {
  // Cloud sign-ins record no platform; their name says which app they are.
  const platform = agentConnectionPlatform(connection)
  if (platform === "grok-bot") return undefined
  if (CALLED.has(platform)) return { kind: "called", state: "on" }
  if (platform === "claude" && known.tasks) {
    const id = connection.participant?.id
    return taskAutoReply(id ? known.tasks.get(id) : undefined)
  }
  if (!known.modern) return undefined
  // An agent not used yet has no participant, and so nothing on.
  const id = connection.participant?.id
  const watched = id ? known.watching?.get(id) : undefined
  const waiting = id ? isWaiting(id) : false
  if (platform === "chatgpt" && !known.watching) return undefined
  if (platform === "chatgpt" || watched)
    return watched
      ? {
          kind: "chat",
          state: "on",
          ...(watched.all ? {} : { spaceIds: watched.spaceIds }),
        }
      : { kind: "chat", state: "off" }
  if (platform === "claude-code" || waiting)
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
