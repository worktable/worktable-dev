// Kept apart from the storage schemas, so a browser bundle that reads a
// version id's time doesn't take zod with it.

/**
 * The time a version id names: when its content was last saved, even for a
 * version that merged rapid saves (its createdAt is the first of them).
 */
export function versionIdTimestamp(versionId: string): number | null {
  const match = versionId.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/
  )
  if (!match) return null
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
  const timestamp = Date.parse(iso)
  return Number.isNaN(timestamp) ? null : timestamp
}
