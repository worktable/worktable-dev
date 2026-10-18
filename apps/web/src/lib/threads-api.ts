import type {
  AgentPlatformId,
  ParticipantRef,
  ThreadLocation,
  ThreadMessage,
  ThreadPostResponse,
  ThreadReadResult,
  ThreadListItem,
  ThreadWaitResult,
} from "@worktable/types"
import { fetchJSON, type ReadOptions } from "./http"

export type ThreadListScope = { kind: "all" } | ThreadLocation
export type ThreadParticipant = ParticipantRef & {
  defaultIdentityId: string
  alwaysOn: boolean
  /** For a connected agent: where it comes from and the icon its owner chose. */
  platform?: AgentPlatformId
  icon?: string | null
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

/** Current identities, keyed by participant or activity principal id. */
export type ParticipantPresentations = Record<
  string,
  Pick<ThreadParticipant, "platform" | "icon"> & { id?: string; name?: string }
>

export function listThreadParticipants(
  location: ThreadLocation = { kind: "worktable" }
): Promise<{
  participants: ThreadParticipant[]
  /** Saved people and agents, including agents no longer offered as recipients. */
  presentations?: ParticipantPresentations
}> {
  return fetchJSON(`${threadBase(location)}/participants`)
}

export function listThreads(
  scope: ThreadListScope,
  options?: ReadOptions
): Promise<{ threads: ThreadListItem[] }> {
  if (scope.kind === "all") return fetchJSON("/api/threads", options)
  if (scope.kind === "worktable") {
    return fetchJSON("/api/threads?location=worktable", options)
  }
  return fetchJSON(threadBase(scope), options)
}

export function readThread(
  location: ThreadLocation,
  threadId: string,
  options: { after?: number; before?: number } & ReadOptions = {}
): Promise<ThreadReadResult> {
  const query = new URLSearchParams()
  if (options.after !== undefined) query.set("after", String(options.after))
  if (options.before !== undefined) query.set("before", String(options.before))
  const suffix = query.size > 0 ? `?${query}` : ""
  return fetchJSON(
    `${threadBase(location)}/${encodeURIComponent(threadId)}${suffix}`,
    { signal: options.signal }
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
): Promise<ThreadPostResponse> {
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
): Promise<ThreadPostResponse> {
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
