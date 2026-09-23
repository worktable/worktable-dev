import { afterEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { getEventListeners } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe"
import {
  createOpenClawDeliveryDedupe,
  portableWorktableDocLinks,
  waitForReconnectDelay,
  WorktableConnector,
} from "./connector.js"
import type { DeliveryDedupe } from "./connector.js"
import { FakeWorktableClient } from "./fake-worktable-client.js"
import {
  createMemoryReplyOutbox,
  createOpenClawReplyOutbox,
} from "./reply-outbox.js"
import type {
  AgentDispatchInput,
  AgentDispatcher,
  ClaimedWorktableDelivery,
  WorktableClient,
} from "./types.js"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

function delivery(
  messageId: string,
  threadId: string,
  body = "Please research this.",
  spaceId = "connected-agents"
): ClaimedWorktableDelivery {
  return {
    messageId,
    threadId,
    location: { kind: "space", spaceId },
    leaseId: `lease_${messageId}`,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    identityId: "idt_atlasdefault",
    thread: {
      id: threadId,
      version: 3,
      location: { kind: "space", spaceId },
      title: body,
      members: [
        { id: "ptc_finn", kind: "agent", name: "Finn" },
        { id: "ptc_atlas", kind: "agent", name: "Atlas" },
      ],
      identities: [
        {
          id: "idt_finndefault",
          memberId: "ptc_finn",
          name: "Finn",
          default: true,
          status: "active",
        },
        {
          id: "idt_atlasdefault",
          memberId: "ptc_atlas",
          name: "Atlas",
          default: true,
          status: "active",
        },
      ],
    },
    message: {
      id: messageId,
      sequence: 1,
      authorIdentityId: "idt_finndefault",
      authorMemberId: "ptc_finn",
      notifyIdentityIds: [],
      responseRequest: { identityId: "idt_atlasdefault", status: "open" },
      body,
      idempotencyKey: `input:${messageId}`,
      createdAt: new Date().toISOString(),
    },
  }
}

class RecordingDispatcher implements AgentDispatcher {
  readonly calls: AgentDispatchInput[] = []
  readonly turnsByThread = new Map<string, number>()

  async dispatch(
    input: AgentDispatchInput,
    callbacks: Parameters<AgentDispatcher["dispatch"]>[1]
  ): Promise<string> {
    this.calls.push(input)
    const conversationId =
      input.conversationId ??
      (input.spaceId ? `${input.spaceId}/${input.threadId}` : input.threadId)
    const turn = (this.turnsByThread.get(conversationId) ?? 0) + 1
    this.turnsByThread.set(conversationId, turn)
    await callbacks.onWorking()
    await callbacks.onReceiving(12)
    return `Reply ${turn} in ${input.threadId}`
  }
}

function memoryDedupe() {
  return createClaimableDedupe({
    ttlMs: 60_000,
    memoryMaxSize: 100,
  })
}

describe("OpenClaw Worktable connector", () => {
  it("removes reconnect abort listeners after timeout and cancellation", async () => {
    const completed = new AbortController()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await waitForReconnectDelay(1, completed.signal)
      expect(getEventListeners(completed.signal, "abort")).toHaveLength(0)
    }

    const cancelled = new AbortController()
    const waiting = waitForReconnectDelay(60_000, cancelled.signal)
    expect(getEventListeners(cancelled.signal, "abort")).toHaveLength(1)
    cancelled.abort()
    await waiting
    expect(getEventListeners(cancelled.signal, "abort")).toHaveLength(0)
  })

  it("stores same-Space Worktable Doc links portably", () => {
    expect(
      portableWorktableDocLinks(
        "[Vision](http://127.0.0.1:7432/spaces/connected-agents/docs/plans/vision#north-star), http://127.0.0.1:7432/spaces/connected-agents/docs/plans/roadmap, and https://example.com",
        "connected-agents",
        "http://127.0.0.1:7432"
      )
    ).toBe(
      "[Vision](/plans/vision#north-star), [/plans/roadmap](/plans/roadmap), and https://example.com"
    )
    expect(
      portableWorktableDocLinks(
        "https://example.com/spaces/connected-agents/docs/reference",
        "connected-agents",
        "http://127.0.0.1:7432"
      )
    ).toBe("https://example.com/spaces/connected-agents/docs/reference")
  })

  it("stores explicit Space Doc links portably in Worktable threads", () => {
    expect(
      portableWorktableDocLinks(
        "[Vision](http://127.0.0.1:7432/spaces/research/docs/plans/vision?mode=review#north-star) and http://127.0.0.1:7432/spaces/research/docs/plans/roadmap",
        "",
        "http://127.0.0.1:7432"
      )
    ).toBe(
      "[Vision](/spaces/research/docs/plans/vision?mode=review#north-star) and [/spaces/research/docs/plans/roadmap](/spaces/research/docs/plans/roadmap)"
    )
  })

  it("does not rewrite Worktable links inside Markdown code", () => {
    const origin = "http://127.0.0.1:7432"
    const docUrl =
      "http://127.0.0.1:7432/spaces/connected-agents/docs/plans/roadmap"
    const body = [
      `Use ${docUrl} in prose.`,
      "",
      `Inline: \`${docUrl}\`.`,
      `Long span: \`\`curl "${docUrl}"\`\`.`,
      "",
      "```sh",
      `curl "${docUrl}"`,
      "```",
      "",
      "~~~txt",
      docUrl,
      "~~~~",
      "",
      `    curl "${docUrl}"`,
    ].join("\n")

    expect(portableWorktableDocLinks(body, "connected-agents", origin)).toBe(
      [
        "Use [/plans/roadmap](/plans/roadmap) in prose.",
        "",
        `Inline: \`${docUrl}\`.`,
        `Long span: \`\`curl "${docUrl}"\`\`.`,
        "",
        "```sh",
        `curl "${docUrl}"`,
        "```",
        "",
        "~~~txt",
        docUrl,
        "~~~~",
        "",
        `    curl "${docUrl}"`,
      ].join("\n")
    )
  })

  it("reuses a thread conversation, isolates another, and posts durable replies", async () => {
    const client = new FakeWorktableClient()
    const dispatcher = new RecordingDispatcher()
    const alternateIdentity = delivery(
      "msg_4",
      "thr_alpha",
      "Use a different role."
    )
    alternateIdentity.thread.identities.push({
      id: "idt_atlasresearch",
      memberId: "ptc_atlas",
      name: "Research",
      default: false,
      status: "active",
    })
    alternateIdentity.identityId = "idt_atlasresearch"
    alternateIdentity.message.responseRequest = {
      identityId: "idt_atlasresearch",
      status: "open",
    }
    client.deliveries.push(
      delivery("msg_1", "thr_alpha"),
      delivery("msg_2", "thr_alpha", "Follow up."),
      delivery("msg_3", "thr_beta"),
      alternateIdentity
    )
    const connector = new WorktableConnector({
      client,
      dispatcher,
      dedupe: memoryDedupe(),
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
    })

    expect(await connector.processOne()).toBe(true)
    expect(await connector.processOne()).toBe(true)
    expect(await connector.processOne()).toBe(true)
    expect(await connector.processOne()).toBe(true)

    expect(
      dispatcher.turnsByThread.get("space:connected-agents/thr_alpha")
    ).toBe(2)
    expect(
      dispatcher.turnsByThread.get("space:connected-agents/thr_beta")
    ).toBe(1)
    expect(
      dispatcher.turnsByThread.get(
        "space:connected-agents/thr_alpha/idt_atlasresearch"
      )
    ).toBe(1)
    expect(client.replies.map((reply) => reply.body)).toEqual([
      "Reply 1 in thr_alpha",
      "Reply 2 in thr_alpha",
      "Reply 1 in thr_beta",
      "Reply 1 in thr_alpha",
    ])
    expect(
      client.replies
        .slice(0, 3)
        .every(
          (reply) =>
            reply.authorIdentityId === "idt_atlasdefault" &&
            reply.responseTo === reply.inReplyTo
        )
    ).toBe(true)
    expect(
      client.replies.every(
        (reply) =>
          reply.location?.kind === "space" &&
          reply.spaceId === "connected-agents"
      )
    ).toBe(true)
    expect(client.accepted).toEqual(
      new Set(["msg_1", "msg_2", "msg_3", "msg_4"])
    )
    expect(
      client.progressEvents.some(
        (event) =>
          event.messageId === "msg_1" &&
          event.phase === "receiving" &&
          event.receivedCharacters === 12
      )
    ).toBe(true)
  })

  it("preserves a migrated V1 Space conversation key", async () => {
    const client = new FakeWorktableClient()
    const dispatcher = new RecordingDispatcher()
    const migrated = delivery("msg_v1", "thr_v1")
    migrated.thread.spaceId = "connected-agents"
    client.deliveries.push(migrated)
    const connector = new WorktableConnector({
      client,
      dispatcher,
      dedupe: memoryDedupe(),
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
    })

    await connector.processOne()

    expect(dispatcher.calls[0]?.conversationId).toBe("connected-agents/thr_v1")
  })

  it("dispatches a named author with its conversation identity name", async () => {
    const client = new FakeWorktableClient()
    const dispatcher = new RecordingDispatcher()
    const namedAuthor = delivery("msg_named_author", "thr_named_author")
    namedAuthor.thread.identities.push({
      id: "idt_finnresearch",
      memberId: "ptc_finn",
      name: "Research",
      default: false,
      status: "active",
    })
    namedAuthor.message.authorIdentityId = "idt_finnresearch"
    client.deliveries.push(namedAuthor)
    const connector = new WorktableConnector({
      client,
      dispatcher,
      dedupe: memoryDedupe(),
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
    })

    await connector.processOne()

    expect(dispatcher.calls[0]?.sender).toEqual({
      id: "ptc_finn",
      kind: "agent",
      name: "Research",
    })
  })

  it("uses a location-qualified Worktable session and stores qualified links portably", async () => {
    const client = new FakeWorktableClient()
    const rootDelivery = delivery(
      "msg_root",
      "thr_worktable",
      "General work",
      ""
    )
    rootDelivery.location = { kind: "worktable" }
    rootDelivery.thread.location = { kind: "worktable" }
    client.deliveries.push(rootDelivery)
    const calls: AgentDispatchInput[] = []
    const dispatcher: AgentDispatcher = {
      async dispatch(input) {
        calls.push(input)
        return "See http://worktable.test/spaces/research/docs/answer."
      },
    }
    const connector = new WorktableConnector({
      client,
      dispatcher,
      dedupe: memoryDedupe(),
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
      worktableOrigin: "http://worktable.test",
    })

    expect(await connector.processOne()).toBe(true)
    expect(calls[0]).toMatchObject({
      location: { kind: "worktable" },
      conversationId: "worktable/thr_worktable",
      threadTarget: "thread:thr_worktable",
    })
    expect(calls[0]).not.toHaveProperty("spaceId")
    expect(client.replies[0]).toMatchObject({
      location: { kind: "worktable" },
      threadId: "thr_worktable",
      body: "See [/spaces/research/docs/answer](/spaces/research/docs/answer).",
    })
    expect(client.replies[0]).not.toHaveProperty("spaceId")
  })

  it("serializes one native session while different threads run concurrently", async () => {
    const client = new FakeWorktableClient()
    client.deliveries.push(
      delivery("msg_same_1", "thr_same"),
      delivery("msg_same_2", "thr_same", "Follow up."),
      delivery("msg_other", "thr_other")
    )
    const started: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let markOtherStarted: (() => void) | undefined
    const otherStarted = new Promise<void>((resolve) => {
      markOtherStarted = resolve
    })
    const dispatcher: AgentDispatcher = {
      async dispatch(input) {
        started.push(input.messageId)
        if (input.messageId === "msg_same_1") await firstGate
        if (input.messageId === "msg_other") markOtherStarted?.()
        return `Reply to ${input.messageId}`
      },
    }
    const connector = new WorktableConnector({
      client,
      dispatcher,
      dedupe: memoryDedupe(),
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
    })

    const processing = [
      connector.processOne(),
      connector.processOne(),
      connector.processOne(),
    ]
    await otherStarted

    expect(started).toContain("msg_same_1")
    expect(started).toContain("msg_other")
    expect(started).not.toContain("msg_same_2")

    releaseFirst?.()
    await Promise.all(processing)
    expect(started.indexOf("msg_same_2")).toBeGreaterThan(
      started.indexOf("msg_same_1")
    )
    expect(client.replies).toHaveLength(3)
  })

  it("addresses a group-thread reply to the original author", async () => {
    const client = new FakeWorktableClient()
    const groupDelivery = delivery("msg_group", "thr_group")
    groupDelivery.thread.members!.push({
      id: "ptc_mara",
      kind: "agent",
      name: "Mara",
    })
    client.deliveries.push(groupDelivery)
    const connector = new WorktableConnector({
      client,
      dispatcher: new RecordingDispatcher(),
      dedupe: memoryDedupe(),
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
    })

    await connector.processOne()

    expect(client.replies).toHaveLength(1)
    expect(client.replies[0]).toMatchObject({
      authorIdentityId: groupDelivery.identityId,
      responseTo: groupDelivery.messageId,
      deliveryLeaseId: groupDelivery.leaseId,
    })
  })

  it("does not invoke another agent turn for a duplicate native event ID", async () => {
    const client = new FakeWorktableClient()
    const dispatcher = new RecordingDispatcher()
    const dedupe = memoryDedupe()
    client.deliveries.push(delivery("msg_duplicate", "thr_alpha"))
    const first = new WorktableConnector({
      client,
      dispatcher,
      dedupe,
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
    })
    await first.processOne()

    client.deliveries.push(delivery("msg_duplicate", "thr_alpha"))
    const restarted = new WorktableConnector({
      client,
      dispatcher,
      dedupe,
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
    })
    await restarted.processOne()

    expect(dispatcher.calls).toHaveLength(1)
    expect(client.replies).toHaveLength(1)
    expect(client.failed.at(-1)?.code).toBe("DUPLICATE_EVENT")
  })

  it("reclaims an event when an overlapping ingress attempt releases it", async () => {
    const client = new FakeWorktableClient()
    const dispatcher = new RecordingDispatcher()
    let claimAttempts = 0
    const dedupe: DeliveryDedupe = {
      claim: async () => {
        claimAttempts += 1
        return claimAttempts === 1
          ? { kind: "inflight", pending: Promise.resolve(false) }
          : { kind: "claimed" }
      },
      commit: async () => true,
      release: () => undefined,
      warmup: async () => 0,
    }
    client.deliveries.push(delivery("msg_reclaimed", "thr_alpha"))
    const connector = new WorktableConnector({
      client,
      dispatcher,
      dedupe,
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
    })

    await connector.processOne()

    expect(claimAttempts).toBe(2)
    expect(dispatcher.calls).toHaveLength(1)
    expect(client.replies).toHaveLength(1)
    expect(client.failed).toHaveLength(0)
  })

  it("retires the current lease when an overlapping ingress attempt commits", async () => {
    const client = new FakeWorktableClient()
    const dispatcher = new RecordingDispatcher()
    const dedupe: DeliveryDedupe = {
      claim: async () => ({
        kind: "inflight",
        pending: Promise.resolve(true),
      }),
      commit: async () => true,
      release: () => undefined,
      warmup: async () => 0,
    }
    client.deliveries.push(delivery("msg_committed_elsewhere", "thr_alpha"))
    const connector = new WorktableConnector({
      client,
      dispatcher,
      dedupe,
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
    })

    await connector.processOne()

    expect(dispatcher.calls).toHaveLength(0)
    expect(client.failed.at(-1)).toMatchObject({
      code: "DUPLICATE_EVENT",
      retryable: false,
    })
  })

  it("retries a retained reply after restart without rerunning the agent", async () => {
    const client = new FakeWorktableClient()
    const dispatcher = new RecordingDispatcher()
    const dedupe = memoryDedupe()
    const replyOutbox = createMemoryReplyOutbox()
    const logs: string[] = []
    let replyAttempts = 0
    const durableReply = client.reply.bind(client)
    client.reply = (input) => {
      replyAttempts += 1
      if (replyAttempts === 1) {
        return Promise.reject(
          Object.assign(new Error("Worktable temporarily unavailable"), {
            code: "ECONNRESET",
          })
        )
      }
      return durableReply(input)
    }
    client.deliveries.push(
      delivery(
        "msg_retained",
        "thr_retained",
        "Private message body that must not be logged."
      )
    )
    const first = new WorktableConnector({
      client,
      dispatcher,
      dedupe,
      replyOutbox,
      accountId: "default",
      logger: {
        error: (message) => logs.push(message),
        warn: (message) => logs.push(message),
      },
    })

    await first.processOne()
    expect(dispatcher.calls).toHaveLength(1)
    expect(client.replies).toHaveLength(0)
    expect(client.failed.at(-1)).toMatchObject({
      code: "ECONNRESET",
      retryable: true,
    })

    client.deliveries.push(delivery("msg_retained", "thr_retained"))
    const restarted = new WorktableConnector({
      client,
      dispatcher,
      dedupe,
      replyOutbox,
      accountId: "default",
    })
    await restarted.processOne()

    expect(replyAttempts).toBe(2)
    expect(dispatcher.calls).toHaveLength(1)
    expect(client.replies).toHaveLength(1)
    expect(client.replies[0]?.body).toBe("Reply 1 in thr_retained")
    expect(logs.join("\n")).not.toContain("Private message body")
    expect(logs.join("\n")).not.toContain("Reply 1 in thr_retained")
  })

  it("upgrades a retained legacy reply to an explicit response", async () => {
    const client = new FakeWorktableClient()
    const dispatcher = new RecordingDispatcher()
    const replyOutbox = createMemoryReplyOutbox()
    const claimed = delivery("msg_legacy_reply", "thr_legacy_reply")
    await replyOutbox.put(
      "space:connected-agents/thr_legacy_reply/msg_legacy_reply",
      {
        spaceId: "connected-agents",
        threadId: claimed.threadId,
        inReplyTo: claimed.messageId,
        to: "Finn",
        body: "Retained legacy response",
        idempotencyKey: "openclaw:legacy-reply",
      }
    )
    client.deliveries.push(claimed)
    const connector = new WorktableConnector({
      client,
      dispatcher,
      dedupe: memoryDedupe(),
      replyOutbox,
      accountId: "default",
    })

    await connector.processOne()

    expect(dispatcher.calls).toHaveLength(0)
    expect(client.replies[0]).toMatchObject({
      responseTo: claimed.messageId,
      authorIdentityId: claimed.identityId,
      deliveryLeaseId: claimed.leaseId,
      body: "Retained legacy response",
    })
    expect(client.replies[0]).not.toHaveProperty("to")
  })

  it("treats a completed empty response as terminal instead of rerunning it", async () => {
    const client = new FakeWorktableClient()
    let dispatches = 0
    const dispatcher: AgentDispatcher = {
      dispatch() {
        dispatches += 1
        return Promise.resolve("   ")
      },
    }
    const dedupe = memoryDedupe()
    const replyOutbox = createMemoryReplyOutbox()
    client.deliveries.push(delivery("msg_empty", "thr_empty"))
    const connector = new WorktableConnector({
      client,
      dispatcher,
      dedupe,
      replyOutbox,
      accountId: "default",
    })
    await connector.processOne()

    expect(client.failed.at(-1)).toMatchObject({
      code: "EMPTY_REPLY",
      retryable: false,
    })
    client.deliveries.push(delivery("msg_empty", "thr_empty"))
    await connector.processOne()
    expect(dispatches).toBe(1)
    expect(client.failed.at(-1)?.code).toBe("DUPLICATE_EVENT")
  })

  it("keeps equal portable message IDs isolated across threads", async () => {
    const client = new FakeWorktableClient()
    const dispatcher = new RecordingDispatcher()
    const dedupe = memoryDedupe()
    client.deliveries.push(
      delivery("msg_copied", "thr_alpha"),
      delivery("msg_copied", "thr_beta")
    )
    const connector = new WorktableConnector({
      client,
      dispatcher,
      dedupe,
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
    })

    await connector.processOne()
    await connector.processOne()

    expect(dispatcher.calls).toHaveLength(2)
    expect(client.replies).toHaveLength(2)
    expect(client.failed).toHaveLength(0)
  })

  it("keeps copied thread and message IDs isolated across Spaces", async () => {
    const client = new FakeWorktableClient()
    const dispatcher = new RecordingDispatcher()
    const first = delivery(
      "msg_copied",
      "thr_copied",
      "First Space",
      "space-one"
    )
    const second = delivery(
      "msg_copied",
      "thr_copied",
      "Second Space",
      "space-two"
    )
    for (const item of [first, second]) {
      const location = {
        kind: "space" as const,
        spaceId:
          item.location.kind === "space" ? item.location.spaceId : "missing",
      }
      item.location = location
      item.thread.location = location
    }
    client.deliveries.push(first, second)
    const connector = new WorktableConnector({
      client,
      dispatcher,
      dedupe: memoryDedupe(),
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
    })

    await connector.processOne()
    await connector.processOne()

    expect(dispatcher.calls.map(({ spaceId }) => spaceId)).toEqual([
      "space-one",
      "space-two",
    ])
    expect(dispatcher.calls.map(({ threadTarget }) => threadTarget)).toEqual([
      "thread:space-one/thr_copied",
      "thread:space-two/thr_copied",
    ])
    expect(dispatcher.turnsByThread.get("space:space-one/thr_copied")).toBe(1)
    expect(dispatcher.turnsByThread.get("space:space-two/thr_copied")).toBe(1)
    expect(client.replies.map(({ spaceId }) => spaceId)).toEqual([
      "space-one",
      "space-two",
    ])
    expect(client.failed).toHaveLength(0)
  })

  it("keeps receiving progress monotonic while heartbeats renew the lease", async () => {
    const client = new FakeWorktableClient()
    client.deliveries.push(delivery("msg_streaming", "thr_streaming"))
    let heartbeat: (() => void | Promise<void>) | undefined
    const heartbeatTimer = {
      start(callback: () => void | Promise<void>) {
        heartbeat = callback
        return 1 as unknown as ReturnType<typeof setInterval>
      },
      stop() {
        heartbeat = undefined
      },
    }
    const dispatcher: AgentDispatcher = {
      async dispatch(_input, callbacks) {
        await callbacks.onReceiving(12)
        await heartbeat?.()
        return "Streaming reply"
      },
    }
    const connector = new WorktableConnector({
      client,
      dispatcher,
      dedupe: memoryDedupe(),
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
      heartbeatMs: 5,
      heartbeatTimer,
    })

    await connector.processOne()

    const receivingIndex = client.progressEvents.findIndex(
      (event) => event.phase === "receiving"
    )
    expect(receivingIndex).toBeGreaterThanOrEqual(0)
    expect(client.progressEvents.slice(receivingIndex)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "receiving",
          receivedCharacters: 12,
        }),
      ])
    )
    expect(
      client.progressEvents
        .slice(receivingIndex)
        .every(
          (event) =>
            event.phase === "receiving" && event.receivedCharacters === 12
        )
    ).toBe(true)
  })

  it("cancels an active turn after sustained heartbeat failures", async () => {
    const client = new FakeWorktableClient()
    client.deliveries.push(delivery("msg_lease_risk", "thr_lease_risk"))
    let progressCalls = 0
    client.progress = (messageId, _leaseId, phase, receivedCharacters) => {
      client.progressEvents.push({ messageId, phase, receivedCharacters })
      progressCalls += 1
      return progressCalls === 1
        ? Promise.resolve()
        : Promise.reject(
            Object.assign(new Error("offline"), { code: "ECONNRESET" })
          )
    }
    let dispatchAborted = false
    let heartbeat: (() => void | Promise<void>) | undefined
    const heartbeatTimer = {
      start(callback: () => void | Promise<void>) {
        heartbeat = callback
        return 1 as unknown as ReturnType<typeof setInterval>
      },
      stop() {
        heartbeat = undefined
      },
    }
    const dispatcher: AgentDispatcher = {
      async dispatch(_input, _callbacks, signal) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await heartbeat?.()
        }
        return new Promise((resolve) => {
          const finish = () => {
            dispatchAborted = true
            resolve("Reply that must not be posted")
          }
          if (signal?.aborted) finish()
          else signal?.addEventListener("abort", finish, { once: true })
        })
      },
    }
    const connector = new WorktableConnector({
      client,
      dispatcher,
      dedupe: memoryDedupe(),
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
      heartbeatMs: 2,
      heartbeatTimer,
    })

    await connector.processOne()

    expect(dispatchAborted).toBe(true)
    expect(progressCalls).toBeGreaterThanOrEqual(4)
    expect(client.replies).toHaveLength(0)
    expect(client.failed.at(-1)?.code).toBe("LEASE_HEARTBEAT_FAILED")
  })

  it("cancels a pending claim when the channel stops", async () => {
    const client = new FakeWorktableClient()
    let claimStarted = false
    let markClaimStarted: (() => void) | undefined
    const claimDidStart = new Promise<void>((resolve) => {
      markClaimStarted = resolve
    })
    let closed = false
    const connectionStates: boolean[] = []
    client.claim = (_waitSeconds?: number, signal?: AbortSignal) => {
      claimStarted = true
      markClaimStarted?.()
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve(null)
          return
        }
        signal?.addEventListener("abort", () => resolve(null), { once: true })
      })
    }
    client.close = () => {
      closed = true
      return Promise.resolve()
    }
    const connector = new WorktableConnector({
      client: client as WorktableClient,
      dispatcher: new RecordingDispatcher(),
      dedupe: memoryDedupe(),
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
      onConnectionState: ({ connected }) => {
        connectionStates.push(connected)
      },
    })
    const abort = new AbortController()
    const running = connector.run(abort.signal)

    await claimDidStart
    expect(claimStarted).toBe(true)
    abort.abort()
    await running

    expect(closed).toBe(true)
    expect(connectionStates).toEqual([true])
  })

  it("verifies pending pairing only after durable and authenticated connection checks", async () => {
    const client = new FakeWorktableClient()
    const events: string[] = []
    client.participants = async () => {
      events.push("participants")
      return []
    }
    const dedupe = memoryDedupe()
    const warmup = dedupe.warmup.bind(dedupe)
    dedupe.warmup = async (namespace) => {
      events.push("dedupe")
      return warmup(namespace)
    }
    const abort = new AbortController()
    const connector = new WorktableConnector({
      client,
      dispatcher: new RecordingDispatcher(),
      dedupe,
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
      onConnected: async () => {
        events.push("pairing")
      },
      onConnectionState: ({ connected }) => {
        if (!connected) return
        events.push("connected")
        abort.abort()
      },
    })

    await connector.run(abort.signal)

    expect(events).toEqual(["dedupe", "participants", "pairing", "connected"])
  })

  it("keeps pairing pending when connection verification fails", async () => {
    const client = new FakeWorktableClient()
    const abort = new AbortController()
    const states: Array<{ connected: boolean; errorCode?: string }> = []
    const connector = new WorktableConnector({
      client,
      dispatcher: new RecordingDispatcher(),
      dedupe: memoryDedupe(),
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
      onConnected: async () => {
        throw Object.assign(new Error("Worktable is unavailable"), {
          code: "PAIRING_COMPLETION_PENDING",
        })
      },
      onConnectionState: (state) => {
        states.push(state)
        if (!state.connected) abort.abort()
      },
    })

    await connector.run(abort.signal)

    expect(states).toEqual([
      { connected: false, errorCode: "PAIRING_COMPLETION_PENDING" },
    ])
  })

  it("reports a disconnected state when the authenticated MCP warmup fails", async () => {
    const client = new FakeWorktableClient()
    const abort = new AbortController()
    client.participants = () =>
      Promise.reject(
        Object.assign(new Error("Unauthorized"), {
          code: "FORBIDDEN",
        })
      )
    const connectionStates: Array<{
      connected: boolean
      errorCode?: string
    }> = []
    const connector = new WorktableConnector({
      client,
      dispatcher: new RecordingDispatcher(),
      dedupe: memoryDedupe(),
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
      onConnectionState: (state) => {
        connectionStates.push(state)
        abort.abort()
      },
    })

    await connector.run(abort.signal)

    expect(connectionStates).toEqual([
      { connected: false, errorCode: "FORBIDDEN" },
    ])
  })

  it.each([
    "claim",
    "outbox",
    "commit",
    "duplicate-cleanup",
    "terminal-commit",
  ] as const)(
    "stops on a local %s failure without redispatching work",
    async (phase) => {
      const client = new FakeWorktableClient()
      const stop = new AbortController()
      let claimCount = 0
      let closed = false
      client.close = async () => {
        closed = true
      }
      client.claim = (_waitSeconds?: number, signal?: AbortSignal) => {
        claimCount += 1
        if (claimCount === 1)
          return Promise.resolve(delivery("msg_state_failure", "thr_failure"))
        return new Promise((resolve) => {
          // A completed HTTP claim can race cancellation and still return a delivery.
          const complete = () =>
            resolve(delivery("msg_after_stop", "thr_after_stop"))
          if (signal?.aborted) {
            complete()
            return
          }
          signal?.addEventListener("abort", complete, { once: true })
        })
      }
      const failure = Object.assign(new Error("Local state is unavailable"), {
        code:
          phase === "outbox" || phase === "duplicate-cleanup"
            ? "DURABLE_REPLY_OUTBOX_UNAVAILABLE"
            : "DURABLE_INGRESS_UNAVAILABLE",
      })
      const dedupe = memoryDedupe()
      const outbox = createMemoryReplyOutbox()
      if (phase === "claim")
        dedupe.claim = async () => {
          throw failure
        }
      if (phase === "commit" || phase === "terminal-commit")
        dedupe.commit = async () => {
          throw failure
        }
      if (phase === "outbox")
        outbox.get = async () => {
          throw failure
        }
      if (phase === "duplicate-cleanup") {
        dedupe.claim = async () => ({ kind: "duplicate" })
        outbox.delete = async () => {
          throw failure
        }
      }
      const dispatcher = new RecordingDispatcher()
      if (phase === "terminal-commit") {
        const dispatch = dispatcher.dispatch.bind(dispatcher)
        dispatcher.dispatch = async (...args) => {
          await dispatch(...args)
          return ""
        }
      }
      if (phase === "duplicate-cleanup" || phase === "terminal-commit") {
        const fail = client.fail.bind(client)
        client.fail = async (...args) => {
          await fail(...args)
          // Finish even if fatal-error propagation regresses, without a timeout.
          stop.abort()
        }
      }
      const connector = new WorktableConnector({
        client,
        dispatcher,
        dedupe,
        replyOutbox: outbox,
        accountId: "default",
      })
      await expect(connector.run(stop.signal)).rejects.toBe(failure)
      expect(closed).toBe(true)
      expect(claimCount).toBeLessThanOrEqual(2)
      expect(client.failed).toHaveLength(
        phase === "duplicate-cleanup" || phase === "terminal-commit" ? 1 : 0
      )
      expect(dispatcher.calls).toHaveLength(
        phase === "commit" || phase === "terminal-commit" ? 1 : 0
      )
      expect(client.replies).toHaveLength(phase === "commit" ? 1 : 0)
    }
  )

  it("bounds shutdown while leaving an active turn lease recoverable", async () => {
    const client = new FakeWorktableClient()
    let closed = false
    let dispatchStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      dispatchStarted = resolve
    })
    let claimCount = 0
    client.claim = (_waitSeconds?: number, signal?: AbortSignal) => {
      claimCount += 1
      if (claimCount === 1) {
        return Promise.resolve(delivery("msg_slow", "thr_slow"))
      }
      return new Promise((resolve) => {
        if (signal?.aborted) {
          resolve(null)
          return
        }
        signal?.addEventListener("abort", () => resolve(null), { once: true })
      })
    }
    client.close = () => {
      closed = true
      return Promise.resolve()
    }
    const dispatcher: AgentDispatcher = {
      dispatch() {
        dispatchStarted?.()
        return new Promise<string>(() => undefined)
      },
    }
    const warnings: string[] = []
    const connector = new WorktableConnector({
      client,
      dispatcher,
      dedupe: memoryDedupe(),
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
      shutdownDrainMs: 20,
      logger: { warn: (message) => warnings.push(message) },
    })
    const abort = new AbortController()
    const running = connector.run(abort.signal)
    await started

    abort.abort()
    await running

    expect(closed).toBe(true)
    expect(client.failed).toHaveLength(0)
    expect(warnings).toEqual([
      expect.stringContaining("their leases will recover after expiry"),
    ])
  })

  it("bounds shutdown while waiting for saturated turn capacity", async () => {
    const client = new FakeWorktableClient()
    for (let index = 0; index < 5; index++) {
      client.deliveries.push(
        delivery(`msg_capacity_${index}`, `thr_capacity_${index}`)
      )
    }
    let startedCount = 0
    let markSaturated: (() => void) | undefined
    const saturated = new Promise<void>((resolve) => {
      markSaturated = resolve
    })
    let releaseTurns: (() => void) | undefined
    const turnGate = new Promise<void>((resolve) => {
      releaseTurns = resolve
    })
    const dispatcher: AgentDispatcher = {
      async dispatch() {
        startedCount += 1
        if (startedCount === 4) markSaturated?.()
        await turnGate
        return "Late reply"
      },
    }
    const connector = new WorktableConnector({
      client,
      dispatcher,
      dedupe: memoryDedupe(),
      replyOutbox: createMemoryReplyOutbox(),
      accountId: "default",
      shutdownDrainMs: 20,
    })
    const abort = new AbortController()
    const running = connector.run(abort.signal)
    await saturated

    abort.abort()
    const completed = await Promise.race([
      running.then(() => true),
      Bun.sleep(150).then(() => false),
    ])
    releaseTurns?.()
    await running

    expect(completed).toBe(true)
    expect(startedCount).toBe(4)
    expect(client.replies).toHaveLength(0)
  })

  it("persists duplicate completion across a connector restart", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "worktable-openclaw-state-"))
    tempDirs.push(stateDir)
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir }
    const first = createOpenClawDeliveryDedupe(env)
    try {
      await first.warmup("default")
    } catch (error) {
      // Bun and this machine's Node 24.13 do not satisfy OpenClaw's safe
      // node:sqlite runtime. Production fails closed on the same condition.
      expect(error).toMatchObject({ code: "DURABLE_INGRESS_UNAVAILABLE" })
      return
    }
    expect(
      await first.claim("msg_persisted", { namespace: "default" })
    ).toEqual({ kind: "claimed" })
    await first.commit("msg_persisted", { namespace: "default" })

    const restarted = createOpenClawDeliveryDedupe(env)
    await restarted.warmup("default")
    expect(
      await restarted.claim("msg_persisted", { namespace: "default" })
    ).toEqual({ kind: "duplicate" })
  })

  it("persists a completed reply across an OpenClaw process restart", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "worktable-reply-outbox-"))
    tempDirs.push(stateDir)
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir }
    const eventId = "worktable:space-a:thr_a:msg_a"
    const reply = {
      spaceId: "space-a",
      threadId: "thr_a",
      inReplyTo: "msg_a",
      responseTo: "msg_a",
      authorIdentityId: "idt_atlasdefault",
      body: "Durably retained response",
      idempotencyKey: "openclaw:msg_a:reply",
    }

    await createOpenClawReplyOutbox(env).put(eventId, reply)
    const restarted = createOpenClawReplyOutbox(env)
    expect(await restarted.get(eventId)).toEqual(reply)
    await restarted.delete(eventId)
    expect(await createOpenClawReplyOutbox(env).get(eventId)).toBeUndefined()
  })
})
