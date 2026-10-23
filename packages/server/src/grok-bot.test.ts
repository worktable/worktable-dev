import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { setAppDirOverride } from "./app-storage.ts"
import { setWorkspaceRootOverride, workspaceCacheKey } from "./workspace.ts"
import { participantsByKey, resolveParticipant } from "./participant-store.ts"
import type { TokenIdentity } from "./token-store.ts"
import {
  acceptDelivery,
  claimNextThreadDelivery,
  listThreadParticipants,
  listThreadParticipantsForDisplay,
  postThreadMessage,
} from "./thread-service.ts"
import { grokBotRouter } from "./routes/grok-bot.ts"
import { grokBotInventory } from "./grok-bot-connections.ts"
import {
  applyGrokBotIdentityDefaults,
  readGrokBotCandidates,
  readGrokBots,
  removeGrokBot,
  updateGrokBot,
  validateGrokWebhook,
} from "./grok-bot-store.ts"
import {
  expireGrokBotDeliveries,
  failThreadDelivery,
  nextThreadDeliveryEligibleAt,
  commitThreadDeliveryReply,
  retryGrokBotDelivery,
  getThreadActivity,
  grokBotDeliveries,
} from "./thread-delivery-store.ts"
import { startGrokBotRuntime } from "./grok-bot-runtime.ts"
import { appendThreadMessage } from "./thread-store.ts"
import {
  drainWorkspaceChanges,
  notifyWorkspaceChangeAndWaitOrThrow,
  onWorkspaceChange,
} from "./workspace-events.ts"

const grok: TokenIdentity = {
  user: "owner",
  workspace: "test",
  credentialClass: "resource",
  agent: null,
  scopes: ["threads:*"],
  principal: {
    id: "oauth:grok:owner",
    type: "agent",
    displayName: "Grok Bot",
    authorizedBy: "workos:owner",
  },
}
const owner: TokenIdentity = {
  user: "owner",
  workspace: "test",
  agent: null,
  scopes: ["*"],
  principal: { id: "local:owner", type: "human", displayName: "Owner" },
}
let appDir: string
let workspaceDir: string
let participantId: string
let stop: (() => Promise<void>) | undefined
let app: Hono
const url = "https://api2.cursor.sh/automations/webhook/test_routine"
const secret = "test-routine-secret-never-return"
const base = `/grok/${encodeURIComponent(grok.principal.id)}`

beforeEach(async () => {
  appDir = await mkdtemp(join(tmpdir(), "worktable-grok-app-"))
  workspaceDir = await mkdtemp(join(tmpdir(), "worktable-grok-workspace-"))
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(workspaceDir)
  participantId = (await resolveParticipant(grok)).participant.id
  await claimNextThreadDelivery(grok, 0, 2)
  app = new Hono()
  app.use("*", async (c, next) => {
    c.set("identity", owner)
    await next()
  })
  app.route("/grok", grokBotRouter)
})
afterEach(async () => {
  await stop?.()
  stop = undefined
  await drainWorkspaceChanges()
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  await Promise.all([
    rm(appDir, { recursive: true, force: true }),
    rm(workspaceDir, { recursive: true, force: true }),
  ])
})
async function configure() {
  const response = await app.request(`${base}/configuration`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ webhookUrl: url, webhookKey: secret }),
  })
  expect(response.status).toBe(200)
  return (await readGrokBots())[0]!
}
async function verified() {
  const connection = await configure()
  await updateGrokBot(connection, { verifiedAt: new Date().toISOString() })
  return connection
}
async function assign(body: string) {
  return postThreadMessage(owner, {
    location: { kind: "worktable" },
    to: participantId,
    body,
    idempotencyKey: body,
    expectsReply: true,
  })
}
async function expire(messageId: string) {
  const path = join(appDir, "thread-deliveries", `${workspaceCacheKey()}.json`)
  const file = JSON.parse(await readFile(path, "utf8"))
  file.deliveries.find(
    (d: { messageId: string }) => d.messageId === messageId
  ).leaseExpiresAt = new Date(0).toISOString()
  await writeFile(path, JSON.stringify(file))
  await expireGrokBotDeliveries(participantId)
}
function fakeFetch(
  onRequest: (input: string, init: RequestInit) => void,
  status = 200
): typeof fetch {
  return (async (input: string, init: RequestInit) => {
    onRequest(input, init)
    return new Response(null, { status })
  }) as unknown as typeof fetch
}

describe("Grok Bot", () => {
  it.each(["runtime", "claim"])(
    "fences pre-configuration work after its lease expires (%s)",
    async (path) => {
      const assigned = await assign("Work claimed before routine setup")
      const claim = (await claimNextThreadDelivery(grok, 0, 2))!
      expect(claim.messageId).toBe(assigned.messageId)
      await configure()
      expect(
        (await app.request(`${base}/check`, { method: "POST" })).status
      ).toBe(200)
      const now = Date.parse(claim.leaseExpiresAt) + 1
      const clock = jest.spyOn(Date, "now").mockReturnValue(now)
      try {
        if (path === "runtime") await expireGrokBotDeliveries(participantId)
        else expect(await claimNextThreadDelivery(grok, 0, 2)).toBeNull()
        expect(
          (await grokBotDeliveries(participantId)).find(
            (d) => d.messageId === assigned.messageId
          )
        ).toMatchObject({
          state: "failed",
          error: { code: "REMOTE_EXECUTION_UNCONFIRMED" },
        })
        expect(
          await nextThreadDeliveryEligibleAt(participantId)
        ).toBeUndefined()
        expect(
          (await grokBotInventory([])).grokBots[0]?.uncertain?.messageId
        ).toBe(assigned.messageId)
      } finally {
        clock.mockRestore()
      }
    }
  )

  it.each([false, true])(
    "recovers when a claimed assignment disappears (connection check: %s)",
    async (probe) => {
      if (probe) {
        await configure()
        expect(
          (await app.request(`${base}/check`, { method: "POST" })).status
        ).toBe(200)
      } else {
        await verified()
        await assign("Assignment removed before reading")
      }
      const claim = (await claimNextThreadDelivery(grok, 0, 2))!
      await rm(join(workspaceDir, "threads", `${claim.threadId}.json`))
      await failThreadDelivery({
        participantId,
        messageId: claim.messageId,
        leaseId: claim.leaseId,
        retryable: false,
        code: "THREAD_NOT_FOUND",
        message: "The portable thread no longer exists.",
      })
      expect((await grokBotInventory([])).grokBots[0]?.status).toBe(
        probe ? "needs-attention" : "ready"
      )
      expect(
        (await app.request(`${base}/retry`, { method: "POST" })).status
      ).toBe(200)
      if (probe) {
        expect((await readGrokBots())[0]?.probe).toBeUndefined()
        expect(
          (await app.request(`${base}/check`, { method: "POST" })).status
        ).toBe(200)
        expect((await claimNextThreadDelivery(grok, 0, 2))?.messageId).toBe(
          (await readGrokBots())[0]?.probe?.messageId
        )
        return
      }
      const next = await assign("A later assignment")
      expect((await claimNextThreadDelivery(grok, 0, 2))?.messageId).toBe(
        next.messageId
      )
    }
  )

  it.each(["Cursor", "Orbit"])(
    "classifies the selected Bot while preserving custom names (%s)",
    async (name) => {
      const identity: TokenIdentity = {
        ...grok,
        agent: "Cursor",
        principal: {
          ...grok.principal,
          id: "oauth:native-bot:owner",
          displayName: name,
        },
      }
      const selected = (
        await resolveParticipant(identity, name === "Cursor" ? {} : { name })
      ).participant
      const cursor = (
        await resolveParticipant({
          agent: "cursor",
          principal: {
            id: "local-token:cursor",
            type: "agent",
            displayName: "Cursor",
          },
        })
      ).participant
      await claimNextThreadDelivery(identity, 0, 2)
      const path = `/grok/${encodeURIComponent(identity.principal.id)}/configuration`
      const save = (name?: string) =>
        app.request(path, {
          method: "PUT",
          body: JSON.stringify({
            webhookUrl: url,
            webhookKey: secret,
            ...(name ? { name } : {}),
          }),
        })
      expect((await save()).status).toBe(200)
      const expected = name === "Cursor" ? "Grok Bot" : name
      const display = await listThreadParticipantsForDisplay(owner)
      expect(
        display.participants.find((p) => p.id === selected.id)
      ).toMatchObject({ name: expected, platform: "grok-bot" })
      expect(display.presentations[identity.principal.id]).toMatchObject({
        name: expected,
        platform: "grok-bot",
      })
      expect(
        (await readGrokBotCandidates()).find(
          (c) => c.id === identity.principal.id
        )?.displayName
      ).toBe(expected)
      expect((await participantsByKey()).get("agent:cursor")).toMatchObject({
        id: cursor.id,
        name: "Cursor",
      })
      const connection = (await readGrokBots()).find(
        (c) => c.connectionId === identity.principal.id
      )!
      const verifiedAt = new Date().toISOString()
      await updateGrokBot(connection, { verifiedAt })
      expect((await save(" Comet ")).status).toBe(200)
      expect(
        (await readGrokBots()).find(
          (c) => c.connectionId === identity.principal.id
        )?.generation
      ).toBe(connection.generation)
      expect((await save()).status).toBe(200)
      expect((await participantsByKey()).get("agent:Cursor")).toMatchObject({
        id: selected.id,
        name: "Comet",
      })
      expect(
        (await readGrokBots()).find(
          (c) => c.connectionId === identity.principal.id
        )
      ).toMatchObject({ participantId: selected.id, verifiedAt })
      expect(
        (await readGrokBotCandidates()).find(
          (c) => c.id === identity.principal.id
        )?.displayName
      ).toBe("Comet")
      for (const name of [" ", "x".repeat(101)]) {
        expect(
          (
            await app.request(path, {
              method: "PUT",
              body: JSON.stringify({ name }),
            })
          ).status
        ).toBe(400)
      }
      expect((await participantsByKey()).get("agent:Cursor")?.name).toBe(
        "Comet"
      )
    }
  )

  it("repairs an existing Cursor-named Bot once without changing its identity or verification", async () => {
    const connection = await verified()
    const verifiedAt = (await readGrokBots())[0]!.verifiedAt
    await resolveParticipant(grok, { name: "Cursor" })
    const path = join(appDir, "grok-bots", `${workspaceCacheKey()}.json`)
    const saved = JSON.parse(await readFile(path, "utf8"))
    delete saved.connections[0].identityDefaultsApplied
    await writeFile(path, JSON.stringify(saved))
    const legacy = (await readGrokBots())[0]!
    await applyGrokBotIdentityDefaults(legacy)
    const current = (await readGrokBots())[0]!
    expect(current).toMatchObject({
      connectionId: connection.connectionId,
      participantId,
      principalId: connection.principalId,
      generation: connection.generation,
      verifiedAt,
      identityDefaultsApplied: true,
    })
    expect(
      (await listThreadParticipantsForDisplay(owner)).presentations[
        participantId
      ]
    ).toMatchObject({ name: "Grok Bot", platform: "grok-bot" })
    await resolveParticipant(grok, { name: "Cursor" })
    await applyGrokBotIdentityDefaults(current)
    expect(
      (await listThreadParticipants(owner)).find((p) => p.id === participantId)
        ?.name
    ).toBe("Cursor")
  })

  it("switches between webhook and email without retaining the previous wake or verification", async () => {
    const previous = await verified()
    for (const emailAddress of [
      "owner@example.test",
      "bot@mail.grokbot.com.evil.test",
      "a\r\nBcc:x@mail.grokbot.com",
    ]) {
      expect(
        (
          await app.request(`${base}/configuration`, {
            method: "PUT",
            body: JSON.stringify({ wakeMethod: "email", emailAddress }),
          })
        ).status
      ).toBe(400)
    }
    expect((await readGrokBots())[0]?.generation).toBe(previous.generation)
    expect(
      (
        await app.request(`${base}/configuration`, {
          method: "PUT",
          body: JSON.stringify({
            wakeMethod: "email",
            emailAddress: "My.Bot@mail.grokbot.com",
          }),
        })
      ).status
    ).toBe(200)
    expect((await readGrokBots())[0]).toMatchObject({
      wakeMethod: "email",
      emailAddress: "my.bot@mail.grokbot.com",
      webhookUrl: "",
      webhookKey: "",
    })
    expect((await readGrokBots())[0]?.verifiedAt).toBeUndefined()
    const check = await app.request(`${base}/check`, { method: "POST" })
    expect(check.status).toBe(200)
    const woken = Promise.withResolvers<void>()
    const env = {
      WORKTABLE_HOSTED: "1",
      WORKTABLE_INVITATION_MAIL_URL:
        "https://cloud.example.test/runtime/invitation-email",
      WORKTABLE_INVITATION_MAIL_RUNTIME_ID: "fixture-runtime",
      WORKTABLE_GATEWAY_SECRET: "fixture-runtime-secret",
    }
    const before = Object.fromEntries(
      Object.keys(env).map((key) => [key, process.env[key]])
    )
    try {
      Object.assign(process.env, env)
      stop = startGrokBotRuntime({
        fetch: fakeFetch((input, init) => {
          expect(input).toBe(
            "https://cloud.example.test/runtime/grok-email-wake"
          )
          expect(new Headers(init.headers).get("authorization")).toBe(
            "Bearer fixture-runtime-secret"
          )
          expect(JSON.parse(String(init.body))).toMatchObject({
            emailAddress: "my.bot@mail.grokbot.com",
            attempt: 1,
          })
          expect(Object.keys(JSON.parse(String(init.body))).sort()).toEqual([
            "attempt",
            "connectionKey",
            "emailAddress",
            "wakeId",
          ])
          woken.resolve()
        }, 202),
      })
      await woken.promise
      const claim = (await claimNextThreadDelivery(grok, 0, 2))!
      await acceptDelivery(grok, claim.messageId, claim.leaseId)
      await postThreadMessage(grok, {
        location: claim.location,
        threadId: claim.threadId,
        authorIdentityId: claim.identityId,
        deliveryLeaseId: claim.leaseId,
        inReplyTo: claim.messageId,
        responseTo: claim.messageId,
        responseIdentityId: null,
        body: "Grok Bot is connected.",
        idempotencyKey: "email-check-reply",
      })
      await stop()
      stop = undefined
    } finally {
      await stop?.()
      stop = undefined
      for (const key of Object.keys(env)) {
        if (before[key] === undefined) delete process.env[key]
        else process.env[key] = before[key]
      }
    }
    expect(
      (
        await app.request(`${base}/configuration`, {
          method: "PUT",
          body: JSON.stringify({ wakeMethod: "webhook" }),
        })
      ).status
    ).toBe(400)
    expect(
      (
        await app.request(`${base}/configuration`, {
          method: "PUT",
          body: JSON.stringify({
            wakeMethod: "webhook",
            webhookUrl: url,
            webhookKey: secret,
          }),
        })
      ).status
    ).toBe(200)
    expect((await readGrokBots())[0]).toMatchObject({
      wakeMethod: "webhook",
      webhookUrl: url,
      webhookKey: secret,
    })
    expect((await readGrokBots())[0]?.emailAddress).toBeUndefined()
    expect((await readGrokBots())[0]?.verifiedAt).toBeUndefined()
  })

  it("verifies an authenticated reply round trip, then drains two threads sequentially", async () => {
    await configure()
    const request = await app.request(`${base}/check`, { method: "POST" })
    expect(request.status).toBe(200)
    const { probe } = await request.json()
    const woken = Promise.withResolvers<void>()
    const requests: RequestInit[] = []
    stop = startGrokBotRuntime({
      fetch: fakeFetch((input, init) => {
        expect(input).toBe(url)
        requests.push(init)
        woken.resolve()
      }),
    })
    await woken.promise
    expect((await grokBotInventory([])).grokBots[0]?.status).toBe("checking")
    expect(JSON.parse(String(requests[0]!.body))).toMatchObject({
      version: 1,
      event: "worktable.inbox.ready",
    })
    expect(Object.keys(JSON.parse(String(requests[0]!.body))).sort()).toEqual([
      "event",
      "version",
      "wakeId",
    ])
    const claim = (await claimNextThreadDelivery(grok, 0, 2))!
    expect(claim.messageId).toBe(probe.messageId)
    expect(Date.parse(claim.leaseExpiresAt) - Date.now()).toBeGreaterThan(
      29 * 60_000
    )
    const clock = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 61_000)
    try {
      await acceptDelivery(grok, claim.messageId, claim.leaseId)
      expect(
        (await grokBotDeliveries(participantId)).find(
          (d) => d.messageId === claim.messageId
        )?.leaseExpiresAt
      ).toBe(claim.leaseExpiresAt)
    } finally {
      clock.mockRestore()
    }
    const ready = Promise.withResolvers<void>()
    const off = onWorkspaceChange((event) => {
      if (event.type === "participants") ready.resolve()
    })
    try {
      const reply = {
        location: claim.location,
        threadId: claim.threadId,
        body: "Grok Bot is connected.",
        authorIdentityId: claim.identityId,
        deliveryLeaseId: claim.leaseId,
        inReplyTo: claim.messageId,
        responseTo: claim.messageId,
        responseIdentityId: null,
        idempotencyKey: "probe-reply",
      }
      const [posted, duplicate] = await Promise.all([
        postThreadMessage(grok, reply),
        postThreadMessage(grok, reply),
      ])
      expect(duplicate.messageId).toBe(posted.messageId)
      // The first response can be lost: an identical retry succeeds after the lease was retired.
      expect((await postThreadMessage(grok, reply)).messageId).toBe(
        posted.messageId
      )
      await ready.promise
      expect((await readGrokBots())[0]?.verifiedAt).toBeDefined()
    } finally {
      off()
    }
    expect(
      (await listThreadParticipants(owner)).find((p) => p.id === participantId)
        ?.alwaysOn
    ).toBe(true)
    await assign("First task")
    await assign("Second task")
    const first = (await claimNextThreadDelivery(grok, 0, 2))!
    expect(await claimNextThreadDelivery(grok, 0, 2)).toBeNull()
    await acceptDelivery(grok, first.messageId, first.leaseId)
    const reply = {
      location: first.location,
      threadId: first.threadId,
      authorIdentityId: first.identityId,
      responseTo: first.messageId,
      responseIdentityId: null,
      body: "Done",
      idempotencyKey: "first-reply",
    }
    await expect(postThreadMessage(grok, reply)).rejects.toMatchObject({
      code: "LEASE_LOST",
    })
    await expect(
      postThreadMessage(grok, {
        ...reply,
        responseTo: undefined,
        inReplyTo: first.messageId,
      })
    ).rejects.toMatchObject({ code: "LEASE_LOST" })
    await postThreadMessage(grok, { ...reply, deliveryLeaseId: first.leaseId })
    const second = await claimNextThreadDelivery(grok, 0, 2)
    expect(second?.messageId).not.toBe(first.messageId)
    expect(second).not.toBeNull()
    const publicState = JSON.stringify(await grokBotInventory([]))
    expect(publicState).not.toContain(secret)
    expect(publicState).not.toContain(url)
    expect(
      (await stat(join(appDir, "grok-bots", `${workspaceCacheKey()}.json`)))
        .mode & 0o777
    ).toBe(0o600)
  })

  it("survives restart, fences uncertain runs and requires an explicit retry", async () => {
    await verified()
    const task = await assign("Potential external work")
    const claim = (await claimNextThreadDelivery(grok, 0, 2))!
    await acceptDelivery(grok, claim.messageId, claim.leaseId)
    await expire(task.messageId)
    let wakes = 0
    stop = startGrokBotRuntime({
      fetch: fakeFetch(() => {
        wakes++
      }),
    })
    await stop()
    stop = undefined
    expect(wakes).toBe(0)
    expect(await claimNextThreadDelivery(grok, 0, 2)).toBeNull()
    expect((await grokBotInventory([])).grokBots[0]).toMatchObject({
      status: "needs-attention",
      uncertain: { messageId: task.messageId },
    })
    const reply = {
      location: claim.location,
      threadId: claim.threadId,
      authorIdentityId: claim.identityId,
      responseTo: claim.messageId,
      responseIdentityId: null,
      body: "Late reply",
      idempotencyKey: "late-reply",
    }
    await expect(postThreadMessage(grok, reply)).rejects.toMatchObject({
      code: "LEASE_LOST",
    })
    await expect(
      postThreadMessage(grok, { ...reply, deliveryLeaseId: claim.leaseId })
    ).rejects.toMatchObject({ code: "LEASE_LOST" })
    expect(
      (await app.request(`${base}/retry`, { method: "POST" })).status
    ).toBe(200)
    const retry = (await claimNextThreadDelivery(grok, 0, 2))!
    expect(retry.messageId).toBe(claim.messageId)
    expect(retry.leaseId).not.toBe(claim.leaseId)
    await acceptDelivery(grok, retry.messageId, retry.leaseId)
    await expect(
      postThreadMessage(grok, { ...reply, deliveryLeaseId: claim.leaseId })
    ).rejects.toMatchObject({ code: "LEASE_LOST" })
    await postThreadMessage(grok, { ...reply, deliveryLeaseId: retry.leaseId })
    expect(
      (await getThreadActivity(claim.location, claim.threadId, claim.messageId))
        ?.state
    ).toBe("replied")
  })

  it("commits a reply atomically against expiry and retry", async () => {
    await verified()
    await assign("Reply at the deadline boundary")
    const claim = (await claimNextThreadDelivery(grok, 0, 2))!
    await acceptDelivery(grok, claim.messageId, claim.leaseId)
    const participant = (await resolveParticipant(grok)).participant
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const completion = commitThreadDeliveryReply(
      { ...claim, participantId },
      async () => {
        entered.resolve()
        await release.promise
        return appendThreadMessage(claim.location, claim.threadId, {
          author: participant,
          authorIdentityId: claim.identityId,
          responseTo: claim.messageId,
          responseIdentityId: null,
          body: "Completed before the deadline",
          idempotencyKey: "deadline-reply",
        })
      }
    )
    await entered.promise
    const expiry = expireGrokBotDeliveries(
      participantId,
      Date.parse(claim.leaseExpiresAt) + 1
    )
    const retry = expiry.then(() =>
      retryGrokBotDelivery({ ...claim, participantId })
    )
    release.resolve()
    const result = await completion
    await expect(retry).rejects.toMatchObject({ code: "DELIVERY_FAILED" })
    expect(
      result.thread.messages.find((message) => message.id === claim.messageId)
        ?.responseRequest?.status
    ).toBe("responded")
    expect(
      (await getThreadActivity(claim.location, claim.threadId, claim.messageId))
        ?.state
    ).toBe("replied")
    expect(await claimNextThreadDelivery(grok, 0, 2)).toBeNull()
  })

  it("resumes queued work after a private-state read failure without another workspace event", async () => {
    await verified()
    await assign("Waiting through a temporary private-state error")
    await drainWorkspaceChanges()
    const path = join(appDir, "grok-bots", `${workspaceCacheKey()}.json`)
    const original = await readFile(path, "utf8")
    await writeFile(path, "{")
    const failed = Promise.withResolvers<void>()
    const woken = Promise.withResolvers<void>()
    const errors = jest
      .spyOn(console, "error")
      .mockImplementation(() => failed.resolve())
    jest.useFakeTimers({ now: Date.now() })
    try {
      stop = startGrokBotRuntime({ fetch: fakeFetch(() => woken.resolve()) })
      await failed.promise
      await writeFile(path, original)
      jest.advanceTimersByTime(15_000)
      await woken.promise
      await stop()
      stop = undefined
      expect((await readGrokBots())[0]?.wake?.attempts).toBe(1)
    } finally {
      await stop?.()
      stop = undefined
      jest.useRealTimers()
      errors.mockRestore()
    }
  })

  it("recovers a durable wake with the same ID and stops retries when disconnected", async () => {
    const connection = await verified()
    await assign("Queued before restart")
    await updateGrokBot(connection, {
      wake: { id: "wake_before_crash", attempts: 1, nextAt: 0 },
    })
    // The canonical message survived a crash before its private delivery write.
    await rm(join(appDir, "thread-deliveries", `${workspaceCacheKey()}.json`))
    const woken = Promise.withResolvers<void>()
    stop = startGrokBotRuntime({
      fetch: fakeFetch((_input, init) => {
        expect(JSON.parse(String(init.body)).wakeId).toBe("wake_before_crash")
        woken.resolve()
      }, 503),
    })
    await woken.promise
    await stop()
    stop = undefined
    expect((await readGrokBots())[0]?.wake).toMatchObject({
      id: "wake_before_crash",
      attempts: 2,
    })
    await removeGrokBot(connection.connectionId)
    expect(await claimNextThreadDelivery(grok, 0, 2)).toBeNull()
    expect(JSON.stringify(await readGrokBots())).not.toContain(secret)
    let wakes = 0
    stop = startGrokBotRuntime({
      fetch: fakeFetch(() => {
        wakes++
      }),
    })
    await stop()
    stop = undefined
    expect(wakes).toBe(0)
  })

  it("rejects unobserved identities and unsafe destinations, and clears private bindings on replacement", async () => {
    expect(
      (
        await app.request("/grok/invented/configuration", {
          method: "PUT",
          body: "{}",
        })
      ).status
    ).toBe(404)
    for (const endpoint of [
      "http://api2.cursor.sh/automations/webhook/a",
      "https://api2.cursor.sh.evil.test/automations/webhook/a",
      "https://localhost/automations/webhook/a",
      "https://api2.cursor.sh/automations/webhook/a?key=x",
      "https://api2.cursor.sh/other",
    ]) {
      expect(() => validateGrokWebhook(endpoint)).toThrow()
    }
    const shortcut =
      "grokbot://app/v1/sidebar?target=webhook-key&automation=worktable-inbox"
    expect(() => validateGrokWebhook(shortcut)).toThrow("Grok shortcut")
    for (const field of ["webhookUrl", "webhookKey"]) {
      const response = await app.request(`${base}/configuration`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          webhookUrl: url,
          webhookKey: secret,
          [field]: shortcut,
        }),
      })
      expect(response.status).toBe(400)
      expect((await response.json()).error).toContain("Grok shortcut")
    }
    expect(await readGrokBots()).toEqual([])
    const connection = await verified()
    await assign("Existing assignment")
    const impostor = {
      ...grok,
      principal: { ...grok.principal, id: "oauth:another:owner" },
    }
    // Simulate a legacy display-name-based participant shared by two credentials.
    const sameParticipant = {
      ...impostor,
      principal: {
        ...impostor.principal,
        participantKey: "principal:oauth:grok:owner",
      },
    }
    expect(await claimNextThreadDelivery(sameParticipant, 0, 2)).toBeNull()
    expect(await claimNextThreadDelivery(grok, 0, 2)).not.toBeNull()
    await notifyWorkspaceChangeAndWaitOrThrow({ type: "workspaceReset" })
    expect(await readGrokBots()).toEqual([])
    expect((await grokBotInventory([])).grokBotCandidates).toEqual([])
    expect(await updateGrokBot(connection, { error: "Old generation" })).toBe(
      false
    )
    expect(await grokBotDeliveries(participantId)).toEqual([])
  })
})
