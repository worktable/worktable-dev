// ============================================================
// Reuse rule for derived per-document caches
// ============================================================
//
// Search and the link graph keep what they extracted from each document
// together with the source revision they saw (format, modification time and
// any catalog metadata). Change events are hints; the revision decides
// whether a cached extraction is still current. A source modified shortly
// before it was read can change again without a visible timestamp change, so
// such entries are re-read until they settle: the racy-timestamp rule Git
// uses for its index.

export const RACY_TIMESTAMP_MS = 2_000

export interface DerivedRevision {
  revision: string
  /** Date.now() taken before the source was read. */
  readAt: number
}

export function canReuseDerived(
  cached: DerivedRevision | undefined,
  revision: string,
  modifiedAtMs: number | undefined
): boolean {
  return (
    cached !== undefined &&
    cached.revision === revision &&
    modifiedAtMs !== undefined &&
    Number.isFinite(modifiedAtMs) &&
    modifiedAtMs < cached.readAt - RACY_TIMESTAMP_MS
  )
}
