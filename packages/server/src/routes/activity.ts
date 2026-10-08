import { Hono } from "hono"
import { readActivityFeed } from "../activity-feed.ts"
import { requireScope } from "../auth.ts"
import { listPending } from "../pending.ts"

export const activityRouter = new Hono()

activityRouter.use("*", requireScope("documents:read"))

// GET /api/activity — what people and agents did, newest first.
activityRouter.get("/", async (c) => {
  const limitRaw = Number(c.req.query("limit"))
  const limit = Number.isInteger(limitRaw)
    ? Math.max(1, Math.min(100, limitRaw))
    : 30
  const actor = c.req.query("actor")
  const offsetRaw = Number(c.req.query("timezoneOffset"))
  return c.json(
    await readActivityFeed({
      spaceId: c.req.query("spaceId") || undefined,
      scopes: c.get("identity").scopes,
      ...(actor === "person" || actor === "agent" ? { actorKind: actor } : {}),
      before: c.req.query("before") || null,
      limit,
      ...(Number.isInteger(offsetRaw) && Math.abs(offsetRaw) <= 14 * 60
        ? { timezoneOffset: offsetRaw }
        : {}),
    })
  )
})

export const pendingRouter = new Hono()

pendingRouter.use("*", requireScope("documents:read"))

// GET /api/pending — what is waiting on the reader.
pendingRouter.get("/", async (c) => c.json(await listPending(c.get("identity"))))
