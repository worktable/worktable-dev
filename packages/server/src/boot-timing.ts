/**
 * Startup phase timing. `WORKTABLE_BOOT_TIMING=1` logs how long each boot
 * phase took and when it finished, in milliseconds since the process started.
 * Without it, each phase costs one environment lookup.
 */
function bootTimingEnabled(): boolean {
  return process.env["WORKTABLE_BOOT_TIMING"] === "1"
}

function logPhase(name: string, started: number): void {
  const ended = performance.now()
  console.log(
    `[boot] ${name}: ${(ended - started).toFixed(1)} ms (done at ${Math.round(ended)} ms)`
  )
}

const noop = (): void => {}

/** Start timing a phase; call the returned function when it ends. */
export function startBootPhase(name: string): () => void {
  if (!bootTimingEnabled()) return noop
  const started = performance.now()
  return () => logPhase(name, started)
}

/** Time background work that starts now, whether it settles or fails. */
export function timeBootTask(name: string, work: Promise<unknown>): void {
  if (!bootTimingEnabled()) return
  const started = performance.now()
  const done = () => logPhase(name, started)
  void work.then(done, done)
}

/** Log the moment a boot milestone is reached. */
export function markBootMilestone(name: string): void {
  if (!bootTimingEnabled()) return
  console.log(`[boot] ${name} at ${Math.round(performance.now())} ms`)
}
