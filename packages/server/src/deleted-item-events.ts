// A delete notes that it left retired history or a Space trash entry in the
// workspace folder. The server registers a runner that moves them out soon
// after, in the background (deleted-items.ts). No I/O happens here, so a
// delete's request never waits on it; without a runner (tests, CLI) the next
// server start moves them.
//
// A pass that an export, snapshot or replacement deferred asks to run again
// with a backoff, starting at a few seconds, so the items leave the
// workspace folder soon after the capture finishes.

const delays = {
  moveMs: 1_000,
  firstRetryMs: 2_000,
  maxRetryMs: 60_000,
}

let runner: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let nextRetryMs = delays.firstRetryMs

function schedule(delayMs: number): void {
  if (!runner || timer) return
  timer = setTimeout(() => {
    timer = null
    runner?.()
  }, delayMs)
  timer.unref?.()
}

export function setDeletedItemsRunner(run: (() => void) | null): void {
  runner = run
  nextRetryMs = delays.firstRetryMs
  if (!run && timer) {
    clearTimeout(timer)
    timer = null
  }
}

export function noteDeletedItems(): void {
  schedule(delays.moveMs)
}

/** The last pass was deferred: run again after a growing delay. */
export function retryDeletedItemsSoon(): void {
  schedule(nextRetryMs)
  nextRetryMs = Math.min(nextRetryMs * 2, delays.maxRetryMs)
}

/** The last pass finished: the next deferral starts the backoff again. */
export function settleDeletedItemsRetry(): void {
  nextRetryMs = delays.firstRetryMs
}

export function setDeletedItemsDelaysForTests(
  overrides: Partial<typeof delays> | null
): void {
  Object.assign(
    delays,
    { moveMs: 1_000, firstRetryMs: 2_000, maxRetryMs: 60_000 },
    overrides ?? {}
  )
  nextRetryMs = delays.firstRetryMs
}
