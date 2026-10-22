import type { LinkGrant, ShareLinkAccess, ShareTarget } from "@worktable/types"
import { fetchJSON } from "./http.ts"

/** Loaded with the access editor; an explicit check creates no link. */
export function checkShareLinkAccess(
  target: ShareTarget,
  options: { grant?: LinkGrant; observe: boolean; linkId?: string }
): Promise<ShareLinkAccess> {
  return fetchJSON<ShareLinkAccess>("/api/shares/links/access", {
    method: "POST",
    body: JSON.stringify({ target, ...options }),
  })
}
