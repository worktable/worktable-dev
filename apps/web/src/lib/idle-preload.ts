// Code for screens a tab hasn't opened yet loads while the tab is idle, so a
// first visit waits only on its data. Each chunk loads in its own idle period,
// and only while no request or navigation is in flight, so it never competes
// with the screen being shown. A browser that asks to save data, or a 2G
// connection, loads nothing ahead.

type Preload = () => Promise<unknown> | undefined

/** The parts of the Network Information API this reads, where it exists. */
interface Connection {
  saveData?: boolean
  effectiveType?: string
}

// requestIdleCallback runs a task within this long even when the tab never
// goes idle; browsers without it wait this long instead.
const IDLE_TIMEOUT_MS = 2_000
const IDLE_FALLBACK_MS = 200
// How often to look again while requests are in flight.
const BUSY_RETRY_MS = 500

function idle(delayMs: number): Promise<void> {
  return new Promise((resolve) =>
    setTimeout(() => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(() => resolve(), { timeout: IDLE_TIMEOUT_MS })
      } else {
        setTimeout(resolve, IDLE_FALLBACK_MS)
      }
    }, delayMs)
  )
}

function declined(): boolean {
  const connection =
    typeof navigator === "undefined"
      ? undefined
      : (navigator as Navigator & { connection?: Connection }).connection
  return (
    connection?.saveData === true ||
    (connection?.effectiveType?.endsWith("2g") ?? false)
  )
}

/**
 * Run `preloads` in order, one per idle period while `busy` is false. A
 * failed preload is left for the visit that needs it. Returns a function
 * that stops the remaining preloads.
 */
export function preloadWhenIdle(
  preloads: readonly Preload[],
  busy: () => boolean
): () => void {
  let stopped = false
  void (async () => {
    for (const preload of preloads) {
      await idle(0)
      while (!stopped && busy()) await idle(BUSY_RETRY_MS)
      // The connection can change between preloads.
      if (stopped || declined()) return
      await Promise.resolve()
        .then(preload)
        .catch(() => {})
    }
  })()
  return () => {
    stopped = true
  }
}
