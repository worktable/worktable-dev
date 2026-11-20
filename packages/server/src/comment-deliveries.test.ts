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
import { commentDeliveryStates } from "./thread-delivery-store.ts"
import { claimNextDelivery, claimNextThreadDelivery } from "./thread-service.ts"
import { writeDoc, writeSpace } from "./store.ts"
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
async function runtime(identity: TokenIdentity, surface: McpSurface) {
  const server = createWorktableMcpServer({
    version: "test",
    surface,
    scopes: ["*"],
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

      // A comment that arrives while the runtime waits wakes it at once.
      await new Promise((r) => setTimeout(r, 2_100))
      const waiting = claim(preview.call, 10)
      await new Promise((r) => setTimeout(r, 200))
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
    let rings = 0
    const ring = () => {
      stop = startGrokBotRuntime({
        fetch: (async () => {
          rings += 1
          return new Response(null, { status: 200 })
        }) as unknown as typeof fetch,
      })
    }
    ring()
    // An older routine claims only thread messages: a comment must not ring
    // it for work it would never find.
    await comment("deck", grokId, "For an older routine.")
    await new Promise((r) => setTimeout(r, 1_000))
    expect(rings).toBe(0)

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
    rings = 0
    ring()
    await new Promise((r) => setTimeout(r, 300))
    rings = 0
    await comment("deck", grokId, "For the new routine.")
    const deadline = Date.now() + 5_000
    while (rings === 0 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50))
    expect(rings).toBeGreaterThan(0)
  }, 30_000)
})
