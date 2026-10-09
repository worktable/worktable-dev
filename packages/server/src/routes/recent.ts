import { Hono } from "hono"
import { requireScope } from "../auth.ts"
import { listRecentDocuments } from "../recent-documents.ts"

export const recentRouter = new Hono()

recentRouter.use("*", requireScope("documents:read"))

// GET /api/recent — newest active documents across Spaces, or in one Space.
// lifetime=temporary lists only temporary documents, soonest to archive first.
recentRouter.get("/", async (c) => {
  const sort = c.req.query("sort") === "created" ? "created" : "updated"
  const limitRaw = Number(c.req.query("limit"))
  const limit = Number.isInteger(limitRaw)
    ? Math.max(1, Math.min(100, limitRaw))
    : 30
  return c.json(
    await listRecentDocuments({
      spaceId: c.req.query("spaceId") || undefined,
      sort,
      includeTemporary: c.req.query("includeTemporary") === "true",
      onlyTemporary: c.req.query("lifetime") === "temporary",
      limit,
    })
  )
})
