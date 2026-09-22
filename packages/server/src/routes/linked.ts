import { Hono } from "hono"
import { requireHumanWorkspaceOwner } from "../auth.ts"
import { isHosted } from "../hosted.ts"
import {
  beginLink,
  disconnectLink,
  linkedStatus,
  setLinkEnabled,
} from "../linked-runtime.ts"
import {
  CloudLinkError,
  cloudAccountStatus,
  completeCloudSignIn,
  signOutCloudAccount,
  startCloudSignIn,
  linkedCloudOrigin,
} from "../cloud-account.ts"

export const cloudCallbackRouter = new Hono()
cloudCallbackRouter.get("/account/callback", async (c) => {
  if (isHosted()) return c.notFound()
  const signedIn = await completeCloudSignIn(c.req.raw)
  c.header("Cache-Control", "no-store")
  c.header("Referrer-Policy", "no-referrer")
  // No credentials in a page or redirect. The original Settings view polls status.
  return c.redirect(
    `${linkedCloudOrigin()}/gateway/local/auth/finished?result=${signedIn ? "connected" : "failed"}`,
    303
  )
})

export const linkedRouter = new Hono()
linkedRouter.use("*", requireHumanWorkspaceOwner())
linkedRouter.use("*", async (c, next) => {
  if (isHosted()) return c.json({ error: "Not found" }, 404)
  c.header("Cache-Control", "no-store")
  return next()
})
linkedRouter.get("/", async (c) =>
  c.json({ ...linkedStatus(), account: await cloudAccountStatus() })
)
linkedRouter.post("/account", async (c) => {
  try {
    // The normal owner/Origin gate has already checked this request's browser origin.
    const origin = c.req.header("Origin") ?? new URL(c.req.url).origin
    return c.json(await startCloudSignIn(origin))
  } catch {
    return c.json({ error: "Could not start Cloud sign-in. Try again." }, 503)
  }
})
linkedRouter.delete("/account", async (c) => {
  await signOutCloudAccount()
  return c.json({ ok: true })
})
linkedRouter.patch("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    enabled?: unknown
  } | null
  if (typeof body?.enabled !== "boolean")
    return c.json({ error: "Invalid request" }, 400)
  try {
    return c.json(await setLinkEnabled(body.enabled))
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not update Worktable Link.",
        ...(error instanceof CloudLinkError ? { code: error.code } : {}),
      },
      503
    )
  }
})
linkedRouter.post("/", async (c) => {
  try {
    return c.json(await beginLink())
  } catch (error) {
    return c.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not enable Worktable Link.",
        ...(error instanceof CloudLinkError ? { code: error.code } : {}),
      },
      503
    )
  }
})
linkedRouter.delete("/", async (c) => {
  await disconnectLink()
  return c.json(linkedStatus())
})
