import type {
  CreatedShareLink,
  CreateShareLinkInput,
  DocumentShareLinks,
  ShareLink,
  ShareTarget,
  UpdateShareLinkInput,
} from "@worktable/types"
import { fetchJSON } from "./http.ts"

// ── Links (v2): several per document ───────────────────────────

/** One document's links, read when its share dialog opens. */
export function shareLinksQueryKey(spaceId: string, path: string) {
  return ["share-links", "document", spaceId, path] as const
}

// Loaded with link management. The page trigger only needs status and keys.
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
