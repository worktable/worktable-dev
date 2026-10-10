import type { ThreadLocation } from "./threads"

// Dependency-free values for code on the web app's startup path. Importing
// them must not pull in Zod or any schema module; the lint config enforces it.

/** A Space shows at most this many pinned starting points. */
export const START_HERE_LIMIT = 7

export function threadLocationKey(location: ThreadLocation): string {
  return location.kind === "worktable"
    ? "worktable"
    : `space:${location.spaceId}`
}
