/** A Doc's name as a skill name: lowercase words joined by hyphens. */
export function skillNameFrom(title: string): string {
  const name = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "")
  return name || "skill"
}

/** What a Doc's last save made: its version and the hash of its content. */
export interface DocLastSave {
  versionId: string
  contentHash: string
}

/**
 * Whether a Doc was changed since a skill's live version, so saving the
 * skill would change what agents get. Content hashes compare where the live
 * version recorded one, so a save of the same content, such as another
 * library's Save of the same Doc, changes nothing; otherwise versions do.
 */
export function savedSinceLive(
  live: { generationId: string; contentHash?: string } | null | undefined,
  lastSave: DocLastSave | null | undefined
): boolean {
  if (!live || !lastSave) return false
  return live.contentHash
    ? lastSave.contentHash !== live.contentHash
    : lastSave.versionId !== live.generationId
}
