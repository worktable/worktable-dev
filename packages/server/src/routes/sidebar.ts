// ============================================================
// GET /api/sidebar: every Space's sidebar contents at once
// ============================================================
//
// Opening a Space in the sidebar shows its tree from four reads: the Space
// and its pins, its Docs list, its documents and its record collections.
// The app asks for all of them once, after its first screen settles, so a
// Space opens with its tree in the frame of the press instead of a round
// trip later. Each part is exactly what its own route sends, built by the
// same function and checked the same way: a Space the caller can't read is
// left out (listSpaces), and a part whose scope the caller lacks is too.

import { Hono } from "hono"
import { requireScope } from "../auth.ts"
import { mapWithConcurrency } from "../bounded-concurrency.ts"
import { recordIndex, recordIndexEnabled } from "../record-index.ts"
import { listSpaces } from "../store.ts"
import { teamsEnabled } from "../team-database.ts"
import { canAccessSpace } from "../team-policy.ts"
import { hasScope } from "../token-store.ts"
import { listSpaceDocs } from "./docs.ts"
import { listSpaceDocuments } from "./documents.ts"
import { listSpaceCollections } from "./records.ts"
import { readSpacePage } from "./spaces.ts"

/**
 * Spaces read at once. Each part is kept with the Space's catalog snapshot
 * or read through it, so a tab that opens while nothing changed costs a
 * check of each Space's snapshot, not a read of its files.
 */
const SPACE_CONCURRENCY = 4

export const sidebarRouter = new Hono()

sidebarRouter.get("/", requireScope("docs:read"), async (c) => {
  const identity = c.get("identity")
  const scopes = identity.scopes
  const spaces = await listSpaces()
  // Collections are counted from the record index; without it they would be
  // counted by reading every record file, so an opened Space reads its own.
  const collectionsReady =
    hasScope(scopes, "records:read") &&
    recordIndexEnabled() &&
    recordIndex.isReady()
  const entries = await mapWithConcurrency(
    spaces,
    SPACE_CONCURRENCY,
    // A Space that fails to read (its access revoked meanwhile, a file that
    // can't be read) is left to its own routes, which say what went wrong.
    async ({ id }) => {
      const [page, docs, documents, collections] = await Promise.all([
        readSpacePage(id, scopes),
        listSpaceDocs(id, true),
        hasScope(scopes, "documents:read")
          ? listSpaceDocuments(id, true)
          : null,
        collectionsReady ? listSpaceCollections(id) : null,
      ]).catch(() => [null, null, null, null] as const)
      if (!page || !docs) return null
      return {
        id,
        ...("page" in page ? { page: page.page } : {}),
        docs,
        ...(documents && "documents" in documents
          ? { documents: documents.documents }
          : {}),
        ...(collections && "collections" in collections
          ? { collections: collections.collections }
          : {}),
      }
    }
  )
  // Access can change while the Spaces are read; send only what the caller
  // can still read, as each Space's own routes check again on the way out.
  const read = entries.filter((entry) => entry !== null)
  return c.json({
    spaces: teamsEnabled()
      ? read.filter((entry) => canAccessSpace(entry.id, "read", identity))
      : read,
  })
})
