import { browserTeamCacheKey } from "./team-context";
export function workspaceCollaborationCacheKey(
  spaceId: string,
  docPath: string,
  workspaceEpoch: string,
  docEpoch = "legacy"
): string {
  const teamKey = browserTeamCacheKey()
  if (teamKey) {
    const key = `worktable-team:${encodeURIComponent(teamKey)}:${encodeURIComponent(spaceId)}:${encodeURIComponent(docPath)}-yjs-v1-${workspaceEpoch}`
    return docEpoch === "legacy" ? key : `${key}-${docEpoch}`
  }
  const legacyKey = `worktable-${spaceId}-${docPath}-yjs-v1-${workspaceEpoch}`
  return docEpoch === "legacy" ? legacyKey : `${legacyKey}-${docEpoch}`
}
