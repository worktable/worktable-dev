// The freshness scan cache, split from freshness.ts so modules that must not
// import store.ts (version-retention.ts — store.ts imports IT) can still evict
// entries. Zero imports on purpose; keep it that way.
//
// Correctness does not depend on eviction: entries are keyed by
// provenance.versionId, which changes on every content write. Eviction exists
// to bound memory, drop deleted docs, and — since retention pruning deletes the
// version files a scan derived lastHumanTouch/humanReviewed from WITHOUT
// changing provenance — to force a rescan after a sweep.

export interface FreshnessCacheEntry {
  provenanceVersionId: string;
  lastHumanTouch: string | null;
  humanReviewed: boolean;
}

const cache = new Map<string, FreshnessCacheEntry>();
let generation = 0;

function cacheKey(spaceId: string, docPath: string): string {
  return `${spaceId}:${docPath}`;
}

export function getFreshnessCacheEntry(
  spaceId: string,
  docPath: string,
): FreshnessCacheEntry | undefined {
  return cache.get(cacheKey(spaceId, docPath));
}

export function setFreshnessCacheEntry(
  spaceId: string,
  docPath: string,
  entry: FreshnessCacheEntry,
): void {
  cache.set(cacheKey(spaceId, docPath), entry);
}

export function getFreshnessCacheGeneration(): number {
  return generation;
}

export function setFreshnessCacheEntryIfCurrent(
  spaceId: string,
  docPath: string,
  entry: FreshnessCacheEntry,
  expectedGeneration: number,
): boolean {
  if (generation !== expectedGeneration) return false;
  setFreshnessCacheEntry(spaceId, docPath, entry);
  return true;
}

export function evictFreshness(spaceId: string, docPath?: string): void {
  generation += 1;
  if (docPath !== undefined) {
    cache.delete(cacheKey(spaceId, docPath));
    return;
  }
  const prefix = `${spaceId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export function clearFreshnessCache(): void {
  generation += 1;
  cache.clear();
}
