// ============================================================
// Document lifetime rules
// ============================================================
//
// A temporary document carries an archive date (`archiveOn`) chosen at a
// known time (`lifetimeSetAt`). Changing its content after that choice keeps
// it active for at least the grace period from the change. Content changes
// are read from the document's last-modified time, so every write path —
// browser, agent, filesystem — extends it without a format-specific hook.
// Renames and comments do not modify content and extend the stored date
// explicitly instead.

import { TEMPORARY_DOCUMENT_GRACE_DAYS } from "@worktable/types"
import type { DocLifetimeFacts } from "./store.ts"

export const TEMPORARY_GRACE_MS = TEMPORARY_DOCUMENT_GRACE_DAYS * 86_400_000

export function graceEndsAt(fromMs: number): string {
  return new Date(fromMs + TEMPORARY_GRACE_MS).toISOString()
}

/**
 * When a temporary document actually archives: its chosen date, or later when
 * its content changed after that date was chosen. Undefined for durable
 * documents.
 */
export function effectiveArchiveOn(
  facts: DocLifetimeFacts | undefined,
  contentUpdatedAt?: string
): string | undefined {
  if (!facts?.archiveOn) return undefined
  let due = Date.parse(facts.archiveOn)
  const changed = contentUpdatedAt ? Date.parse(contentUpdatedAt) : Number.NaN
  const chosen = facts.lifetimeSetAt
    ? Date.parse(facts.lifetimeSetAt)
    : Number.NEGATIVE_INFINITY
  if (Number.isFinite(changed) && changed > chosen) {
    due = Math.max(due, changed + TEMPORARY_GRACE_MS)
  }
  return new Date(due).toISOString()
}
