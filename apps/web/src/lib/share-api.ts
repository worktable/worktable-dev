import { fetchJSON } from "./http.ts"

export type ShareArtifact = {
  kind: "doc" | "html"
  spaceId: string
  artifactKey: string
}

export interface PublicShare {
  url: string
  createdAt: string
}

export interface ShareStatus {
  share: PublicShare | null
}

export function shareQueryKey(artifact: ShareArtifact) {
  return [
    "document-share",
    artifact.kind,
    artifact.spaceId,
    artifact.artifactKey,
  ] as const
}

export function getDocumentShare(
  artifact: ShareArtifact
): Promise<ShareStatus> {
  const query = new URLSearchParams(artifact)
  return fetchJSON<ShareStatus>(`/api/shares?${query.toString()}`)
}

export function createDocumentShare(
  artifact: ShareArtifact
): Promise<ShareStatus> {
  return fetchJSON<ShareStatus>("/api/shares", {
    method: "POST",
    body: JSON.stringify(artifact),
  })
}

export function stopDocumentShare(
  artifact: ShareArtifact
): Promise<{ ok: true }> {
  return fetchJSON<{ ok: true }>("/api/shares", {
    method: "DELETE",
    body: JSON.stringify(artifact),
  })
}
