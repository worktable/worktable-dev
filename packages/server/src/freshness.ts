// ============================================================
// Derived doc freshness / trust signals
// ============================================================
//
// lastHumanTouch, humanReviewed, ageDays, and stale are always
// derived from version history and provenance — never stored, so
// they cannot drift, and never writable over MCP, so an agent
// cannot launder its own output into "reviewed".
//
// Cache correctness does not depend on invalidation: entries are
// keyed by provenance.versionId, which changes on every content
// write (including external edits recorded by the watcher), so a
// mismatch forces a rescan. Eviction hooks bound memory, drop
// deleted docs, and let retention pruning force a rescan (the cache
// itself lives in freshness-cache.ts so version-retention.ts can
// evict without importing store.ts through this module).

import type { DocFreshness, DocListEntry } from "@worktable/types";
import {
  clearFreshnessCache,
  evictFreshness,
  getFreshnessCacheGeneration,
  getFreshnessCacheEntry,
  setFreshnessCacheEntryIfCurrent,
  type FreshnessCacheEntry,
} from "./freshness-cache.ts";
import { onWorkspaceChange } from "./workspace-events.ts";

export { evictFreshness };

// Workspace replacement and any future storage provider use the same event
// seam. Cache invalidation therefore follows the content change, not the one
// executor that currently emits it.
onWorkspaceChange((event) => {
  if (event.type === "workspaceReset") clearFreshnessCache();
});
import {
  getDocProvenance,
  listDocVersions,
  readSpace,
  sourceCategory,
  type DocProvenance,
  type DocVersionEntry,
} from "./store";
import { getWikiConfig, WIKI_DEFAULTS } from "./wiki-config";

/** A version counts as a human touch when a person edited or reviewed it. */
export function isHumanTouch(version: DocVersionEntry): boolean {
  if (version.checkpoint?.kind === "review") return true;
  if (version.checkpoint?.kind === "manual" && version.checkpoint.sourceCategory === "human") {
    return true;
  }
  return sourceCategory(version.source, version.createdBy) === "human";
}

function daysSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86_400_000));
}

async function scanVersions(
  spaceId: string,
  docPath: string,
  currentVersionId?: string,
): Promise<Omit<FreshnessCacheEntry, "provenanceVersionId">> {
  const versions = await listDocVersions(spaceId, docPath);
  // Provenance is the authoritative pointer to the live snapshot. Prefer it
  // over inferred list order so legacy same-millisecond ids (which predate the
  // sequence suffix) cannot make an agent version masquerade as current.
  const newest =
    (currentVersionId
      ? versions.find((version) => version.id === currentVersionId)
      : undefined) ?? versions[0];
  const lastHuman = versions.find(isHumanTouch);
  return {
    lastHumanTouch: lastHuman?.createdAt ?? null,
    humanReviewed: newest !== undefined && isHumanTouch(newest),
  };
}

async function scanAndCacheFreshness(
  spaceId: string,
  docPath: string,
  provenanceVersionId: string,
): Promise<FreshnessCacheEntry> {
  for (;;) {
    const generation = getFreshnessCacheGeneration();
    const entry = {
      provenanceVersionId,
      ...(await scanVersions(spaceId, docPath, provenanceVersionId || undefined)),
    };
    if (setFreshnessCacheEntryIfCurrent(spaceId, docPath, entry, generation)) {
      return entry;
    }
  }
}

export async function getDocFreshness(
  spaceId: string,
  docPath: string,
  opts?: { provenance?: DocProvenance; staleAgeDays?: number }
): Promise<DocFreshness> {
  const provenance = opts?.provenance ?? (await getDocProvenance(spaceId, docPath));
  const staleAgeDays = opts?.staleAgeDays ?? WIKI_DEFAULTS.staleAgeDays;
  let entry: FreshnessCacheEntry | undefined = getFreshnessCacheEntry(spaceId, docPath);
  if (!provenance) {
    // Doc has no recorded writes (e.g. created before versioning). Derive
    // nothing rather than guessing; a scan may still find imported history.
    if (!entry) {
      entry = await scanAndCacheFreshness(spaceId, docPath, "");
    }
  } else if (!entry || entry.provenanceVersionId !== provenance.versionId) {
    entry = await scanAndCacheFreshness(spaceId, docPath, provenance.versionId);
  }

  const now = Date.now();
  const lastTouch = provenance?.updatedAt ?? null;
  const ageDays = lastTouch ? daysSince(lastTouch, now) : null;
  const staleBasis = entry.lastHumanTouch ?? lastTouch;
  const stale = staleBasis !== null && daysSince(staleBasis, now) > staleAgeDays;

  return {
    lastHumanTouch: entry.lastHumanTouch,
    ageDays,
    humanReviewed: entry.humanReviewed,
    stale,
  };
}

/** Decorate a doc list in place-order with freshness, using the space's staleness threshold. */
export async function decorateDocsWithFreshness(
  spaceId: string,
  docs: DocListEntry[]
): Promise<DocListEntry[]> {
  const space = await readSpace(spaceId);
  const { staleAgeDays } = getWikiConfig(space.data);
  return Promise.all(docs.map(async (doc) => ({
    ...doc,
    freshness: await getDocFreshness(spaceId, doc.path, {
      provenance: doc.provenance,
      staleAgeDays,
    }),
  })));
}
