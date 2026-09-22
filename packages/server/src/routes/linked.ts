import { Hono } from "hono"
import { requireHumanWorkspaceOwner } from "../auth.ts"
import { isHosted } from "../hosted.ts"
import { beginLink, disconnectLink, linkedStatus } from "../linked-runtime.ts"

export const linkedRouter = new Hono()
linkedRouter.use("*", requireHumanWorkspaceOwner())
linkedRouter.use("*", async (c, next) => {
  if (isHosted()) return c.json({ error: "Not found" }, 404)
  c.header("Cache-Control", "no-store")
  return next()
})
linkedRouter.get("/", (c) => c.json(linkedStatus()))
linkedRouter.post("/", async (c) => {
  try {
    return c.json(await beginLink())
  } catch {
    return c.json({ error: "Could not start linking. Try again shortly." }, 503)
  }
})
linkedRouter.delete("/", async (c) => {
  await disconnectLink()
  return c.json(linkedStatus())
})
