import type {
  CreatedShareLink,
  CreateShareLinkInput,
  DocumentShareLinks,
  ShareLink,
  ShareLinksPage,
  ShareTarget,
  SharingPolicy,
  SharingPolicyResponse,
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
  input: Pick<CreateShareLinkInput, "target" | "label" | "expiresAt">
): Promise<CreatedShareLink> {
  return fetchJSON<CreatedShareLink>("/api/shares/links", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export function updateShareLink(
  id: string,
  change: Pick<UpdateShareLinkInput, "label" | "expiresAt">
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

// ── Settings → Links ───────────────────────────────────────────

/** Which links Settings → Links lists. Without a status, all but revoked. */
export interface ShareLinksFilters {
  spaceId?: string
  status?: "expired" | "revoked"
}

/** Every link the reader may oversee, read when Settings → Links opens. */
export function allShareLinksQueryKey(filters: ShareLinksFilters) {
  return ["share-links", "all", filters] as const
}

export function getShareLinksPage(
  filters: ShareLinksFilters,
  cursor: string | null
): Promise<ShareLinksPage> {
  const query = new URLSearchParams()
  if (filters.spaceId) query.set("spaceId", filters.spaceId)
  if (filters.status) query.set("status", filters.status)
  if (cursor) query.set("cursor", cursor)
  const search = query.toString()
  return fetchJSON<ShareLinksPage>(
    `/api/shares/links/all${search ? `?${search}` : ""}`
  )
}

/** The owner policy; only owners read it. */
export const SHARE_POLICY_QUERY_KEY = ["share-policy"] as const

export function getSharingPolicy(): Promise<SharingPolicyResponse> {
  return fetchJSON<SharingPolicyResponse>("/api/shares/policy")
}

/** Saved whole; it applies from every link's next view. */
export function saveSharingPolicy(
  policy: SharingPolicy
): Promise<SharingPolicyResponse> {
  return fetchJSON<SharingPolicyResponse>("/api/shares/policy", {
    method: "PUT",
    body: JSON.stringify(policy),
  })
}
