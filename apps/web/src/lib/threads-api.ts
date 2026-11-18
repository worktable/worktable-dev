import type {
  AgentPlatformId,
  ParticipantRef,
  ThreadLocation,
  ThreadMessage,
  ThreadPostResponse,
  ThreadReadResult,
  ThreadListResult,
  ThreadRenameResult,
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

export function threadBase(location: ThreadLocation): string {
  return location.kind === "worktable"
    ? "/api/threads"
    : `/api/spaces/${encodeURIComponent(location.spaceId)}/threads`
}

/** Current identities, keyed by participant or activity principal id. */
export type ParticipantPresentations = Record<
  string,
  Pick<ThreadParticipant, "platform" | "icon"> & {
    id?: string
    /** An agent's Threads participant; a person's is id. */
    participantId?: string
    name?: string
    /** A person's photo, named by its content. */
    photo?: string
  }
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

/** Who comments in a Space can be sent to: everyone who may read it. */
export function listCommentRecipients(
  spaceId: string
): Promise<{ participants: ThreadParticipant[] }> {
  return fetchJSON(
    `/api/spaces/${encodeURIComponent(spaceId)}/annotations/recipients`
  )
}

/** The threads in lists now, or only the archived ones. */
export function listThreads(
  scope: ThreadListScope,
  archived: "exclude" | "only",
  options?: ReadOptions
): Promise<ThreadListResult> {
  const query = new URLSearchParams({ archived })
  if (scope.kind === "worktable") query.set("location", "worktable")
  const base = scope.kind === "space" ? threadBase(scope) : "/api/threads"
  return fetchJSON(`${base}?${query}`, options)
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
    to?: string
    notifyIdentityIds?: string[]
    responseIdentityId?: string | null
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

export function renameThread(
  location: ThreadLocation,
  threadId: string,
  input: { title: string; expectedTitle: string }
): Promise<ThreadRenameResult> {
  return fetchJSON(`${threadBase(location)}/${encodeURIComponent(threadId)}`, {
    method: "PATCH",
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
