import { Hono } from "hono"
import { canManageUserSettings } from "../auth.ts"
import { resolveParticipant } from "../participant-store.ts"

export const profileRouter = new Hono()

const MAX_NAME_LENGTH = 100

function forbidden() {
  return { error: "Forbidden", required: "owner" }
}

profileRouter.get("/", async (c) => {
  if (!canManageUserSettings(c)) return c.json(forbidden(), 403)
  const { participant } = await resolveParticipant(c.get("identity"))
  return c.json({ id: participant.id, name: participant.name })
})

profileRouter.put("/", async (c) => {
  if (!canManageUserSettings(c)) return c.json(forbidden(), 403)
  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown
  } | null
  const name = typeof body?.name === "string" ? body.name.trim() : ""
  if (!name) return c.json({ error: "name must not be empty" }, 400)
  if (name.length > MAX_NAME_LENGTH) {
    return c.json(
      { error: `name must be at most ${MAX_NAME_LENGTH} characters` },
      400
    )
  }
  const { participant } = await resolveParticipant(c.get("identity"), {
    name,
  })
  return c.json({ id: participant.id, name: participant.name })
})
