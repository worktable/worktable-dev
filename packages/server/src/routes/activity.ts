import { Hono } from "hono"
import { readActivityAgents, readActivityFeed } from "../activity-feed.ts"
import { requireScope } from "../auth.ts"
import { listPending, markPendingDone } from "../pending.ts"
import { visitorCommentReader } from "../visitor-comment-access.ts"

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
      ...(c.req.query("actorId") ? { actorId: c.req.query("actorId") } : {}),
      ...(c.req.query("docPath") ? { docPath: c.req.query("docPath") } : {}),
      before: c.req.query("before") || null,
      limit,
      ...(Number.isInteger(offsetRaw) && Math.abs(offsetRaw) <= 14 * 60
        ? { timezoneOffset: offsetRaw }
        : {}),
    })
  )
})

// GET /api/activity/agents — agents to filter by, most recently active first.
activityRouter.get("/agents", async (c) =>
  c.json({
    agents: await readActivityAgents({
      spaceId: c.req.query("spaceId") || undefined,
      scopes: c.get("identity").scopes,
    }),
  })
)

export const pendingRouter = new Hono()

pendingRouter.use("*", requireScope("documents:read"))

// GET /api/pending — what is waiting on the reader, optionally in one Space.
pendingRouter.get("/", async (c) =>
  c.json(
    await listPending(
      c.get("identity"),
      c.req.query("spaceId") || undefined,
      c.get("identity").agent === null &&
        c.get("identity").principal.type === "human" &&
        !c.get("identity").operatorVerification
        ? (spaceId) => visitorCommentReader(c, spaceId)
        : undefined
    )
  )
)

// POST /api/pending/done: the reader lets go of something that waits on them
// without answering it.
pendingRouter.post("/done", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { id?: unknown } | null
  if (typeof body?.id !== "string" || !body.id) {
    return c.json({ error: "id is required", code: "VALIDATION_ERROR" }, 400)
  }
  const refused = await markPendingDone(c.get("identity"), body.id)
  if (refused === "not-found") {
    return c.json({ error: "Nothing waits under that id", code: "NOT_FOUND" }, 404)
  }
  if (refused) {
    return c.json({ error: "This can't be marked done", code: "FORBIDDEN" }, 403)
  }
  return c.json({ ok: true })
})
