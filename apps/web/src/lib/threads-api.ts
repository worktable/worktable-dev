import type {
  ParticipantRef,
  ThreadLocation,
  ThreadMessage,
  ThreadPostResult,
  ThreadReadResult,
  ThreadSummary,
  ThreadWaitResult,
} from "@worktable/types"
import { fetchJSON } from "./http"

export type ThreadListScope = { kind: "all" } | ThreadLocation
export type ThreadParticipant = ParticipantRef & {
  defaultIdentityId: string
  alwaysOn: boolean
}
type ThreadManagementResult = { threadId: string; revision: number }

export function threadScopeContains(
  scope: ThreadListScope,
  location: ThreadLocation
): boolean {
  if (scope.kind === "all") return true
  if (scope.kind === "worktable") return location.kind === "worktable"
  return location.kind === "space" && scope.spaceId === location.spaceId
}

function threadBase(location: ThreadLocation): string {
  return location.kind === "worktable"
    ? "/api/threads"
    : `/api/spaces/${encodeURIComponent(location.spaceId)}/threads`
}

export function listThreadParticipants(
  location: ThreadLocation = { kind: "worktable" }
): Promise<{ participants: ThreadParticipant[] }> {
  return fetchJSON(`${threadBase(location)}/participants`)
}

export function listThreads(
  scope: ThreadListScope
): Promise<{ threads: ThreadSummary[] }> {
  if (scope.kind === "all") return fetchJSON("/api/threads")
  if (scope.kind === "worktable") {
    return fetchJSON("/api/threads?location=worktable")
  }
  return fetchJSON(threadBase(scope))
}

export function readThread(
  location: ThreadLocation,
  threadId: string,
  options: { after?: number; before?: number } = {}
): Promise<ThreadReadResult> {
  const query = new URLSearchParams()
  if (options.after !== undefined) query.set("after", String(options.after))
  if (options.before !== undefined) query.set("before", String(options.before))
  const suffix = query.size > 0 ? `?${query}` : ""
  return fetchJSON(
    `${threadBase(location)}/${encodeURIComponent(threadId)}${suffix}`
  )
}

export function readThreadMessage(
  location: ThreadLocation,
  threadId: string,
  messageId: string
): Promise<{ message: ThreadMessage }> {
  return fetchJSON(
    `${threadBase(location)}/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`
  )
}

export function createThread(
  location: ThreadLocation,
  input: {
    to: string
    body: string
    idempotencyKey: string
    waitSeconds?: number
  }
): Promise<ThreadPostResult> {
  return fetchJSON(threadBase(location), {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export function postThreadReply(
  location: ThreadLocation,
  threadId: string,
  input: {
    body: string
    idempotencyKey: string
    notifyIdentityIds?: string[]
    responseIdentityId?: string | null
    inReplyTo?: string
    responseTo?: string | null
    waitSeconds?: number
  }
): Promise<ThreadPostResult> {
  return fetchJSON(
    `${threadBase(location)}/${encodeURIComponent(threadId)}/messages`,
    {
      method: "POST",
      body: JSON.stringify(input),
    }
  )
}

export function assignThreadMessage(
  location: ThreadLocation,
  threadId: string,
  messageId: string,
  identityId: string | null
): Promise<ThreadManagementResult> {
  return fetchJSON(
    `${threadBase(location)}/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/assignment`,
    { method: "PUT", body: JSON.stringify({ identityId }) }
  )
}

export function waitForThread(
  location: ThreadLocation,
  threadId: string,
  input: {
    after: number
    activityRevision?: number
    waitSeconds?: number
  }
): Promise<ThreadWaitResult> {
  const query = new URLSearchParams({
    after: String(input.after),
    activityRevision: String(input.activityRevision ?? -1),
    waitSeconds: String(input.waitSeconds ?? 25),
  })
  return fetchJSON(
    `${threadBase(location)}/${encodeURIComponent(threadId)}/wait?${query}`
  )
}
