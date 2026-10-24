import { Hono } from "hono"
import { APP_FAMILIES, type AppFamily } from "@worktable/hosted-contract"
import { canOperateHost, trustedLocalIdentity } from "../auth.ts"
import { isHosted } from "../hosted.ts"
import {
  beginLink,
  disconnectLink,
  linkedStatus,
  noteAppSetup,
  setLinkEnabled,
} from "../linked-runtime.ts"
import {
  CloudLinkError,
  cloudAccountStatus,
  completeCloudSignIn,
  signOutCloudAccount,
  startCloudSignIn,
  linkedCloudOrigin,
  cloudLinkRequest,
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
linkedRouter.use("*", trustedLocalIdentity())
linkedRouter.use("*", async (c, next) =>
  canOperateHost(c)
    ? next()
    : c.json({ error: "Operator authority is required" }, 403)
)
linkedRouter.use("*", async (c, next) => {
  if (isHosted()) return c.json({ error: "Not found" }, 404)
  c.header("Cache-Control", "no-store")
  return next()
})
linkedRouter.get("/", async (c) =>
  c.json({ ...linkedStatus(), account: await cloudAccountStatus() })
)
linkedRouter.get("/subscriptions", async (c) => {
  try {
    return c.json(
      await cloudLinkRequest(linkedCloudOrigin(), { action: "subscriptions" })
    )
  } catch {
    return c.json({ error: "Could not load Cloud subscriptions" }, 503)
  }
})
// The person is following a chat app's steps here with Link on.
linkedRouter.post("/app-intent", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    app?: unknown
  } | null
  if (!APP_FAMILIES.includes(body?.app as AppFamily))
    return c.json({ error: "Invalid request" }, 400)
  await noteAppSetup(body!.app as AppFamily)
  return c.json({ ok: true })
})
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
    workspaceId?: unknown
  } | null
  if (typeof body?.enabled !== "boolean")
    return c.json({ error: "Invalid request" }, 400)
  try {
    if (
      body.workspaceId !== undefined &&
      (typeof body.workspaceId !== "string" ||
        !body.workspaceId ||
        body.workspaceId.length > 256)
    )
      return c.json({ error: "Choose a Worktable" }, 400)
    return c.json(
      await setLinkEnabled(body.enabled, body.workspaceId as string | undefined)
    )
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
