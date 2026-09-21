/**
 * Released V1 Space manifests accepted any directory-name identity. Preserve
 * those local names without allowing either host path separator or traversal.
 */
export function requireSafeLegacySpaceId(spaceId: string): string {
  if (
    spaceId.length === 0 ||
    spaceId === "." ||
    spaceId === ".." ||
    spaceId.includes("/") ||
    spaceId.includes("\\") ||
    spaceId.includes("\0")
  ) {
    throw new Error("legacy Space ID is unsafe")
  }
  return spaceId
}
