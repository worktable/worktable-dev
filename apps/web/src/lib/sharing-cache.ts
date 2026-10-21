import type { QueryClient } from "@tanstack/react-query"
import type { DocumentPageResult } from "@worktable/types"

/** A creator's access can change while the reader's own access stays the same.
 * Refresh only cached sharing views, leaving document contents and lists alone. */
export function invalidateSharingQueries(client: QueryClient): void {
  for (const query of client.getQueryCache().findAll()) {
    const key = query.queryKey
    const page = query.state.data as DocumentPageResult | undefined
    if (
      key[0] === "share-links" ||
      (key[0] === "spaces" &&
        key[2] === "document-page" &&
        page?.kind === "document" &&
        page.sharing)
    ) {
      void client.invalidateQueries({ queryKey: key, exact: true })
    }
  }
}
