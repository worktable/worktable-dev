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
