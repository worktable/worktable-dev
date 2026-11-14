import { Hono } from "hono"
import { HOME_PIN_LIMIT, HomePinRefSchema, type HomeFeed } from "@worktable/types"
import { z } from "zod"
import { requireScope } from "../auth.ts"
import { readHomeFeed, resolveHomePins } from "../home-feed.ts"
import { listRecentDocuments } from "../recent-documents.ts"
import { canReadSpaceFor, personalPreferencesKey } from "../personal-identity.ts"
import {
  PreferencesUnreadableError,
  readHomePins,
  saveHomePins,
} from "../personal-navigation-store.ts"

export const homeRouter = new Hono()

homeRouter.use("*", requireScope("documents:read"))

// GET /api/home — the newest runs of work and how busy each Space was, or in
// one Space, its runs and folders. Across Spaces it carries the reader's own
// pins and the temporary docs that archive soonest, so Home is one request.
homeRouter.get("/", async (c) => {
  const spaceId = c.req.query("spaceId") || undefined
  const limitRaw = Number(c.req.query("limit"))
  const offsetRaw = Number(c.req.query("timezoneOffset"))
  const person = spaceId ? null : personalPreferencesKey(c)
  const [feed, pins, temporary] = await Promise.all([
    readHomeFeed({
      ...(spaceId ? { spaceId } : {}),
      ...(spaceId && c.req.query("folder")
        ? { folder: c.req.query("folder") }
        : {}),
      limit: Number.isInteger(limitRaw) ? Math.max(1, Math.min(30, limitRaw)) : 8,
      ...(Number.isInteger(offsetRaw) && Math.abs(offsetRaw) <= 14 * 60
        ? { timezoneOffset: offsetRaw }
        : {}),
    }),
    person
      ? resolveHomePins(readHomePins(person), canReadSpaceFor(c))
      : undefined,
    spaceId
      ? undefined
      : listRecentDocuments({ onlyTemporary: true, limit: 100 }).then(
          (recent) => recent.items
        ),
  ])
  const body: HomeFeed = {
    ...feed,
    ...(pins ? { pins } : {}),
    ...(temporary ? { temporary } : {}),
  }
  return c.json(body)
})

const SaveHomePinsSchema = z.object({
  pins: HomePinRefSchema.array().max(HOME_PIN_LIMIT),
})

// PUT /api/home/pins — replace the reader's own Home pins.
homeRouter.put("/pins", async (c) => {
  const person = personalPreferencesKey(c)
  if (!person) return c.json({ error: "Forbidden" }, 403)
  const parsed = SaveHomePinsSchema.safeParse(
    await c.req.json().catch(() => null)
  )
  if (!parsed.success) return c.json({ error: "Invalid pins" }, 400)
  const canRead = canReadSpaceFor(c)
  try {
    const saved = await saveHomePins(
      person,
      parsed.data.pins.filter((pin) => canRead(pin.spaceId))
    )
    return c.json({ pins: await resolveHomePins(saved, canRead) })
  } catch (error) {
    if (error instanceof PreferencesUnreadableError) {
      return c.json({ error: error.message, code: error.code }, 503)
    }
    throw error
  }
})
