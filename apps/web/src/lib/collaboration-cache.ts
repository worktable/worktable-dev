export function workspaceCollaborationCacheKey(
  spaceId: string,
  docPath: string,
  workspaceEpoch: string,
  docEpoch = "legacy"
): string {
  const legacyKey = `worktable-${spaceId}-${docPath}-yjs-v1-${workspaceEpoch}`
  return docEpoch === "legacy" ? legacyKey : `${legacyKey}-${docEpoch}`
}
