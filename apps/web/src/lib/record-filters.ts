import type { RecordPredicateOp } from "@worktable/types"
import { RECORD_PREDICATE_OPS } from "@worktable/types/constants"

// Search validation for the records route runs on every navigation, so it is
// part of the startup bundle. Keep this module free of schema imports.

/** One filter chip: a predicate-AST leaf with compact keys for the URL. */
export interface RecordFilter {
  f: string
  op: RecordPredicateOp
  v?: unknown
}

/** Structural validation for one filter: does the value shape fit the
 *  operator? Malformed chips (shared URLs, stale localStorage) must be
 *  dropped BEFORE compiling, or the server 400s the whole grid query. */
export function isValidFilter(filter: RecordFilter): boolean {
  if (
    !filter.f ||
    !(RECORD_PREDICATE_OPS as readonly string[]).includes(filter.op)
  )
    return false
  switch (filter.op) {
    case "isEmpty":
      return filter.v === undefined || typeof filter.v === "boolean"
    case "contains":
      return typeof filter.v === "string"
    case "has":
      return ["string", "number", "boolean"].includes(typeof filter.v)
    case "in":
      return (
        Array.isArray(filter.v) &&
        filter.v.every((entry) =>
          ["string", "number", "boolean"].includes(typeof entry)
        )
      )
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return typeof filter.v === "string" || typeof filter.v === "number"
    default:
      // eq / neq
      return ["string", "number", "boolean"].includes(typeof filter.v)
  }
}
