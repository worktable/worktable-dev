// ============================================================
// Wiki conventions configuration
// ============================================================
//
// Central home for the thresholds behind freshness, lint, and
// write-time guidance. Values are defaults; a space can override
// any of them under settings.wiki (validated leniently — unknown
// or malformed keys fall back to the default).

import type { SpaceFile } from "@worktable/types";

export interface WikiConfig {
  /** Days without a human touch before a doc reads as stale. */
  staleAgeDays: number;
  /** Soft length budget for markdown docs, in lines. */
  docLengthBudgetLines: number;
  /** Soft length budget for BlockNote docs, in blocks. */
  docLengthBudgetBlocks: number;
  /** Folder nesting depth beyond which guidance warns. */
  folderDepthBudget: number;
  /** Seconds a doc must be visible and focused before the UI infers a review. */
  reviewDwellSeconds: number;
}

export const WIKI_DEFAULTS: WikiConfig = {
  staleAgeDays: 30,
  docLengthBudgetLines: 400,
  docLengthBudgetBlocks: 300,
  folderDepthBudget: 2,
  reviewDwellSeconds: 10,
};

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function getWikiConfig(space?: Pick<SpaceFile, "settings"> | null): WikiConfig {
  const overrides = space?.settings?.["wiki"];
  if (!overrides || typeof overrides !== "object") return { ...WIKI_DEFAULTS };
  const candidate = overrides as Record<string, unknown>;
  return {
    staleAgeDays: positiveNumber(candidate["staleAgeDays"], WIKI_DEFAULTS.staleAgeDays),
    docLengthBudgetLines: positiveNumber(candidate["docLengthBudgetLines"], WIKI_DEFAULTS.docLengthBudgetLines),
    docLengthBudgetBlocks: positiveNumber(candidate["docLengthBudgetBlocks"], WIKI_DEFAULTS.docLengthBudgetBlocks),
    folderDepthBudget: positiveNumber(candidate["folderDepthBudget"], WIKI_DEFAULTS.folderDepthBudget),
    reviewDwellSeconds: positiveNumber(candidate["reviewDwellSeconds"], WIKI_DEFAULTS.reviewDwellSeconds),
  };
}
