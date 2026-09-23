import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { existsSync, mkdirSync, rmdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { defaultConversationIdentityId } from "@worktable/types"
import { createToken, revokeToken, type TokenIdentity } from "./token-store.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { upsertAgentConnection } from "./agent-connection-store.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import {
  notePathEventIfSuppressed,
  setSpaceArchived,
  writeSpace,
} from "./store.ts"
import { resolveParticipant } from "./participant-store.ts"
import {
  getThreadActivity,
  nextThreadDeliveryEligibleAt,
} from "./thread-delivery-store.ts"
import {
  acceptDelivery,
  assignResponseRequest,
  claimNextThreadDelivery,
  failDelivery,
  listThreadParticipants,
  listThreadSummaries,
  postThreadMessage,
  progressDelivery,
  readThreadMessage,
  readThreadMessages,
  waitForThreadReply,
} from "./thread-service.ts"
import { assignThreadMessage, threadPath } from "./thread-store.ts"
import {
  inboxSignalRevision,
  threadSignalRevision,
  waitForInboxSignal,
  waitForThreadSignal,
} from "./thread-waiters.ts"
import {
  drainWorkspaceChanges,
  notifyWorkspaceChange,
  onWorkspaceChange,
} from "./workspace-events.ts"
import { WsManager } from "./ws.ts"

let workspaceDir: string
let appDir: string

async function waitForFiles(paths: string[]): Promise<void> {
  const deadline = Date.now() + 2_000
  while (paths.some((path) => !existsSync(path)) && Date.now() < deadline) {
    // test-policy: external-readiness-backoff
    await Bun.sleep(5)
  }
  expect(paths.filter((path) => !existsSync(path))).toEqual([])
}

const finn: TokenIdentity = {
  user: "owner",
  workspace: "test",
  scopes: ["threads:*"],
  agent: "claude-code@work",
  principal: {
    id: "local-token:finn-a",
    type: "agent",
    displayName: "Finn",
    authorizedBy: "local:owner",
  },
}

const atlas: TokenIdentity = {
  user: "owner",
  workspace: "test",
  scopes: ["threads:*"],
  agent: "openclaw@personal",
  principal: {
    id: "local-token:atlas-a",
    type: "agent",
    displayName: "Atlas",
    authorizedBy: "local:owner",
  },
}

const mara: TokenIdentity = {
  user: "owner",
  workspace: "test",
  scopes: ["threads:*"],
  agent: "codex@elsewhere",
  principal: {
    id: "local-token:mara",
    type: "agent",
    displayName: "Mara",
    authorizedBy: "local:owner",
  },
}

const owner: TokenIdentity = {
  user: "owner",
  workspace: "test",
  scopes: ["*"],
  agent: null,
  principal: {
    id: "local:owner",
    type: "human",
    displayName: "Owner",
  },
}

async function expireDeliveryLease(messageId: string): Promise<void> {
  const directory = join(appDir, "thread-deliveries")
  const [name] = (await readdir(directory)).filter((entry) =>
    entry.endsWith(".json")
  )
  if (!name) throw new Error("Missing thread delivery state")
  const path = join(directory, name)
  const file = JSON.parse(await readFile(path, "utf8"))
  const delivery = file.deliveries.find(
    (candidate: { messageId: string }) => candidate.messageId === messageId
  )
  if (!delivery) throw new Error(`Missing delivery ${messageId}`)
  delivery.leaseExpiresAt = new Date(0).toISOString()
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8")
}

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "worktable-threads-workspace-"))
  appDir = await mkdtemp(join(tmpdir(), "worktable-threads-app-"))
  setWorkspaceRootOverride(workspaceDir)
  setAppDirOverride(appDir)
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: "connected-agents",
    name: "Connected Agents",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  })
  await resolveParticipant(atlas, {
    name: "Atlas",
    defaultSpaceId: "connected-agents",
  })
  await resolveParticipant(finn, {
    name: "Finn",
    defaultSpaceId: "connected-agents",
  })
})

afterEach(async () => {
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await Promise.all([
    rm(workspaceDir, { recursive: true, force: true }),
    rm(appDir, { recursive: true, force: true }),
  ])
})

describe("thread service", () => {
  it("identifies only durable agent connections as always on", async () => {
    const atlasParticipant = (await resolveParticipant(atlas)).participant
    const finnParticipant = (await resolveParticipant(finn)).participant
    const alwaysOnCredential = await createToken({
      scopes: ["threads:*"],
      agent: atlas.agent,
    })
    const onDemandCredential = await createToken({
      scopes: ["threads:*"],
      agent: finn.agent,
    })
    await upsertAgentConnection({
      target: {
        kind: "agent-adapter",
        adapter: "openclaw",
        installationId: "oci_thread_service",
      },
      mode: "always-on",
      participant: atlasParticipant,
      machine: "test",
      credentialId: alwaysOnCredential.metadata.id,
    })
    await upsertAgentConnection({
      target: { kind: "mcp-client", clientId: "claude-code" },
      mode: "on-demand",
      participant: finnParticipant,
      machine: "test",
      credentialId: onDemandCredential.metadata.id,
    })

    expect(
      Object.fromEntries(
        (await listThreadParticipants(owner)).map((participant) => [
          participant.name,
          participant.alwaysOn,
        ])
      )
    ).toEqual({ Atlas: true, Finn: false })
  })

  it("keeps Worktable deliveries from legacy adapters until they opt into V2 locations", async () => {
    const posted = await postThreadMessage(finn, {
      location: { kind: "worktable" },
      to: "Atlas",
      body: "This needs a location-aware adapter.",
      idempotencyKey: "legacy-root-gate",
      waitSeconds: 0,
    })
    expect(posted.location).toEqual({ kind: "worktable" })
    const spacePosted = await postThreadMessage(finn, {
      location: { kind: "space", spaceId: "connected-agents" },
      to: "Atlas",
      body: "Legacy adapters can still receive this Space delivery.",
      idempotencyKey: "legacy-space-delivery",
      waitSeconds: 0,
    })
    expect(await claimNextThreadDelivery(atlas, 0)).toMatchObject({
      messageId: spacePosted.messageId,
      location: { kind: "space", spaceId: "connected-agents" },
    })

    await resolveParticipant(atlas, { threadLocationVersion: 2 })
    expect(await claimNextThreadDelivery(atlas, 0)).toMatchObject({
      messageId: posted.messageId,
      location: { kind: "worktable" },
    })
  })

  it("persists a Finn-to-Atlas thread and continues it through delivery", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Research the connector shape.",
      idempotencyKey: "finn-first",
    })
    expect(first.createdThread).toBe(true)
    expect(first.activity?.state).toBe("queued")

    const claim = await claimNextThreadDelivery(atlas, 0)
    expect(claim?.message.body).toBe("Research the connector shape.")
    await acceptDelivery(atlas, claim!.messageId, claim!.leaseId)
    const progress = await progressDelivery(atlas, {
      messageId: claim!.messageId,
      leaseId: claim!.leaseId,
      phase: "receiving",
      receivedCharacters: 42,
    })
    expect(progress.state).toBe("receiving")
    expect(progress.receivedCharacters).toBe(42)

    const reply = await postThreadMessage(atlas, {
      threadId: first.threadId,
      body: "The channel plugin is the clean seam.",
      idempotencyKey: "atlas-first",
      inReplyTo: first.messageId,
      responseTo: first.messageId,
      expectsReply: false,
    })
    expect(reply.threadId).toBe(first.threadId)

    const read = await readThreadMessages(finn, first.threadId)
    expect(read.messages.map((message) => message.body)).toEqual([
      "Research the connector shape.",
      "The channel plugin is the clean seam.",
    ])
    expect(read.activities).toHaveLength(1)
    expect(read.activities[0]).toMatchObject({
      messageId: first.messageId,
      state: "replied",
      attempts: 1,
    })
    expect(read.activity?.state).toBe("replied")

    const onDisk = JSON.parse(
      await readFile(threadPath("connected-agents", first.threadId), "utf8")
    )
    expect(onDisk.type).toBe("worktable.thread")
    expect(onDisk.messages).toHaveLength(2)
  })

  it("deduplicates assigned and unassigned creation retries", async () => {
    const input = {
      to: "Atlas",
      body: "One request",
      idempotencyKey: "same-key",
      waitSeconds: 0,
    }
    const first = await postThreadMessage(finn, input)
    const retry = await postThreadMessage(finn, input)
    expect(retry.threadId).toBe(first.threadId)
    expect(retry.messageId).toBe(first.messageId)
    expect(retry.createdThread).toBe(false)

    await expect(
      postThreadMessage(finn, { ...input, body: "Different request" })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })

    const unassignedInput = {
      to: "Atlas",
      body: "This opening message does not request attention.",
      idempotencyKey: "unassigned-retry",
      notifyIdentityIds: [],
      responseIdentityId: null,
      waitSeconds: 0,
    }
    const unassigned = await postThreadMessage(finn, unassignedInput)
    const unassignedRetry = await postThreadMessage(finn, unassignedInput)
    expect(unassignedRetry).toMatchObject({
      threadId: unassigned.threadId,
      messageId: unassigned.messageId,
      createdThread: false,
    })
    await assignResponseRequest(finn, {
      location: first.location,
      threadId: first.threadId,
      messageId: first.messageId,
      identityId: null,
    })
    expect(await postThreadMessage(finn, input)).toMatchObject({
      threadId: first.threadId,
      messageId: first.messageId,
      createdThread: false,
    })
  })

  it("preserves an idempotent reply retry after upgrading a legacy thread", async () => {
    const finnParticipant = (await resolveParticipant(finn)).participant
    const atlasParticipant = (await resolveParticipant(atlas)).participant
    const threadId = "thr_legacy_retry"
    const sourceId = "msg_legacy_source"
    const replyId = "msg_legacy_reply"
    const createdAt = "2026-08-01T10:00:00.000Z"
    const path = threadPath({ kind: "worktable" }, threadId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      `${JSON.stringify(
        {
          type: "worktable.thread",
          version: 2,
          id: threadId,
          location: { kind: "worktable" },
          title: "Legacy retry",
          participants: [finnParticipant, atlasParticipant],
          revision: 2,
          messages: [
            {
              id: sourceId,
              sequence: 1,
              authorId: finnParticipant.id,
              recipientIds: [atlasParticipant.id],
              body: "Please answer this once.",
              expectsReply: true,
              idempotencyKey: "legacy-source",
              createdAt,
            },
            {
              id: replyId,
              sequence: 2,
              authorId: atlasParticipant.id,
              recipientIds: [finnParticipant.id],
              body: "This answer was already committed.",
              inReplyTo: sourceId,
              expectsReply: false,
              idempotencyKey: "legacy-reply",
              createdAt: "2026-08-01T10:01:00.000Z",
            },
          ],
          createdAt,
          updatedAt: "2026-08-01T10:01:00.000Z",
        },
        null,
        2
      )}\n`,
      "utf8"
    )

    const retry = await postThreadMessage(atlas, {
      location: { kind: "worktable" },
      threadId,
      to: finnParticipant.id,
      body: "This answer was already committed.",
      inReplyTo: sourceId,
      expectsReply: false,
      idempotencyKey: "legacy-reply",
      waitSeconds: 0,
    })

    expect(retry).toMatchObject({
      threadId,
      messageId: replyId,
      createdThread: false,
    })
  })

  it("replays a committed create after its recipient credential disconnects", async () => {
    const credential = await createToken({
      scopes: ["threads:*"],
      agent: atlas.agent,
    })
    const input = {
      to: "Atlas",
      body: "The first response may be lost.",
      idempotencyKey: "disconnected-recipient-retry",
      waitSeconds: 0,
    }
    const first = await postThreadMessage(finn, input)
    await revokeToken(credential.metadata.id)
    expect(
      (await listThreadParticipants(finn)).some(
        (participant) => participant.name === "Atlas"
      )
    ).toBe(false)

    const retry = await postThreadMessage(finn, input)
    expect(retry).toMatchObject({
      threadId: first.threadId,
      messageId: first.messageId,
      createdThread: false,
    })
    await expect(
      postThreadMessage(finn, { ...input, body: "Different intent" })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })
  })

  it("replays a committed follow-up after its recipient credential disconnects", async () => {
    const credential = await createToken({
      scopes: ["threads:*"],
      agent: atlas.agent,
    })
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Start a durable conversation.",
      idempotencyKey: "disconnected-follow-up-start",
      waitSeconds: 0,
    })
    const input = {
      threadId: first.threadId,
      to: "Atlas",
      body: "The follow-up response may be lost.",
      idempotencyKey: "disconnected-follow-up-retry",
      waitSeconds: 0,
    }
    const followUp = await postThreadMessage(finn, input)
    await revokeToken(credential.metadata.id)
    expect(
      (await listThreadParticipants(finn)).some(
        (participant) => participant.name === "Atlas"
      )
    ).toBe(false)

    const retry = await postThreadMessage(finn, input)
    expect(retry).toMatchObject({
      threadId: first.threadId,
      messageId: followUp.messageId,
      createdThread: false,
    })
    await expect(
      postThreadMessage(finn, {
        ...input,
        body: "Different follow-up intent",
      })
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" })
  })

  it("refuses creation while the portable idempotency scan is incomplete", async () => {
    const input = {
      to: "Atlas",
      body: "Do not duplicate this request.",
      idempotencyKey: "incomplete-idempotency-scan",
      waitSeconds: 0,
    }
    const first = await postThreadMessage(finn, input)
    const corruptPath = threadPath("connected-agents", "thr_corrupt")
    await writeFile(corruptPath, '{"type":', "utf8")

    await expect(postThreadMessage(finn, input)).rejects.toMatchObject({
      code: "THREAD_STORE_INCOMPLETE",
    })
    await expect(
      postThreadMessage(finn, {
        ...input,
        body: "A genuinely new request.",
        idempotencyKey: "new-during-incomplete-scan",
      })
    ).rejects.toMatchObject({ code: "THREAD_STORE_INCOMPLETE" })
    expect(
      (await readdir(dirname(corruptPath))).filter((name) =>
        name.endsWith(".json")
      )
    ).toHaveLength(2)

    await rm(corruptPath)
    const retry = await postThreadMessage(finn, input)
    expect(retry).toMatchObject({
      threadId: first.threadId,
      messageId: first.messageId,
      createdThread: false,
    })
  })

  it("derives a concise readable title from the first message", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: `## **Review** [the connected agent plan](/plans/agents) and identify ${"important tradeoffs ".repeat(8)}`,
      idempotencyKey: "readable-title",
    })
    const read = await readThreadMessages(finn, first.threadId)
    expect(read.thread.title).toBe(
      "Review the connected agent plan and identify important tradeoffs…"
    )
    expect(read.thread.title.length).toBeLessThanOrEqual(72)

    const unbroken = `https://${"a".repeat(100)}`
    const second = await postThreadMessage(finn, {
      to: "Atlas",
      body: unbroken,
      idempotencyKey: "unbroken-title",
    })
    const unbrokenRead = await readThreadMessages(finn, second.threadId)
    expect(unbrokenRead.thread.title).toBe(`${unbroken.slice(0, 71)}…`)
  })

  it("rejects portable messages outside membership or cursor ordering", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Validate this portable boundary.",
      idempotencyKey: "portable-schema-boundary",
      expectsReply: false,
    })
    const path = threadPath("connected-agents", first.threadId)
    const original = JSON.parse(await readFile(path, "utf8"))

    const outsideRecipient = structuredClone(original)
    outsideRecipient.messages[0].notifyIdentityIds = ["idt_outside_actor_1"]
    await writeFile(
      path,
      `${JSON.stringify(outsideRecipient, null, 2)}\n`,
      "utf8"
    )
    await expect(
      readThreadMessages(owner, first.threadId, {
        spaceId: "connected-agents",
      })
    ).rejects.toThrow("attention targets must be conversation identities")

    const outsideAuthor = structuredClone(original)
    outsideAuthor.messages[0].authorIdentityId = "idt_outside_actor_1"
    await writeFile(path, `${JSON.stringify(outsideAuthor, null, 2)}\n`, "utf8")
    await expect(
      readThreadMessages(owner, first.threadId, {
        spaceId: "connected-agents",
      })
    ).rejects.toThrow("authors must be conversation identities")

    const invalidSequence = structuredClone(original)
    invalidSequence.messages[0].sequence = 2
    await writeFile(
      path,
      `${JSON.stringify(invalidSequence, null, 2)}\n`,
      "utf8"
    )
    await expect(
      readThreadMessages(owner, first.threadId, {
        spaceId: "connected-agents",
      })
    ).rejects.toThrow("sequences must be ordered and contiguous")
  })

  it("serializes concurrent follow-ups without losing messages", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Start",
      idempotencyKey: "concurrent-start",
    })
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        postThreadMessage(finn, {
          threadId: first.threadId,
          body: `Follow-up ${index}`,
          idempotencyKey: `concurrent-${index}`,
          waitSeconds: 0,
        })
      )
    )
    const read = await readThreadMessages(finn, first.threadId)
    expect(read.thread.messages).toHaveLength(9)
    expect(read.thread.messages.map((message) => message.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9,
    ])
  })

  it("serializes portable thread appends across Worktable processes", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Start across processes",
      idempotencyKey: "cross-process-append-start",
    })
    const thread = (await readThreadMessages(finn, first.threadId)).thread
    const author = thread.members.find(
      (participant) => participant.name === "Finn"
    )!
    const recipient = thread.members.find(
      (participant) => participant.name === "Atlas"
    )!
    const lockRoot = join(appDir, "thread-locks")
    const cacheDirs = await readdir(lockRoot)
    expect(cacheDirs).toHaveLength(1)
    const lockDir = join(
      lockRoot,
      cacheDirs[0]!,
      "connected-agents",
      `${first.threadId}.lock`
    )
    mkdirSync(lockDir, { recursive: true })

    const moduleUrl = new URL("./thread-store.ts", import.meta.url).href
    const spawnAppend = (body: string, idempotencyKey: string) => {
      const readyPath = join(appDir, `${idempotencyKey}.ready`)
      const source = `
        import { writeFileSync } from "node:fs";
        import { appendThreadMessage } from ${JSON.stringify(moduleUrl)};
        writeFileSync(process.env.READY_PATH, "ready");
        const result = await appendThreadMessage(
          "connected-agents",
          ${JSON.stringify(first.threadId)},
          {
            author: ${JSON.stringify(author)},
            recipient: ${JSON.stringify(recipient)},
            body: ${JSON.stringify(body)},
            idempotencyKey: ${JSON.stringify(idempotencyKey)},
            expectsReply: true
          }
        );
        console.log(result.message.id);
      `
      return {
        readyPath,
        child: Bun.spawn({
          cmd: [process.execPath, "-e", source],
          cwd: process.cwd(),
          env: {
            ...process.env,
            WORKTABLE_APP_DIR: appDir,
            WORKTABLE_WORKSPACE: workspaceDir,
            READY_PATH: readyPath,
          },
          stdout: "pipe",
          stderr: "pipe",
        }),
      }
    }
    const spawnedAppenders = [
      spawnAppend("Append from process A", "cross-process-append-a"),
      spawnAppend("Append from process B", "cross-process-append-b"),
    ]
    const appenders = spawnedAppenders.map(({ child }) => child)
    let exited = 0
    for (const appender of appenders) {
      void appender.exited.then(() => {
        exited += 1
      })
    }

    try {
      await waitForFiles(spawnedAppenders.map(({ readyPath }) => readyPath))
      expect(exited).toBe(0)
    } finally {
      if (existsSync(lockDir)) rmdirSync(lockDir)
    }

    expect(
      await Promise.all(appenders.map((appender) => appender.exited))
    ).toEqual([0, 0])
    expect(
      await Promise.all(
        appenders.map((appender) => new Response(appender.stderr).text())
      )
    ).toEqual(["", ""])
    const updated = (await readThreadMessages(finn, first.threadId)).thread
    expect(updated.messages.map((message) => message.sequence)).toEqual([
      1, 2, 3,
    ])
    expect(
      updated.messages
        .slice(1)
        .map((message) => message.body)
        .sort()
    ).toEqual(["Append from process A", "Append from process B"])
  })

  it("keeps copied message IDs isolated by durable thread identity", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "First portable thread.",
      idempotencyKey: "composite-delivery-first",
    })
    const second = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Copied portable thread.",
      idempotencyKey: "composite-delivery-second",
    })
    const secondPath = threadPath("connected-agents", second.threadId)
    const copied = JSON.parse(await readFile(secondPath, "utf8"))
    copied.messages[0].id = first.messageId
    await writeFile(secondPath, `${JSON.stringify(copied, null, 2)}\n`, "utf8")

    await listThreadSummaries(atlas, "connected-agents")
    expect(
      await getThreadActivity(
        "connected-agents",
        first.threadId,
        first.messageId
      )
    ).toMatchObject({ state: "queued" })
    expect(
      await getThreadActivity(
        "connected-agents",
        second.threadId,
        first.messageId
      )
    ).toMatchObject({ state: "queued" })

    const claims = [
      await claimNextThreadDelivery(atlas, 0),
      await claimNextThreadDelivery(atlas, 0),
    ]
    expect(claims.map((claim) => claim?.threadId).sort()).toEqual(
      [first.threadId, second.threadId].sort()
    )
    expect(claims.every((claim) => claim?.messageId === first.messageId)).toBe(
      true
    )
  })

  it("keeps copied thread and message IDs isolated across Spaces", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Portable thread copied across Spaces.",
      idempotencyKey: "cross-space-delivery-identity",
    })
    const now = new Date().toISOString()
    await writeSpace({
      type: "worktable.space",
      version: 1,
      id: "second-space",
      name: "Second Space",
      createdAt: now,
      updatedAt: now,
      createdBy: "test",
      settings: {},
    })
    const sourcePath = threadPath("connected-agents", first.threadId)
    const copied = JSON.parse(await readFile(sourcePath, "utf8"))
    if (copied.version === 1) {
      copied.spaceId = "second-space"
    } else {
      copied.location = { kind: "space", spaceId: "second-space" }
    }
    const copiedPath = threadPath("second-space", first.threadId)
    await mkdir(dirname(copiedPath), { recursive: true })
    await writeFile(copiedPath, `${JSON.stringify(copied, null, 2)}\n`, "utf8")

    await listThreadSummaries(atlas, "second-space")
    expect(
      await getThreadActivity(
        "connected-agents",
        first.threadId,
        first.messageId
      )
    ).toMatchObject({ state: "queued" })
    expect(
      await getThreadActivity("second-space", first.threadId, first.messageId)
    ).toMatchObject({ state: "queued" })

    const claims = [
      await claimNextThreadDelivery(atlas, 0),
      await claimNextThreadDelivery(atlas, 0),
    ]
    expect(claims.map((claim) => claim?.spaceId).sort()).toEqual([
      "connected-agents",
      "second-space",
    ])
    expect(claims.every((claim) => claim?.threadId === first.threadId)).toBe(
      true
    )
    expect(claims.every((claim) => claim?.messageId === first.messageId)).toBe(
      true
    )
    await expect(
      readThreadMessages(finn, first.threadId)
    ).rejects.toMatchObject({
      code: "AMBIGUOUS_THREAD_LOCATION",
    })
    expect(
      (
        await readThreadMessages(finn, first.threadId, {
          spaceId: "second-space",
        })
      ).thread
    ).toMatchObject({
      location: { kind: "space", spaceId: "second-space" },
    })
  })

  it("omits archived Spaces from the Worktable-wide thread list", async () => {
    const now = new Date().toISOString()
    await writeSpace({
      type: "worktable.space",
      version: 1,
      id: "archived-space",
      name: "Archived Space",
      createdAt: now,
      updatedAt: now,
      createdBy: "test",
      settings: {},
    })
    const active = await postThreadMessage(finn, {
      location: { kind: "space", spaceId: "connected-agents" },
      to: "Atlas",
      body: "Keep this active Space thread visible.",
      idempotencyKey: "active-space-aggregate",
    })
    const archived = await postThreadMessage(finn, {
      location: { kind: "space", spaceId: "archived-space" },
      to: "Atlas",
      body: "Hide this archived Space thread from the aggregate.",
      idempotencyKey: "archived-space-aggregate",
    })
    const worktable = await postThreadMessage(finn, {
      location: { kind: "worktable" },
      to: "Atlas",
      body: "Keep this Worktable thread visible.",
      idempotencyKey: "worktable-aggregate",
    })
    await setSpaceArchived("archived-space", true)

    expect(
      (await listThreadSummaries(finn)).map((thread) => thread.id).sort()
    ).toEqual([active.threadId, worktable.threadId].sort())
    expect(
      (
        await listThreadSummaries(finn, {
          kind: "space",
          spaceId: "archived-space",
        })
      ).map((thread) => thread.id)
    ).toEqual([archived.threadId])
  })

  it("rebinds a durable delivery when a portable edit changes its recipient", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "The portable recipient may change.",
      idempotencyKey: "portable-recipient-rebind",
    })
    const maraBinding = await resolveParticipant(mara, {
      name: "Mara",
      defaultSpaceId: "connected-agents",
    })
    const path = threadPath("connected-agents", first.threadId)
    const portable = JSON.parse(await readFile(path, "utf8"))
    const now = new Date().toISOString()
    const maraIdentityId = `idt_${maraBinding.participant.id.slice(4)}`
    portable.members.push({
      ...maraBinding.participant,
      status: "active",
      addedAt: now,
    })
    portable.identities.push({
      id: maraIdentityId,
      memberId: maraBinding.participant.id,
      name: maraBinding.participant.name,
      default: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    portable.messages[0].notifyIdentityIds = []
    portable.messages[0].responseRequest = {
      identityId: maraIdentityId,
      status: "open",
    }
    portable.revision += 1
    portable.updatedAt = new Date().toISOString()
    await writeFile(path, `${JSON.stringify(portable, null, 2)}\n`, "utf8")

    await listThreadSummaries(atlas, "connected-agents")
    expect(
      await getThreadActivity(
        "connected-agents",
        first.threadId,
        first.messageId
      )
    ).toMatchObject({
      participantId: (await resolveParticipant(atlas)).participant.id,
      state: "failed",
      error: { code: "DELIVERY_RETIRED" },
    })

    await listThreadSummaries(mara, "connected-agents")
    expect(
      await getThreadActivity(
        "connected-agents",
        first.threadId,
        first.messageId,
        maraIdentityId
      )
    ).toMatchObject({
      participantId: maraBinding.participant.id,
      state: "queued",
      attempts: 0,
      error: undefined,
    })
    expect(await claimNextThreadDelivery(atlas, 0)).toBeNull()
    expect(await claimNextThreadDelivery(mara, 0)).toMatchObject({
      spaceId: "connected-agents",
      threadId: first.threadId,
      messageId: first.messageId,
    })
  })

  it("wakes a bounded wait when a reply arrives", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Wait for me",
      idempotencyKey: "wait-start",
    })
    const waiting = waitForThreadReply(finn, {
      threadId: first.threadId,
      after: first.cursor,
      messageId: first.messageId,
      waitSeconds: 2,
    })
    await postThreadMessage(atlas, {
      threadId: first.threadId,
      body: "Here",
      idempotencyKey: "wait-reply",
      inReplyTo: first.messageId,
      responseTo: first.messageId,
      expectsReply: false,
    })
    const result = await waiting
    expect(result.timedOut).toBe(false)
    expect(result.messages[0]?.body).toBe("Here")
  })

  it("assigns an existing message to one identity and retires it when unassigned", async () => {
    const created = await postThreadMessage(finn, {
      to: "Atlas",
      body: "This can be assigned after it is sent.",
      idempotencyKey: "assign-existing-message",
      responseIdentityId: null,
      waitSeconds: 0,
    })
    const atlasIdentityId = defaultConversationIdentityId(
      (await resolveParticipant(atlas)).participant.id
    )

    const assigned = await assignResponseRequest(finn, {
      location: created.location,
      threadId: created.threadId,
      messageId: created.messageId,
      identityId: atlasIdentityId,
    })
    expect(assigned.messages[0]?.responseRequest).toEqual({
      identityId: atlasIdentityId,
      status: "open",
    })
    expect((await claimNextThreadDelivery(atlas, 0, 2))?.identityId).toBe(
      atlasIdentityId
    )

    const unassigned = await assignResponseRequest(finn, {
      location: created.location,
      threadId: created.threadId,
      messageId: created.messageId,
      identityId: null,
    })
    expect(unassigned.messages[0]?.responseRequest).toBeUndefined()
    expect(
      await getThreadActivity(
        created.location,
        created.threadId,
        created.messageId,
        atlasIdentityId
      )
    ).toMatchObject({ state: "failed", error: { code: "DELIVERY_RETIRED" } })
    const summary = (await listThreadSummaries(finn, created.location)).find(
      (thread) => thread.id === created.threadId
    )
    expect(summary).toBeDefined()
    expect(summary?.activity).toBeUndefined()
  })

  it("captures the committed assignment transition for delivery reconciliation", async () => {
    const created = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Capture the assignment changed under the store lock.",
      idempotencyKey: "assignment-transition",
      waitSeconds: 0,
    })
    const atlasIdentityId = defaultConversationIdentityId(
      (await resolveParticipant(atlas)).participant.id
    )

    const transition = await assignThreadMessage(
      created.location,
      created.threadId,
      created.messageId,
      null
    )

    expect(transition.replacedIdentityId).toBe(atlasIdentityId)
    expect(transition.thread.messages[0]?.responseRequest).toBeUndefined()
  })

  it("does not treat historical terminal activity as a new unscoped wait event", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "This reply will already be complete.",
      idempotencyKey: "historical-activity-start",
    })
    const reply = await postThreadMessage(atlas, {
      threadId: first.threadId,
      body: "Already answered.",
      idempotencyKey: "historical-activity-reply",
      inReplyTo: first.messageId,
      expectsReply: false,
    })

    const waited = await waitForThreadReply(finn, {
      threadId: first.threadId,
      after: reply.cursor,
      waitSeconds: 0.02,
    })
    expect(waited.timedOut).toBe(true)
    expect(waited.messages).toEqual([])
  })

  it("does not lose a thread or inbox signal emitted before waiter registration", async () => {
    const threadId = "thr_waiter_generation"
    const participantId = "ptc_waiter_generation"
    const threadRevision = threadSignalRevision(threadId)
    const inboxRevision = inboxSignalRevision(participantId)

    notifyWorkspaceChange({
      type: "threadActivity",
      spaceId: "connected-agents",
      threadId,
      messageId: "msg_waiter_generation",
      participantId,
    })

    expect(await waitForThreadSignal(threadId, 10, threadRevision)).toBe(true)
    expect(await waitForInboxSignal(participantId, 10, inboxRevision)).toBe(
      true
    )
  })

  it("wakes a blocked claim when an external file edit adds a delivery", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Seed a portable thread without requesting a reply.",
      idempotencyKey: "external-claim-seed",
      expectsReply: false,
    })
    await drainWorkspaceChanges()

    const claiming = claimNextThreadDelivery(atlas, 2)
    const path = threadPath("connected-agents", first.threadId)
    const thread = JSON.parse(await readFile(path, "utf8"))
    const author = thread.members.find(
      (member: { name: string }) => member.name === "Finn"
    )
    const recipientIdentity = thread.identities.find(
      (identity: { name: string }) => identity.name === "Atlas"
    )
    const now = new Date().toISOString()
    thread.revision += 1
    thread.updatedAt = now
    thread.messages.push({
      id: "msg_external_delivery",
      sequence: thread.messages.length + 1,
      authorIdentityId: thread.identities.find(
        (identity: { memberId: string }) => identity.memberId === author.id
      ).id,
      authorMemberId: author.id,
      notifyIdentityIds: [],
      responseRequest: { identityId: recipientIdentity.id, status: "open" },
      body: "This message arrived through the portable file protocol.",
      idempotencyKey: "external-file-delivery",
      createdAt: now,
    })
    await writeFile(path, `${JSON.stringify(thread, null, 2)}\n`, "utf8")
    notifyWorkspaceChange({
      type: "thread",
      spaceId: "connected-agents",
      threadId: first.threadId,
    })
    await drainWorkspaceChanges()

    const claim = await claiming
    expect(claim?.message.id).toBe("msg_external_delivery")
    expect(claim?.message.body).toBe(
      "This message arrived through the portable file protocol."
    )
  })

  it("replays an external thread edit observed during internal suppression", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Internal content before the collision.",
      idempotencyKey: "suppressed-thread-replay",
      expectsReply: false,
    })
    await drainWorkspaceChanges()
    const path = threadPath("connected-agents", first.threadId)
    const portable = JSON.parse(await readFile(path, "utf8"))
    portable.title = "External edit wins"
    portable.revision += 1

    const events: unknown[] = []
    const off = onWorkspaceChange((event) => {
      if (event.type === "thread" && event.threadId === first.threadId) {
        events.push(event)
      }
    })
    try {
      await writeFile(path, `${JSON.stringify(portable, null, 2)}\n`, "utf8")
      expect(notePathEventIfSuppressed(path)).toBe(true)
      const deadline = Date.now() + 2_000
      while (events.length === 0 && Date.now() < deadline) {
        // test-policy: external-readiness-backoff
        await Bun.sleep(10)
      }
      await drainWorkspaceChanges()
      expect(events).toContainEqual({
        type: "thread",
        location: { kind: "space", spaceId: "connected-agents" },
        spaceId: "connected-agents",
        threadId: first.threadId,
      })
    } finally {
      off()
    }
  })

  it("keeps waiting when the caller posts another message before the reply", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Wait for Atlas specifically.",
      idempotencyKey: "wait-other-participant",
    })
    const waiting = waitForThreadReply(finn, {
      threadId: first.threadId,
      after: first.cursor,
      messageId: first.messageId,
      waitSeconds: 2,
    })
    await postThreadMessage(finn, {
      threadId: first.threadId,
      body: "One more detail from Finn.",
      idempotencyKey: "wait-own-follow-up",
      waitSeconds: 0,
    })
    await postThreadMessage(atlas, {
      threadId: first.threadId,
      body: "Atlas has the answer.",
      idempotencyKey: "wait-other-reply",
      inReplyTo: first.messageId,
      responseTo: first.messageId,
      expectsReply: false,
    })

    const result = await waiting
    expect(result.timedOut).toBe(false)
    expect(result.messages.map((message) => message.body)).toEqual([
      "Atlas has the answer.",
    ])
    expect(result.cursor).toBe(result.messages.at(-1)!.sequence)
    expect(
      (
        await readThreadMessages(finn, first.threadId, {
          after: result.cursor,
        })
      ).messages
    ).toEqual([])

    const ownFollowUp = await postThreadMessage(finn, {
      threadId: first.threadId,
      body: "A concurrent update from Finn.",
      idempotencyKey: "wait-unscoped-own-follow-up",
      responseIdentityId: null,
      waitSeconds: 0,
    })
    const unscoped = await waitForThreadReply(finn, {
      threadId: first.threadId,
      after: result.cursor,
      waitSeconds: 0,
    })
    expect(unscoped.timedOut).toBe(true)
    expect(unscoped.messages).toEqual([])
    expect(unscoped.cursor).toBe(ownFollowUp.cursor)
  })

  it("does not skip a simultaneous reply to another message while awaiting a later reply", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "First simultaneous question.",
      idempotencyKey: "simultaneous-first",
    })
    const second = await postThreadMessage(finn, {
      threadId: first.threadId,
      body: "Second simultaneous question.",
      idempotencyKey: "simultaneous-second",
    })
    const waiting = waitForThreadReply(finn, {
      threadId: first.threadId,
      after: second.cursor,
      messageId: second.messageId,
      // Exercise signal/cursor behavior without turning host scheduler latency
      // into the assertion under parallel verification load.
      waitSeconds: 1,
    })
    await postThreadMessage(atlas, {
      threadId: first.threadId,
      body: "Answer to the first question.",
      idempotencyKey: "simultaneous-first-reply",
      inReplyTo: first.messageId,
      responseTo: first.messageId,
      expectsReply: false,
    })
    await postThreadMessage(atlas, {
      threadId: first.threadId,
      body: "Answer to the second question.",
      idempotencyKey: "simultaneous-second-reply",
      inReplyTo: second.messageId,
      responseTo: second.messageId,
      expectsReply: false,
    })

    const result = await waiting
    expect(result.timedOut).toBe(false)
    expect(result.messages.map((message) => message.body)).toEqual([
      "Answer to the second question.",
    ])
    expect(result.cursor).toBe(second.cursor)
    const catchup = await readThreadMessages(finn, first.threadId, {
      after: result.cursor,
    })
    expect(catchup.messages.map((message) => message.body)).toEqual([
      "Answer to the first question.",
      "Answer to the second question.",
    ])
  })

  it("does not advance a timed-out wait past a filtered message", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Wait only for a direct reply to this message.",
      idempotencyKey: "timeout-filtered-cursor-start",
    })
    await postThreadMessage(atlas, {
      threadId: first.threadId,
      body: "An unrelated update from Atlas.",
      idempotencyKey: "timeout-filtered-cursor-update",
      expectsReply: false,
    })

    const waited = await waitForThreadReply(finn, {
      threadId: first.threadId,
      after: first.cursor,
      messageId: first.messageId,
      waitSeconds: 0,
    })
    expect(waited.timedOut).toBe(true)
    expect(waited.messages).toEqual([])
    expect(waited.cursor).toBe(first.cursor)
    expect(
      (
        await readThreadMessages(finn, first.threadId, {
          after: waited.cursor,
        })
      ).messages.map((message) => message.body)
    ).toEqual(["An unrelated update from Atlas."])
  })

  it("waits for the addressed participant in a portable group thread", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Atlas should answer this.",
      idempotencyKey: "group-recipient-start",
    })
    const maraBinding = await resolveParticipant(mara, {
      name: "Mara",
      defaultSpaceId: "connected-agents",
    })
    const path = threadPath("connected-agents", first.threadId)
    const portable = JSON.parse(await readFile(path, "utf8"))
    const now = new Date().toISOString()
    portable.members.push({
      ...maraBinding.participant,
      status: "active",
      addedAt: now,
    })
    portable.identities.push({
      id: `idt_${maraBinding.participant.id.slice(4)}`,
      memberId: maraBinding.participant.id,
      name: maraBinding.participant.name,
      default: true,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    portable.revision += 1
    await writeFile(path, `${JSON.stringify(portable, null, 2)}\n`, "utf8")

    await postThreadMessage(mara, {
      threadId: first.threadId,
      to: "Finn",
      body: "Mara commented first.",
      idempotencyKey: "group-recipient-mara",
      inReplyTo: first.messageId,
      expectsReply: false,
    })
    const beforeAtlas = await waitForThreadReply(finn, {
      threadId: first.threadId,
      after: first.cursor,
      messageId: first.messageId,
      waitSeconds: 0,
    })
    expect(beforeAtlas.timedOut).toBe(true)
    expect(beforeAtlas.messages).toEqual([])

    await postThreadMessage(atlas, {
      threadId: first.threadId,
      to: "Finn",
      body: "Atlas supplied the addressed answer.",
      idempotencyKey: "group-recipient-atlas",
      inReplyTo: first.messageId,
      responseTo: first.messageId,
      expectsReply: false,
    })
    const afterAtlas = await waitForThreadReply(finn, {
      threadId: first.threadId,
      after: first.cursor,
      messageId: first.messageId,
      waitSeconds: 0,
    })
    expect(afterAtlas.timedOut).toBe(false)
    expect(afterAtlas.messages.map((message) => message.body)).toEqual([
      "Atlas supplied the addressed answer.",
    ])
    expect(afterAtlas.cursor).toBe(first.cursor)
    expect(
      (
        await readThreadMessages(finn, first.threadId, {
          after: afterAtlas.cursor,
        })
      ).messages.map((message) => message.body)
    ).toEqual(["Mara commented first.", "Atlas supplied the addressed answer."])
  })

  it("keeps a participant stable when its credential principal rotates", async () => {
    const original = await resolveParticipant(finn)
    const rotated = await resolveParticipant({
      ...finn,
      principal: { ...finn.principal, id: "local-token:finn-b" },
    })
    expect(rotated.participant.id).toBe(original.participant.id)
  })

  it("recovers a participant ID from portable thread snapshots after app data resets", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Keep this thread portable.",
      idempotencyKey: "portable-participant",
    })
    const original = await resolveParticipant(atlas)
    const replacementAppDir = await mkdtemp(
      join(tmpdir(), "worktable-threads-replacement-app-")
    )
    try {
      setAppDirOverride(replacementAppDir)
      const recovered = await resolveParticipant(atlas, {
        name: "Atlas",
        defaultSpaceId: "connected-agents",
      })
      expect(recovered.participant.id).toBe(original.participant.id)
      await postThreadMessage(atlas, {
        threadId: first.threadId,
        body: "I can still reply after reconnecting.",
        idempotencyKey: "portable-participant-reply",
        inReplyTo: first.messageId,
        expectsReply: false,
      })
    } finally {
      setAppDirOverride(appDir)
      await rm(replacementAppDir, { recursive: true, force: true })
    }
    const read = await readThreadMessages(finn, first.threadId)
    expect(read.messages.at(-1)?.body).toBe(
      "I can still reply after reconnecting."
    )
  })

  it("fails closed when portable participant recovery cannot scan every thread", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Keep this identity recoverable.",
      idempotencyKey: "portable-participant-incomplete",
    })
    const original = await resolveParticipant(atlas)
    const path = threadPath("connected-agents", first.threadId)
    const portable = await readFile(path, "utf8")
    const replacementAppDir = await mkdtemp(
      join(tmpdir(), "worktable-threads-incomplete-participant-app-")
    )
    try {
      setAppDirOverride(replacementAppDir)
      await writeFile(path, '{"type":', "utf8")
      await expect(
        resolveParticipant(atlas, {
          name: "Atlas",
          defaultSpaceId: "connected-agents",
        })
      ).rejects.toMatchObject({ code: "THREAD_STORE_INCOMPLETE" })

      await writeFile(path, portable, "utf8")
      const recovered = await resolveParticipant(atlas, {
        name: "Atlas",
        defaultSpaceId: "connected-agents",
      })
      expect(recovered.participant.id).toBe(original.participant.id)
    } finally {
      await writeFile(path, portable, "utf8")
      setAppDirOverride(appDir)
      await rm(replacementAppDir, { recursive: true, force: true })
    }
  })

  it("recovers a portable participant outside its new default Space", async () => {
    const now = new Date().toISOString()
    await writeSpace({
      type: "worktable.space",
      version: 1,
      id: "another-space",
      name: "Another Space",
      createdAt: now,
      updatedAt: now,
      createdBy: "test",
      settings: {},
    })
    const original = await resolveParticipant(finn)
    await postThreadMessage(finn, {
      spaceId: "another-space",
      to: "Atlas",
      body: "This is the only portable snapshot for Finn.",
      idempotencyKey: "cross-space-participant",
    })

    const replacementAppDir = await mkdtemp(
      join(tmpdir(), "worktable-threads-cross-space-app-")
    )
    try {
      setAppDirOverride(replacementAppDir)
      const recovered = await resolveParticipant(finn, {
        defaultSpaceId: "connected-agents",
      })
      expect(recovered.participant.id).toBe(original.participant.id)
      expect(recovered.defaultSpaceId).toBe("connected-agents")
    } finally {
      setAppDirOverride(appDir)
      await rm(replacementAppDir, { recursive: true, force: true })
    }
  })

  it("does not merge distinct authenticated agents that share a display name", async () => {
    const firstWorkosAgent: TokenIdentity = {
      ...finn,
      agent: "workos-subject-one",
      principal: {
        ...finn.principal,
        id: "workos-agent:subject-one",
        displayName: "Connected agent",
      },
    }
    const secondWorkosAgent: TokenIdentity = {
      ...finn,
      agent: "workos-subject-two",
      principal: {
        ...finn.principal,
        id: "workos-agent:subject-two",
        displayName: "Connected agent",
      },
    }
    const firstBinding = await resolveParticipant(firstWorkosAgent, {
      defaultSpaceId: "connected-agents",
    })
    const secondBinding = await resolveParticipant(secondWorkosAgent, {
      defaultSpaceId: "connected-agents",
    })
    expect(secondBinding.participant.id).not.toBe(firstBinding.participant.id)
    const sameNameThread = await postThreadMessage(firstWorkosAgent, {
      to: secondBinding.participant.id,
      body: "Two distinct agents with one display name can still collaborate.",
      idempotencyKey: "same-display-name-thread",
    })
    expect(
      (
        await readThreadMessages(firstWorkosAgent, sameNameThread.threadId)
      ).thread.identities.map((identity) => identity.name)
    ).toEqual(["Connected agent", "Connected agent (2)"])
    const thread = await postThreadMessage(firstWorkosAgent, {
      to: "Atlas",
      body: "Only the first delegated agent owns this thread.",
      idempotencyKey: "same-display-name-owner",
    })
    await postThreadMessage(atlas, {
      threadId: thread.threadId,
      body: "@Connected agent (2), join this thread as the other same-named agent.",
      idempotencyKey: "same-display-name-add-member",
      notifyIdentityIds: [
        defaultConversationIdentityId(secondBinding.participant.id),
      ],
      responseIdentityId: null,
    })
    const expanded = (
      await readThreadMessages(firstWorkosAgent, thread.threadId)
    ).thread
    expect(expanded.identities.map((identity) => identity.name)).toEqual([
      "Connected agent",
      "Atlas",
      "Connected agent (2)",
    ])

    const replacementAppDir = await mkdtemp(
      join(tmpdir(), "worktable-threads-same-name-app-")
    )
    try {
      setAppDirOverride(replacementAppDir)
      const secondRecovered = await resolveParticipant(secondWorkosAgent)
      const firstRecovered = await resolveParticipant(firstWorkosAgent)
      expect(secondRecovered.participant.id).not.toBe(
        firstRecovered.participant.id
      )
      expect(firstRecovered.participant.id).toBe(firstBinding.participant.id)
      expect(
        (await readThreadMessages(secondWorkosAgent, thread.threadId)).thread.id
      ).toBe(thread.threadId)
      expect(
        (await readThreadMessages(firstWorkosAgent, thread.threadId)).thread.id
      ).toBe(thread.threadId)
    } finally {
      setAppDirOverride(appDir)
      await rm(replacementAppDir, { recursive: true, force: true })
    }
  })

  it("rebuilds missing machine-local delivery state from portable messages", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Recover this delivery after app data is lost.",
      idempotencyKey: "portable-delivery",
    })
    const replacementAppDir = await mkdtemp(
      join(tmpdir(), "worktable-threads-replacement-delivery-app-")
    )
    try {
      setAppDirOverride(replacementAppDir)
      const recovered = await claimNextThreadDelivery(atlas, 0)
      expect(recovered).toMatchObject({
        messageId: first.messageId,
        threadId: first.threadId,
        attempt: 1,
      })
    } finally {
      setAppDirOverride(appDir)
      await rm(replacementAppDir, { recursive: true, force: true })
    }
  })

  it("does not redeliver a portably replied message after app data is lost", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Remember that this was answered.",
      idempotencyKey: "portable-replied-delivery",
    })
    await postThreadMessage(atlas, {
      threadId: first.threadId,
      body: "This durable reply is the recovery proof.",
      idempotencyKey: "portable-replied-response",
      inReplyTo: first.messageId,
      responseTo: first.messageId,
      expectsReply: false,
    })
    const replacementAppDir = await mkdtemp(
      join(tmpdir(), "worktable-threads-replied-delivery-app-")
    )
    try {
      setAppDirOverride(replacementAppDir)
      expect(await claimNextThreadDelivery(atlas, 0)).toBeNull()
      expect(
        await getThreadActivity(
          "connected-agents",
          first.threadId,
          first.messageId
        )
      ).toMatchObject({
        state: "replied",
        attempts: 0,
      })
    } finally {
      setAppDirOverride(appDir)
      await rm(replacementAppDir, { recursive: true, force: true })
    }
  })

  it("rebuilds replied human delivery activity before serving reads", async () => {
    const ownerBinding = await resolveParticipant(owner)
    const first = await postThreadMessage(atlas, {
      to: ownerBinding.participant.id,
      body: "Please answer this from the Worktable UI.",
      idempotencyKey: "human-delivery",
    })
    await postThreadMessage(owner, {
      threadId: first.threadId,
      body: "Answered from the UI.",
      idempotencyKey: "human-delivery-reply",
      inReplyTo: first.messageId,
      responseTo: first.messageId,
      expectsReply: false,
    })

    const replacementAppDir = await mkdtemp(
      join(tmpdir(), "worktable-threads-human-delivery-app-")
    )
    try {
      setAppDirOverride(replacementAppDir)
      const read = await readThreadMessages(owner, first.threadId)
      expect(read.activities).toEqual([
        expect.objectContaining({
          messageId: first.messageId,
          participantId: ownerBinding.participant.id,
          state: "replied",
        }),
      ])
      expect((await listThreadSummaries(owner, "connected-agents"))[0]).toEqual(
        expect.objectContaining({
          activity: expect.objectContaining({
            messageId: first.messageId,
            state: "replied",
          }),
        })
      )
    } finally {
      setAppDirOverride(appDir)
      await rm(replacementAppDir, { recursive: true, force: true })
    }
  })

  it("recovers the human owner from portable snapshots without pairing options", async () => {
    const first = await postThreadMessage(owner, {
      spaceId: "connected-agents",
      to: "Atlas",
      body: "Keep the human side portable too.",
      idempotencyKey: "portable-owner",
    })
    const original = await resolveParticipant(owner)
    const replacementAppDir = await mkdtemp(
      join(tmpdir(), "worktable-threads-replacement-owner-app-")
    )
    try {
      setAppDirOverride(replacementAppDir)
      const recovered = await resolveParticipant(owner)
      expect(recovered.participant.id).toBe(original.participant.id)
      await postThreadMessage(owner, {
        threadId: first.threadId,
        body: "The owner can still continue this thread.",
        idempotencyKey: "portable-owner-follow-up",
      })
    } finally {
      setAppDirOverride(appDir)
      await rm(replacementAppDir, { recursive: true, force: true })
    }
  })

  it("rejects thread creation for a Space that does not exist", async () => {
    await expect(
      postThreadMessage(finn, {
        spaceId: "missing-space",
        to: "Atlas",
        body: "Do not orphan this thread.",
        idempotencyKey: "missing-space",
      })
    ).rejects.toMatchObject({ code: "THREAD_SPACE_MISMATCH" })
    expect(
      existsSync(join(workspaceDir, "spaces", "missing-space"))
    ).toBeFalse()
  })

  it("rejects thread listing for a Space that does not exist", async () => {
    await expect(
      listThreadSummaries(finn, "missing-space")
    ).rejects.toMatchObject({ code: "THREAD_SPACE_MISMATCH" })
  })

  it("rejects a cross-thread reply target on a new thread", async () => {
    const existing = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Existing thread.",
      idempotencyKey: "existing-reply-target",
    })
    await expect(
      postThreadMessage(finn, {
        to: "Atlas",
        body: "Do not create a dangling cross-thread reply.",
        idempotencyKey: "cross-thread-reply",
        inReplyTo: existing.messageId,
      })
    ).rejects.toMatchObject({ code: "THREAD_NOT_FOUND" })
    expect(await listThreadSummaries(finn, "connected-agents")).toHaveLength(1)
  })

  it("rejects unknown or invisible mentions when creating a thread", async () => {
    await expect(
      postThreadMessage(finn, {
        to: "Atlas",
        body: "Do not create a thread with an invented target.",
        idempotencyKey: "unknown-creation-target",
        notifyIdentityIds: ["idt_unknownidentity"],
        responseIdentityId: null,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })

    const atlasBinding = await resolveParticipant(atlas)
    await expect(
      postThreadMessage(finn, {
        to: "Atlas",
        body: "This does not visibly mention the recipient.",
        idempotencyKey: "invisible-creation-mention",
        notifyIdentityIds: [
          defaultConversationIdentityId(atlasBinding.participant.id),
        ],
        responseIdentityId: null,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(await listThreadSummaries(finn, "connected-agents")).toHaveLength(0)
  })

  it("emits participant changes through the workspace event seam", async () => {
    const changes: Array<string | undefined> = []
    const off = onWorkspaceChange((event) => {
      if (event.type === "participants") changes.push(event.spaceId)
    })
    try {
      await resolveParticipant(mara, {
        name: "Mara",
        defaultSpaceId: "connected-agents",
      })
      await resolveParticipant(mara, { name: "Mara Renamed" })
      await drainWorkspaceChanges()
    } finally {
      off()
    }
    expect(changes).toEqual([
      undefined,
      "connected-agents",
      undefined,
      "connected-agents",
    ])
  })

  it("lets workspace participants discover threads and join by posting", async () => {
    const maraBinding = await resolveParticipant(mara, {
      name: "Mara",
      defaultSpaceId: "connected-agents",
    })
    const outsiderBinding = await resolveParticipant(
      {
        ...atlas,
        agent: "codex@workspace-collaborator",
        principal: {
          ...atlas.principal,
          id: "local-token:workspace-collaborator",
          displayName: "Outsider",
        },
      },
      { name: "Outsider" }
    )
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Start with Finn and Atlas.",
      idempotencyKey: "workspace-visible-thread",
    })

    expect(await listThreadSummaries(mara, "connected-agents")).toHaveLength(1)
    const beforePost = await readThreadMessages(mara, first.threadId)
    expect(
      beforePost.thread.members.some(
        (participant) => participant.id === maraBinding.participant.id
      )
    ).toBe(false)

    await postThreadMessage(mara, {
      threadId: first.threadId,
      body: "Join the conversation without a manual membership step.",
      idempotencyKey: "workspace-auto-roster",
      notifyIdentityIds: [],
      responseIdentityId: null,
    })
    await assignResponseRequest(finn, {
      location: first.location,
      threadId: first.threadId,
      messageId: first.messageId,
      identityId: defaultConversationIdentityId(outsiderBinding.participant.id),
    })
    const joined = await readThreadMessages(mara, first.threadId)
    expect(joined.thread.members.map((member) => member.id)).toEqual(
      expect.arrayContaining([
        maraBinding.participant.id,
        outsiderBinding.participant.id,
      ])
    )
    expect(joined.viewerIdentityId).toBe(
      defaultConversationIdentityId(maraBinding.participant.id)
    )
    expect(joined.thread.messages[0]?.responseRequest?.identityId).toBe(
      defaultConversationIdentityId(outsiderBinding.participant.id)
    )
  })

  it("retries when backoff expires instead of waiting for another inbox event", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Retry this delivery.",
      idempotencyKey: "retry-backoff",
    })
    const initial = await claimNextThreadDelivery(atlas, 0)
    await progressDelivery(atlas, {
      messageId: initial!.messageId,
      leaseId: initial!.leaseId,
      phase: "receiving",
      receivedCharacters: 42,
    })
    await drainWorkspaceChanges()
    jest.useFakeTimers({ now: Date.now() })
    try {
      await failDelivery(atlas, {
        messageId: initial!.messageId,
        leaseId: initial!.leaseId,
        retryable: true,
        code: "TEMPORARY",
        message: "Try again.",
      })

      await drainWorkspaceChanges()
      const scheduled = Promise.withResolvers<number>()
      const schedule = globalThis.setTimeout
      const timer = jest.spyOn(globalThis, "setTimeout").mockImplementation(((
        ...args: Parameters<typeof setTimeout>
      ) => {
        const handle = schedule(...args)
        scheduled.resolve(args[1] ?? 0)
        return handle
      }) as typeof setTimeout)
      try {
        const pending = claimNextThreadDelivery(atlas, 3)
        const delay = await scheduled.promise
        // The inbox must wake at retry eligibility, before the three-second poll ends.
        expect(delay).toBeGreaterThan(0)
        expect(delay).toBeLessThanOrEqual(1_000)
        timer.mockRestore()
        jest.advanceTimersByTime(delay)
        const retried = await pending
        expect(retried).toMatchObject({
          messageId: first.messageId,
          attempt: 2,
        })
        expect(
          await getThreadActivity(
            "connected-agents",
            first.threadId,
            first.messageId,
          ),
        ).toMatchObject({
          state: "queued",
          receivedCharacters: undefined,
          error: undefined,
        })
        const secondProgress = await progressDelivery(atlas, {
          messageId: retried!.messageId,
          leaseId: retried!.leaseId,
          phase: "receiving",
          receivedCharacters: 5,
        })
        expect(secondProgress.receivedCharacters).toBe(5)
      } finally {
        timer.mockRestore()
      }
    } finally {
      jest.useRealTimers()
    }
  })

  it("clears a failed delivery error when a late durable reply arrives", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Reply even if the adapter reports a terminal failure.",
      idempotencyKey: "late-reply-after-failure",
    })
    const claim = await claimNextThreadDelivery(atlas, 0)
    await failDelivery(atlas, {
      messageId: claim!.messageId,
      leaseId: claim!.leaseId,
      retryable: false,
      code: "TEMPORARY_AGENT_FAILURE",
      message: "The final reply crossed the failure report.",
    })
    await postThreadMessage(atlas, {
      threadId: first.threadId,
      body: "The reply still arrived durably.",
      idempotencyKey: "late-reply-after-failure-response",
      inReplyTo: first.messageId,
      responseTo: first.messageId,
      expectsReply: false,
    })

    expect(
      await getThreadActivity(
        "connected-agents",
        first.threadId,
        first.messageId
      )
    ).toMatchObject({
      state: "replied",
      error: undefined,
    })
  })

  it("isolates delivery claims and propagates a terminal failure", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Only Atlas can claim this.",
      idempotencyKey: "isolated-claim",
    })
    expect(await claimNextThreadDelivery(finn, 0)).toBeNull()

    const claim = await claimNextThreadDelivery(atlas, 0)
    expect(claim?.messageId).toBe(first.messageId)
    await expect(
      acceptDelivery(finn, claim!.messageId, claim!.leaseId)
    ).rejects.toMatchObject({ code: "LEASE_LOST" })

    const failed = await failDelivery(atlas, {
      messageId: claim!.messageId,
      leaseId: claim!.leaseId,
      retryable: false,
      code: "AGENT_UNAVAILABLE",
      message: "Atlas is unavailable.",
    })
    expect(failed).toMatchObject({
      state: "failed",
      error: {
        code: "AGENT_UNAVAILABLE",
        retryable: false,
      },
    })

    const waited = await waitForThreadReply(finn, {
      threadId: first.threadId,
      after: first.cursor,
      messageId: first.messageId,
      activityRevision: first.activity!.revision,
      waitSeconds: 1,
    })
    expect(waited.timedOut).toBe(false)
    expect(waited.activity?.state).toBe("failed")
  })

  it("keeps same-thread deliveries ordered while another thread proceeds", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "First turn in the shared session.",
      idempotencyKey: "ordered-thread-first",
    })
    const followUp = await postThreadMessage(finn, {
      threadId: first.threadId,
      body: "Second turn must wait for the first.",
      idempotencyKey: "ordered-thread-second",
    })
    const firstClaim = await claimNextThreadDelivery(atlas, 0)
    expect(firstClaim?.messageId).toBe(first.messageId)
    const atlasParticipant = (await resolveParticipant(atlas)).participant
    expect(
      await nextThreadDeliveryEligibleAt(atlasParticipant.id)
    ).toBeGreaterThan(Date.now() + 50_000)

    const independent = await postThreadMessage(finn, {
      to: "Atlas",
      body: "This other thread can run concurrently.",
      idempotencyKey: "ordered-thread-independent",
    })
    const concurrentClaim = await claimNextThreadDelivery(atlas, 0)
    expect(concurrentClaim?.messageId).toBe(independent.messageId)
    expect(concurrentClaim?.threadId).not.toBe(first.threadId)

    await postThreadMessage(atlas, {
      threadId: first.threadId,
      body: "First turn complete.",
      idempotencyKey: "ordered-thread-first-reply",
      inReplyTo: first.messageId,
      responseTo: first.messageId,
      expectsReply: false,
    })
    const followUpClaim = await claimNextThreadDelivery(atlas, 0)
    expect(followUpClaim?.messageId).toBe(followUp.messageId)
  })

  it("serializes delivery claims across Worktable processes", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Only one process may claim this.",
      idempotencyKey: "cross-process-claim",
    })
    const atlasParticipant = (await resolveParticipant(atlas)).participant
    const deliveryDir = join(appDir, "thread-deliveries")
    const deliveryFiles = (await readdir(deliveryDir)).filter((name) =>
      name.endsWith(".json")
    )
    expect(deliveryFiles).toHaveLength(1)
    const lockDir = join(deliveryDir, `${deliveryFiles[0]}.lock`)
    mkdirSync(lockDir)

    const moduleUrl = new URL("./thread-delivery-store.ts", import.meta.url)
      .href
    const source = `
      import { writeFileSync } from "node:fs";
      import { claimThreadDelivery } from ${JSON.stringify(moduleUrl)};
      writeFileSync(process.env.READY_PATH, "ready");
      console.log(JSON.stringify(await claimThreadDelivery(${JSON.stringify(atlasParticipant.id)})));
    `
    const spawnClaim = (name: string) => {
      const readyPath = join(appDir, `${name}.ready`)
      return {
        readyPath,
        child: Bun.spawn({
          cmd: [process.execPath, "-e", source],
          cwd: process.cwd(),
          env: {
            ...process.env,
            WORKTABLE_APP_DIR: appDir,
            WORKTABLE_WORKSPACE: workspaceDir,
            READY_PATH: readyPath,
          },
          stdout: "pipe",
          stderr: "pipe",
        }),
      }
    }
    const spawnedClaimers = [spawnClaim("claim-a"), spawnClaim("claim-b")]
    const claimers = spawnedClaimers.map(({ child }) => child)
    let exited = 0
    for (const claimer of claimers) {
      void claimer.exited.then(() => {
        exited += 1
      })
    }

    try {
      await waitForFiles(spawnedClaimers.map(({ readyPath }) => readyPath))
      expect(exited).toBe(0)
    } finally {
      if (existsSync(lockDir)) rmdirSync(lockDir)
    }

    const exitCodes = await Promise.all(
      claimers.map((claimer) => claimer.exited)
    )
    const outputs = await Promise.all(
      claimers.map((claimer) => new Response(claimer.stdout).text())
    )
    const errors = await Promise.all(
      claimers.map((claimer) => new Response(claimer.stderr).text())
    )
    expect(exitCodes).toEqual([0, 0])
    expect(errors).toEqual(["", ""])
    const claims = outputs.map(
      (output) => JSON.parse(output.trim()) as { messageId: string } | null
    )
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect(claims.find(Boolean)?.messageId).toBe(first.messageId)
  })

  it("stops reclaiming an expired lease after three attempts", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Do not retry this forever after adapter crashes.",
      idempotencyKey: "expired-lease-attempt-limit",
    })

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = await claimNextThreadDelivery(atlas, 0)
      expect(claim).toMatchObject({
        messageId: first.messageId,
        attempt,
      })
      await expireDeliveryLease(first.messageId)
    }

    expect(await claimNextThreadDelivery(atlas, 0)).toBeNull()
    expect(
      await getThreadActivity(
        "connected-agents",
        first.threadId,
        first.messageId
      )
    ).toMatchObject({
      state: "failed",
      attempts: 3,
      error: {
        code: "DELIVERY_FAILED",
        retryable: false,
      },
    })
  })

  it("returns the persisted terminal failure on an idempotent post retry", async () => {
    const input = {
      to: "Atlas",
      body: "This idempotent delivery will fail.",
      idempotencyKey: "terminal-idempotent-retry",
      waitSeconds: 1,
    }
    const first = await postThreadMessage(finn, {
      ...input,
      waitSeconds: 0,
    })
    const claim = await claimNextThreadDelivery(atlas, 0)
    await failDelivery(atlas, {
      messageId: claim!.messageId,
      leaseId: claim!.leaseId,
      retryable: false,
      code: "AGENT_UNAVAILABLE",
      message: "Atlas is unavailable.",
    })

    const retry = await postThreadMessage(finn, input)
    expect(retry).toMatchObject({
      threadId: first.threadId,
      messageId: first.messageId,
      timedOut: false,
      activity: {
        state: "failed",
        error: { code: "AGENT_UNAVAILABLE" },
      },
    })
  })

  it("does not let a same-author follow-up hide a failed delivery", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "This delivery will fail.",
      idempotencyKey: "failed-first",
    })
    const firstClaim = await claimNextThreadDelivery(atlas, 0)
    await failDelivery(atlas, {
      messageId: firstClaim!.messageId,
      leaseId: firstClaim!.leaseId,
      retryable: false,
      code: "WORKSPACE_VANISHED",
      message: "The agent workspace disappeared.",
    })

    const followUp = await postThreadMessage(finn, {
      threadId: first.threadId,
      body: "Try this follow-up instead.",
      idempotencyKey: "failed-follow-up",
      inReplyTo: first.messageId,
    })

    const afterFollowUp = await readThreadMessages(finn, first.threadId)
    expect(afterFollowUp.activities).toEqual([
      expect.objectContaining({
        messageId: first.messageId,
        state: "failed",
        error: expect.objectContaining({ code: "WORKSPACE_VANISHED" }),
      }),
      expect.objectContaining({
        messageId: followUp.messageId,
        state: "queued",
      }),
    ])

    const followUpClaim = await claimNextThreadDelivery(atlas, 0)
    expect(followUpClaim?.messageId).toBe(followUp.messageId)
    await postThreadMessage(atlas, {
      threadId: first.threadId,
      body: "The follow-up worked.",
      idempotencyKey: "failed-follow-up-reply",
      inReplyTo: followUp.messageId,
      responseTo: followUp.messageId,
      expectsReply: false,
    })

    const final = await readThreadMessages(finn, first.threadId)
    expect(final.activities).toEqual([
      expect.objectContaining({
        messageId: first.messageId,
        state: "failed",
        error: expect.objectContaining({ code: "WORKSPACE_VANISHED" }),
      }),
      expect.objectContaining({
        messageId: followUp.messageId,
        state: "replied",
      }),
    ])
  })

  it("broadcasts activity for the changed message rather than the newest delivery", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "This first delivery fails.",
      idempotencyKey: "ws-first-delivery",
    })
    const claim = await claimNextThreadDelivery(atlas, 0)
    await failDelivery(atlas, {
      messageId: claim!.messageId,
      leaseId: claim!.leaseId,
      retryable: false,
      code: "FIRST_FAILED",
      message: "The first delivery failed.",
    })
    await postThreadMessage(finn, {
      threadId: first.threadId,
      body: "This newer delivery stays queued.",
      idempotencyKey: "ws-newer-delivery",
    })

    const messages: Array<Record<string, unknown>> = []
    const manager = new WsManager()
    const atlasParticipant = (await resolveParticipant(atlas)).participant
    manager.subscribe(
      {
        data: {
          spaceId: "connected-agents",
          canReadThreads: true,
        },
        send(value) {
          messages.push(JSON.parse(value) as Record<string, unknown>)
        },
        close() {},
      },
      "connected-agents"
    )
    await manager.handleChange({
      type: "threadActivity",
      spaceId: "connected-agents",
      threadId: first.threadId,
      messageId: first.messageId,
      participantId: atlasParticipant.id,
    })

    expect(messages.at(-1)).toMatchObject({
      type: "thread_activity",
      data: {
        messageId: first.messageId,
        state: "failed",
      },
    })
  })

  it("does not retire delivery state from an incomplete portable scan", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Keep this delivery while the editor is mid-write.",
      idempotencyKey: "incomplete-scan-delivery",
    })
    const path = threadPath("connected-agents", first.threadId)
    const portable = await readFile(path, "utf8")
    await writeFile(path, "{", "utf8")

    expect(await listThreadSummaries(atlas, "connected-agents")).toEqual([])
    expect(
      await getThreadActivity(
        "connected-agents",
        first.threadId,
        first.messageId
      )
    ).toMatchObject({
      state: "queued",
      error: undefined,
    })

    await writeFile(path, portable, "utf8")
    const recovered = await claimNextThreadDelivery(atlas, 0)
    expect(recovered?.messageId).toBe(first.messageId)
  })

  it("retires a queued delivery when its portable thread was deleted", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "This thread will be deleted.",
      idempotencyKey: "deleted-thread-delivery",
    })
    await rm(threadPath("connected-agents", first.threadId))

    expect(await claimNextThreadDelivery(atlas, 0)).toBeNull()
    expect(
      await getThreadActivity(
        "connected-agents",
        first.threadId,
        first.messageId
      )
    ).toMatchObject({
      state: "failed",
      error: {
        code: "DELIVERY_RETIRED",
        retryable: false,
      },
    })

    const removalEvents: string[] = []
    const off = onWorkspaceChange((event) => {
      if (
        event.type === "threadActivity" &&
        event.messageId === first.messageId
      ) {
        removalEvents.push(event.messageId)
      }
    })
    try {
      expect(await claimNextThreadDelivery(atlas, 0)).toBeNull()
      await drainWorkspaceChanges()
      expect(
        await getThreadActivity(
          "connected-agents",
          first.threadId,
          first.messageId
        )
      ).toBeUndefined()
      expect(removalEvents).toEqual([first.messageId])
    } finally {
      off()
    }
  })

  it("purges replied delivery state when its portable thread was deleted", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "This completed thread will be deleted.",
      idempotencyKey: "deleted-replied-delivery",
    })
    await postThreadMessage(atlas, {
      threadId: first.threadId,
      body: "Completed before deletion.",
      idempotencyKey: "deleted-replied-response",
      inReplyTo: first.messageId,
      responseTo: first.messageId,
      expectsReply: false,
    })
    expect(
      await getThreadActivity(
        "connected-agents",
        first.threadId,
        first.messageId
      )
    ).toMatchObject({ state: "replied" })

    await rm(threadPath("connected-agents", first.threadId))
    expect(await claimNextThreadDelivery(atlas, 0)).toBeNull()
    expect(
      await getThreadActivity(
        "connected-agents",
        first.threadId,
        first.messageId
      )
    ).toBeUndefined()
  })

  it("retires delivery when portable edits remove the reply request", async () => {
    const first = await postThreadMessage(finn, {
      to: "Atlas",
      body: "This originally expected a reply.",
      idempotencyKey: "edited-delivery",
    })
    const path = threadPath("connected-agents", first.threadId)
    const portable = JSON.parse(await readFile(path, "utf8")) as {
      revision: number
      messages: Array<{
        responseRequest?: { identityId: string; status: string }
      }>
    }
    const originalRequest = portable.messages[0]!.responseRequest
    portable.messages[0]!.responseRequest = undefined
    portable.revision += 1
    await writeFile(path, `${JSON.stringify(portable, null, 2)}\n`, "utf8")

    expect(await claimNextThreadDelivery(atlas, 0)).toBeNull()
    expect(
      await getThreadActivity(
        "connected-agents",
        first.threadId,
        first.messageId
      )
    ).toMatchObject({
      state: "failed",
      error: {
        code: "DELIVERY_RETIRED",
        retryable: false,
      },
    })

    portable.messages[0]!.responseRequest = originalRequest
    portable.revision += 1
    await writeFile(path, `${JSON.stringify(portable, null, 2)}\n`, "utf8")
    const recovered = await claimNextThreadDelivery(atlas, 0)
    expect(recovered?.messageId).toBe(first.messageId)
    expect(
      await getThreadActivity(
        "connected-agents",
        first.threadId,
        first.messageId
      )
    ).toMatchObject({
      state: "queued",
      error: undefined,
    })
  })

  it("bounds long-thread reads and fetches a reply target outside the window", async () => {
    const created = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Message 1",
      idempotencyKey: "long-1",
      waitSeconds: 0,
    })
    const path = threadPath(created.location, created.threadId)
    const portable = JSON.parse(await readFile(path, "utf8"))
    const first = portable.messages[0]
    const createdAt = first.createdAt
    const responseMessageId = "msg_longthread01000"
    const atlasIdentity = portable.identities.find(
      (identity: { name: string }) => identity.name === "Atlas"
    )!
    portable.messages = Array.from({ length: 1_000 }, (_, index) => ({
      ...first,
      id: `msg_longthread${String(index + 1).padStart(5, "0")}`,
      sequence: index + 1,
      body: `Message ${index + 1}`,
      notifyIdentityIds: [],
      responseRequest:
        index === 0
          ? {
              ...first.responseRequest,
              status: "responded",
              respondedBy: responseMessageId,
              resolvedAt: createdAt,
            }
          : undefined,
      idempotencyKey: `long-${index + 1}`,
      ...(index === 999
        ? {
            authorIdentityId: atlasIdentity.id,
            authorMemberId: atlasIdentity.memberId,
          }
        : {}),
      ...(index === 999
        ? { inReplyTo: "msg_longthread00001" }
        : { inReplyTo: undefined }),
      createdAt,
    }))
    portable.revision = 1_000
    await writeFile(path, `${JSON.stringify(portable, null, 2)}\n`, "utf8")

    const recent = await readThreadMessages(finn, created.threadId)
    expect(recent.messages).toHaveLength(100)
    expect(recent.messages[0]?.sequence).toBe(901)
    expect(recent.oldestCursor).toBe(901)
    expect(recent.hasOlder).toBe(true)
    expect(recent.hasNewer).toBe(false)
    expect(recent.thread.messages).toHaveLength(100)

    const older = await readThreadMessages(finn, created.threadId, {
      before: recent.oldestCursor,
    })
    expect(older.messages[0]?.sequence).toBe(801)
    expect(older.messages.at(-1)?.sequence).toBe(900)
    expect(older.hasOlder).toBe(true)
    expect(older.hasNewer).toBe(true)

    const beyondRestoredEnd = await readThreadMessages(finn, created.threadId, {
      after: 2_000,
    })
    expect(beyondRestoredEnd.messages).toEqual([])
    expect(beyondRestoredEnd.cursor).toBe(1_000)
    expect(beyondRestoredEnd.hasNewer).toBe(false)

    const beforeStart = await readThreadMessages(finn, created.threadId, {
      before: 1,
    })
    expect(beforeStart.messages).toEqual([])
    expect(beforeStart.hasOlder).toBe(false)
    expect(beforeStart.hasNewer).toBe(true)

    const target = await readThreadMessage(finn, {
      threadId: created.threadId,
      messageId: "msg_longthread00001",
    })
    expect(target.message.body).toBe("Message 1")

    const waited = await waitForThreadReply(finn, {
      location: created.location,
      threadId: created.threadId,
      after: 0,
      messageId: "msg_longthread00001",
      waitSeconds: 0,
    })
    expect(waited.messages.map((message) => message.id)).toEqual([
      responseMessageId,
    ])
  })

  it("supports a one-member self-handoff and later workspace participation", async () => {
    const finnParticipant = await resolveParticipant(finn)
    const available = await listThreadParticipants(finn)
    expect(
      available.some(
        (participant) => participant.id === finnParticipant.participant.id
      )
    ).toBe(false)

    const selfHandoff = await postThreadMessage(finn, {
      to: finnParticipant.participant.id,
      body: "Talk to myself",
      idempotencyKey: "self-thread",
    })
    const selfThread = await readThreadMessages(finn, selfHandoff.threadId, {
      location: selfHandoff.location,
    })
    expect(selfThread.thread.members).toHaveLength(1)
    expect(selfThread.thread.messages[0]).toMatchObject({
      authorMemberId: finnParticipant.participant.id,
      notifyIdentityIds: [],
      responseRequest: {
        identityId: selfThread.viewerIdentityId,
        status: "open",
      },
    })

    const thread = await postThreadMessage(finn, {
      to: "Atlas",
      body: "Private two-person thread",
      idempotencyKey: "two-person",
    })
    await postThreadMessage(finn, {
      threadId: thread.threadId,
      to: finnParticipant.participant.id,
      body: "Follow up to myself",
      idempotencyKey: "self-follow-up",
    })
    const maraBinding = await resolveParticipant(
      {
        ...atlas,
        agent: "codex@elsewhere",
        principal: {
          ...atlas.principal,
          id: "local-token:outsider",
          displayName: "Mara",
        },
      },
      { name: "Mara" }
    )
    await postThreadMessage(finn, {
      threadId: thread.threadId,
      to: "Mara",
      body: "Invite another workspace participant",
      idempotencyKey: "workspace-participant",
    })
    expect(
      (await readThreadMessages(finn, thread.threadId)).thread.members.some(
        (member) => member.id === maraBinding.participant.id
      )
    ).toBe(true)
  })
})
