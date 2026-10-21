import type { ThreadLocation } from "./threads"

// Dependency-free values for code on the web app's startup path. Importing
// them must not pull in Zod or any schema module; the lint config enforces it.

/** A Space shows at most this many pinned starting points. */
export const START_HERE_LIMIT = 7

/** The longest label a share link takes. */
export const SHARE_LINK_LABEL_MAX_LENGTH = 80

export function threadLocationKey(location: ThreadLocation): string {
  return location.kind === "worktable"
    ? "worktable"
    : `space:${location.spaceId}`
}

/** Collection, record and widget ids: lowercase letters, digits and inner dashes. */
export const CANONICAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/

export function isCanonicalId(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_ID_PATTERN.test(value)
}

/** Record query predicate operators. */
export const RECORD_PREDICATE_OPS = [
  "eq",
  "neq",
  "in",
  "contains",
  "has",
  "gt",
  "gte",
  "lt",
  "lte",
  "isEmpty",
] as const
