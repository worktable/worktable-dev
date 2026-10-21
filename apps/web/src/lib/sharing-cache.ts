import type { QueryClient } from "@tanstack/react-query"
import { documentQueryKeys } from "./documents-queries"
import { openShareLinkCount } from "./share-links"
import type { ShareLink, DocumentPageResult } from "@worktable/types"

const revisions = new WeakMap<QueryClient, number>()

/** A creator's access can change while the reader's own access stays the same.
 * Refresh only cached sharing views, leaving document contents and lists alone. */
export function invalidateSharingQueries(
  client: QueryClient,
  revision?: number
): void {
  // A tab can receive the same revision on several Space streams.
  if (revision !== undefined) {
    if (revision === revisions.get(client)) return
    revisions.set(client, revision)
  }
  for (const query of client.getQueryCache().findAll()) {
    const key = query.queryKey
    const page = query.state.data as DocumentPageResult | undefined
    if (
      key[0] === "share-links" ||
      key[0] === "share-policy" ||
      (key[0] === "spaces" &&
        key[2] === "document-page" &&
        page?.kind === "document" &&
        page.sharing)
    ) {
      void client.invalidateQueries({ queryKey: key, exact: true })
    }
  }
}

/** Keep the count and deadline in step with the latest document link list. */
export function notePageLinks(
  queryClient: QueryClient,
  spaceId: string,
  path: string,
  links: readonly ShareLink[]
): void {
  const activeLinks = openShareLinkCount(links)
  const expiry = links.reduce(
    (soonest, link) =>
      link.status === "active" && link.expiresAt
        ? Math.min(soonest, Date.parse(link.expiresAt))
        : soonest,
    Infinity
  )
  const nextExpiry = Number.isFinite(expiry)
    ? new Date(expiry).toISOString()
    : undefined
  queryClient.setQueryData<DocumentPageResult>(
    documentQueryKeys.page(spaceId, path),
    (page) =>
      page?.kind === "document" &&
      page.sharing &&
      (page.sharing.activeLinks !== activeLinks ||
        page.sharing.nextExpiry !== nextExpiry)
        ? { ...page, sharing: { ...page.sharing, activeLinks, nextExpiry } }
        : undefined
  )
}
