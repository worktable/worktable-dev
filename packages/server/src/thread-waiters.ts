import type { ThreadLocation } from "@worktable/types"
import { threadLocationKey } from "@worktable/types"
import { onWorkspaceChange, threadEventLocation } from "./workspace-events.ts"
import { readThread } from "./thread-store.ts"

type Resolve = () => void

const threadWaiters = new Map<string, Set<Resolve>>()
const inboxWaiters = new Map<string, Set<Resolve>>()
const threadRevisions = new Map<string, number>()
const inboxRevisions = new Map<string, number>()

function wake(
  map: Map<string, Set<Resolve>>,
  revisions: Map<string, number>,
  key: string
): void {
  revisions.set(key, (revisions.get(key) ?? 0) + 1)
  const waiters = map.get(key)
  if (!waiters) return
  map.delete(key)
  for (const resolve of waiters) resolve()
}

onWorkspaceChange(async (event) => {
  if (event.type === "thread") {
    const location = threadEventLocation(event)
    wake(
      threadWaiters,
      threadRevisions,
      `${threadLocationKey(location)}\0${event.threadId}`
    )
    wake(threadWaiters, threadRevisions, event.threadId)
    try {
      const thread = await readThread(location, event.threadId)
      // Passive mentions remain in the portable thread but do not activate an
      // agent inbox. Only an assignment creates work.
      const requestedIdentityIds = new Set(
        thread.messages.flatMap((message) =>
          message.responseRequest ? [message.responseRequest.identityId] : []
        )
      )
      const memberIds = new Set(
        thread.identities
          .filter((identity) => requestedIdentityIds.has(identity.id))
          .map((identity) => identity.memberId)
      )
      for (const memberId of memberIds) {
        wake(inboxWaiters, inboxRevisions, memberId)
      }
    } catch {
      // Deletions still wake thread readers. There is no remaining portable
      // membership or recipient set to target at the inbox layer.
    }
  } else if (event.type === "threadActivity") {
    const location = threadEventLocation(event)
    wake(
      threadWaiters,
      threadRevisions,
      `${threadLocationKey(location)}\0${event.threadId}`
    )
    wake(threadWaiters, threadRevisions, event.threadId)
    wake(inboxWaiters, inboxRevisions, event.participantId)
  }
})

function wait(
  map: Map<string, Set<Resolve>>,
  revisions: Map<string, number>,
  key: string,
  timeoutMs: number,
  afterRevision: number
): Promise<boolean> {
  if (timeoutMs <= 0) return Promise.resolve(false)
  if ((revisions.get(key) ?? 0) !== afterRevision) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const waiters = map.get(key) ?? new Set<Resolve>()
    let settled = false
    const finish = (changed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      waiters.delete(onChange)
      if (waiters.size === 0) map.delete(key)
      resolve(changed)
    }
    const onChange = () => finish(true)
    waiters.add(onChange)
    map.set(key, waiters)
    const timer = setTimeout(() => finish(false), timeoutMs)
  })
}

export function threadSignalRevision(
  locationOrThreadId: ThreadLocation | string,
  threadId?: string
): number {
  const key =
    typeof locationOrThreadId === "string"
      ? locationOrThreadId
      : `${threadLocationKey(locationOrThreadId)}\0${threadId ?? ""}`
  return threadRevisions.get(key) ?? 0
}

export function inboxSignalRevision(participantId: string): number {
  return inboxRevisions.get(participantId) ?? 0
}

export function waitForThreadSignal(
  locationOrThreadId: ThreadLocation | string,
  threadIdOrTimeout: string | number,
  timeoutOrRevision?: number,
  afterRevision?: number
): Promise<boolean> {
  const qualified = typeof locationOrThreadId !== "string"
  const threadId = qualified ? String(threadIdOrTimeout) : locationOrThreadId
  const key = qualified
    ? `${threadLocationKey(locationOrThreadId)}\0${threadId}`
    : threadId
  const timeoutMs = qualified
    ? (timeoutOrRevision ?? 0)
    : Number(threadIdOrTimeout)
  const revision =
    afterRevision ??
    (qualified
      ? threadSignalRevision(locationOrThreadId, threadId)
      : (timeoutOrRevision ?? threadSignalRevision(threadId)))
  return wait(threadWaiters, threadRevisions, key, timeoutMs, revision)
}

export function waitForInboxSignal(
  participantId: string,
  timeoutMs: number,
  afterRevision = inboxSignalRevision(participantId)
): Promise<boolean> {
  return wait(
    inboxWaiters,
    inboxRevisions,
    participantId,
    timeoutMs,
    afterRevision
  )
}
