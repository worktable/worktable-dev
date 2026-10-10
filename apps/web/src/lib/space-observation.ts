// What this tab has observed of each Space's change stream.
//
// A read stays good while the Space's socket is live and caught up past it:
// the server sends every change in the Space on that socket, so if nothing
// arrived after a request began, its answer still holds. Any change message,
// or losing the socket, starts a new generation, which retires every earlier
// proof at once.

interface SpaceObservation {
  generation: number
  /** The server has confirmed this tab's subscription and it is still open. */
  live: boolean
}

/** What was known about a Space when a request began. */
export interface SpaceMark {
  generation: number
  live: boolean
  /** performance.now() when the request began. */
  at: number
}

interface ObservationGlobal {
  __worktableSpaceObservations?: Map<string, SpaceObservation>
  __worktableSpaceReadMarks?: Map<string, SpaceMark>
}

// Route chunks can each carry a copy of this module; share one registry.
const browserGlobal = globalThis as typeof globalThis & ObservationGlobal
const observations =
  browserGlobal.__worktableSpaceObservations ??
  (browserGlobal.__worktableSpaceObservations = new Map())
const readMarks =
  browserGlobal.__worktableSpaceReadMarks ??
  (browserGlobal.__worktableSpaceReadMarks = new Map())

function observation(spaceId: string): SpaceObservation {
  let entry = observations.get(spaceId)
  if (!entry) {
    entry = { generation: 0, live: false }
    observations.set(spaceId, entry)
  }
  return entry
}

/** The workspace thread stream, observed like a Space. */
export const THREAD_STREAM = "\0threads"

/** Whether this tab is subscribed and caught up on the stream right now. */
export function isSpaceLive(spaceId: string): boolean {
  return observations.get(spaceId)?.live === true
}

/** Whether any stream is live, so the server can reach this tab at all. */
export function anyStreamLive(): boolean {
  for (const entry of observations.values()) if (entry.live) return true
  return false
}

/**
 * Refresh interval for a list the socket keeps current: none while the
 * Space's socket is live, a slow check otherwise. Workspace-wide lists have
 * no single socket, so they keep the slow check.
 */
export function pollUnlessLive(
  spaceId: string | undefined,
  intervalMs = 60_000
): () => number | false {
  return () => (spaceId && isSpaceLive(spaceId) ? false : intervalMs)
}

/** Something in the Space changed, or may have changed unseen. */
export function noteSpaceChange(spaceId: string): void {
  observation(spaceId).generation += 1
}

/** The Space's socket became caught up (subscribed) or stopped being so. */
export function noteSpaceLive(spaceId: string, live: boolean): void {
  const entry = observation(spaceId)
  if (entry.live === live) return
  entry.live = live
  // Losing the stream may hide changes; catching up reveals none by itself.
  if (!live) entry.generation += 1
}

export function markSpace(spaceId: string): SpaceMark {
  const entry = observation(spaceId)
  return {
    generation: entry.generation,
    live: entry.live,
    at: performance.now(),
  }
}

/** No change or connection transition reached this tab since the mark. */
export function spaceUnchangedSince(spaceId: string, mark: SpaceMark): boolean {
  return observation(spaceId).generation === mark.generation
}

/**
 * The mark was taken on a live socket that has stayed live with nothing new
 * since, so a read that began at the mark is still current.
 */
export function spaceValidatedLive(spaceId: string, mark: SpaceMark): boolean {
  const entry = observation(spaceId)
  return mark.live && entry.live && entry.generation === mark.generation
}

/**
 * Run a Space read and remember what the tab knew when it began, under `key`.
 * Later callers can ask whether that answer is still proven current.
 */
export async function trackSpaceRead<T>(
  spaceId: string,
  key: string,
  read: () => Promise<T>
): Promise<T> {
  const mark = markSpace(spaceId)
  const value = await read()
  readMarks.set(key, mark)
  return value
}

export function spaceReadMark(key: string): SpaceMark | undefined {
  return readMarks.get(key)
}

/** For tests: forget everything observed. */
export function resetSpaceObservations(): void {
  observations.clear()
  readMarks.clear()
}
