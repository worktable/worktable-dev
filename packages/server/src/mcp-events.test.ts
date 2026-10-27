import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import { createHmac } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { drainActivity } from "./activity-log.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { createAnnotation } from "./annotation-store.ts"
import {
  EventsError,
  startMcpEventsRuntime,
  subscribe,
  unsubscribe,
  type EventsCaller,
  type EventsTransport,
} from "./mcp-events.ts"
import { resolveParticipant } from "./participant-store.ts"
import { pendingList, pendingMarks } from "./pending-list.ts"
import { writeDoc, writeSpace } from "./store.ts"
import type { RequestPrincipal } from "./token-store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

// ChatGPT subscribes to items sent to it and Worktable posts each one to the
// callback. These tests stand in for the callback with a transport, so nothing
// leaves the process.

const chatgpt: RequestPrincipal = {
  id: "oauth:chatgpt",
  type: "agent",
  displayName: "ChatGPT",
  authorizedBy: "local:owner",
}
const caller: EventsCaller = {
  identity: { agent: "chatgpt", principal: chatgpt, scopes: ["*"] },
  origin: "https://worktable.example",
}
const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`
const CALLBACK = "https://receiver.example/mcp-events/cb_1"

let root: string
let appDir: string
let participantId: string
let stop: (() => Promise<void>) | undefined

interface Sent {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
  raw: string
}

/** A callback that answers challenges and then `status`, and records each request. */
function callback(
  sent: Sent[],
  {
    status = () => 200,
    addresses = ["93.184.216.34"],
    challenge = (value: string) => value,
  }: {
    status?: () => number
    addresses?: string[]
    challenge?: (value: string) => string
  } = {}
): EventsTransport {
  return {
    resolve: async () => addresses,
    fetch: async (url, init) => {
      const raw = String(init.body)
      const body = JSON.parse(raw) as Record<string, unknown>
      sent.push({
        url,
        headers: init.headers as Record<string, string>,
        body,
        raw,
      })
      if (body.type === "verification")
        return Response.json({ challenge: challenge(String(body.challenge)) })
      return new Response(null, { status: status() })
    },
  }
}

const events = (sent: Sent[]) =>
  sent.filter((s) => s.body.type !== "verification")

async function comment(spaceId: string, body: string): Promise<void> {
  await createAnnotation(spaceId, {
    target: { type: "doc", docPath: "explorer" },
    category: "comment",
    body,
    author: { type: "user", id: "user", name: "Karo" },
    to: [{ id: participantId, kind: "agent", name: "ChatGPT" }],
  })
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(10)
  expect(check()).toBe(true)
}

async function space(id: string, name: string): Promise<void> {
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id,
    name,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  })
  await writeDoc(id, "explorer", `# ${name}\n\nTeam is $49 a month.\n`)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-mcp-events-"))
  appDir = await mkdtemp(join(tmpdir(), "worktable-mcp-events-app-"))
  setWorkspaceRootOverride(root)
  setAppDirOverride(appDir)
  ensureWorkspaceManifest()
  await space("pricing", "Pricing")
  await space("launch", "Launch")
  participantId = (await resolveParticipant(caller.identity)).participant.id
  await pendingList()
})

afterEach(async () => {
  await stop?.()
  stop = undefined
  jest.useRealTimers()
  await drainActivity()
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
  await rm(appDir, { recursive: true, force: true })
})

const params = (overrides: Record<string, unknown> = {}) => ({
  name: "item.sent_to_you",
  arguments: { spaceId: "pricing" },
  delivery: { mode: "webhook", url: CALLBACK, secret: SECRET },
  cursor: null,
  ...overrides,
})

describe("MCP Events", () => {
  it("subscribes once the callback answers its challenge, and only to a public callback", async () => {
    const sent: Sent[] = []
    const first = await subscribe(caller, params(), callback(sent))
    expect(first.id).toMatch(/^sub_/)
    expect(Date.parse(first.refreshBefore)).toBeLessThanOrEqual(
      Date.now() + 24 * 60 * 60_000
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body.type).toBe("verification")

    // Renewing the same subscription keeps its id and needs no new check.
    const renewed = await subscribe(caller, params(), callback(sent))
    expect(renewed.id).toBe(first.id)
    expect(sent).toHaveLength(1)

    const refusal = (
      run: Promise<unknown>
    ): Promise<{ code: number; reason?: unknown }> =>
      run.then(
        () => ({ code: 0 }),
        (error: EventsError) => ({
          code: error.code,
          reason: error.data?.reason,
        })
      )
    const other = params({
      delivery: { mode: "webhook", url: `${CALLBACK}x`, secret: SECRET },
    })
    expect(
      await refusal(
        subscribe(caller, other, callback([], { challenge: () => "wrong" }))
      )
    ).toEqual({ code: -32015, reason: "invalid_challenge" })
    expect(
      await refusal(
        subscribe(caller, other, callback([], { addresses: ["10.1.2.3"] }))
      )
    ).toEqual({ code: -32015, reason: "blocked_address" })
    expect(
      await refusal(
        subscribe(
          caller,
          params({
            delivery: {
              mode: "webhook",
              url: "http://receiver.example/cb",
              secret: SECRET,
            },
          }),
          callback([])
        )
      )
    ).toMatchObject({ code: -32602 })
  })

  it("posts each new item once, signed, marks it delivered, and stops after unsubscribe", async () => {
    const sent: Sent[] = []
    const transport = callback(sent)
    await subscribe(caller, params(), transport)
    stop = startMcpEventsRuntime({ transport })

    await comment("pricing", "Team at 49 feels high. Try 39?")
    await comment("launch", "Out of this subscription's Space.")
    await until(() => events(sent).length === 1)
    const [event] = events(sent)
    const body = event!.body as {
      eventId: string
      name: string
      data: { itemId: string; excerpt: string; notice: string; url: string }
    }
    expect(body.name).toBe("item.sent_to_you")
    expect(body.data.excerpt).toBe("Team at 49 feels high. Try 39?")
    expect(body.data.notice).toContain("not instructions")
    expect(body.data.url).toStartWith("https://worktable.example/")
    expect(event!.headers["webhook-id"]).toBe(body.eventId)
    const timestamp = event!.headers["webhook-timestamp"]!
    const expected = createHmac("sha256", Buffer.alloc(32, 7))
      .update(`${body.eventId}.${timestamp}.${event!.raw}`)
      .digest("base64")
    expect(event!.headers["webhook-signature"]).toBe(`v1,${expected}`)
    expect(pendingMarks(body.data.itemId)?.deliveredAt).toBeDefined()

    await unsubscribe(caller, {
      name: "item.sent_to_you",
      arguments: { spaceId: "pricing" },
      delivery: { mode: "webhook", url: CALLBACK },
    })
    await comment("pricing", "After unsubscribing.")
    await Bun.sleep(100)
    expect(events(sent)).toHaveLength(1)
  })

  it("retries with the same event id, and ends the subscription on 410", async () => {
    const sent: Sent[] = []
    const statuses = [503, 200, 410]
    const arrivals = [1, 2, 3].map(() => Promise.withResolvers<void>())
    const recording = callback(sent, { status: () => statuses.shift() ?? 200 })
    const transport: EventsTransport = {
      ...recording,
      fetch: async (url, init) => {
        const response = await recording.fetch(url, init)
        arrivals[events(sent).length - 1]?.resolve()
        return response
      },
    }
    await subscribe(caller, params(), transport)
    stop = startMcpEventsRuntime({ transport })

    jest.useFakeTimers({ now: Date.now() })
    await comment("pricing", "Delivered on the second try.")
    await arrivals[0]!.promise
    await stop()
    // The failed attempt waits its retry delay, even across a restart.
    stop = startMcpEventsRuntime({ transport })
    jest.advanceTimersByTime(15_000)
    await arrivals[1]!.promise
    const [first, second] = events(sent)
    expect(second!.body.eventId).toBe(first!.body.eventId)

    await comment("pricing", "The receiver is gone.")
    await arrivals[2]!.promise
    jest.useRealTimers()
    await comment("pricing", "Never sent: the subscription ended.")
    await Bun.sleep(100)
    expect(events(sent)).toHaveLength(3)
  })
})
