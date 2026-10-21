import type {
  ShareLinksPage,
  SharingPolicy,
  SharingPolicyResponse,
} from "@worktable/types"
import { fetchJSON } from "./http.ts"

// Settings → Links: every link the reader oversees, and the owner policy.
// Apart from share-api so the page's Share button doesn't load them.

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

/**
 * Saved whole; it applies from every link's next view. Made from an older
 * revision than the server's, it is refused with 409 and the newer policy.
 */
export function saveSharingPolicy(
  policy: SharingPolicy,
  revision: number
): Promise<SharingPolicyResponse> {
  return fetchJSON<SharingPolicyResponse>("/api/shares/policy", {
    method: "PUT",
    headers: { "If-Match": `"${revision}"` },
    body: JSON.stringify(policy),
  })
}
