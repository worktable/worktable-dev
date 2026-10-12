import { Hono } from "hono"
import type { WithContentRevision } from "@worktable/types"
import { requireScope } from "../auth.ts"
import { withContentRevisions } from "../document-content-revision.ts"
import {
  listRecentDocuments,
  type RecentDocument,
} from "../recent-documents.ts"

export const recentRouter = new Hono()

recentRouter.use("*", requireScope("documents:read"))

// GET /api/recent — newest active documents across Spaces, or in one Space.
// lifetime=temporary lists only temporary documents, soonest to archive first.
// temporaryLimit=N adds those as `temporary` beside the main list.
recentRouter.get("/", async (c) => {
  const sort = c.req.query("sort") === "created" ? "created" : "updated"
  const limitRaw = Number(c.req.query("limit"))
  const limit = Number.isInteger(limitRaw)
    ? Math.max(1, Math.min(100, limitRaw))
    : 30
  const temporaryLimitRaw = Number(c.req.query("temporaryLimit"))
  const recent = await listRecentDocuments({
    spaceId: c.req.query("spaceId") || undefined,
    sort,
    includeTemporary: c.req.query("includeTemporary") === "true",
    onlyTemporary: c.req.query("lifetime") === "temporary",
    limit,
    temporaryLimit: Number.isInteger(temporaryLimitRaw)
      ? Math.max(0, Math.min(100, temporaryLimitRaw))
      : 0,
  })
  // Rows open their documents by content revision.
  const rows = await withContentRevisions(
    [...recent.items, ...(recent.temporary ?? [])],
    (item) => ({ spaceId: item.spaceId, path: item.document.path }),
    (item, revision) => ({
      ...item,
      document: { ...item.document, revision } as WithContentRevision<
        RecentDocument["document"]
      >,
    })
  )
  return c.json({
    ...recent,
    items: rows.slice(0, recent.items.length),
    ...(recent.temporary ? { temporary: rows.slice(recent.items.length) } : {}),
  })
})
