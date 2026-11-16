/**
 * A note Try Next started for one Doc. The Doc's comment box takes it the
 * next time it opens there, so the person only has to pick what it's about.
 * Kept in memory: a reload forgets it.
 */
let waiting: { spaceId: string; path: string; text: string } | null = null

export function startNote(spaceId: string, path: string, text: string): void {
  waiting = text ? { spaceId, path, text } : null
}

/** The note waiting for this Doc, if any. */
export function noteFor(
  spaceId: string | undefined,
  path: string | undefined
): string | null {
  return waiting && waiting.spaceId === spaceId && waiting.path === path
    ? waiting.text
    : null
}

/** The box took the note; later boxes open empty. */
export function clearNote(spaceId: string | undefined, path: string | undefined) {
  if (noteFor(spaceId, path) !== null) waiting = null
}
