// ============================================================
// Waiting for what's addressed to an agent
// ============================================================
//
// An agent that asks to wait gets the pending read's answer once something
// new arrives in its scope. Clients that support MCP tasks wait in the
// background (mcp/modern.ts); others hold one call for a bounded time, as a
// thread wait does. Either way the answer is the pending read in notices mode,
// so a wait shows and marks exactly what that read would.
//
// A wait selects by revision only, never by what was already shown. Marking
// is what completes a wait, so a wait that skipped shown items would lose
// them if its answer were lost on the way: asked again, it would find nothing.

import { resolveParticipant } from "./participant-store.ts"
import { onPendingChange } from "./pending-list.ts"
import {
  readPending,
  type PendingReadInput,
  type PendingReadResult,
} from "./pending-read.ts"
import type { TokenIdentity } from "./token-store.ts"

/** The longest one held call waits, the same as a thread wait. */
export const PENDING_WAIT_SECONDS = 25

/**
 * How long after its last check an agent still counts as waiting: longer than
 * a held call, and than a task's poll interval, with room for the call after.
 */
const WAITING_FOR_MS = 35_000

const waitingAt = new Map<string, number>()
const waitingListeners = new Set<() => void>()
let waitingTimer: ReturnType<typeof setTimeout> | undefined

/** That an agent is waiting for what's sent to it now. Kept in memory only. */
export function noteWaiting(participantId: string): void {
  const started = !isWaiting(participantId)
  waitingAt.set(participantId, Date.now())
  if (started) for (const listener of waitingListeners) listener()
  scheduleWaitingExpiry()
}

/** Whether an agent has waited, or polled its wait, within the last moments. */
export function isWaiting(participantId: string): boolean {
  const at = waitingAt.get(participantId)
  return at !== undefined && Date.now() - at < WAITING_FOR_MS
}

/** Called when an agent starts or stops waiting. */
export function onWaitingChange(listener: () => void): () => void {
  waitingListeners.add(listener)
  return () => waitingListeners.delete(listener)
}

function scheduleWaitingExpiry(): void {
  if (waitingTimer) clearTimeout(waitingTimer)
  waitingTimer = undefined
  if (!waitingAt.size) return
  const next = Math.min(...waitingAt.values()) + WAITING_FOR_MS
  waitingTimer = setTimeout(
    () => {
      waitingTimer = undefined
      let stopped = false
      for (const [id, at] of waitingAt)
        if (Date.now() - at >= WAITING_FOR_MS) {
          waitingAt.delete(id)
          stopped = true
        }
      if (stopped) for (const listener of waitingListeners) listener()
      scheduleWaitingExpiry()
    },
    Math.max(next - Date.now(), 0)
  )
  waitingTimer.unref?.()
}

type Reader = Pick<TokenIdentity, "agent" | "principal" | "scopes"> &
  Partial<TokenIdentity>

/**
 * The revision a wait reads after. Without one, what arrives from now on. A
 * revision the list never gave (state lost, or from elsewhere) reads from the
 * start: every open item in scope, shown or not, beats one missed.
 */
export function waitSince(since: number | undefined, revision: number): number {
  if (since === undefined) return revision
  return since > revision ? 0 : since
}

/**
 * The pending read once something after `since` arrives in scope, or the
 * count (0) when nothing does within `seconds`.
 */
export async function waitForPending(
  reader: Reader,
  input: Pick<PendingReadInput, "scope" | "since">,
  options: { seconds?: number; signal?: AbortSignal } = {}
): Promise<PendingReadResult> {
  const { participant } = await resolveParticipant(reader)
  let changed = Promise.withResolvers<void>()
  const off = onPendingChange((change) => {
    if (
      change.type === "added" &&
      change.entry.recipient.participantId === participant.id
    )
      changed.resolve()
  })
  try {
    const since = waitSince(
      input.since,
      (await readPending(reader, { mode: "count" })).revision
    )
    const seconds = Math.min(
      Math.max(options.seconds ?? PENDING_WAIT_SECONDS, 0),
      PENDING_WAIT_SECONDS
    )
    const deadline = Date.now() + seconds * 1000
    const ended = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.max(deadline - Date.now(), 0))
      timer.unref?.()
      options.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true }
      )
    })
    while (true) {
      noteWaiting(participant.id)
      const waiting = changed.promise
      const ready = await readyPending(reader, { scope: input.scope, since })
      if (ready) return ready
      if (Date.now() >= deadline || options.signal?.aborted)
        return { revision: since, count: 0 }
      await Promise.race([waiting, ended])
      changed = Promise.withResolvers<void>()
    }
  } finally {
    off()
  }
}

/**
 * The pending read in notices mode when something after `since` waits in
 * scope, else null. A read that returns nothing marks nothing.
 */
async function readyPending(
  reader: Reader,
  input: Pick<PendingReadInput, "scope"> & { since: number }
): Promise<PendingReadResult | null> {
  const result = await readPending(reader, { ...input, mode: "notices" })
  return result.items?.length ? result : null
}
