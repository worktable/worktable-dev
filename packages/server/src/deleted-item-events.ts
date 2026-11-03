// A delete notes that it left retired history or a Space trash entry in the
// workspace folder. The server registers a runner that moves them out soon
// after, in the background (deleted-items.ts). No I/O happens here, so a
// delete's request never waits on it; without a runner (tests, CLI) the next
// server start moves them.

const MOVE_DELAY_MS = 1_000

let runner: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | null = null

export function setDeletedItemsRunner(run: (() => void) | null): void {
  runner = run
  if (!run && timer) {
    clearTimeout(timer)
    timer = null
  }
}

export function noteDeletedItems(): void {
  if (!runner || timer) return
  timer = setTimeout(() => {
    timer = null
    runner?.()
  }, MOVE_DELAY_MS)
  timer.unref?.()
}
