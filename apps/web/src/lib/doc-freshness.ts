import { sourceCategory, type DocFreshness, type DocSourceCategory } from "@worktable/types";

/** Chip wording for who last wrote a doc. Single-user workspace: human = "You". */
export const CATEGORY_LABELS: Record<DocSourceCategory, string> = {
  human: "You",
  agent: "Agent",
  external: "File",
  system: "System",
  restore: "Restore",
};

/**
 * Who to attribute the doc's current state to. Leads with `humanReviewed`
 * because a review checkpoint's provenance source is "manual-checkpoint",
 * which the raw source heuristics would misread as "system".
 */
export function docAttribution(
  provenance: { source?: string; updatedBy?: string } | undefined,
  freshness: DocFreshness | undefined
): DocSourceCategory {
  if (freshness?.humanReviewed) return "human";
  return sourceCategory(provenance?.source, provenance?.updatedBy);
}

/** Tooltip copy for a stale marker — shared by Space Home and the sidebar dots. */
export function staleTitle(freshness: DocFreshness): string {
  if (freshness.lastHumanTouch) {
    const days = Math.max(
      0,
      Math.floor((Date.now() - new Date(freshness.lastHumanTouch).getTime()) / 86_400_000)
    );
    return `No review or human edit in ${days} days`;
  }
  // Never human-touched: the server's stale basis is the last write, so
  // ageDays carries the duration.
  if (freshness.ageDays !== null) {
    return `Never reviewed by a human — last changed ${freshness.ageDays} days ago`;
  }
  return "Never reviewed or edited by a human";
}
