import { useQuery } from "@tanstack/react-query"
import { readDocVersion, type DocVersionEntry } from "./docs-api"
import { readWidgetVersion } from "./widgets-api"
import { spaceAccessKey } from "./team-access"
import { browserTeamMemberId } from "./team-context"

export type HistoryKind = "doc" | "html"
type VersionSnapshot = DocVersionEntry & {
  after: DocVersionEntry["after"] & { content: unknown }
}

export const versionHistoryKeys = {
  list: (kind: HistoryKind, spaceId: string, path: string, revision: string) =>
    ["spaces", spaceId, "document-history", kind, path, revision] as const,
  snapshot: (
    kind: HistoryKind,
    spaceId: string,
    path: string,
    versionId: string | null
  ) =>
    [
      "spaces",
      spaceId,
      "document-content",
      path,
      "version-history",
      kind,
      versionId,
      spaceAccessKey(spaceId),
    ] as const,
}

/** Read only the selected snapshot; returning to it reuses the same content. */
export function useVersionSnapshot(
  kind: HistoryKind,
  spaceId: string,
  path: string,
  versionId: string | null
) {
  return useQuery({
    queryKey: versionHistoryKeys.snapshot(kind, spaceId, path, versionId),
    queryFn: async (): Promise<VersionSnapshot> =>
      kind === "doc"
        ? readDocVersion(spaceId, path, versionId!)
        : readWidgetVersion(spaceId, path, versionId!),
    enabled:
      Boolean(versionId) &&
      (!browserTeamMemberId() || Boolean(spaceAccessKey(spaceId))),
    staleTime: Infinity,
    retry: false,
  })
}
