import type { SpaceFile } from "@worktable/types"

/** "side-quests" → "Side Quests". */
export function formatGroupLabel(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

/** Archive metadata only when well formed, matching the server's reading. */
export function getSpaceArchiveInfo(space: SpaceFile) {
  const value = space.settings["archive"]
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate["archivedAt"] !== "string" ||
    typeof candidate["archivedBy"] !== "string"
  ) {
    return undefined
  }

  return {
    archivedAt: candidate["archivedAt"],
    archivedBy: candidate["archivedBy"],
    ...(typeof candidate["reason"] === "string"
      ? { reason: candidate["reason"] }
      : {}),
  }
}
