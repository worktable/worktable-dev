import { readPersonSetup } from "./personal-navigation-store.ts"
import type { SetupItemId } from "@worktable/types/setup"
import { base64url, SignJWT } from "jose"
import {
  GATEWAY_HEADER,
  LINKED_ASSERTION_HEADER,
  LINKED_ASSERTION_ISSUER,
  LINKED_ASSERTION_TYPE,
} from "@worktable/hosted-contract"
import { createHash } from "node:crypto"
import { createLinkedIngress } from "./linked-ingress.ts"
import { Hono } from "hono"
import { trustedLocalIdentity, verifyBearer } from "./auth.ts"
import { teamRouter } from "./routes/team.ts"
import { teamAuthRouter } from "./routes/team-auth.ts"
import { documentsRouter } from "./routes/documents.ts"
import { widgetsRouter } from "./routes/widgets.ts"
import { DEFAULT_AGENT_ACCESS, type DocumentId } from "@worktable/types"
import { listDocumentGenerationsV2 } from "./document-version-store-v2.ts"
import {
  createTeamAgentConnection,
  disconnectTeamAgentConnection,
  listTeamAgentConnections,
  updateTeamAgentConnection,
} from "./team-agent-connections.ts"
import { updateTeamAgent } from "./team-policy.ts"
import { spacesRouter } from "./routes/spaces.ts"
import { profileRouter } from "./routes/profile.ts"
import { workspaceRouter } from "./routes/workspace.ts"
import { tokensRouter } from "./routes/tokens.ts"
import { TeamAccessError } from "./team-policy.ts"
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  rename,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { existsSync } from "node:fs"
import { updateAgentConnection } from "./agent-connection-store.ts"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import {
  ensureWorkspaceManifest,
  writeWorkspaceManifest,
  workspaceCacheKey,
  prepareWorkspaceTarget,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import {
  activateLocalTeams,
  setLocalTeamInitializationHookForTests,
} from "./team-activation.ts"
import { clearTeamAuthInstances, getTeamAuth } from "./team-auth.ts"
import {
  closeTeamDatabases,
  currentTeamWorktable,
  teamsEnabled,
  requireTeamDatabase,
  advanceTeamPolicy,
} from "./team-database.ts"
import { findTeamMember, findTeamMemberById } from "./team-members.ts"
import { identityForTeamMember } from "./team-identity.ts"
import {
  bindTeamAgentCredential,
  canAccessSpace,
  canCreateTeamSpace,
  createTeamAgent,
  getSpaceAccessPolicy,
  registerTeamSpace,
  requireTeamHuman,
  requireTeamOwner,
  resolveTeamAgentCredential,
  runWithTeamIdentity,
  reconnectCloudPersonalAgent,
  setSpaceAccessPolicy,
} from "./team-policy.ts"
import {
  mutateSpace,
  readDoc,
  readSpace,
  setSpaceArchived,
  writeDoc,
  writeSpace,
} from "./store.ts"
import { createDocumentAnnotationForPath } from "./document-annotation-service.ts"
import { replyAnnotation } from "./annotation-store.ts"
import { listPending } from "./pending.ts"
import type { TokenIdentity } from "./token-store.ts"
import {
  claimNextThreadDelivery,
  cachedParticipantPresentations,
  listThreadParticipants,
  postThreadMessage,
} from "./thread-service.ts"
import { findThread } from "./thread-store.ts"
import { resolveParticipant } from "./participant-store.ts"
import { participantKey } from "./participant-store.ts"
import { dispatchOperation } from "./mcp/dispatcher.ts"

let root: string
const origin = "http://localhost:7481"
const password = "Synthetic-members-only-123"

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-team-foundation-"))
  setAppDirOverride(join(root, "app"))
  setWorkspaceRootOverride(join(root, "workspace"))
  prepareWorkspaceTarget(join(root, "workspace"), "create")
})

afterEach(async () => {
  clearTeamAuthInstances()
  closeTeamDatabases()
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
})

function sessionHeaders(headers: Headers): Headers {
  return new Headers({
    Cookie: headers
      .getSetCookie()
      .map((cookie) => cookie.split(";", 1)[0])
      .join("; "),
  })
}

async function setup() {
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: "original",
    name: "Original",
    createdAt: now,
    updatedAt: now,
    createdBy: "user",
    settings: {},
  })
  const bootstrap: TokenIdentity = {
    user: "owner",
    workspace: join(root, "workspace"),
    credentialClass: "local",
    scopes: ["*"],
    agent: null,
    principal: { id: "local:owner", type: "human", displayName: "Owner" },
  }
  expect(teamsEnabled()).toBe(false)
  const activated = await activateLocalTeams(
    origin,
    { name: "Alice", email: "alice@example.test", password },
    bootstrap
  )
  const auth = await getTeamAuth(origin)
  const ownerHeaders = sessionHeaders(activated.headers)
  const invitation = await auth.api.createInvitation({
    headers: ownerHeaders,
    body: {
      organizationId: currentTeamWorktable()!.organizationId,
      email: "bob@example.test",
      role: "member",
    },
  })
  const bob = await auth.api.signUpEmail({
    body: { name: "Bob", email: "bob@example.test", password },
    returnHeaders: true,
  })
  const bobHeaders = sessionHeaders(bob.headers)
  await auth.api.acceptInvitation({
    headers: bobHeaders,
    body: { invitationId: invitation.id },
  })
  const member = findTeamMember(bob.response.user.id)!
  return {
    auth,
    owner: activated.identity,
    ownerHeaders,
    member: identityForTeamMember(member),
    bobHeaders,
    invitation,
  }
}

describe("team foundation", () => {
  test("thread recipients require current Space access and reply capability; Pending replies belong to their author", async () => {
    const { owner, member } = await setup()
    const bob = (await resolveParticipant(member)).participant
    const location = { kind: "space" as const, spaceId: "original" }
    const offered = () => listThreadParticipants(owner, location)
    expect(
      (await offered()).some((participant) => participant.id === bob.id)
    ).toBe(false)
    await expect(
      runWithTeamIdentity(owner, () =>
        postThreadMessage(owner, {
          location,
          to: bob.id,
          body: "Private request",
          idempotencyKey: crypto.randomUUID(),
        })
      )
    ).rejects.toThrow("Choose a recipient")
    const agent = createTeamAgent(
      { name: "Reader", platform: "codex", ownership: "team" },
      owner
    )
    const { createToken, setTokenScopes } = await import("./token-store.ts")
    const credential = await createToken({
      agent: "codex",
      scopes: ["threads:read"],
    })
    bindTeamAgentCredential(agent.id, credential.metadata.principal.id, owner)
    setSpaceAccessPolicy(
      {
        spaceId: "original",
        visibility: "restricted",
        grants: [
          { subjectType: "agent", subjectId: agent.id, access: "edit" },
          {
            subjectType: "member",
            subjectId: member.team!.memberId!,
            access: "read",
          },
        ],
      },
      owner
    )
    expect(
      (await offered()).some((participant) => participant.name === "Reader")
    ).toBe(false)
    await setTokenScopes(credential.metadata.id, [
      "threads:read",
      "threads:write",
    ])
    const recipient = (await offered()).find(
      (participant) => participant.name === "Reader"
    )!
    expect(recipient).toBeDefined()
    await runWithTeamIdentity(owner, () =>
      postThreadMessage(owner, {
        location,
        to: recipient.id,
        body: "Please reply",
        idempotencyKey: crypto.randomUUID(),
      })
    )
    await runWithTeamIdentity(owner, () =>
      postThreadMessage(owner, {
        location,
        to: bob.id,
        body: "For your information",
        idempotencyKey: crypto.randomUUID(),
        expectsReply: false,
      })
    )
    expect(
      (await writeDoc("original", "pending-proof", "# Pending proof")).ok
    ).toBe(true)
    const { annotation } = await createDocumentAnnotationForPath({
      spaceId: "original",
      path: "pending-proof",
      input: {
        category: "comment",
        body: "Question",
        author: { type: "user", id: owner.principal.id },
      },
    })
    await replyAnnotation("original", annotation.id, "Answer", {
      type: "agent",
      id: agent.actorId,
    })
    expect(
      (await runWithTeamIdentity(owner, () => listPending(owner))).items.some(
        (item) => item.kind === "commentReply"
      )
    ).toBe(true)
    expect(
      (await runWithTeamIdentity(member, () => listPending(member))).items.some(
        (item) => item.kind === "commentReply"
      )
    ).toBe(false)
    updateTeamAgent(agent.id, { active: false }, owner)
    await expect(
      runWithTeamIdentity(owner, () =>
        postThreadMessage(owner, {
          location,
          to: recipient.id,
          body: "No longer connected",
          idempotencyKey: crypto.randomUUID(),
        })
      )
    ).rejects.toThrow("Choose a recipient")
  })

  test("deliveries wait while an agent cannot reply in their Space and arrive when access returns", async () => {
    const { owner } = await setup()
    const location = { kind: "space" as const, spaceId: "original" }
    const agent = createTeamAgent(
      { name: "Responder", platform: "codex", ownership: "team" },
      owner
    )
    const { createToken } = await import("./token-store.ts")
    const credential = await createToken({
      agent: "codex",
      scopes: ["threads:read", "threads:write"],
    })
    bindTeamAgentCredential(agent.id, credential.metadata.principal.id, owner)
    const grant = (grants: Parameters<typeof setSpaceAccessPolicy>[0]["grants"]) =>
      setSpaceAccessPolicy(
        { spaceId: "original", visibility: "restricted", grants },
        owner
      )
    grant([{ subjectType: "agent", subjectId: agent.id, access: "edit" }])
    const recipient = (await listThreadParticipants(owner, location)).find(
      (participant) => participant.name === "Responder"
    )!
    await runWithTeamIdentity(owner, () =>
      postThreadMessage(owner, {
        location,
        to: recipient.id,
        body: "Please reply when you can",
        idempotencyKey: crypto.randomUUID(),
      })
    )
    const responder = resolveTeamAgentCredential({
      ...credential.metadata,
      credentialClass: "local",
    } as TokenIdentity)!
    const claim = () =>
      runWithTeamIdentity(responder, () =>
        claimNextThreadDelivery(responder, 0, 2)
      )
    grant([])
    // Losing access hides the request without retiring it.
    expect(await claim()).toBeNull()
    grant([{ subjectType: "agent", subjectId: agent.id, access: "edit" }])
    const delivered = await claim()
    expect(delivered?.message.body).toBe("Please reply when you can")
  })

  test("agents use threads outside Spaces only when their access reaches that far", async () => {
    const { owner, member } = await setup()
    const bob = (await resolveParticipant(member)).participant
    const worktable = { kind: "worktable" as const }
    const posted = await runWithTeamIdentity(owner, () =>
      postThreadMessage(owner, {
        location: worktable,
        to: bob.id,
        body: "Planning outside any Space",
        idempotencyKey: crypto.randomUUID(),
        expectsReply: false,
      })
    )
    const agent = createTeamAgent(
      { name: "Scoped", platform: "codex", ownership: "team" },
      owner
    )
    const { createToken } = await import("./token-store.ts")
    const credential = await createToken({
      agent: "codex",
      scopes: ["threads:read", "threads:write"],
    })
    bindTeamAgentCredential(agent.id, credential.metadata.principal.id, owner)
    setSpaceAccessPolicy(
      {
        spaceId: "original",
        visibility: "restricted",
        grants: [{ subjectType: "agent", subjectId: agent.id, access: "edit" }],
      },
      owner
    )
    const scoped = resolveTeamAgentCredential({
      ...credential.metadata,
      credentialClass: "local",
    } as TokenIdentity)!
    const offered = async () =>
      (await listThreadParticipants(owner, worktable)).some(
        (participant) => participant.name === "Scoped"
      )
    expect(await offered()).toBe(false)
    await expect(
      runWithTeamIdentity(scoped, () => findThread(posted.threadId, worktable))
    ).rejects.toThrow(TeamAccessError)
    await expect(
      runWithTeamIdentity(scoped, () => findThread(posted.threadId))
    ).rejects.toThrow()
    updateTeamAgent(agent.id, { worktableThreads: "edit" }, owner)
    expect(await offered()).toBe(true)
    expect(
      (await runWithTeamIdentity(scoped, () => findThread(posted.threadId))).id
    ).toBe(posted.threadId)
    // Personal agents follow their member unless narrowed to some Spaces.
    const personal = createTeamAgent(
      { name: "Bob Helper", platform: "codex", ownership: "personal" },
      member
    )
    bindTeamAgentCredential(personal.id, "local-token:bob-helper", member)
    const helper = resolveTeamAgentCredential({
      ...owner,
      team: undefined,
      agent: "codex",
      principal: { id: "local-token:bob-helper", type: "agent", displayName: "Codex" },
    })!
    expect(
      (await runWithTeamIdentity(helper, () => findThread(posted.threadId))).id
    ).toBe(posted.threadId)
    updateTeamAgent(personal.id, { spaceIds: [] }, member)
    await expect(
      runWithTeamIdentity(helper, () => findThread(posted.threadId, worktable))
    ).rejects.toThrow(TeamAccessError)
  })

  test("local activation preserves the owner and restricts existing Spaces; new Spaces share and grant management separately", async () => {
    const linkPath = join(root, "app", "linked", `${workspaceCacheKey()}.json`)
    await mkdir(join(root, "app", "linked"), { recursive: true })
    await writeFile(
      linkPath,
      JSON.stringify({
        version: 1,
        cloudOrigin: "https://cloud.example.test",
        controlSecret: "a".repeat(64),
        workspaceEpoch: await (
          await import("./collaboration-epoch.ts")
        ).getWorkspaceCollaborationEpoch(),
        label: "Existing installation",
        bootSequence: 1,
        disabled: false,
        billingWorkspaceId: "first_subscription",
      })
    )
    setLocalTeamInitializationHookForTests(() => {
      throw new Error("Interrupted local setup")
    })
    try {
      await expect(
        activateLocalTeams(
          origin,
          { name: "Alice", email: "alice@example.test", password },
          {
            user: "owner",
            workspace: join(root, "workspace"),
            credentialClass: "local",
            scopes: ["*"],
            agent: null,
            principal: {
              id: "local:owner",
              type: "human",
              displayName: "Owner",
            },
          }
        )
      ).rejects.toThrow("Interrupted local setup")
    } finally {
      setLocalTeamInitializationHookForTests(null)
    }
    const { writeTeamMarker, currentWorktableId } =
      await import("./team-database.ts")
    writeTeamMarker(currentWorktableId())
    clearTeamAuthInstances()
    closeTeamDatabases()
    ;(await import("./team-initialization.ts")).recoverTeamInitialization()
    const { owner, member } = await setup()
    expect((await import("./linked-runtime.ts")).linkedStatus()).toMatchObject({
      state: "paused",
      enabled: false,
      teamAuthorizationRequired: true,
      billingWorkspaceId: "first_subscription",
    })
    expect(
      JSON.parse(await readFile(linkPath, "utf8")).teamAuthorizationRequired
    ).toBe(true)

    expect(teamsEnabled()).toBe(true)
    expect(
      requireTeamDatabase()
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM organization")
        .get()!.count
    ).toBe(1)
    expect(owner.principal.id).toBe("local:owner")
    expect(canAccessSpace("original", "edit", owner)).toBe(true)
    expect(canAccessSpace("original", "read", member)).toBe(false)
    runWithTeamIdentity(member, () => registerTeamSpace("shared"))
    expect(canAccessSpace("shared", "edit", owner)).toBe(true)
    expect(canAccessSpace("shared", "manage", member)).toBe(true)
    runWithTeamIdentity(member, () =>
      setSpaceAccessPolicy(
        {
          spaceId: "shared",
          visibility: "restricted",
          grants: [
            {
              subjectType: "member",
              subjectId: member.team!.memberId!,
              access: "manage",
            },
          ],
        },
        member
      )
    )
    expect(canAccessSpace("shared", "read", owner)).toBe(true)
    expect(
      runWithTeamIdentity(member, () => getSpaceAccessPolicy("shared"))
        .visibility
    ).toBe("restricted")

    // A shared Space lets every member edit its content, but only managers
    // change how the Space itself appears to everyone.
    setSpaceAccessPolicy(
      { spaceId: "original", visibility: "shared", grants: [] },
      owner
    )
    await expect(
      runWithTeamIdentity(member, () => setSpaceArchived("original", true))
    ).rejects.toThrow(TeamAccessError)
    await expect(
      runWithTeamIdentity(member, () =>
        dispatchOperation("spaces.update", {
          spaceId: "original",
          name: "Renamed by a member",
        })
      )
    ).rejects.toThrow(TeamAccessError)
    const sorted = await runWithTeamIdentity(member, () =>
      mutateSpace("original", (space) => ({
        ...space,
        settings: { ...space.settings, docSort: "updated" },
      }))
    )
    expect(sorted.data?.settings["docSort"]).toBe("updated")
    expect(sorted.data?.name).toBe("Original")
    const archived = await runWithTeamIdentity(owner, () =>
      setSpaceArchived("original", true)
    )
    expect(archived.space?.settings["archive"]).toBeDefined()
  })

  test("personal agents remain distinct, follow current member access, and never inherit administrative authority", async () => {
    const { owner, member, auth, ownerHeaders, bobHeaders } = await setup()
    const aliceAgent = createTeamAgent(
      { name: "Alice Codex", platform: "codex", ownership: "personal" },
      owner
    )
    const bobAgent = createTeamAgent(
      { name: "Bob Codex", platform: "codex", ownership: "personal" },
      member
    )
    bindTeamAgentCredential(aliceAgent.id, "local-token:alice", owner)
    bindTeamAgentCredential(bobAgent.id, "local-token:bob", member)
    const credential = (id: string): TokenIdentity => ({
      ...owner,
      team: undefined,
      agent: "codex",
      principal: { id, type: "agent", displayName: "Codex" },
    })
    const alice = resolveTeamAgentCredential(credential("local-token:alice"))!
    const bob = resolveTeamAgentCredential(credential("local-token:bob"))!
    const { resolveParticipant } = await import("./participant-store.ts")
    const aliceParticipant = await resolveParticipant(alice)
    const bobParticipant = await resolveParticipant(bob)
    const presentations = (identity: TokenIdentity) =>
      runWithTeamIdentity(identity, () =>
        cachedParticipantPresentations(participantKey(identity))
      )
    expect(
      (await presentations(owner))[aliceParticipant.participant.id]?.name
    ).toBe("Alice Codex")
    expect(
      (await presentations(member))[aliceParticipant.participant.id]
    ).toBeUndefined()
    expect(
      (await presentations(member))[bobParticipant.participant.id]?.name
    ).toBe("Bob Codex")
    expect(
      (await presentations(owner))[aliceParticipant.participant.id]?.name
    ).toBe("Alice Codex")
    expect(participantKey(alice)).not.toBe(participantKey(bob))
    expect(canAccessSpace("original", "edit", alice)).toBe(true)
    expect(canAccessSpace("original", "read", bob)).toBe(false)
    setSpaceAccessPolicy(
      { spaceId: "original", visibility: "shared", grants: [] },
      owner
    )
    expect(canAccessSpace("original", "edit", bob)).toBe(true)
    expect(canAccessSpace("original", "manage", alice)).toBe(false)
    expect(() => requireTeamHuman(alice)).toThrow()
    updateTeamAgent(bobAgent.id, { spaceIds: [] }, member)
    expect(canAccessSpace("original", "read", bob)).toBe(false)
    expect(canCreateTeamSpace(bob)).toBe(false)
    const now = new Date().toISOString()
    await expect(
      runWithTeamIdentity(bob, () =>
        writeSpace({
          type: "worktable.space",
          version: 1,
          id: "refused",
          name: "Refused",
          createdAt: now,
          updatedAt: now,
          createdBy: "agent",
          settings: {},
        })
      )
    ).rejects.toThrow(TeamAccessError)
    // A refused creation leaves nothing that reserves the name.
    expect(existsSync(join(root, "workspace", "spaces", "refused"))).toBe(false)
    const beforeInvalid = await runWithTeamIdentity(
      member,
      listTeamAgentConnections
    )
    await expect(
      runWithTeamIdentity(member, () =>
        createTeamAgentConnection({
          label: "chatgpt-desktop",
          access: { threads: false, read: false, edit: false },
        })
      )
    ).rejects.toThrow("at least one")
    expect(await runWithTeamIdentity(member, listTeamAgentConnections)).toEqual(
      beforeInvalid
    )
    const first = await runWithTeamIdentity(member, () =>
      createTeamAgentConnection({
        label: "chatgpt-desktop",
        displayName: "Bob Assistant",
        access: { ...DEFAULT_AGENT_ACCESS, edit: false },
      })
    )
    const content = new Hono()
    content.use("/api/*", trustedLocalIdentity())
    content.route("/api/spaces/:spaceId/documents", documentsRouter)
    const write = () =>
      content.request(`${origin}/api/spaces/original/documents`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${first.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: "agent-edit",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: "Written after a human granted edit access",
        }),
      })
    expect((await write()).status).toBe(403)
    await expect(
      runWithTeamIdentity(member, () =>
        updateAgentConnection(first.connection.id, {
          access: { threads: false, read: false, edit: false },
        })
      )
    ).rejects.toThrow("at least one")
    const edited = await runWithTeamIdentity(member, () =>
      updateTeamAgentConnection(first.connection.id, {
        displayName: "Bob Research",
        access: DEFAULT_AGENT_ACCESS,
      })
    )
    expect((await write()).status).toBe(201)
    expect(edited?.participant?.name).toBe("Bob Research")
    updateTeamAgent(first.connection.id, { spaceIds: [] }, member)
    const reconnect = await runWithTeamIdentity(member, () =>
      createTeamAgentConnection({
        label: "chatgpt-desktop",
        access: DEFAULT_AGENT_ACCESS,
      })
    )
    expect(reconnect.connection.id).toBe(first.connection.id)
    expect(reconnect.connection.displayName).toBe("Bob Research")
    expect(reconnect.connection.spaceIds).toEqual([])
    const otherMember = await runWithTeamIdentity(owner, () =>
      createTeamAgentConnection({
        label: "chatgpt-desktop",
        access: DEFAULT_AGENT_ACCESS,
      })
    )
    expect(otherMember.connection.id).not.toBe(first.connection.id)
    expect(() =>
      createTeamAgent(
        { name: "Team Codex", platform: "codex", ownership: "team" },
        member
      )
    ).toThrow()
    const resident = createTeamAgent(
      { name: "Team Assistant", platform: "codex", ownership: "team" },
      owner
    )
    bindTeamAgentCredential(resident.id, "local-token:team-assistant", owner)
    setSpaceAccessPolicy(
      {
        spaceId: "original",
        visibility: "restricted",
        grants: [
          { subjectType: "agent", subjectId: resident.id, access: "read" },
        ],
      },
      owner
    )
    const teamIdentity = resolveTeamAgentCredential(
      credential("local-token:team-assistant")
    )!
    expect(canAccessSpace("original", "read", teamIdentity)).toBe(true)
    expect(canAccessSpace("original", "edit", teamIdentity)).toBe(false)
    await runWithTeamIdentity(owner, () =>
      dispatchOperation("html.create", {
        lifetime: "durable",
        spaceId: "original",
        id: "status",
        name: "Status",
        html: "<main><h1>Readable by read grants</h1></main>",
      })
    )
    const readable = (await runWithTeamIdentity(teamIdentity, () =>
      dispatchOperation("html.read", { spaceId: "original", widgetId: "status" })
    )) as { html: string }
    expect(readable.html).toContain("Readable by read grants")
    await expect(
      runWithTeamIdentity(teamIdentity, () =>
        dispatchOperation("html.update", {
          spaceId: "original",
          widgetId: "status",
          html: "<main>Changed without edit access</main>",
        })
      )
    ).rejects.toThrow(TeamAccessError)
    await auth.api.updateMemberRole({
      headers: ownerHeaders,
      body: {
        organizationId: currentTeamWorktable()!.organizationId,
        memberId: member.team!.memberId!,
        role: "owner",
      },
    })
    await auth.api.removeMember({
      headers: bobHeaders,
      body: {
        organizationId: currentTeamWorktable()!.organizationId,
        memberIdOrEmail: owner.team!.memberId!,
      },
    })
    expect(
      resolveTeamAgentCredential(credential("local-token:team-assistant"))
        ?.principal.id
    ).toBe(teamIdentity.principal.id)
    expect(canAccessSpace("original", "read", teamIdentity)).toBe(true)
    updateTeamAgent(resident.id, { active: false }, member)
    const policy = runWithTeamIdentity(member, () =>
      getSpaceAccessPolicy("original")
    )
    expect(policy.grants).toEqual([])
    expect(() => setSpaceAccessPolicy(policy, member)).not.toThrow()
  })

  test("each member arranges their own Spaces, and an arrangement never names a Space they cannot read", async () => {
    const { owner, member } = await setup()
    const as = (identity: TokenIdentity) => {
      const next = new Hono()
      next.use("*", async (c, go) => {
        c.set("identity", identity)
        await go()
      })
      next.route("/api/workspace", workspaceRouter)
      next.route("/api/profile", profileRouter)
      return next
    }
    const save = (identity: TokenIdentity, body: Record<string, unknown>) =>
      as(identity).fetch(
        new Request("http://localhost/api/profile/navigation", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ knownSpaces: ["original"], ...body }),
        })
      )
    const navigation = async (identity: TokenIdentity) =>
      (
        (await (
          await as(identity).fetch(new Request("http://localhost/api/workspace"))
        ).json()) as { navigation?: unknown }
      ).navigation
    const groups = [{ id: "g1", name: "Old work" }]
    const arrangement = { groups, spaceGroups: { original: "g1" }, pins: ["original"] }

    const grantBob = (access: "read" | null) =>
      setSpaceAccessPolicy(
        {
          spaceId: "original",
          visibility: "restricted",
          grants: access
            ? [{ subjectType: "member", subjectId: member.team!.memberId!, access }]
            : [],
        },
        owner
      )

    expect((await save(owner, { expectedRevision: 0, ...arrangement })).status).toBe(200)
    expect(await navigation(member)).toBeNull()

    grantBob("read")
    expect((await save(member, { expectedRevision: 0, ...arrangement })).status).toBe(200)

    // Losing access hides the Space from Bob's arrangement without forgetting it.
    grantBob(null)
    expect(await navigation(member)).toEqual({ revision: 1, groups, spaceGroups: {}, pins: [] })
    const more = [...groups, { id: "g2", name: "New work" }]
    expect(
      (await save(member, { expectedRevision: 1, groups: more, spaceGroups: {}, pins: [] })).status
    ).toBe(200)

    grantBob("read")
    expect(await navigation(member)).toEqual({ ...arrangement, revision: 2, groups: more })

    // A tab that loaded while the Space was hidden doesn't know it, so its
    // change leaves the Space's placement alone.
    expect(
      (await save(member, { expectedRevision: 2, groups: more, spaceGroups: {}, pins: [], knownSpaces: [] })).status
    ).toBe(200)
    expect(await navigation(member)).toEqual({ ...arrangement, revision: 3, groups: more })
    expect(await navigation(owner)).toEqual({ revision: 1, ...arrangement })
  })

  test("removing and reinviting a member preserves their actor but never restores old credentials or Space grants", async () => {
    const { auth, owner, ownerHeaders, member } = await setup()
    const oldMemberId = member.team!.memberId!
    runWithTeamIdentity(member, () => registerTeamSpace("bob-private"))
    setSpaceAccessPolicy(
      {
        spaceId: "bob-private",
        visibility: "restricted",
        grants: [
          { subjectType: "member", subjectId: oldMemberId, access: "manage" },
        ],
      },
      member
    )
    const agent = createTeamAgent(
      { name: "Bob Codex", platform: "codex", ownership: "personal" },
      member
    )
    bindTeamAgentCredential(agent.id, "local-token:bob", member)
    bindTeamAgentCredential(agent.id, "oauth:bob", member, true)
    const raw: TokenIdentity = {
      ...owner,
      team: undefined,
      agent: "codex",
      principal: { id: "local-token:bob", type: "agent", displayName: "Codex" },
    }
    const liveAgent = resolveTeamAgentCredential(raw)!
    expect(liveAgent).not.toBeNull()
    const cloudRaw: TokenIdentity = {
      ...raw,
      credentialIssuedAt: Date.now() - 60_000,
      principal: { ...raw.principal, id: "oauth:bob" },
    }
    const previousCloud = resolveTeamAgentCredential(cloudRaw)!
    await runWithTeamIdentity(member, () =>
      disconnectTeamAgentConnection(agent.id)
    )
    expect(resolveTeamAgentCredential(cloudRaw)).toBeNull()
    expect(
      (await runWithTeamIdentity(owner, listTeamAgentConnections)).some(
        (connection) => connection.id === agent.id
      )
    ).toBe(false)
    expect(
      (await runWithTeamIdentity(member, listTeamAgentConnections)).find(
        (connection) => connection.id === agent.id
      )?.canReconnect
    ).toBe(true)
    expect(() => reconnectCloudPersonalAgent(agent.id, owner)).toThrow()
    reconnectCloudPersonalAgent(agent.id, member)
    expect(resolveTeamAgentCredential(cloudRaw)).toBeNull()
    const freshCloudRaw = {
      ...cloudRaw,
      credentialIssuedAt: Math.ceil(Date.now() / 1000) * 1000,
    }
    expect(resolveTeamAgentCredential(freshCloudRaw)?.principal.id).toBe(
      previousCloud.principal.id
    )
    await auth.api.removeMember({
      headers: ownerHeaders,
      body: {
        organizationId: currentTeamWorktable()!.organizationId,
        memberIdOrEmail: oldMemberId,
      },
    })
    expect(resolveTeamAgentCredential(raw)).toBeNull()
    expect(canAccessSpace("bob-private", "read", liveAgent)).toBe(false)
    const localAuth = new Hono().route("/auth/team", teamAuthRouter)
    const removedSignIn = await localAuth.request(
      `${origin}/auth/team/sign-in/email`,
      {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        body: JSON.stringify({ email: "bob@example.test", password }),
      }
    )
    expect(removedSignIn.status).toBe(403)
    expect(removedSignIn.headers.get("Set-Cookie")).toBeNull()
    expect(findTeamMemberById(oldMemberId)).toBeNull()
    const invitation = await auth.api.createInvitation({
      headers: ownerHeaders,
      body: {
        organizationId: currentTeamWorktable()!.organizationId,
        email: "bob@example.test",
        role: "member",
      },
    })
    const signedIn = await auth.api.signInEmail({
      body: { email: "bob@example.test", password },
      returnHeaders: true,
    })
    await auth.api.acceptInvitation({
      headers: sessionHeaders(signedIn.headers),
      body: { invitationId: invitation.id },
    })
    const returned = findTeamMember(member.team!.userId!)!
    expect(returned.actorId).toBe(member.principal.id)
    expect(returned.id).not.toBe(oldMemberId)
    expect(findTeamMemberById(oldMemberId)).toBeNull()
    expect(
      canAccessSpace("bob-private", "manage", identityForTeamMember(returned))
    ).toBe(false)
    expect(resolveTeamAgentCredential(raw)).toBeNull()
    const returnedIdentity = identityForTeamMember(returned)
    expect(
      (
        await runWithTeamIdentity(returnedIdentity, listTeamAgentConnections)
      ).find((connection) => connection.id === agent.id)?.canReconnect
    ).toBe(true)
    expect(resolveTeamAgentCredential(freshCloudRaw)).toBeNull()
    const nextIssuedAt = Math.ceil(Date.now() / 1000) * 1000 + 1000
    const clock = spyOn(Date, "now").mockReturnValue(nextIssuedAt)
    try {
      reconnectCloudPersonalAgent(agent.id, returnedIdentity)
      expect(resolveTeamAgentCredential(freshCloudRaw)).toBeNull()
      const reauthorized = resolveTeamAgentCredential({
        ...cloudRaw,
        credentialIssuedAt: nextIssuedAt,
      })!
      expect(reauthorized.principal.id).not.toBe(previousCloud.principal.id)
      expect(canAccessSpace("bob-private", "read", reauthorized)).toBe(false)
      expect(canAccessSpace("bob-private", "read", previousCloud)).toBe(false)
    } finally {
      clock.mockRestore()
    }
  })
})

test("an HTML Doc reads Records for members with read access and writes only for editors", async () => {
  const { owner, member, bobHeaders } = await setup()
  setSpaceAccessPolicy(
    {
      spaceId: "original",
      visibility: "restricted",
      grants: [
        {
          subjectType: "member",
          subjectId: member.team!.memberId!,
          access: "read",
        },
      ],
    },
    owner
  )
  await runWithTeamIdentity(owner, async () => {
    await dispatchOperation("records.upsert_collection", {
      spaceId: "original",
      collectionId: "tasks",
      fields: { title: { type: "string" } },
    })
    await dispatchOperation("records.create", {
      spaceId: "original",
      collectionId: "tasks",
      recordId: "first",
      data: { title: "First" },
    })
    await dispatchOperation("html.create", {
      lifetime: "durable",
      spaceId: "original",
      id: "board",
      name: "Board",
      html: "<main><h1>Board</h1></main>",
      permissions: { records: { tasks: { read: true, create: true } } },
    })
  })
  const app = new Hono()
  app.onError(
    (error) =>
      new Response(error.message, {
        status: error instanceof TeamAccessError ? 403 : 500,
      })
  )
  app.use("/api/*", trustedLocalIdentity())
  app.route("/api/spaces/:spaceId/widgets", widgetsRouter)
  const bridge = (path: string, method: string, body: unknown) =>
    app.request(`${origin}/api/spaces/original/widgets/board${path}`, {
      method,
      headers: { Cookie: bobHeaders.get("Cookie")!, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

  // The bridge sends queries as POST; they are reads.
  const query = await bridge("/records/tasks/query", "POST", {})
  expect(query.status).toBe(200)
  expect(
    ((await query.json()) as { records: { id: string }[] }).records.map(
      (record) => record.id
    )
  ).toEqual(["first"])
  expect(
    (await bridge("/records/tasks", "POST", { data: { title: "Second" } }))
      .status
  ).toBe(403)
  expect((await bridge("/state", "PUT", { state: { seen: true } })).status).toBe(
    403
  )
})

test("HTTP requires named members, admits an invitation once, and binds minted credentials to the inviting member", async () => {
  const { bobHeaders, member, owner } = await setup()
  const app = new Hono()
  app.onError(
    (error) =>
      new Response(error.message, {
        status: error instanceof TeamAccessError ? 403 : 500,
      })
  )
  app.use("/api/*", trustedLocalIdentity())
  app.route("/api/team", teamRouter)
  app.route("/api/spaces", spacesRouter)
  app.route("/api/tokens", tokensRouter)
  app.route("/api/spaces/:spaceId/documents", documentsRouter)
  app.route("/auth/team", teamAuthRouter)
  const hostProbeStatuses: number[] = []
  for (let index = 0; index < 32; index++)
    hostProbeStatuses.push(
      (
        await app.request(`${origin}/auth/team/get-session`, {
          headers: {
            "X-Forwarded-Host": `host-${index}.example.test`,
            "X-Forwarded-Proto": "https",
          },
        })
      ).status
    )
  expect(
    hostProbeStatuses.every((status) => status === 200 || status === 429)
  ).toBe(true)
  expect((await app.request(`${origin}/api/spaces`)).status).toBe(401)
  const spaces = await app.request(`${origin}/api/spaces`, {
    headers: bobHeaders,
  })
  expect(await spaces.json()).toEqual({ spaces: [] })
  expect(
    (
      await app.request(`${origin}/api/spaces/original`, {
        headers: bobHeaders,
      })
    ).status
  ).toBe(403)
  const headers = new Headers(bobHeaders)
  headers.set("Content-Type", "application/json")
  headers.set("X-Worktable-Member", owner.team!.memberId!)
  expect(
    (
      await app.request(`${origin}/api/spaces`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Wrong Account" }),
      })
    ).status
  ).toBe(409)
  headers.set("X-Worktable-Member", member.team!.memberId!)
  const created = await app.request(`${origin}/api/spaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Shared Notes" }),
  })
  expect(created.status).toBe(201)
  const { spaceId } = (await created.json()) as { spaceId: string }
  const collision = await app.request(`${origin}/api/spaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Original" }),
  })
  expect(collision.status).toBe(201)
  expect(await collision.json()).toMatchObject({ spaceId: "original-2" })
  expect(canAccessSpace("original", "read", member)).toBe(false)

  expect(
    runWithTeamIdentity(member, () => getSpaceAccessPolicy(spaceId)).visibility
  ).toBe("shared")
  const document = await app.request(
    `${origin}/api/spaces/${spaceId}/documents`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        path: "hello",
        format: { id: "worktable.markdown", sourceVersion: 1 },
        source: "# Team notes",
      }),
    }
  )
  expect(document.status).toBe(201)
  // Each person authors their own versions, so one member's saves never
  // continue another's version.
  const { documentId } = (await document.json()) as { documentId: DocumentId }
  expect(
    (
      await listDocumentGenerationsV2({
        workspaceRoot: join(root, "workspace"),
        spaceId,
        documentId,
      })
    ).map((generation) => generation.createdBy)
  ).toEqual([member.principal.id])
  setSpaceAccessPolicy({ spaceId, visibility: "shared", grants: [] }, owner)
  expect(canAccessSpace(spaceId, "manage", member)).toBe(false)
  const order = () =>
    app.request(`${origin}/api/spaces/${spaceId}/doc-order`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ sort: "alphabetical" }),
    })
  expect((await order()).status).toBe(200)
  setSpaceAccessPolicy(
    {
      spaceId,
      visibility: "restricted",
      grants: [
        {
          subjectType: "member",
          subjectId: member.team!.memberId!,
          access: "read",
        },
      ],
    },
    owner
  )
  expect(
    (
      await app.request(`${origin}/api/spaces/${spaceId}/documents`, {
        headers,
      })
    ).status
  ).toBe(200)
  expect(
    (
      await app.request(`${origin}/api/spaces/${spaceId}/documents`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          path: "forbidden",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: "Denied",
        }),
      })
    ).status
  ).toBe(403)
  const invite = await app.request(`${origin}/api/team/invitations`, {
    method: "POST",
    headers: new Headers({
      Cookie: bobHeaders.get("Cookie")!,
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ email: "carol@example.test" }),
  })
  expect(invite.status).toBe(201)
  const { invitation } = (await invite.json()) as { invitation: { id: string } }
  const request = () =>
    app.request(`${origin}/auth/team/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invitationId: invitation.id,
        name: "Carol",
        password,
      }),
    })
  expect((await request()).status).toBe(200)
  expect((await request()).status).toBe(410)
  expect(
    (await app.request(`${origin}/auth/team/sign-up/email`, { method: "POST" }))
      .status
  ).toBe(404)
  expect((await order()).status).toBe(403)
  const connectionsBeforeFailure = await runWithTeamIdentity(
    member,
    listTeamAgentConnections
  )
  const tokenFile = join(root, "app", "tokens.json")
  await mkdir(tokenFile)
  try {
    expect(
      (
        await app.request(`${origin}/api/tokens`, {
          method: "POST",
          headers: new Headers({
            Cookie: bobHeaders.get("Cookie")!,
            "Content-Type": "application/json",
          }),
          body: JSON.stringify({ agent: "codex", scopes: ["docs:read"] }),
        })
      ).status
    ).toBe(500)
  } finally {
    await rm(tokenFile, { recursive: true, force: true })
  }
  expect(await runWithTeamIdentity(member, listTeamAgentConnections)).toEqual(
    connectionsBeforeFailure
  )
  const tokenResponse = await app.request(`${origin}/api/tokens`, {
    method: "POST",
    headers: new Headers({
      Cookie: bobHeaders.get("Cookie")!,
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({ agent: "codex", scopes: ["docs:read"] }),
  })
  expect(tokenResponse.status).toBe(201)
  const { token } = (await tokenResponse.json()) as { token: string }
  const target = (await resolveParticipant(owner)).participant
  const posted = await runWithTeamIdentity(member, () =>
    postThreadMessage(member, {
      to: target.id,
      body: "Shared Worktable thread",
      idempotencyKey: "team-global-lookup",
    })
  )
  expect(
    (await runWithTeamIdentity(member, () => findThread(posted.threadId))).id
  ).toBe(posted.threadId)
  const identity = await verifyBearer(token)
  expect(identity?.principal.type).toBe("agent")
  expect(identity?.team?.memberId).toBe(member.team!.memberId)
  expect(canAccessSpace("original", "read", identity!)).toBe(false)
})

test("a Cloud plan holds members and pending invitations, never more, and keeps the person who pays an owner", async () => {
  const { auth, ownerHeaders, owner, member } = await setup()
  const {
    assertPayerKeepsOwnership,
    assertRoomForInvitation,
    peopleInWorktable,
    PlanFullError,
  } = await import("./hosted-billing.ts")
  const team = (limit: number | null) => ({
    plan: "team" as const,
    peopleLimit: limit,
    access: "active" as const,
  })
  // Alice and Bob are members.
  expect(peopleInWorktable()).toBe(2)
  const pending = await auth.api.createInvitation({
    headers: ownerHeaders,
    body: {
      organizationId: currentTeamWorktable()!.organizationId,
      email: "carol@example.test",
      role: "member",
    },
  })
  expect(peopleInWorktable()).toBe(3)
  expect(() => assertRoomForInvitation(team(4))).not.toThrow()
  expect(() => assertRoomForInvitation(team(null))).not.toThrow()
  let full: unknown
  try {
    assertRoomForInvitation(team(3))
  } catch (error) {
    full = error
  }
  expect(full).toBeInstanceOf(PlanFullError)
  expect((full as InstanceType<typeof PlanFullError>).room).toMatchObject({
    plan: "team",
    limit: 3,
    used: 3,
    nextPlan: "team30",
  })
  // An expired invitation frees its place.
  requireTeamDatabase()
    .query("UPDATE invitation SET expiresAt = ? WHERE id = ?")
    .run(Date.now() - 1000, pending.id)
  expect(peopleInWorktable()).toBe(2)

  // The payer can't be removed or made a member until billing moves.
  const worktable = currentTeamWorktable()!
  requireTeamDatabase()
    .query(
      "INSERT INTO wt_identity_bindings(worktable_id, issuer, subject, user_id, company_id) VALUES (?, ?, ?, ?, NULL)"
    )
    .run(worktable.id, "https://identity.example.test", "user_payer", owner.team!.userId!)
  advanceTeamPolicy(worktable.id)
  const paidBy = {
    ...team(10),
    payer: { subject: "user_payer", name: "Alice" },
  }
  expect(() =>
    assertPayerKeepsOwnership(owner.team!.userId!, null, paidBy)
  ).toThrow(TeamAccessError)
  expect(() =>
    assertPayerKeepsOwnership(owner.team!.userId!, "member", paidBy)
  ).toThrow(TeamAccessError)
  expect(() =>
    assertPayerKeepsOwnership(owner.team!.userId!, "owner", paidBy)
  ).not.toThrow()
  expect(() =>
    assertPayerKeepsOwnership(member.team!.userId!, null, paidBy)
  ).not.toThrow()
})

test("invitations carry a starting Space, report their email, and grant a restricted Space only while the inviter manages it", async () => {
  const { bobHeaders, member, owner, ownerHeaders } = await setup()
  const app = new Hono()
  app.onError(
    (error) =>
      new Response(error.message, {
        status: error instanceof TeamAccessError ? 403 : 500,
      })
  )
  app.use("/api/*", trustedLocalIdentity())
  app.route("/api/team", teamRouter)
  app.route("/auth/team", teamAuthRouter)
  const asOwner = new Headers({
    Cookie: ownerHeaders.get("Cookie")!,
    "Content-Type": "application/json",
  })
  const asBob = new Headers({
    Cookie: bobHeaders.get("Cookie")!,
    "Content-Type": "application/json",
  })
  const invite = (headers: Headers, body: object) =>
    app.request(`${origin}/api/team/invitations`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
  const enroll = (invitationId: string, name: string) =>
    app.request(`${origin}/auth/team/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitationId, name, password }),
    })
  const identityFor = (email: string) => {
    const userId = requireTeamDatabase()
      .query<{ id: string }, [string]>('SELECT id FROM "user" WHERE email = ?')
      .get(email)!.id
    return identityForTeamMember(findTeamMember(userId)!)
  }

  // "original" existed before Teams, so it is restricted and Bob can't see
  // it: naming it reads exactly like naming a Space that doesn't exist.
  expect(
    (await invite(asBob, { email: "nobody@example.test", spaceId: "original" }))
      .status
  ).toBe(404)

  const variables = {
    WORKTABLE_INVITATION_MAIL_URL: "https://control.example.test/runtime/invitations/email",
    WORKTABLE_INVITATION_MAIL_RUNTIME_ID: "runtime_test",
    WORKTABLE_GATEWAY_SECRET: "synthetic-gateway-secret-for-invitation-email",
  } as const
  const saved = Object.keys(variables).map((key) => process.env[key])
  Object.assign(process.env, variables)
  const sent: Array<{ headers: Headers; body: Record<string, unknown> }> = []
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    expect(String(input)).toBe(variables.WORKTABLE_INVITATION_MAIL_URL)
    sent.push({
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    })
    return Response.json({ status: "sent" })
  }) as typeof fetch)
  try {
    writeWorkspaceManifest({ ...ensureWorkspaceManifest(), name: "Northwind" })
    const created = await invite(asOwner, {
      email: "carol@example.test",
      spaceId: "original",
    })
    expect(created.status).toBe(201)
    const carolInvite = (await created.json()) as {
      invitation: { id: string }
      email: string
    }
    expect(carolInvite.email).toBe("sent")
    expect(sent).toHaveLength(1)
    expect(sent[0]!.headers.get("Authorization")).toBe(
      `Bearer ${variables.WORKTABLE_GATEWAY_SECRET}`
    )
    expect(sent[0]!.headers.get("X-Worktable-Runtime")).toBe("runtime_test")
    expect(sent[0]!.body).toMatchObject({
      invitationId: carolInvite.invitation.id,
      email: "carol@example.test",
      inviterName: "Alice",
      worktableName: "Northwind",
      spaceName: "Original",
    })
    // A just-emailed invitation can't be emailed again straight away.
    const again = await app.request(
      `${origin}/api/team/invitations/${carolInvite.invitation.id}/email`,
      { method: "POST", headers: asOwner }
    )
    expect(again.status).toBe(429)
    expect(sent).toHaveLength(1)
    const listed = (await (
      await app.request(`${origin}/api/team/invitations`, { headers: asOwner })
    ).json()) as {
      email: boolean
      invitations: Array<{
        id: string
        startSpaceId: string | null
        emailed: boolean
        url: string
      }>
    }
    expect(listed.email).toBe(true)
    expect(
      listed.invitations.find((item) => item.id === carolInvite.invitation.id)
    ).toMatchObject({
      startSpaceId: "original",
      emailed: true,
      url: `${origin}/login?invite=${carolInvite.invitation.id}`,
    })

    // An expired invitation is never emailed again.
    requireTeamDatabase()
      .query("UPDATE invitation SET expiresAt = ? WHERE id = ?")
      .run(Date.now() - 1000, carolInvite.invitation.id)
    expect(
      (
        await app.request(
          `${origin}/api/team/invitations/${carolInvite.invitation.id}/email`,
          { method: "POST", headers: asOwner }
        )
      ).status
    ).toBe(410)
    expect(sent).toHaveLength(1)

    // A provider failure is reported, and the invitation still exists.
    fetchSpy.mockImplementation((async () =>
      new Response("unavailable", { status: 502 })) as unknown as typeof fetch)
    const failed = await invite(asOwner, { email: "erin@example.test" })
    expect(failed.status).toBe(201)
    expect(((await failed.json()) as { email: string }).email).toBe("failed")
  } finally {
    fetchSpy.mockRestore()
    for (const [index, key] of Object.keys(variables).entries()) {
      const value = saved[index]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  const { invitation: carolInvitation } = (await (
    await invite(asOwner, { email: "carol2@example.test", spaceId: "original" })
  ).json()) as { invitation: { id: string } }
  const joined = await enroll(carolInvitation.id, "Carol")
  expect(joined.status).toBe(200)
  expect(await joined.json()).toEqual({ ok: true, spaceId: "original" })
  expect(canAccessSpace("original", "edit", identityFor("carol2@example.test"))).toBe(
    true
  )
  // Joining has ticked off the new member's first step, and the inviter's,
  // by the time acceptance answers, so the member's first page shows it.
  const stepDone = (identity: TokenIdentity, item: SetupItemId) =>
    readPersonSetup(participantKey(identity))?.items[item]
  expect(stepDone(identityFor("carol2@example.test"), "join-space")).toMatchObject(
    { spaceId: "original" }
  )
  expect(stepDone(owner, "invite-team")).toBeDefined()

  // A Space archived since the invitation is not where the member lands.
  const { invitation: hankInvitation } = (await (
    await invite(asOwner, { email: "hank@example.test", spaceId: "original" })
  ).json()) as { invitation: { id: string } }
  await runWithTeamIdentity(owner, () => setSpaceArchived("original", true))
  expect(await (await enroll(hankInvitation.id, "Hank")).json()).toEqual({
    ok: true,
  })
  await runWithTeamIdentity(owner, () => setSpaceArchived("original", false))

  // Retiring a Space's policy clears it from pending invitations, so a Space
  // that later takes the same id is never granted through them.
  const { invitation: ginaInvitation } = (await (
    await invite(asOwner, { email: "gina@example.test", spaceId: "original" })
  ).json()) as { invitation: { id: string } }
  const { retireTeamSpacePolicy } = await import("./team-policy.ts")
  retireTeamSpacePolicy("original")
  const afterRetire = (await (
    await app.request(`${origin}/api/team/invitations`, { headers: asOwner })
  ).json()) as { invitations: Array<{ id: string; startSpaceId: string | null }> }
  expect(
    afterRetire.invitations.find((item) => item.id === ginaInvitation.id)
      ?.startSpaceId
  ).toBeNull()

  // Bob manages a restricted Space, invites Dave into it, then loses that
  // authority before Dave accepts: Dave joins without access to it.
  setSpaceAccessPolicy(
    {
      spaceId: "original",
      visibility: "restricted",
      grants: [
        { subjectType: "member", subjectId: member.team!.memberId!, access: "manage" },
      ],
    },
    owner
  )
  const daveInvite = await invite(asBob, {
    email: "dave@example.test",
    spaceId: "original",
  })
  expect(daveInvite.status).toBe(201)
  const { invitation: daveInvitation } = (await daveInvite.json()) as {
    invitation: { id: string }
  }
  setSpaceAccessPolicy(
    {
      spaceId: "original",
      visibility: "restricted",
      grants: [
        { subjectType: "member", subjectId: member.team!.memberId!, access: "read" },
      ],
    },
    owner
  )
  // Reading a restricted Space is not enough to invite someone into it.
  expect(
    (await invite(asBob, { email: "frank@example.test", spaceId: "original" }))
      .status
  ).toBe(403)
  const daveJoined = await enroll(daveInvitation.id, "Dave")
  expect(await daveJoined.json()).toEqual({ ok: true })
  expect(canAccessSpace("original", "read", identityFor("dave@example.test"))).toBe(
    false
  )
})

test("content replacement retires old Space grants and lets a reused Space acquire its new creator", async () => {
  const { owner, member } = await setup()
  const agent = createTeamAgent(
    { name: "Shared agent", platform: "codex", ownership: "team" },
    owner
  )
  bindTeamAgentCredential(agent.id, "local-token:replaced-space", owner)
  const raw = {
    ...owner,
    team: undefined,
    agent: "codex",
    principal: {
      id: "local-token:replaced-space",
      type: "agent" as const,
      displayName: "Shared agent",
    },
  }
  const agentIdentity = resolveTeamAgentCredential(raw)!
  setSpaceAccessPolicy(
    {
      spaceId: "original",
      visibility: "shared",
      grants: [
        {
          subjectType: "member",
          subjectId: member.team!.memberId!,
          access: "manage",
        },
        { subjectType: "agent", subjectId: agent.id, access: "edit" },
      ],
    },
    owner
  )
  expect(canAccessSpace("original", "manage", member)).toBe(true)
  expect(canAccessSpace("original", "edit", agentIdentity)).toBe(true)
  const { operatorSnapshotDirectory } = await import("./operator-snapshot.ts")
  const { writeWorkspaceSnapshot } = await import("./workspace-snapshot.ts")
  const operationId = "content_only_recovery"
  const download = join(
    await operatorSnapshotDirectory(operationId),
    "download"
  )
  const snapshot = await writeWorkspaceSnapshot(download)
  expect(snapshot.teamState).toBeUndefined()
  await rename(join(root, "workspace"), join(root, "missing-workspace"))
  const {
    recoverMissingWorkspaceSnapshot,
    setMissingRootRecoveryHookForTests,
  } = await import("./workspace-snapshot-restore.ts")
  setMissingRootRecoveryHookForTests(() => {
    throw new Error("Interrupted offline restore")
  })
  try {
    await expect(
      recoverMissingWorkspaceSnapshot(
        operationId,
        snapshot.workspaceId,
        snapshot.sourceCheckpoint
      )
    ).rejects.toThrow("Interrupted offline restore")
  } finally {
    setMissingRootRecoveryHookForTests(null)
  }
  // A replacement process completes the durable reset before serving any member.
  const { startServer, stopActiveServer } = await import("./index.ts")
  startServer(0, "127.0.0.1")
  try {
    expect(canAccessSpace("original", "read", member)).toBe(false)
  } finally {
    await stopActiveServer()
  }
  expect(findTeamMemberById(member.team!.memberId!)?.actorId).toBe(
    member.principal.id
  )
  expect(canAccessSpace("original", "read", member)).toBe(false)
  expect(canAccessSpace("original", "read", agentIdentity)).toBe(false)
  expect(canAccessSpace("original", "manage", owner)).toBe(true)
  const recreated = (await readSpace("original")).data!
  await rm(join(root, "workspace", "spaces", "original"), {
    recursive: true,
    force: true,
  })
  await runWithTeamIdentity(member, () =>
    writeSpace({ ...recreated, name: "Recreated" })
  )
  expect(canAccessSpace("original", "manage", member)).toBe(true)
  expect(canAccessSpace("original", "read", agentIdentity)).toBe(false)
})

test("pending pairings create no agent until authorized redemption and expire without a connection", async () => {
  const { owner, member } = await setup()
  const {
    registerTeamPairing,
    bindTeamPairingCredential,
    retireFailedTeamPairingCredential,
    requireTeamPairingAdministrator,
  } = await import("./team-pairing.ts")
  const input = {
    name: "Bob remote",
    platform: "codex",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
  const inventory = () => runWithTeamIdentity(member, listTeamAgentConnections)
  registerTeamPairing(
    "abandoned",
    { ...input, expiresAt: new Date(Date.now() - 1).toISOString() },
    member
  )
  registerTeamPairing("ready", input, member)
  expect(await inventory()).toEqual([])
  expect(() =>
    bindTeamPairingCredential("abandoned", "local-token:never-minted")
  ).toThrow()
  expect(() => requireTeamPairingAdministrator("ready", owner)).not.toThrow()
  const binding = bindTeamPairingCredential(
    "ready",
    "local-token:redeemed-pairing"
  )
  expect(await inventory()).toMatchObject([{ displayName: "Bob remote" }])
  bindTeamPairingCredential("ready", "local-token:redeemed-pairing")
  expect(await inventory()).toHaveLength(1)
  retireFailedTeamPairingCredential(binding, "local-token:redeemed-pairing")
  expect(await inventory()).toEqual([])
  expect(() => requireTeamPairingAdministrator("ready", member)).not.toThrow()
  const resident = createTeamAgent(
    { name: "Existing team agent", platform: "codex", ownership: "team" },
    owner
  )
  bindTeamAgentCredential(resident.id, "local-token:existing-team-agent", owner)
  registerTeamPairing(
    "failed-reconnect",
    { ...input, agentId: resident.id },
    owner
  )
  const reconnect = bindTeamPairingCredential(
    "failed-reconnect",
    "local-token:failed-reconnect"
  )
  retireFailedTeamPairingCredential(reconnect, "local-token:failed-reconnect")
  const raw = (key: string): TokenIdentity => ({
    ...owner,
    team: undefined,
    agent: "codex",
    principal: { id: key, type: "agent", displayName: "Existing team agent" },
  })
  expect(
    resolveTeamAgentCredential(raw("local-token:failed-reconnect"))
  ).toBeNull()
  expect(
    resolveTeamAgentCredential(raw("local-token:existing-team-agent"))?.team
      ?.agentId
  ).toBe(resident.id)
})

test("connector rollback retires its Team credential without removing other agent credentials", async () => {
  const { member } = await setup()
  const { pairingRouter } = await import("./routes/pairing.ts")
  const { createPairingSession } = await import("./pairing-store.ts")
  const { registerTeamPairing } = await import("./team-pairing.ts")
  const { verifyToken } = await import("./token-store.ts")
  const app = new Hono().route("/api/pairing", pairingRouter)
  const post = (path: string, body: unknown) => app.request(`${origin}/api/pairing/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const existing = createTeamAgent({ name: "Existing", platform: "codex", ownership: "personal" }, member)
  bindTeamAgentCredential(existing.id, "local-token:prior-pairing", member)
  for (const [event, agentId, keepAnother] of [
    ["rolled_back", undefined, false],
    ["failed_no_config", undefined, true],
    ["rolled_back", existing.id, false],
  ] as const) {
    const name = `Rollback ${event} ${agentId ?? keepAnother}`
    const pairing = await createPairingSession({ client: "codex", scopes: ["docs:read"], mcpUrl: `${origin}/mcp` })
    registerTeamPairing(pairing.session.id, { name, platform: "codex", agentId, expiresAt: pairing.session.expiresAt }, member)
    const response = await post("redeem", { code: pairing.code, hostname: name.replaceAll(" ", "-") })
    expect(response.status).toBe(200)
    const { token } = await response.json() as { token: string }
    const raw = (await verifyToken(token))!
    const identity = resolveTeamAgentCredential(raw)!
    expect(identity.team?.agentId).toBeDefined()
    if (keepAnother) bindTeamAgentCredential(identity.team!.agentId!, "local-token:another-pairing", member)
    expect((await runWithTeamIdentity(member, listTeamAgentConnections)).some(item => item.id === identity.team!.agentId)).toBe(true)
    expect((await post("progress", { code: pairing.code, event })).status).toBe(200)
    expect(await verifyToken(token)).toBeNull()
    expect(resolveTeamAgentCredential(raw)).toBeNull()
    expect((await runWithTeamIdentity(member, listTeamAgentConnections)).some(item => item.id === identity.team!.agentId)).toBe(Boolean(agentId || keepAnother))
    // Repeated rollback reports remain harmless.
    expect((await post("progress", { code: pairing.code, event })).status).toBe(200)
  }
  expect((await runWithTeamIdentity(member, listTeamAgentConnections)).some(item => item.id === existing.id)).toBe(true)
})

test("re-pairing an installation keeps its agent and retires the previous credential", async () => {
  const { member, owner } = await setup()
  const { pairingRouter } = await import("./routes/pairing.ts")
  const { createPairingSession } = await import("./pairing-store.ts")
  const { registerTeamPairing } = await import("./team-pairing.ts")
  const { verifyToken } = await import("./token-store.ts")
  const app = new Hono().route("/api/pairing", pairingRouter)
  const request = (path: string, body: unknown, token?: string) =>
    app.request(`${origin}/api/pairing/${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    })
  const pair = async (identity: TokenIdentity) => {
    const pairing = await createPairingSession({
      client: "codex",
      target: { kind: "mcp-client", client: "codex", icon: "sparkles" },
      scopes: ["docs:read"],
      mcpUrl: `${origin}/mcp`,
    })
    registerTeamPairing(
      pairing.session.id,
      { name: "Laptop Codex", platform: "codex", expiresAt: pairing.session.expiresAt },
      identity
    )
    const redeemed = await request("redeem", { code: pairing.code, hostname: "laptop" })
    expect(redeemed.status).toBe(200)
    const { token } = (await redeemed.json()) as { token: string }
    expect((await request("complete", { code: pairing.code }, token)).status).toBe(200)
    return token
  }
  const first = await pair(member)
  const firstAgent = resolveTeamAgentCredential((await verifyToken(first))!)!
  const second = await pair(member)
  expect(await verifyToken(first)).toBeNull()
  const secondAgent = resolveTeamAgentCredential((await verifyToken(second))!)!
  expect(secondAgent.team?.agentId).toBe(firstAgent.team?.agentId)
  const agents = (await runWithTeamIdentity(member, listTeamAgentConnections))
    .filter((agent) => agent.id === secondAgent.team?.agentId)
  expect(agents).toHaveLength(1)
  expect(agents[0]!.icon).toBe("sparkles")
  // Another member pairing the same kind of installation gets their own agent.
  const ownerToken = await pair(owner)
  const ownerAgent = resolveTeamAgentCredential((await verifyToken(ownerToken))!)!
  expect(ownerAgent.team?.agentId).not.toBe(secondAgent.team?.agentId)
  expect(await verifyToken(second)).not.toBeNull()
})

test("access follows changes made through another database connection", async () => {
  const { owner, member } = await setup()
  const { Database } = await import("bun:sqlite")
  const { teamDatabasePath } = await import("./team-database.ts")
  setSpaceAccessPolicy(
    {
      spaceId: "original",
      visibility: "restricted",
      grants: [
        { subjectType: "member", subjectId: member.team!.memberId!, access: "edit" },
      ],
    },
    owner
  )
  const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 0))
  await nextTurn()
  expect(canAccessSpace("original", "edit", member)).toBe(true)
  // Another process (the CLI, a second server) writes without our hooks.
  const other = new Database(teamDatabasePath())
  try {
    other.exec("PRAGMA busy_timeout = 5000")
    other
      .query("DELETE FROM wt_space_grants WHERE subject_id = ?")
      .run(member.team!.memberId!)
    await nextTurn()
    expect(canAccessSpace("original", "read", member)).toBe(false)
    // A demotion that bypasses Better Auth's after-hook still applies.
    other
      .query("UPDATE member SET role = 'member' WHERE id = ?")
      .run(owner.team!.memberId!)
    await nextTurn()
    expect(() => requireTeamOwner(owner)).toThrow(TeamAccessError)
    expect(canAccessSpace("original", "read", owner)).toBe(false)
  } finally {
    other.close()
  }
  // A database replaced underneath the running server is never trusted.
  const { copyFileSync, renameSync } = await import("node:fs")
  copyFileSync(teamDatabasePath(), `${teamDatabasePath()}.copy`)
  renameSync(`${teamDatabasePath()}.copy`, teamDatabasePath())
  await nextTurn()
  expect(() => currentTeamWorktable()).toThrow("restart after recovery")
})

test("an owner who already has a password keeps it for their account", async () => {
  const { setOwnerPassword } = await import("./session-store.ts")
  await setOwnerPassword(password)
  const activated = await activateLocalTeams(
    origin,
    { name: "Alice", email: "alice@example.test" },
    {
      user: "owner",
      workspace: join(root, "workspace"),
      credentialClass: "local",
      scopes: ["*"],
      agent: null,
      principal: { id: "local:owner", type: "human", displayName: "Owner" },
    }
  )
  expect(activated.member.role).toBe("owner")
  const signedIn = await (await getTeamAuth(origin)).api.signInEmail({
    body: { email: "alice@example.test", password },
  })
  expect(signedIn.user.email).toBe("alice@example.test")
})

test("an interrupted activation can be retried with another email or password", async () => {
  const bootstrap: TokenIdentity = {
    user: "owner",
    workspace: join(root, "workspace"),
    credentialClass: "local",
    scopes: ["*"],
    agent: null,
    principal: { id: "local:owner", type: "human", displayName: "Owner" },
  }
  setLocalTeamInitializationHookForTests(() => {
    throw new Error("Interrupted local setup")
  })
  try {
    await expect(
      activateLocalTeams(
        origin,
        { name: "Alice", email: "alice@example.test", password },
        bootstrap
      )
    ).rejects.toThrow("Interrupted local setup")
  } finally {
    setLocalTeamInitializationHookForTests(null)
  }
  // The same email with a new password, after the first attempt was lost.
  setLocalTeamInitializationHookForTests(() => {
    throw new Error("Interrupted again")
  })
  try {
    await expect(
      activateLocalTeams(
        origin,
        { name: "Alice", email: "alice@example.test", password: "Another-password-1" },
        bootstrap
      )
    ).rejects.toThrow("Interrupted again")
  } finally {
    setLocalTeamInitializationHookForTests(null)
  }
  // A different email replaces the unfinished attempt entirely.
  const activated = await activateLocalTeams(
    origin,
    { name: "Carol", email: "carol@example.test", password },
    bootstrap
  )
  expect(activated.member.email).toBe("carol@example.test")
  expect(activated.member.role).toBe("owner")
  expect(
    requireTeamDatabase()
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM member")
      .get()!.count
  ).toBe(1)
})

test("self-hosted recovery issues single-use reset links and explicit operator grants", async () => {
  const { owner, member, auth, ownerHeaders, bobHeaders } = await setup()
  const { issueTeamPasswordReset, setTeamOperator } = await import(
    "./team-recovery.ts"
  )
  const { verifyTeamSession } = await import("./team-session.ts")
  const { hasTeamOperatorAuthority } = await import("./team-members.ts")
  const localAuth = new Hono().route("/auth/team", teamAuthRouter)
  const post = (path: string, body: unknown) =>
    localAuth.request(`${origin}/auth/team/${path}`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  // Members cannot reset anyone; owners cannot reset another owner.
  await expect(
    issueTeamPasswordReset(origin, { memberId: owner.team!.memberId! }, member)
  ).rejects.toThrow(TeamAccessError)
  const link = await issueTeamPasswordReset(
    origin,
    { memberId: member.team!.memberId! },
    owner
  )
  const token = new URL(link.url).searchParams.get("reset")!
  // Stored hashed: a copied database holds no usable link.
  expect(
    requireTeamDatabase()
      .query<{ identifier: string }, []>("SELECT identifier FROM verification")
      .all()
      .some((row) => row.identifier.includes(token))
  ).toBe(false)
  const newPassword = "Chosen-after-reset-456"
  expect((await post("reset-password", { token, newPassword })).status).toBe(200)
  expect((await post("reset-password", { token, newPassword })).status).toBe(400)
  expect(
    await verifyTeamSession(new Request(origin, { headers: bobHeaders }))
  ).toBeNull()
  expect(
    (await post("sign-in/email", { email: "bob@example.test", password: newPassword }))
      .status
  ).toBe(200)
  // The machine can recover an owner's account.
  const ownerLink = await issueTeamPasswordReset(
    origin,
    { email: "alice@example.test" },
    "machine"
  )
  expect(ownerLink.url).toContain("/login?reset=")

  // Operator authority is granted explicitly and ends with membership.
  expect(hasTeamOperatorAuthority(member.team!.userId!)).toBe(false)
  expect(() =>
    setTeamOperator({ memberId: member.team!.memberId! }, true, member)
  ).toThrow(TeamAccessError)
  setTeamOperator({ memberId: member.team!.memberId! }, true, owner)
  expect(hasTeamOperatorAuthority(member.team!.userId!)).toBe(true)
  // An operator can control the machine, so only the machine resets them.
  await expect(
    issueTeamPasswordReset(origin, { memberId: member.team!.memberId! }, owner)
  ).rejects.toThrow("from the Worktable's machine")
  setTeamOperator({ memberId: owner.team!.memberId! }, false, owner)
  expect(() =>
    setTeamOperator({ memberId: member.team!.memberId! }, false, member)
  ).toThrow("keep an operator")
  await auth.api.removeMember({
    headers: ownerHeaders,
    body: {
      organizationId: currentTeamWorktable()!.organizationId,
      memberIdOrEmail: member.team!.memberId!,
    },
  })
  const invitation = await auth.api.createInvitation({
    headers: ownerHeaders,
    body: {
      organizationId: currentTeamWorktable()!.organizationId,
      email: "bob@example.test",
      role: "member",
    },
  })
  // Invited back with a forgotten password: the invitation names the account.
  const rejoin = await issueTeamPasswordReset(
    origin,
    { invitationId: invitation.id },
    owner
  )
  const rejoinPassword = "Rejoined-with-reset-789"
  expect(
    (
      await post("reset-password", {
        token: new URL(rejoin.url).searchParams.get("reset"),
        newPassword: rejoinPassword,
      })
    ).status
  ).toBe(200)
  expect(
    (await post("enroll", { invitationId: invitation.id, name: "Bob", password: rejoinPassword }))
      .status
  ).toBe(200)
  expect(hasTeamOperatorAuthority(member.team!.userId!)).toBe(false)
  // The machine restores an operator when none is left.
  setTeamOperator({ email: "alice@example.test" }, true, "machine")
  expect(hasTeamOperatorAuthority(owner.team!.userId!)).toBe(true)
})

test("Cloud maps provider subjects to the same membership model and keeps browser authentication separate from local sessions", async () => {
  const previous = {
    hosted: process.env.WORKTABLE_HOSTED,
    issuer: process.env.WORKTABLE_AUTH_SERVER_URL,
    owner: process.env.WORKTABLE_OWNER_SUBJECT,
  }
  process.env.WORKTABLE_HOSTED = "1"
  process.env.WORKTABLE_AUTH_SERVER_URL = "https://identity.example.test"
  process.env.WORKTABLE_OWNER_SUBJECT = "user_alice"
  try {
    const {
      resolveVerifiedCloudMember,
      acceptCloudTeamInvitation,
      setCloudTeamInitializationHookForTests,
    } = await import("./team-cloud.ts")
    const { cloudTeamSessionHeaders } = await import("./team-auth.ts")
    const { verifyTeamSession } = await import("./team-session.ts")
    const alice = {
      issuer: process.env.WORKTABLE_AUTH_SERVER_URL,
      subject: "user_alice",
      email: "alice@example.test",
      name: "Alice",
      companyId: "org_company",
    }
    const bob = {
      ...alice,
      subject: "user_bob",
      email: "bob@gmail.test",
      name: "Bob",
      companyId: undefined,
    }
    const {
      stopWorkspaceRequestAdmissionAndDrain,
      resumeWorkspaceRequestAdmission,
    } = await import("./workspace-request-lifecycle.ts")
    await stopWorkspaceRequestAdmissionAndDrain()
    try {
      await expect(
        resolveVerifiedCloudMember(origin, alice, false, "First cloud team")
      ).rejects.toMatchObject({ status: "SERVICE_UNAVAILABLE" })
      expect(currentTeamWorktable()).toBeNull()
    } finally {
      resumeWorkspaceRequestAdmission()
    }
    setCloudTeamInitializationHookForTests(() => {
      throw new Error("Injected initialization interruption")
    })
    try {
      await expect(
        resolveVerifiedCloudMember(origin, alice, false, "First cloud team")
      ).rejects.toThrow("Injected initialization interruption")
    } finally {
      setCloudTeamInitializationHookForTests(null)
    }
    expect(currentTeamWorktable()).toBeNull()
    // Recreate the filesystem point left by a crash before SQLite commit.
    const { writeTeamMarker, currentWorktableId } =
      await import("./team-database.ts")
    writeTeamMarker(currentWorktableId())
    clearTeamAuthInstances()
    closeTeamDatabases()
    expect(() => currentTeamWorktable()).toThrow()
    const { recoverTeamInitialization } =
      await import("./team-initialization.ts")
    const db = requireTeamDatabase()
    const secret = db
      .query<
        { value: string },
        []
      >("SELECT value FROM wt_config WHERE key = 'auth-secret'")
      .get()!.value
    db.query("UPDATE wt_config SET value = ? WHERE key = 'auth-secret'").run(
      "synthetic-replacement-authentication-state"
    )
    expect(recoverTeamInitialization).toThrow("authentication state changed")
    expect(() => currentTeamWorktable()).toThrow()
    db.query("UPDATE wt_config SET value = ? WHERE key = 'auth-secret'").run(
      secret
    )
    recoverTeamInitialization()
    expect(currentTeamWorktable()).toBeNull()
    const owner = await resolveVerifiedCloudMember(
      origin,
      alice,
      false,
      "First cloud team"
    )
    expect(
      requireTeamDatabase()
        .query<
          { count: number },
          []
        >("SELECT COUNT(*) AS count FROM organization")
        .get()!.count
    ).toBe(1)
    expect(ensureWorkspaceManifest().name).toBe("First cloud team")
    expect(owner?.principal.type).toBe("human")
    expect(owner?.principal.id).not.toBe("workos:user_alice")
    const { serveTeamDirectory } = await import("./team-directory.ts")
    const scopedVariables = [
      "WORKTABLE_CLOUD_WORKSPACE_ID",
      "WORKTABLE_RESOURCE_URL",
      "WORKTABLE_GATEWAY_SECRET",
      "WORKTABLE_BROWSER_ASSERTION_KEYRING",
    ] as const
    const saved = scopedVariables.map((key) => process.env[key])
    try {
      process.env.WORKTABLE_CLOUD_WORKSPACE_ID = "cloud_test_worktable"
      process.env.WORKTABLE_RESOURCE_URL =
        "https://cloud.example.test/api/mcp/w/cloud_test_worktable"
      process.env.WORKTABLE_GATEWAY_SECRET =
        "synthetic-gateway-secret-for-directory-check"
      const secret = new Uint8Array(32).fill(17)
      process.env.WORKTABLE_BROWSER_ASSERTION_KEYRING = JSON.stringify([
        { kid: "test", secret: base64url.encode(secret), state: "signing" },
      ])
      const proof = (typ: string) =>
        new SignJWT({})
          .setProtectedHeader({ alg: "HS256", kid: "test", typ })
          .setIssuer("https://cloud.example.test/_worktable/control")
          .setAudience("urn:worktable:team-directory:cloud_test_worktable")
          .setIssuedAt()
          .setExpirationTime("60s")
          .sign(secret)
      const request = async (typ: string) =>
        new Request("https://cloud.example.test/_worktable/team-directory", {
          headers: {
            [GATEWAY_HEADER]: process.env.WORKTABLE_GATEWAY_SECRET!,
            Authorization: `Bearer ${await proof(typ)}`,
          },
        })
      expect(
        (await serveTeamDirectory(await request("worktable-browser+jwt")))
          .status
      ).toBe(404)
      const directory = await serveTeamDirectory(
        await request("worktable-directory+jwt")
      )
      expect(directory.status).toBe(200)
      const snapshot = await directory.json()
      expect(snapshot.name).toBe("First cloud team")
      expect(
        snapshot.members.map((entry: { subject: string }) => entry.subject)
      ).toEqual(["user_alice"])
      writeWorkspaceManifest({
        ...ensureWorkspaceManifest(),
        name: "Renamed cloud team",
      })
      const renamed = await (
        await serveTeamDirectory(await request("worktable-directory+jwt"))
      ).json()
      expect(renamed.name).toBe("Renamed cloud team")
      expect(renamed.revision).toBeGreaterThan(snapshot.revision)
      const repeated = await (
        await serveTeamDirectory(await request("worktable-directory+jwt"))
      ).json()
      expect(repeated.revision).toBe(renamed.revision)
    } finally {
      for (const [index, key] of scopedVariables.entries()) {
        const value = saved[index]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    await expect(resolveVerifiedCloudMember(origin, bob)).rejects.toThrow(
      "not a member"
    )
    const auth = await getTeamAuth(origin)
    const headers = await cloudTeamSessionHeaders(auth, owner!.team!.userId!)
    const invitation = await auth.api.createInvitation({
      headers,
      body: {
        organizationId: currentTeamWorktable()!.organizationId,
        email: "bob@company.test",
        role: "member",
      },
    })
    // The invitation was emailed to one address; a forwarded link does not
    // admit a different account.
    await expect(
      acceptCloudTeamInvitation(origin, bob, invitation.id)
    ).rejects.toMatchObject({
      code: "INVITATION_EMAIL_MISMATCH",
      message:
        "This invitation is for b•••@company.test. Sign in with that address to join.",
    })
    // A refused attempt leaves no account behind, and the hosted request
    // path admits Bob to the acceptance route without binding him first.
    const bindings = () =>
      requireTeamDatabase()
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) AS count FROM wt_identity_bindings WHERE subject = ?"
        )
        .get(bob.subject)!.count
    expect(bindings()).toBe(0)
    expect(
      (await resolveVerifiedCloudMember(origin, bob, "deferred"))?.cloudIdentity
        ?.subject
    ).toBe(bob.subject)
    expect(bindings()).toBe(0)
    const invitedBob = { ...bob, email: "Bob@Company.test" }
    await acceptCloudTeamInvitation(origin, invitedBob, invitation.id)
    await expect(
      acceptCloudTeamInvitation(origin, invitedBob, invitation.id)
    ).rejects.toMatchObject({ code: "INVITATION_USED" })
    const member = await resolveVerifiedCloudMember(origin, bob)
    expect(member?.team?.memberId).toBeDefined()
    expect(findTeamMember(member!.team!.userId!)?.role).toBe("member")
    // An unchanged identity is a read: it keeps working while a backup holds writes.
    const { stopWorkspaceMutationsAndDrain } = await import(
      "./workspace-request-lifecycle.ts"
    )
    await stopWorkspaceMutationsAndDrain()
    try {
      expect(
        (await resolveVerifiedCloudMember(origin, bob))?.principal.id
      ).toBe(member?.principal.id)
    } finally {
      resumeWorkspaceRequestAdmission()
    }
    const updated = await resolveVerifiedCloudMember(origin, {
      ...bob,
      email: "bob.updated@example.test",
    })
    expect(updated?.principal.id).toBe(member?.principal.id)
    expect(findTeamMember(member!.team!.userId!)?.email).toBe(
      "bob.updated@example.test"
    )
    expect(await verifyTeamSession(new Request(origin, { headers }))).toBeNull()
    await auth.api.removeMember({
      headers,
      body: {
        organizationId: currentTeamWorktable()!.organizationId,
        memberIdOrEmail: member!.team!.memberId!,
      },
    })
    await expect(resolveVerifiedCloudMember(origin, bob)).rejects.toThrow(
      "no longer a member"
    )
  } finally {
    for (const [key, value] of [
      ["WORKTABLE_HOSTED", previous.hosted],
      ["WORKTABLE_AUTH_SERVER_URL", previous.issuer],
      ["WORKTABLE_OWNER_SUBJECT", previous.owner],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("linked Cloud agents require an explicit local member binding and follow live Space permissions", async () => {
  const { auth, owner, member, ownerHeaders } = await setup()
  const key = new Uint8Array(32).fill(4)
  const ingress = await createLinkedIngress({
    key,
    binding: {
      installationId: "installation",
      destinationId: "a".repeat(32),
      ownerSubject: "workos_bob",
      generation: 1,
    },
    scopes: ["docs:read", "docs:write", "spaces:read"],
    publicOrigin: "https://cloud.example.test",
  })
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "worktable_docs_write",
      arguments: {
        request: {
          action: "write",
          lifetime: "durable",
          spaceId: "original",
          docPath: "linked-proof",
          content: "# Linked proof",
        },
      },
    },
  })
  const request = async () => {
    const assertion = await new SignJWT({
      request: {
        binding: ingress.binding,
        grant: {
          kind: "mcp",
          principalId: "oauth:linked:workos_bob",
          displayName: "Linked app",
          scopes: ["docs:read", "docs:write", "spaces:read"],
          credentialIssuedAt: Date.now() - 60_000,
        },
        method: "POST",
        path: "/api/mcp",
        bodyDigest: createHash("sha256").update(body).digest("hex"),
      },
    })
      .setProtectedHeader({ alg: "HS256", typ: LINKED_ASSERTION_TYPE })
      .setIssuer(LINKED_ASSERTION_ISSUER)
      .setAudience(ingress.binding.destinationId)
      .setIssuedAt()
      .setExpirationTime("60s")
      .setJti(crypto.randomUUID())
      .sign(key)
    return ingress.fetch(
      new Request("http://127.0.0.1/api/mcp", {
        method: "POST",
        headers: {
          [LINKED_ASSERTION_HEADER]: assertion,
          "Content-Type": "application/json",
        },
        body,
      })
    )
  }
  expect((await request()).status).toBe(403)
  requireTeamDatabase()
    .query(
      "INSERT INTO wt_identity_bindings(worktable_id, issuer, subject, user_id) VALUES (?, ?, ?, ?)"
    )
    .run(
      currentTeamWorktable()!.id,
      "https://cloud.example.test",
      "workos_bob",
      member.team!.userId!
    )
  expect((await (await request()).json()).result.isError).toBe(true)
  expect((await readDoc("original", "linked-proof")).data).toBeNull()
  // Signing in is connecting: the member's setup shows it before the agent
  // has done anything.
  expect(
    readPersonSetup(participantKey(member))?.items["connect-agent"]
  ).toBeDefined()
  setSpaceAccessPolicy(
    {
      spaceId: "original",
      visibility: "restricted",
      grants: [
        {
          subjectType: "member",
          subjectId: member.team!.memberId!,
          access: "edit",
        },
      ],
    },
    owner
  )
  expect((await (await request()).json()).result.isError).not.toBe(true)
  expect((await readDoc("original", "linked-proof")).data).toContain(
    "Linked proof"
  )
  await auth.api.removeMember({
    headers: ownerHeaders,
    body: {
      organizationId: currentTeamWorktable()!.organizationId,
      memberIdOrEmail: member.team!.memberId!,
    },
  })
  expect((await request()).status).toBe(403)
  ingress.revoke()
})

test("operator snapshots drain admitted membership changes before capturing Team state", async () => {
  const { owner, member, ownerHeaders } = await setup()
  const { startServer, stopActiveServer } = await import("./index.ts")
  const { admitWorkspaceRequest, isWorkspaceRequestAdmissionOpen } = await import("./workspace-request-lifecycle.ts")
  const { changeTeamMembership } = await import("./team-administration.ts")
  const { writeLiveOperatorWorkspaceSnapshot } = await import("./operator-snapshot.ts")
  const { Database } = await import("bun:sqlite")
  startServer(0, "127.0.0.1")
  const releaseAdmission = admitWorkspaceRequest()!
  expect(releaseAdmission).not.toBeNull()
  let releaseMember!: () => void
  const held = new Promise<void>(resolve => { releaseMember = resolve })
  const change = held.then(() => changeTeamMembership(
    origin, new Request(origin, { headers: ownerHeaders }), owner, member.team!.memberId!, "owner"
  )).finally(releaseAdmission)
  const capture = writeLiveOperatorWorkspaceSnapshot("admitted-membership-test")
  try {
    const deadline = Date.now() + 2000
    while (isWorkspaceRequestAdmissionOpen() && Date.now() < deadline) {
      // test-policy: external-readiness-backoff (live snapshot admission barrier)
      await Bun.sleep(5)
    }
    expect(isWorkspaceRequestAdmissionOpen()).toBe(false)
    releaseMember()
    const [, snapshot] = await Promise.all([change, capture])
    const db = new Database(join(snapshot.destination, "team", "auth.sqlite"), { readonly: true })
    try {
      expect(db.query<{ role: string }, [string]>("SELECT role FROM member WHERE id = ?").get(member.team!.memberId!)?.role).toBe("owner")
    } finally { db.close() }
    expect(isWorkspaceRequestAdmissionOpen()).toBe(true)
  } finally {
    releaseMember()
    await Promise.allSettled([change, capture])
    await stopActiveServer()
  }
})

test("operator recovery preserves members and grants while requiring fresh sessions and agent connections", async () => {
  const { owner, member, bobHeaders, auth: ownerAuth, ownerHeaders } =
    await setup()
  const pending = await ownerAuth.api.createInvitation({
    headers: ownerHeaders,
    body: {
      organizationId: currentTeamWorktable()!.organizationId,
      email: "carol@example.test",
      role: "member",
    },
  })
  const { restoreTeamBackupState, withTeamBackupBarrier } =
    await import("./team-backup.ts")
  const { verifyTeamSession } = await import("./team-session.ts")
  const { writeWorkspaceSnapshot } = await import("./workspace-snapshot.ts")
  const agent = createTeamAgent(
    { name: "Bob Codex", platform: "codex", ownership: "personal" },
    member
  )
  bindTeamAgentCredential(agent.id, "local-token:backup-bob", member)
  bindTeamAgentCredential(agent.id, "oauth:backup-bob", member)
  const cloudCredential: TokenIdentity = {
    ...owner,
    team: undefined,
    agent: "codex",
    credentialIssuedAt: Date.now() - 60_000,
    principal: { id: "oauth:backup-bob", type: "agent", displayName: "Codex" },
  }
  const beforeRestore = resolveTeamAgentCredential(cloudCredential)!
  setSpaceAccessPolicy(
    {
      spaceId: "original",
      visibility: "restricted",
      grants: [
        {
          subjectType: "member",
          subjectId: member.team!.memberId!,
          access: "read",
        },
      ],
    },
    owner
  )
  await rm(join(root, "app", "participants", `${workspaceCacheKey()}.json`), {
    force: true,
  })
  const directory = join(root, "snapshot")
  const snapshot = await writeWorkspaceSnapshot(directory, {
    captureTeamState: true,
    withCaptureBarrier: async (work) =>
      withTeamBackupBarrier(async () => {
        const result = await work()
        // A permission change after capture must not alter the captured content's authorization.
        setSpaceAccessPolicy(
          { spaceId: "original", visibility: "restricted", grants: [] },
          owner
        )
        return result
      }),
  })
  const state = snapshot.teamState
  expect(canAccessSpace("original", "read", member)).toBe(false)
  expect(state).toBeDefined()
  const staleParticipant = (
    await resolveParticipant(owner, { name: "Post-snapshot name" })
  ).participant
  const staleParticipantBytes = await (
    await import("node:fs/promises")
  ).readFile(join(root, "app", "participants", `${workspaceCacheKey()}.json`))
  clearTeamAuthInstances()
  closeTeamDatabases()
  await rm(join(root, "app"), { recursive: true })
  expect(() => teamsEnabled()).toThrow(
    "Team authorization state is unavailable"
  )
  expect(() => currentTeamWorktable()).toThrow()
  expect(state!.participants).toBeUndefined()
  const participantPath = join(
    root,
    "app",
    "participants",
    `${workspaceCacheKey()}.json`
  )
  await (
    await import("node:fs/promises")
  ).mkdir(join(root, "app", "participants"), { recursive: true })
  await (
    await import("node:fs/promises")
  ).writeFile(participantPath, staleParticipantBytes)
  await restoreTeamBackupState(directory, state!)
  // Invitation links are joining capabilities; restore never revives one.
  expect(
    requireTeamDatabase()
      .query<{ status: string }, [string]>(
        "SELECT status FROM invitation WHERE id = ?"
      )
      .get(pending.id)?.status
  ).toBe("canceled")
  const restoredParticipant = (
    await resolveParticipant(owner, { initialName: "Alice" })
  ).participant
  expect(restoredParticipant.name).toBe("Alice")
  expect(restoredParticipant.id).not.toBe(staleParticipant.id)
  expect(teamsEnabled()).toBe(true)
  expect(findTeamMemberById(member.team!.memberId!)?.actorId).toBe(
    member.principal.id
  )
  expect(canAccessSpace("original", "read", member)).toBe(true)
  expect(canAccessSpace("original", "edit", member)).toBe(false)
  expect(
    await verifyTeamSession(new Request(origin, { headers: bobHeaders }))
  ).toBeNull()
  const raw: TokenIdentity = {
    ...owner,
    team: undefined,
    agent: "codex",
    principal: {
      id: "local-token:backup-bob",
      type: "agent",
      displayName: "Codex",
    },
  }
  expect(resolveTeamAgentCredential(raw)).toBeNull()
  expect(resolveTeamAgentCredential(cloudCredential)).toBeNull()
  expect(canAccessSpace("original", "read", beforeRestore)).toBe(false)
  reconnectCloudPersonalAgent(agent.id, member)
  expect(resolveTeamAgentCredential(cloudCredential)).toBeNull()
  expect(canAccessSpace("original", "read", beforeRestore)).toBe(false)
  const fresh = resolveTeamAgentCredential({
    ...cloudCredential,
    credentialIssuedAt: Math.ceil(Date.now() / 1000) * 1000,
  })!
  expect(fresh.principal.id).toBe(beforeRestore.principal.id)
  expect(canAccessSpace("original", "read", fresh)).toBe(true)
  const auth = await getTeamAuth(origin)
  const signedIn = await auth.api.signInEmail({
    body: { email: "bob@example.test", password },
    returnHeaders: true,
  })
  expect(
    (
      await verifyTeamSession(
        new Request(origin, { headers: sessionHeaders(signedIn.headers) })
      )
    )?.principal.id
  ).toBe(member.principal.id)
})
