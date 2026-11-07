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
  const entries = await mapWithConcurrency(
    spaces,
    SPACE_CONCURRENCY,
    async ({ id }) => {
      const [page, docs, documents, collections] = await Promise.all([
        readSpacePage(id, scopes),
        listSpaceDocs(id, true),
        hasScope(scopes, "documents:read")
          ? listSpaceDocuments(id, true)
          : null,
        hasScope(scopes, "records:read") ? listSpaceCollections(id) : null,
      ])
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
  return c.json({
    spaces: teamsEnabled()
      ? entries.filter((entry) => canAccessSpace(entry.id, "read", identity))
      : entries,
  })
})
