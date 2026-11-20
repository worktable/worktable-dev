import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { Annotation } from "@worktable/types"
import { apiErrorResponse } from "./api-error-response.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { ownerIdentity } from "./auth.ts"
import { readAnnotation } from "./annotation-store.ts"
import { createWorktableMcpServer } from "./mcp/server.ts"
import type { McpSurface } from "./mcp/surface.ts"
import { resolveParticipant } from "./participant-store.ts"
import { pendingList, pendingMarks } from "./pending-list.ts"
import { annotationsRouter } from "./routes/annotations.ts"
import { grokBotRouter } from "./routes/grok-bot.ts"
import { readGrokBots, updateGrokBot } from "./grok-bot-store.ts"
import { startGrokBotRuntime } from "./grok-bot-runtime.ts"
import {
  commentDeliveryStates,
  nextThreadDeliveryEligibleAt,
  takesComments,
} from "./thread-delivery-store.ts"
import { claimNextDelivery, claimNextThreadDelivery } from "./thread-service.ts"
import { writeDoc, writeSpace } from "./store.ts"
import { readFile, writeFile } from "node:fs/promises"
import { workspaceCacheKey } from "./workspace.ts"
import type { TokenIdentity } from "./token-store.ts"
import { drainWorkspaceChanges } from "./workspace-events.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

// An agent Worktable calls, such as an OpenClaw or Hermes runtime.
const robin: TokenIdentity = {
  user: "owner",
  workspace: "test",
  scopes: ["*"],
  agent: "openclaw",
  principal: {
    id: "token:robin",
    type: "agent",
    displayName: "openclaw runtime",
    authorizedBy: "local:owner",
  },
}
const grok: TokenIdentity = {
  user: "owner",
  workspace: "test",
  credentialClass: "resource",
  agent: null,
  scopes: ["*"],
  principal: {
    id: "oauth:grok:owner",
    type: "agent",
    displayName: "Grok Bot",
    authorizedBy: "workos:owner",
  },
}

let root: string
let appDir: string
let stop: (() => Promise<void>) | undefined
const app = new Hono()
app.use("*", async (c, next) => {
  c.set("identity", ownerIdentity())
  await next()
})
app.route("/api/spaces/:spaceId/annotations", annotationsRouter)
app.route("/grok", grokBotRouter)
app.onError(apiErrorResponse)

async function comment(docPath: string, to: string, body: string) {
  const response = await app.fetch(
    new Request("http://localhost/api/spaces/demo/annotations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: { type: "block", docPath, blockId: "s1" },
        category: "comment",
        body,
        to: [to],
      }),
    })
  )
  expect(response.status).toBe(200)
  return ((await response.json()) as { annotation: Annotation }).annotation
}

/** A runtime over MCP, calling the grouped delivery tool the plugins use. */
async function runtime(
  identity: TokenIdentity,
  surface: McpSurface,
  scopes: string[] = ["*"]
) {
  const server = createWorktableMcpServer({
    version: "test",
    surface,
    scopes,
    identity: { agent: identity.agent, principal: identity.principal },
    principal: identity.principal,
  })
  const client = new Client({ name: "runtime", version: "1" })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverSide), client.connect(clientSide)])
  const call = async (name: string, request: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: { request } })) as {
      isError?: boolean
      structuredContent?: Record<string, unknown>
      content: Array<{ type: string; text?: string }>
    }
    if (result.isError) throw new Error(result.content[0]?.text ?? "error")
    return (result.structuredContent ??
      JSON.parse(result.content[0]!.text!)) as Record<string, unknown>
  }
  return { call, close: () => client.close() }
}

/** A page of comments as a runtime receives it. */
interface ClaimedPage {
  kind: string
  batchId: string
  messageId: string
  leaseId: string
  page: { spaceId: string; path: string }
  comments: Array<{ body: string; from: { id: string; kind: string } }>
}

const claim = (call: Awaited<ReturnType<typeof runtime>>["call"], waitSeconds = 0) =>
  call("worktable_thread_delivery", {
    action: "claim",
    waitSeconds,
    threadLocationVersion: 2,
    comments: true,
  }).then((result) => result.delivery as ClaimedPage | null)

/** Let deliveries waiting out a retry backoff go now. */
async function skipBackoff() {
  const path = join(appDir, "thread-deliveries", `${workspaceCacheKey()}.json`)
  const file = JSON.parse(await readFile(path, "utf8"))
  for (const record of file.deliveries)
    if (record.nextAttemptAt) record.nextAttemptAt = new Date(0).toISOString()
  await writeFile(path, JSON.stringify(file))
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wt-comment-deliveries-"))
  appDir = await mkdtemp(join(tmpdir(), "wt-comment-deliveries-app-"))
  setWorkspaceRootOverride(root)
  setAppDirOverride(appDir)
  ensureWorkspaceManifest()
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: "demo",
    name: "Demo",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  })
  for (const path of ["deck", "notes"])
    await writeDoc("demo", path, [
      {
        id: "s1",
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "Slide one", styles: {} }],
        children: [],
      },
    ])
  await pendingList()
})
afterEach(async () => {
  await stop?.()
  stop = undefined
  await drainWorkspaceChanges()
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  await rm(root, { recursive: true, force: true })
  await rm(appDir, { recursive: true, force: true })
})

describe("comments delivered to an agent's runtime", () => {
  it("hands out a page of comments at once, and answers each one exactly once", async () => {
    const agentId = (await resolveParticipant(robin, { name: "Robin" })).participant.id
    const released = await runtime(robin, "released")
    const preview = await runtime(robin, "preview")
    try {
      const first = await comment("deck", agentId, "Shorten slide one.")
      const second = await comment("deck", agentId, "Fix the title.")
      const elsewhere = await comment("notes", agentId, "Add a date.")

      // Off the preview surface, and for a runtime that doesn't ask, nothing.
      expect(await claim(released.call)).toBeNull()
      expect(await claimNextThreadDelivery(robin, 0, 2)).toBeNull()

      // Each page comes as its own batch, and a leased page isn't handed out again.
      const batches = [(await claim(preview.call))!, (await claim(preview.call))!]
      expect(await claim(preview.call)).toBeNull()
      expect(batches.map((b) => b.kind)).toEqual(["comments", "comments"])
      const page = batches.find((b) => b.page.path === "deck")!
      const other = batches.find((b) => b.page.path === "notes")!
      expect(page.page).toMatchObject({ spaceId: "demo", path: "deck" })
      // Its id stays when the page is renamed, for a runtime to key on.
      expect((page.page as { id?: string }).id).toMatch(/^doc_/)
      expect(page.comments.map((c: { body: string }) => c.body).sort()).toEqual([
        "Fix the title.",
        "Shorten slide one.",
      ])
      // The owner, as a thread member, so the runtime's owner rule reads it.
      expect(page.comments[0].from).toMatchObject({ kind: "human" })
      expect(page.comments[0].from.id).toMatch(/^ptc_/)
      expect(pendingMarks(`cmt:${first.id}:${first.requests![0]!.id}`)?.deliveredAt).toBeDefined()

      await preview.call("worktable_thread_delivery", {
        action: "accept",
        messageId: page.messageId,
        leaseId: page.leaseId,
      })
      const states = await commentDeliveryStates()
      expect(states.get(first.requests![0]!.id)?.state).toBe("working")
      expect(states.get(second.requests![0]!.id)?.state).toBe("working")

      // The agent answers one comment itself during its turn.
      await preview.call("worktable_annotations_write", {
        action: "reply",
        spaceId: "demo",
        annotationId: second.id,
        body: "Title fixed.",
      })
      // Its runtime's answer goes on the one still waiting, once.
      const reply = {
        action: "reply",
        messageId: page.messageId,
        leaseId: page.leaseId,
        body: "Done: shortened.",
      }
      await preview.call("worktable_thread_delivery", reply)
      await preview.call("worktable_thread_delivery", reply)
      const answeredFirst = await readAnnotation("demo", first.id)
      const answeredSecond = await readAnnotation("demo", second.id)
      expect(answeredFirst.thread.map((m) => [m.author.name, m.body])).toEqual([
        ["Robin", "Done: shortened."],
      ])
      expect(answeredSecond.thread.map((m) => m.body)).toEqual(["Title fixed."])
      expect(answeredFirst.requests!.map((r) => r.status)).toEqual(["replied"])
      const after = await commentDeliveryStates()
      expect(after.get(first.requests![0]!.id)?.state).toBe("replied")
      expect(after.get(second.requests![0]!.id)?.state).toBe("replied")

      // A failed turn puts the whole page back to wait.
      const notes = other
      await preview.call("worktable_thread_delivery", {
        action: "fail",
        messageId: notes.messageId,
        leaseId: notes.leaseId,
        retryable: true,
        code: "TURN_FAILED",
        message: "The turn failed",
      })
      expect((await commentDeliveryStates()).get(elsewhere.requests![0]!.id)?.state).toBe("queued")

      // While a page is being worked on, its new comments wait for that
      // batch to end and then come together. (The failed page skips its
      // retry backoff.)
      await skipBackoff()
      const busy = (await claim(preview.call))!
      expect(busy.page.path).toBe("notes")
      await comment("notes", agentId, "Also add a summary.")
      await comment("notes", agentId, "And a link.")
      expect(await claim(preview.call)).toBeNull()
      // A waiting runtime sleeps until the batch ends, not on held comments.
      const wakeAt = await nextThreadDeliveryEligibleAt(agentId, {
        allowWorktable: true,
        allowComments: true,
      })
      expect(wakeAt).toBeGreaterThan(Date.now() + 30_000)
      const held = claim(preview.call, 10)
      await preview.call("worktable_thread_delivery", {
        action: "reply",
        messageId: busy.messageId,
        leaseId: busy.leaseId,
        body: "Added the date.",
      })
      const joined = (await held)!
      expect(joined.comments.map((c) => c.body).sort()).toEqual([
        "Also add a summary.",
        "And a link.",
      ])
      // The agent answers every comment itself; its runtime's report still
      // goes through, and adds nothing.
      for (const annotationId of new Set(
        joined.comments.map((c) => (c as unknown as { annotationId: string }).annotationId)
      ))
        await preview.call("worktable_annotations_write", {
          action: "reply",
          spaceId: "demo",
          annotationId,
          body: "Answered directly.",
        })
      await preview.call("worktable_thread_delivery", {
        action: "reply",
        messageId: joined.messageId,
        leaseId: joined.leaseId,
        body: "Done.",
      })
      for (const c of joined.comments as unknown as Array<{ annotationId: string }>)
        expect(
          (await readAnnotation("demo", c.annotationId)).thread.map((m) => m.body)
        ).toEqual(["Answered directly."])

      // A comment that arrives while the runtime waits wakes it at once.
      await skipBackoff()
      const waiting = claim(preview.call, 10)
      const started = Date.now()
      await comment("deck", agentId, "One more thing.")
      const woken = await waiting
      expect(woken?.kind).toBe("comments")
      expect(Date.now() - started).toBeLessThan(3_000)
    } finally {
      await released.close()
      await preview.close()
    }
  }, 60_000)

  it("names an agent author as its member, keeps comments from credentials that can't read them, and retries an expired page whole", async () => {
    const agentId = (await resolveParticipant(robin, { name: "Robin" })).participant.id
    const atlas: TokenIdentity = {
      ...robin,
      agent: "claude-code@atlas",
      principal: { ...robin.principal, id: "token:atlas", displayName: "Atlas" },
    }
    const atlasId = (await resolveParticipant(atlas, { name: "Atlas" })).participant.id
    const writer = await runtime(atlas, "preview")
    const narrow = await runtime(robin, "preview", ["threads:*"])
    const preview = await runtime(robin, "preview")
    try {
      // Another agent comments to Robin.
      for (const body of ["From Atlas: check the totals.", "From Atlas: and the dates."])
        await writer.call("worktable_annotations_write", {
          action: "create",
          spaceId: "demo",
          target: { type: "doc", docPath: "deck" },
          body,
          to: [agentId],
        })
      // A credential that can't read comments gets none.
      expect(await claim(narrow.call)).toBeNull()
      const page = (await claim(preview.call))!
      expect(page.comments.map((c) => c.from)).toEqual([
        // Each agent author says who connected it: nobody on one-person Worktable.
        expect.objectContaining({ id: atlasId, kind: "agent", connectedBy: null }),
        expect.objectContaining({ id: atlasId, kind: "agent", connectedBy: null }),
      ])
      await preview.call("worktable_thread_delivery", {
        action: "accept",
        messageId: page.messageId,
        leaseId: page.leaseId,
      })
      // The runtime goes quiet: once the lease expires, the page comes back whole.
      const path = join(appDir, "thread-deliveries", `${workspaceCacheKey()}.json`)
      const file = JSON.parse(await readFile(path, "utf8"))
      for (const record of file.deliveries)
        if (record.leaseId === page.leaseId)
          record.leaseExpiresAt = new Date(0).toISOString()
      await writeFile(path, JSON.stringify(file))
      // The agent answered one comment itself; a late report under the lost
      // lease isn't taken as answering the other.
      await preview.call("worktable_annotations_write", {
        action: "reply",
        spaceId: "demo",
        annotationId: (page.comments[0] as unknown as { annotationId: string }).annotationId,
        body: "Totals checked.",
      })
      await expect(
        preview.call("worktable_thread_delivery", {
          action: "reply",
          messageId: page.messageId,
          leaseId: page.leaseId,
          body: "Late.",
        })
      ).rejects.toThrow(/LEASE_LOST|no longer valid/)
      // A comment that came meanwhile doesn't change the retried batch, so
      // the runtime knows it as the turn it already ran.
      await writer.call("worktable_annotations_write", {
        action: "create",
        spaceId: "demo",
        target: { type: "doc", docPath: "deck" },
        body: "From Atlas: one more.",
        to: [agentId],
      })
      const again = (await claim(preview.call))!
      expect(again.leaseId).not.toBe(page.leaseId)
      expect(again.batchId).toBe(page.batchId)
      expect(again.comments.map((c) => c.body)).toEqual([page.comments[1]!.body])
      await preview.call("worktable_thread_delivery", {
        action: "reply",
        messageId: again.messageId,
        leaseId: again.leaseId,
        body: "Checked.",
      })
      const next = (await claim(preview.call))!
      expect(next.batchId).not.toBe(page.batchId)
      expect(next.comments.map((c) => c.body)).toEqual(["From Atlas: one more."])
    } finally {
      await writer.close()
      await narrow.close()
      await preview.close()
    }
  }, 30_000)

  it("rings Grok for a comment only once its routine asks for comments", async () => {
    const grokId = (await resolveParticipant(grok, { name: "Grok" })).participant.id
    await claimNextThreadDelivery(grok, 0, 2)
    const configured = await app.request(
      `/grok/${encodeURIComponent(grok.principal.id)}/configuration`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          webhookUrl: "https://api2.cursor.sh/automations/webhook/test_routine",
          webhookKey: "test-routine-secret",
        }),
      }
    )
    expect(configured.status).toBe(200)
    await updateGrokBot((await readGrokBots())[0]!, {
      verifiedAt: new Date().toISOString(),
    })
    let rang: () => void = () => {}
    const ring = () => {
      stop = startGrokBotRuntime({
        fetch: (async () => {
          rang()
          return new Response(null, { status: 200 })
        }) as unknown as typeof fetch,
      })
    }
    ring()
    // An older routine claims only thread messages: a comment must not ring
    // it for work it would never find. The runtime rings for comments only
    // once the routine has asked for them.
    await comment("deck", grokId, "For an older routine.")
    expect(await takesComments(grokId)).toBe(false)

    // The routine asks for comments once; from then on a comment rings it.
    const page = (await claimNextDelivery(grok, 0, 2, { comments: true }))!
    const { call, close } = await runtime(grok, "preview")
    await call("worktable_thread_delivery", {
      action: "accept",
      messageId: page.messageId,
      leaseId: page.leaseId,
    })
    await call("worktable_thread_delivery", {
      action: "reply",
      messageId: page.messageId,
      leaseId: page.leaseId,
      body: "Done.",
    })
    await close()
    await stop!()
    expect(await takesComments(grokId)).toBe(true)
    ring()
    const rung = new Promise<void>((resolve) => (rang = resolve))
    await comment("deck", grokId, "For the new routine.")
    await rung

    // A page Grok's run failed on can be retried from its connection, whole.
    await comment("deck", grokId, "And this one.")
    const failing = (await claimNextDelivery(grok, 0, 2, { comments: true }))!
    expect((failing as { comments: unknown[] }).comments).toHaveLength(2)
    const again = await runtime(grok, "preview")
    await again.call("worktable_thread_delivery", {
      action: "fail",
      messageId: failing.messageId,
      leaseId: failing.leaseId,
      retryable: false,
      code: "TURN_FAILED",
      message: "The run failed",
    })
    await again.close()
    const requestId = failing.messageId
    expect((await commentDeliveryStates()).get(requestId)?.state).toBe("failed")
    const connectionId = (await readGrokBots())[0]!.connectionId
    const retried = await app.request(`/grok/${encodeURIComponent(connectionId)}/retry`, {
      method: "POST",
    })
    expect(retried.status).toBe(200)
    const states = await commentDeliveryStates()
    for (const c of (failing as unknown as { comments: Array<{ requestId: string }> }).comments)
      expect(states.get(c.requestId)?.state).toBe("queued")

    // A run Grok never confirms holds its other work, until its comment is
    // resolved.
    const unconfirmed = (await claimNextDelivery(grok, 0, 2, { comments: true }))!
    const owner = await runtime(grok, "preview")
    await owner.call("worktable_thread_delivery", {
      action: "accept",
      messageId: unconfirmed.messageId,
      leaseId: unconfirmed.leaseId,
    })
    await owner.close()
    const path = join(appDir, "thread-deliveries", `${workspaceCacheKey()}.json`)
    const file = JSON.parse(await readFile(path, "utf8"))
    for (const record of file.deliveries)
      if (record.leaseId === unconfirmed.leaseId)
        record.leaseExpiresAt = new Date(0).toISOString()
    await writeFile(path, JSON.stringify(file))
    await comment("notes", grokId, "Unrelated work.")
    expect(await claimNextDelivery(grok, 0, 2, { comments: true })).toBeNull()
    for (const c of (unconfirmed as unknown as { comments: Array<{ annotationId: string }> })
      .comments) {
      const resolved = await app.request(
        `/api/spaces/demo/annotations/${c.annotationId}/resolve`,
        { method: "POST" }
      )
      expect(resolved.status).toBe(200)
    }
    const next = (await claimNextDelivery(grok, 0, 2, { comments: true })) as {
      kind?: string
      page?: { path: string }
    } | null
    expect(next).toMatchObject({ kind: "comments", page: { path: "notes" } })
  }, 30_000)
})
