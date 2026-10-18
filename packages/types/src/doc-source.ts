export type DocSourceCategory =
  | "human"
  | "agent"
  | "external"
  | "system"
  | "restore"

/**
 * Classify who a doc write came from. Single source of truth shared by the
 * server (checkpoint labels) and the web UI (version history) — keep the
 * heuristics here so the two can never disagree.
 */
export function sourceCategory(
  source?: string,
  updatedBy?: string
): DocSourceCategory {
  const normalizedSource = (source ?? "").toLowerCase()
  const normalizedBy = (updatedBy ?? "").toLowerCase()
  if (normalizedSource === "version-restore") return "restore"
  // A browser persist with no human-edit signal is machine normalization
  // drift, not a human touch — must never launder to "human".
  if (normalizedSource === "browser-yjs-sync") return "system"
  if (normalizedSource === "browser-yjs") return "human"
  if (normalizedSource === "mcp" || normalizedBy.includes("agent"))
    return "agent"
  if (normalizedSource === "filesystem") return "external"
  if (normalizedSource === "rest-api") {
    if (normalizedBy === "user" || normalizedBy === "human") return "human"
    if (normalizedBy && normalizedBy !== "unknown") return "agent"
    return "system"
  }
  return "system"
}
