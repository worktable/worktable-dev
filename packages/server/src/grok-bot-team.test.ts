import { afterEach, beforeEach, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { setAppDirOverride } from "./app-storage.ts"
import {
  prepareWorkspaceTarget,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { activateLocalTeams } from "./team-activation.ts"
import { clearTeamAuthInstances } from "./team-auth.ts"
import { closeTeamDatabases } from "./team-database.ts"
import {
  bindTeamAgentCredential,
  createTeamAgent,
  resolveTeamAgentCredential,
  runWithTeamIdentity,
  updateTeamAgent,
} from "./team-policy.ts"
import {
  createAgentCredential,
  updateAgentConnection,
} from "./agent-connection-store.ts"
import { createToken, verifyToken, type TokenIdentity } from "./token-store.ts"
import { writeSpace } from "./store.ts"
import { claimNextThreadDelivery, postThreadMessage } from "./thread-service.ts"
import { readGrokBots, updateGrokBot } from "./grok-bot-store.ts"
import { grokBotRouter } from "./routes/grok-bot.ts"
import { startGrokBotRuntime } from "./grok-bot-runtime.ts"
import { drainWorkspaceChanges } from "./workspace-events.ts"

let root: string
let owner: TokenIdentity
let stop: (() => Promise<void>) | undefined

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-grok-team-"))
  setAppDirOverride(join(root, "app"))
  const workspace = join(root, "workspace")
  setWorkspaceRootOverride(workspace)
  prepareWorkspaceTarget(workspace, "create")
  for (const id of ["restricted", "available"]) {
    const now = new Date().toISOString()
    await writeSpace({
      type: "worktable.space",
      version: 1,
      id,
      name: id,
      createdAt: now,
      updatedAt: now,
      createdBy: "owner",
      settings: {},
    })
  }
  const activated = await activateLocalTeams(
    "http://grok-team.test",
    {
      name: "Owner",
      email: "owner@example.test",
      password: "grok-test-password-123",
    },
    {
      user: "owner",
      workspace,
      agent: null,
      credentialClass: "local",
      scopes: ["*"],
      principal: { id: "local:owner", type: "human", displayName: "Owner" },
    }
  )
  owner = activated.identity
})

afterEach(async () => {
  await stop?.()
  stop = undefined
  await drainWorkspaceChanges()
  clearTeamAuthInstances()
  closeTeamDatabases()
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
})

it("keeps separate manual Team agents independent when access changes", async () => {
  const first = await runWithTeamIdentity(owner, () =>
    createAgentCredential({
      label: null,
      access: { threads: true, read: false, edit: false },
    })
  )
  const second = await runWithTeamIdentity(owner, () =>
    createAgentCredential({
      label: null,
      access: { threads: true, read: true, edit: true },
    })
  )
  expect(first.connection.id).not.toBe(second.connection.id)
  expect(first.connection.participant?.id).not.toBe(
    second.connection.participant?.id
  )
  await runWithTeamIdentity(owner, () =>
    updateAgentConnection(second.connection.id, {
      access: { threads: true, read: true, edit: false },
    })
  )
  expect((await verifyToken(first.token))?.scopes).not.toContain("docs:read")
})

it("requires current Threads access and skips inaccessible work without exhausting wake retries", async () => {
  const agent = createTeamAgent(
    { name: "Orbit", platform: "grok-bot", ownership: "personal" },
    owner
  )
  const credential = await createToken({
    agent: "grok-bot",
    scopes: ["threads:*"],
  })
  bindTeamAgentCredential(agent.id, credential.metadata.principal.id, owner)
  const bot = {
    ...resolveTeamAgentCredential(credential.metadata)!,
    credentialClass: "resource" as const,
  }
  await runWithTeamIdentity(bot, () => claimNextThreadDelivery(bot, 0, 2))
  const app = new Hono()
  app.use("*", async (c, next) =>
    runWithTeamIdentity(owner, async () => {
      c.set("identity", owner)
      await next()
    })
  )
  app.route("/grok", grokBotRouter)
  const configure = () =>
    app.request(`/grok/${encodeURIComponent(bot.principal.id)}/configuration`, {
      method: "PUT",
      body: JSON.stringify({
        webhookUrl: "https://api2.cursor.sh/automations/webhook/team-test",
        webhookKey: "test-only",
      }),
    })
  updateTeamAgent(agent.id, { scopeCeiling: ["docs:read"] }, owner)
  expect((await configure()).status).toBe(400)
  expect(await readGrokBots()).toHaveLength(0)
  updateTeamAgent(
    agent.id,
    { scopeCeiling: ["threads:*"], spaceIds: ["restricted", "available"] },
    owner
  )
  expect((await configure()).status).toBe(200)
  const connection = (await readGrokBots())[0]!
  await updateGrokBot(connection, { verifiedAt: new Date().toISOString() })
  const assign = (spaceId: string) =>
    runWithTeamIdentity(owner, () =>
      postThreadMessage(owner, {
        location: { kind: "space", spaceId },
        to: connection.participantId,
        body: spaceId,
        expectsReply: true,
        idempotencyKey: spaceId,
      })
    )
  const queued = await assign("restricted")
  updateTeamAgent(agent.id, { spaceIds: ["available"] }, owner)
  await drainWorkspaceChanges()
  await updateGrokBot(connection, {
    wake: { id: "wake_before_access_change", attempts: 1, nextAt: 0 },
  })
  let wakes = 0
  const woken = Promise.withResolvers<void>()
  stop = startGrokBotRuntime({
    fetch: (async () => {
      wakes++
      woken.resolve()
      return new Response(null, { status: 200 })
    }) as unknown as typeof fetch,
  })
  for (
    let attempt = 0;
    attempt < 100 && (await readGrokBots())[0]?.wake;
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect((await readGrokBots())[0]?.wake).toBeUndefined()
  expect(wakes).toBe(0)
  expect((await readGrokBots())[0]?.error).toBeUndefined()
  updateTeamAgent(agent.id, { spaceIds: ["restricted", "available"] }, owner)
  await woken.promise
  const delivery = await runWithTeamIdentity(bot, () =>
    claimNextThreadDelivery(bot, 0, 2)
  )
  expect(delivery?.messageId).toBe(queued.messageId)
})
