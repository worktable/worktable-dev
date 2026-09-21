// ============================================================
// Derived HTML-doc (widget) freshness / trust signals
// ============================================================
//
// The same contract as doc freshness (freshness.ts): lastHumanTouch,
// humanReviewed, ageDays, and stale are always derived from the widget
// version log and provenance — never stored on widget.yaml, so they cannot
// drift, and never writable over MCP, so an agent cannot launder its own
// output into "reviewed". The cache keys on provenance.versionId, which
// changes on every recorded write (including watcher-recorded external
// edits), so a mismatch forces a rescan.

import type { DocFreshness, WidgetFile } from "@worktable/types";
import { readSpace } from "./store";
import { isHumanTouch } from "./freshness";
import { getWidgetProvenance, listWidgetVersions } from "./widget-version-store";
import { getWikiConfig, WIKI_DEFAULTS } from "./wiki-config";
import { onWorkspaceChange } from "./workspace-events";

/** A widget list entry decorated with derived freshness. */
export type WidgetListEntry = WidgetFile & { freshness?: DocFreshness };

interface FreshnessCacheEntry {
  provenanceVersionId: string;
  lastHumanTouch: string | null;
  humanReviewed: boolean;
}

const cache = new Map<string, FreshnessCacheEntry>();
let generation = 0;

function cacheKey(spaceId: string, widgetId: string): string {
  return `${spaceId}:${widgetId}`;
}

export function evictWidgetFreshness(spaceId: string, widgetId?: string): void {
  generation += 1;
  if (widgetId !== undefined) {
    cache.delete(cacheKey(spaceId, widgetId));
    return;
  }
  const prefix = `${spaceId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

function clearWidgetFreshnessCache(): void {
  generation += 1;
  cache.clear();
}

onWorkspaceChange((event) => {
  if (event.type === "workspaceReset") clearWidgetFreshnessCache();
});

/**
 * A records-connected widget renders live data, so the age of its HTML shell
 * says nothing about content staleness — a 60-day-old dashboard over a hot
 * collection is not stale. Any read grant marks it live.
 */
export function isRecordsConnected(widget: WidgetFile): boolean {
  const grants = widget.permissions?.records ?? {};
  return Object.values(grants).some((grant) => grant.read);
}

function daysSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86_400_000));
}

async function scanVersions(
  spaceId: string,
  widgetId: string,
  currentVersionId?: string,
): Promise<Omit<FreshnessCacheEntry, "provenanceVersionId">> {
  const versions = await listWidgetVersions(spaceId, widgetId);
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
  widgetId: string,
  provenanceVersionId: string,
): Promise<FreshnessCacheEntry> {
  for (;;) {
    const expectedGeneration = generation;
    const entry = {
      provenanceVersionId,
      ...(await scanVersions(
        spaceId,
        widgetId,
        provenanceVersionId || undefined,
      )),
    };
    if (generation !== expectedGeneration) continue;
    cache.set(cacheKey(spaceId, widgetId), entry);
    return entry;
  }
}

export async function getWidgetFreshness(
  spaceId: string,
  widget: WidgetFile,
  opts?: { staleAgeDays?: number }
): Promise<DocFreshness> {
  const provenance = await getWidgetProvenance(spaceId, widget.id);
  const staleAgeDays = opts?.staleAgeDays ?? WIKI_DEFAULTS.staleAgeDays;
  const key = cacheKey(spaceId, widget.id);

  let entry: FreshnessCacheEntry | undefined = cache.get(key);
  if (!provenance) {
    // Pre-history widget (created before versioning). Derive nothing rather
    // than guessing: never reviewed, age from the stored updatedAt below.
    if (!entry) {
      entry = await scanAndCacheFreshness(spaceId, widget.id, "");
    }
  } else if (!entry || entry.provenanceVersionId !== provenance.versionId) {
    entry = await scanAndCacheFreshness(
      spaceId,
      widget.id,
      provenance.versionId,
    );
  }

  const now = Date.now();
  const lastTouch = provenance?.updatedAt ?? widget.updatedAt ?? null;
  const ageDays = lastTouch ? daysSince(lastTouch, now) : null;
  const staleBasis = entry.lastHumanTouch ?? lastTouch;
  const stale =
    !isRecordsConnected(widget) &&
    staleBasis !== null &&
    daysSince(staleBasis, now) > staleAgeDays;

  return {
    lastHumanTouch: entry.lastHumanTouch,
    ageDays,
    humanReviewed: entry.humanReviewed,
    stale,
  };
}

/** Decorate a widget list with freshness, using the space's staleness threshold. */
export async function decorateWidgetsWithFreshness(
  spaceId: string,
  widgets: WidgetFile[]
): Promise<WidgetListEntry[]> {
  const space = await readSpace(spaceId);
  const { staleAgeDays } = getWikiConfig(space.data);
  return Promise.all(widgets.map(async (widget) => ({
    ...widget,
    freshness: await getWidgetFreshness(spaceId, widget, { staleAgeDays }),
  })));
}
