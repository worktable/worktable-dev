import {
  assertPayerKeepsOwnership,
  assertRoomForInvitation,
  inviteWithinPlan,
  memberIsPayer,
  PlanFullError,
  requestBilling,
} from "../hosted-billing.ts"
import { hasOwnerPassword } from "../session-store.ts"
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
import {
  findTeamMember,
  findTeamMemberById,
  hasTeamOperatorAuthority,
  listTeamMembers,
} from "../team-members.ts"
import {
  createTeamAgent,
  reconnectCloudPersonalAgent,
  getSpaceAccessPolicy,
  listTeamAgents,
  requireTeamHuman,
  requireTeamOwner,
  setSpaceAccessPolicy,
  teamMemberForIdentity,
  requireTeamAgentAdministrator,
  TeamAccessError,
  updateTeamAgent,
} from "../team-policy.ts"
import { sameOriginRequestAllowed } from "../auth.ts"
import { resolveWorkspaceOriginForRequest } from "../workspace-origin.ts"
import { readSpace } from "../store.ts"
import { issueTeamPasswordReset, setTeamOperator } from "../team-recovery.ts"
import {
  allInvitationDetails,
  assertInvitationStartSpace,
  claimInvitationEmail,
  invitationDetails,
  recordInvitationDetails,
  recordInvitationEmail,
} from "../team-invitations.ts"
import {
  invitationEmailConfigured,
  sendInvitationEmail,
  notifyPayerPlanFull,
} from "../team-invitation-email.ts"
import { ensureWorkspaceManifest } from "../workspace.ts"

export const teamRouter = new Hono()

function invitationUrl(c: Context, invitationId: string): string {
  return `${origin(c)}${isHosted() ? `/t/${process.env[ENV.CLOUD_WORKSPACE_ID]}/join` : "/login"}?invite=${encodeURIComponent(invitationId)}`
}

async function emailInvitation(
  invitation: { id: string; email: string; expiresAt: Date | string | number },
  inviterName: string,
  spaceName?: string
) {
  const status = await sendInvitationEmail({
    invitationId: invitation.id,
    email: invitation.email,
    inviterName: inviterName.slice(0, 100) || "A teammate",
    worktableName: ensureWorkspaceManifest().name.slice(0, 100) || "Worktable",
    ...(spaceName ? { spaceName: spaceName.slice(0, 200) } : {}),
    expiresAt: new Date(invitation.expiresAt).getTime(),
  })
  recordInvitationEmail(invitation.id, status)
  return status
}
const origin = (c: Context) =>
  resolveWorkspaceOriginForRequest(c.req.raw).origin
const setup = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.string().email().max(254),
    password: z.string().min(8).max(128).optional(),
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
  // Without a new password, the owner keeps the one this Worktable has.
  if (
    !parsed.success ||
    (!parsed.data.password && !(await hasOwnerPassword()))
  )
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
  try {
    const accepted = await acceptCloudTeamInvitation(
      origin(c),
      identity.cloudIdentity,
      parsed.data.invitationId,
      requestBilling(c.req.raw)
    )
    return c.json({ ok: true, ...accepted })
  } catch (error) {
    if (!(error instanceof PlanFullError)) throw error
    return c.json(
      {
        error:
          "This Worktable is full. Ask the person who invited you to make room.",
        code: error.code,
      },
      409
    )
  }
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
  const target = findTeamMemberById(c.req.param("id"))
  if (target)
    assertPayerKeepsOwnership(
      target.userId,
      body.data.role,
      requestBilling(c.req.raw)
    )
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
  const target = findTeamMemberById(c.req.param("id"))
  if (target)
    assertPayerKeepsOwnership(target.userId, null, requestBilling(c.req.raw))
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
  const details = allInvitationDetails()
  return c.json({
    email: invitationEmailConfigured(),
    invitations: invitations
      .filter(
        (item) => member.role === "owner" || item.inviterId === member.userId
      )
      .map((item) => {
        const extra = details.get(item.id)
        return {
          ...item,
          url: invitationUrl(c, item.id),
          startSpaceId: extra?.startSpaceId ?? null,
          emailed: (extra?.emailSends ?? 0) > 0,
          expired: !(new Date(item.expiresAt).getTime() > Date.now()),
        }
      }),
  })
})
// Someone who doesn't pay found the plan full and asks the payer to upgrade.
// The control plane emails the payer at most once a day.
teamRouter.post("/plan-full", async (c) => {
  const { member } = await teamAdministrativeContext(
    origin(c),
    c.req.raw,
    c.get("identity")
  )
  const billing = requestBilling(c.req.raw)
  if (!billing || memberIsPayer(member.userId, billing))
    return c.json({ error: "Nobody else to ask" }, 409)
  try {
    assertRoomForInvitation(billing)
    return c.json({ error: "The plan has room" }, 409)
  } catch (error) {
    if (!(error instanceof PlanFullError)) throw error
  }
  notifyPayerPlanFull(member.name)
  return c.body(null, 204)
})
teamRouter.post("/invitations", async (c) => {
  const parsed = z
    .object({
      email: z.string().email().max(254),
      spaceId: z.string().min(1).max(200).optional(),
    })
    .strict()
    .safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ error: "Enter an email address" }, 400)
  const { auth, headers, member, worktable } = await teamAdministrativeContext(
    origin(c),
    c.req.raw,
    c.get("identity")
  )
  const space = parsed.data.spaceId
    ? (await readSpace(parsed.data.spaceId)).data
    : null
  if (parsed.data.spaceId) {
    if (!space) return c.json({ error: "Space not found" }, 404)
    assertInvitationStartSpace(member, parsed.data.spaceId)
  }
  const billing = requestBilling(c.req.raw)
  let invitation: Awaited<ReturnType<typeof auth.api.createInvitation>>
  try {
    invitation = await inviteWithinPlan(billing, () =>
      auth.api.createInvitation({
        headers,
        body: {
          organizationId: worktable.organizationId,
          email: parsed.data.email,
          role: "member",
        },
      })
    )
  } catch (error) {
    if (!(error instanceof PlanFullError)) throw error
    // Only the payer can change the plan; anyone else's attempt is passed on.
    if (!memberIsPayer(member.userId, billing)) notifyPayerPlanFull(member.name)
    return c.json(
      { error: error.message, code: error.code, ...error.room },
      409
    )
  }
  recordInvitationDetails(invitation.id, parsed.data.spaceId ?? null)
  const email = invitationEmailConfigured()
    ? claimInvitationEmail(invitation.id) === null
      ? await emailInvitation(invitation, member.name, space?.name)
      : "limited"
    : null
  return c.json(
    { invitation, url: invitationUrl(c, invitation.id), email },
    201
  )
})
teamRouter.post("/invitations/:id/email", async (c) => {
  if (!invitationEmailConfigured())
    return c.json({ error: "This Worktable can't send email" }, 409)
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
    invitation.status !== "pending" ||
    (member.role !== "owner" && invitation.inviterId !== member.userId)
  )
    return c.json({ error: "Invitation not found" }, 404)
  if (!(new Date(invitation.expiresAt).getTime() > Date.now()))
    return c.json({ error: "This invitation has expired" }, 410)
  const blocked = claimInvitationEmail(invitation.id)
  if (blocked) return c.json({ error: blocked }, 429)
  const spaceId = invitationDetails(invitation.id)?.startSpaceId
  const space = spaceId ? (await readSpace(spaceId)).data : null
  // The email names whoever sent the invitation, not whoever resends it.
  const inviter = findTeamMember(invitation.inviterId)
  return c.json({
    email: await emailInvitation(
      invitation,
      inviter?.name ?? member.name,
      space?.name
    ),
  })
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
  // Every field is checked before any is saved, so a refused request
  // changes nothing.
  const agent = requireTeamAgentAdministrator(c.req.param("id"), c.get("identity"))
  if (parsed.data.worktableThreads !== undefined && agent.ownership !== "team")
    throw new TeamAccessError("Personal agents follow their member's thread access")
  if (parsed.data.spaceIds !== undefined && agent.ownership !== "personal")
    throw new TeamAccessError("Team agents use explicit Space grants")
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
