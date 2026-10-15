import { Hono } from "hono"
import { APIError } from "better-auth/api"
import { z } from "zod"
import { getTeamAuth } from "../team-auth.ts"
import {
  currentTeamWorktable,
  requireTeamDatabase,
  teamDatabasePath,
} from "../team-database.ts"
import { findTeamMember } from "../team-members.ts"
import { withCrossProcessLock } from "../cross-process-lock.ts"
import { sameOriginRequestAllowed } from "../auth.ts"
import { isHosted } from "../hosted.ts"
import { resolveWorkspaceOriginForRequest } from "../workspace-origin.ts"

export const teamAuthRouter = new Hono()
const enrollment = z
  .object({
    invitationId: z.string().min(1).max(200),
    name: z.string().trim().min(1).max(100),
    password: z.string().min(8).max(128),
  })
  .strict()
// Password work is bounded per invitation: an unknown link costs one query and
// cannot use up the attempts of a person holding a real one.
const attempts = new Map<string, number[]>()
const MAX_ATTEMPTS_PER_INVITATION = 10

function expiresAtMs(value: unknown): number {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  return Date.parse(String(value))
}

function pendingInvitation(invitationId: string) {
  const worktable = currentTeamWorktable()!
  const invitation = requireTeamDatabase()
    .query<
      { email: string; inviterId: string; expiresAt: number | string },
      [string, string]
    >("SELECT email, inviterId, expiresAt FROM invitation WHERE id = ? AND organizationId = ? AND status = 'pending' AND role = 'member'")
    .get(invitationId, worktable.organizationId)
  return invitation &&
    expiresAtMs(invitation.expiresAt) > Date.now() &&
    findTeamMember(invitation.inviterId)
    ? invitation
    : null
}

teamAuthRouter.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store")
  if (isHosted() || !currentTeamWorktable())
    return c.json({ error: "Not found" }, 404)
  if (c.req.method !== "GET" && !sameOriginRequestAllowed(c.req.raw))
    return c.json({ error: "Forbidden" }, 403)
  return next()
})
teamAuthRouter.onError((error) => {
  if (error instanceof APIError)
    return new Response(JSON.stringify(error.body), {
      status: error.statusCode,
      headers: { "Content-Type": "application/json" },
    })
  throw error
})

// Expose individual-account authentication only. Organization endpoints, generic
// signup, and the Cloud execution endpoint remain trusted server APIs.
for (const endpoint of [
  "sign-in/email",
  "sign-out",
  "change-password",
  "revoke-sessions",
  "reset-password",
] as const) {
  teamAuthRouter.post(`/${endpoint}`, async (c) => {
    const auth = await getTeamAuth(
      resolveWorkspaceOriginForRequest(c.req.raw).origin
    )
    const response = await auth.handler(c.req.raw)
    if (endpoint === "sign-in/email" && response.ok) {
      const result = (await response.clone().json()) as { user?: { id?: string } }
      if (!result.user?.id || !findTeamMember(result.user.id)) {
        if (result.user?.id)
          await (await auth.$context).internalAdapter.deleteUserSessions(result.user.id)
        return c.json({ error: "Ask a team member for an invitation to join this Worktable" }, 403)
      }
    }
    return response
  })
}
teamAuthRouter.get("/get-session", async (c) => {
  const auth = await getTeamAuth(
    resolveWorkspaceOriginForRequest(c.req.raw).origin
  )
  return auth.handler(c.req.raw)
})
teamAuthRouter.post("/enroll", async (c) => {
  const parsed = enrollment.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success)
    return c.json(
      { error: "Enter your name and a password of at least eight characters" },
      400
    )
  const unavailable = () =>
    c.json(
      { error: "This invitation has expired or is no longer available" },
      410
    )
  if (!pendingInvitation(parsed.data.invitationId)) return unavailable()
  const now = Date.now()
  for (const [id, times] of attempts) {
    const recent = times.filter((at) => at > now - 60_000)
    if (recent.length) attempts.set(id, recent)
    else attempts.delete(id)
  }
  const recent = attempts.get(parsed.data.invitationId) ?? []
  if (recent.length >= MAX_ATTEMPTS_PER_INVITATION)
    return c.json({ error: "Too many attempts. Try again later." }, 429)
  attempts.set(parsed.data.invitationId, [...recent, now])
  return withCrossProcessLock(
    `${teamDatabasePath()}.members.lock`,
    { label: "Team invitation" },
    async () => {
      const invitation = pendingInvitation(parsed.data.invitationId)
      if (!invitation) return unavailable()
      const auth = await getTeamAuth(
        resolveWorkspaceOriginForRequest(c.req.raw).origin
      )
      const context = await auth.$context
      const existing = await context.internalAdapter.findUserByEmail(
        invitation.email.toLowerCase()
      )
      const signedIn = existing
        ? await auth.api.signInEmail({
            body: { email: invitation.email, password: parsed.data.password },
            returnHeaders: true,
          })
        : await auth.api.signUpEmail({
            body: {
              name: parsed.data.name,
              email: invitation.email,
              password: parsed.data.password,
            },
            returnHeaders: true,
          })
      const headers = new Headers({
        Cookie: signedIn.headers
          .getSetCookie()
          .map((value) => value.split(";", 1)[0])
          .join("; "),
      })
      await auth.api.acceptInvitation({
        headers,
        body: { invitationId: parsed.data.invitationId },
      })
      for (const cookie of signedIn.headers.getSetCookie())
        c.header("Set-Cookie", cookie, { append: true })
      return c.json({ ok: true })
    }
  )
})
