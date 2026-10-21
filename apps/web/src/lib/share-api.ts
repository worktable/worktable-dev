import type {
  CreatedShareLink,
  CreateShareLinkInput,
  DocumentShareLinks,
  ShareLink,
  ShareTarget,
  UpdateShareLinkInput,
} from "@worktable/types"
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

// ── Links (v2): several per document ───────────────────────────

/** One document's links, read when its share dialog opens. */
export function shareLinksQueryKey(spaceId: string, path: string) {
  return ["share-links", "document", spaceId, path] as const
}

export function getDocumentShareLinks(
  target: ShareTarget
): Promise<DocumentShareLinks> {
  const query = new URLSearchParams(target)
  return fetchJSON<DocumentShareLinks>(`/api/shares/links?${query.toString()}`)
}

/** The response is the only time the link's URL is shown. */
export function createShareLink(
  input: CreateShareLinkInput
): Promise<CreatedShareLink> {
  return fetchJSON<CreatedShareLink>("/api/shares/links", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export function updateShareLink(
  id: string,
  change: UpdateShareLinkInput
): Promise<{ link: ShareLink }> {
  return fetchJSON<{ link: ShareLink }>(
    `/api/shares/links/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(change) }
  )
}

export function revokeShareLink(id: string): Promise<{ link: ShareLink }> {
  return fetchJSON<{ link: ShareLink }>(
    `/api/shares/links/${encodeURIComponent(id)}`,
    { method: "DELETE" }
  )
}
