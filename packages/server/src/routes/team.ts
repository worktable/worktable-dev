import { updateTeamAgentConnection } from "../team-agent-connections.ts"
import { isHosted } from "../hosted.ts"
import { ENV } from "@worktable/hosted-contract"
import { acceptCloudTeamInvitation } from "../team-cloud.ts"
import { Hono, type Context } from "hono"
import { z } from "zod"
import { activateLocalTeams } from "../team-activation.ts"
import {
  changeTeamMembership,
  teamAdministrativeContext,
} from "../team-administration.ts"
import { currentTeamWorktable, currentWorktableId } from "../team-database.ts"
import { hasTeamOperatorAuthority, listTeamMembers } from "../team-members.ts"
import {
  createTeamAgent,
  reconnectCloudPersonalAgent,
  getSpaceAccessPolicy,
  listTeamAgents,
  requireTeamHuman,
  requireTeamOwner,
  setSpaceAccessPolicy,
  teamMemberForIdentity,
  updateTeamAgent,
} from "../team-policy.ts"
import { sameOriginRequestAllowed } from "../auth.ts"
import { resolveWorkspaceOriginForRequest } from "../workspace-origin.ts"
import { readSpace } from "../store.ts"
import { issueTeamPasswordReset, setTeamOperator } from "../team-recovery.ts"

export const teamRouter = new Hono()
const origin = (c: Context) =>
  resolveWorkspaceOriginForRequest(c.req.raw).origin
const setup = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.string().email().max(254),
    password: z.string().min(8).max(128),
  })
  .strict()
const grant = z.object({
  subjectType: z.enum(["member", "agent"]),
  subjectId: z.string().min(1),
  access: z.enum(["read", "edit", "manage"]),
})
const policy = z
  .object({
    visibility: z.enum(["shared", "restricted"]),
    grants: z.array(grant).max(1000),
  })
  .strict()

teamRouter.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store")
  if (c.req.method !== "GET" && !sameOriginRequestAllowed(c.req.raw))
    return c.json({ error: "Forbidden" }, 403)
  return next()
})
teamRouter.get("/", (c) => {
  const worktable = currentTeamWorktable()
  const member = worktable ? teamMemberForIdentity(c.get("identity")) : null
  return c.json({
    enabled: Boolean(worktable),
    worktableId: worktable?.id ?? currentWorktableId(),
    member,
    operator: member ? hasTeamOperatorAuthority(member.userId) : false,
    policyRevision: worktable?.policyRevision ?? 0,
  })
})
teamRouter.post("/activate", async (c) => {
  const parsed = setup.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success)
    return c.json(
      {
        error:
          "Enter your name, email and a password of at least eight characters",
      },
      400
    )
  const activated = await activateLocalTeams(
    origin(c),
    parsed.data,
    c.get("identity")
  )
  for (const cookie of activated.headers.getSetCookie())
    c.header("Set-Cookie", cookie, { append: true })
  return c.json({ member: activated.member }, 201)
})
teamRouter.post("/accept-invitation", async (c) => {
  const identity = c.get("identity")
  if (!identity.cloudIdentity)
    return c.json({ error: "Cloud sign-in is required" }, 403)
  const parsed = z
    .object({ invitationId: z.string().min(1).max(200) })
    .strict()
    .safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "Invalid invitation" }, 400)
  await acceptCloudTeamInvitation(
    origin(c),
    identity.cloudIdentity,
    parsed.data.invitationId
  )
  return c.json({ ok: true })
})
teamRouter.use("*", async (c, next) => {
  requireTeamHuman(c.get("identity"))
  return next()
})
teamRouter.get("/members", (c) => c.json({ members: listTeamMembers() }))
teamRouter.patch("/members/:id", async (c) => {
  const body = z
    .object({ role: z.enum(["owner", "member"]) })
    .strict()
    .safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: "Choose owner or member" }, 400)
  await changeTeamMembership(
    origin(c),
    c.req.raw,
    c.get("identity"),
    c.req.param("id"),
    body.data.role
  )
  return c.json({ ok: true })
})
teamRouter.delete("/members/:id", async (c) => {
  await changeTeamMembership(
    origin(c),
    c.req.raw,
    c.get("identity"),
    c.req.param("id"),
    null
  )
  return c.json({ ok: true })
})
// Owners pass a reset link on themselves; there is no email.
teamRouter.post("/members/:id/password-reset", async (c) =>
  c.json(
    await issueTeamPasswordReset(
      origin(c),
      { memberId: c.req.param("id") },
      c.get("identity")
    ),
    201
  )
)
// A person invited back may have forgotten their earlier account's password.
teamRouter.post("/invitations/:id/password-reset", async (c) =>
  c.json(
    await issueTeamPasswordReset(
      origin(c),
      { invitationId: c.req.param("id") },
      c.get("identity")
    ),
    201
  )
)
teamRouter.put("/members/:id/operator", async (c) => {
  const body = z
    .object({ operator: z.boolean() })
    .strict()
    .safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: "Invalid operator change" }, 400)
  setTeamOperator(
    { memberId: c.req.param("id") },
    body.data.operator,
    c.get("identity")
  )
  return c.json({ ok: true })
})
teamRouter.get("/invitations", async (c) => {
  const { auth, headers, member, worktable } = await teamAdministrativeContext(
    origin(c),
    c.req.raw,
    c.get("identity")
  )
  const invitations = await auth.api.listInvitations({
    headers,
    query: { organizationId: worktable.organizationId },
  })
  return c.json({
    invitations: invitations.filter(
      (item) => member.role === "owner" || item.inviterId === member.userId
    ),
  })
})
teamRouter.post("/invitations", async (c) => {
  const parsed = z
    .object({ email: z.string().email().max(254) })
    .strict()
    .safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "Enter an email address" }, 400)
  const { auth, headers, worktable } = await teamAdministrativeContext(
    origin(c),
    c.req.raw,
    c.get("identity")
  )
  const invitation = await auth.api.createInvitation({
    headers,
    body: {
      organizationId: worktable.organizationId,
      email: parsed.data.email,
      role: "member",
    },
  })
  return c.json(
    {
      invitation,
      url: `${origin(c)}${isHosted() ? `/t/${process.env[ENV.CLOUD_WORKSPACE_ID]}/join` : "/login"}?invite=${encodeURIComponent(invitation.id)}`,
    },
    201
  )
})
teamRouter.delete("/invitations/:id", async (c) => {
  const { auth, headers, member, worktable } = await teamAdministrativeContext(
    origin(c),
    c.req.raw,
    c.get("identity")
  )
  const invitations = await auth.api.listInvitations({
    headers,
    query: { organizationId: worktable.organizationId },
  })
  const invitation = invitations.find((item) => item.id === c.req.param("id"))
  if (
    !invitation ||
    (member.role !== "owner" && invitation.inviterId !== member.userId)
  )
    return c.json({ error: "Invitation not found" }, 404)
  await auth.api.cancelInvitation({
    headers,
    body: { invitationId: invitation.id },
  })
  return c.json({ ok: true })
})
teamRouter.get("/spaces/:spaceId", async (c) => {
  if (!(await readSpace(c.req.param("spaceId"))).data)
    return c.json({ error: "Space not found" }, 404)
  return c.json(getSpaceAccessPolicy(c.req.param("spaceId")))
})
teamRouter.put("/spaces/:spaceId", async (c) => {
  const parsed = policy.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success)
    return c.json({ error: "Invalid Space permissions" }, 400)
  const spaceId = c.req.param("spaceId")
  if (!(await readSpace(spaceId)).data)
    return c.json({ error: "Space not found" }, 404)
  setSpaceAccessPolicy({ spaceId, ...parsed.data }, c.get("identity"))
  return c.json({ spaceId, ...parsed.data })
})
teamRouter.post("/spaces/share", async (c) => {
  requireTeamOwner(c.get("identity"))
  const parsed = z
    .object({ spaceIds: z.array(z.string().min(1)).min(1).max(1000) })
    .strict()
    .safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "Choose Spaces to share" }, 400)
  for (const spaceId of parsed.data.spaceIds)
    if (!(await readSpace(spaceId)).data)
      return c.json({ error: "Space not found" }, 404)
  for (const spaceId of parsed.data.spaceIds)
    setSpaceAccessPolicy(
      { ...getSpaceAccessPolicy(spaceId), visibility: "shared" },
      c.get("identity")
    )
  return c.json({ ok: true })
})
teamRouter.get("/agents", (c) =>
  c.json({ agents: listTeamAgents(c.get("identity")) })
)
teamRouter.post("/agents", async (c) => {
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(100),
      platform: z.string().trim().min(1).max(64),
      ownership: z.enum(["personal", "team"]),
    })
    .strict()
    .safeParse(await c.req.json().catch(() => null))
  if (!parsed.success)
    return c.json(
      { error: "Enter a name, platform and owner for the agent" },
      400
    )
  return c.json({ agent: createTeamAgent(parsed.data, c.get("identity")) }, 201)
})

teamRouter.patch("/agents/:id", async (c) => {
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(100).optional(),
      spaceIds: z.array(z.string().min(1)).max(1000).nullable().optional(),
      worktableThreads: z.enum(["none", "read", "edit"]).optional(),
    })
    .strict()
    .safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "Invalid agent settings" }, 400)
  if (parsed.data.worktableThreads !== undefined)
    updateTeamAgent(
      c.req.param("id"),
      { worktableThreads: parsed.data.worktableThreads },
      c.get("identity")
    )
  if (parsed.data.name !== undefined || parsed.data.spaceIds !== undefined)
    await updateTeamAgentConnection(c.req.param("id"), {displayName: parsed.data.name, ...(parsed.data.spaceIds !== undefined ? {spaceIds: parsed.data.spaceIds} : {})})
  return c.json({agent: listTeamAgents(c.get("identity")).find(agent => agent.id === c.req.param("id"))})
})
teamRouter.delete("/agents/:id", (c) => {
  updateTeamAgent(c.req.param("id"), { active: false }, c.get("identity"))
  return c.json({ ok: true })
})

teamRouter.post("/agents/:id/reconnect", c => {
  reconnectCloudPersonalAgent(c.req.param("id"), c.get("identity"))
  return c.json({ok: true})
})
