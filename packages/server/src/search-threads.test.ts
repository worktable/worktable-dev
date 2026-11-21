import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type { SpaceFile, ThreadSearchResult } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import { resolveParticipant } from "./participant-store.ts"
import { searchRouter } from "./routes/search.ts"
import { threadsRouter } from "./routes/threads.ts"
import { invalidateSearchIndex, setSearchIndexRebuildHookForTests, setSearchWaitForTests } from "./search-index.ts"
import { keepSearchIndexOnDisk } from "./search-store.ts"
import { writeSpace } from "./store.ts"
import type { TokenIdentity } from "./token-store.ts"
import { notifyWorkspaceChange } from "./workspace-events.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"

let workspaceDir: string
let appDir: string

function agent(name: string, scopes: string[]): TokenIdentity {
  return {
    user: "owner",
    workspace: "test",
    scopes,
    agent: `${name.toLowerCase()}@work`,
    principal: {
      id: `token:${name.toLowerCase()}`,
      type: "agent",
      displayName: name,
      authorizedBy: "local:owner",
    },
  }
}

const finn = agent("Finn", ["threads:*", "search:read", "documents:read"])
const atlas = agent("Atlas", ["threads:*"])

function appFor(identity: TokenIdentity): Hono {
  const app = new Hono()
  app.use("*", async (c, next) => {
    c.set("identity", identity)
    await next()
  })
  app.route("/api/threads", threadsRouter)
  app.route("/api/spaces/:spaceId/threads", threadsRouter)
  app.route("/api/search", searchRouter)
  return app
}

async function call(app: Hono, method: string, path: string, body?: unknown) {
  const response = await app.fetch(
    new Request(`http://localhost${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  )
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

async function find(app: Hono, query: string, extra = "") {
  const res = await call(app, "GET", `/api/search?query=${encodeURIComponent(query)}&documentMode=common${extra}`)
  expect(res.status).toBe(200)
  return res.json.results as ThreadSearchResult[]
}

beforeEach(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "worktable-thread-search-workspace-"))
  appDir = await mkdtemp(join(tmpdir(), "worktable-thread-search-app-"))
  setWorkspaceRootOverride(workspaceDir)
  setAppDirOverride(appDir)
  const now = new Date().toISOString()
  const space: SpaceFile = {
    type: "worktable.space",
    version: 1,
    id: "launch",
    name: "Launch",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
  await writeSpace(space)
  for (const [identity, name] of [[finn, "Finn"], [atlas, "Atlas"]] as const) {
    await resolveParticipant(identity, { name, defaultSpaceId: "launch" })
  }
  // Every answer here comes from a finished index, however slow the machine.
  setSearchWaitForTests(60_000)
})

afterEach(async () => {
  keepSearchIndexOnDisk(false)
  setSearchIndexRebuildHookForTests(null)
  setSearchWaitForTests(null)
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await Promise.all([
    rm(workspaceDir, { recursive: true, force: true }),
    rm(appDir, { recursive: true, force: true }),
  ])
})

describe("thread search", () => {
  it("finds a thread once, by the message that matched best, for readers of threads", async () => {
    const app = appFor(finn)
    const created = await call(app, "POST", "/api/spaces/launch/threads", {
      to: "Atlas",
      body: "Kickoff for the observatory.",
      idempotencyKey: "search-space-create",
    })
    expect(created.status).toBe(201)
    const threadId = created.json.threadId as string
    expect((await find(app, "observatory")).map((result) => result.threadId)).toEqual([threadId])

    // A message posted since is found, in the same one result.
    const reply = await call(app, "POST", `/api/spaces/launch/threads/${threadId}/messages`, {
      body: "The narwhal census needs a budget.",
      idempotencyKey: "search-space-reply",
    })
    expect(reply.status).toBe(200)
    const found = await find(app, "narwhal")
    expect(found).toEqual([
      expect.objectContaining({
        type: "thread",
        location: { kind: "space", spaceId: "launch" },
        spaceId: "launch",
        threadId,
        sequence: 2,
        excerpt: "The narwhal census needs a budget.",
      }),
    ])
    expect(found[0]!.messageId).toMatch(/^msg_/)
    // Every message holds the thread's title; the thread is still one result.
    const title = (await call(app, "GET", `/api/spaces/launch/threads/${threadId}`)).json.thread as { title: string }
    expect((await find(app, title.title)).map((result) => result.threadId)).toEqual([threadId])

    // Threads of the whole Worktable too, with no Space.
    const general = await call(app, "POST", "/api/threads", {
      to: "Atlas",
      body: "A narwhal question for everyone.",
      idempotencyKey: "search-worktable-create",
    })
    const generalId = general.json.threadId as string
    const both = await find(app, "narwhal")
    expect(both.map((result) => result.threadId).sort()).toEqual([threadId, generalId].sort())
    expect(both.find((result) => result.threadId === generalId)).not.toHaveProperty("spaceId")

    expect(await find(app, "narwhal", "&kinds=doc")).toEqual([])
    expect(await find(app, "narwhal", "&kinds=thread")).toHaveLength(2)
    // A reader without threads:read finds none.
    expect(await find(appFor(agent("Finn", ["search:read", "documents:read"])), "narwhal")).toEqual([])
  })

  it("leaves archived threads out unless asked, and puts them after the rest", async () => {
    const app = appFor(finn)
    const quiet = await call(app, "POST", "/api/spaces/launch/threads", {
      to: "Atlas",
      body: "The kumquat order, settled.",
      idempotencyKey: "search-quiet-create",
    })
    const quietId = quiet.json.threadId as string
    const live = await call(app, "POST", "/api/threads", {
      to: "Atlas",
      body: "Kumquat trees for the office?",
      idempotencyKey: "search-live-create",
    })
    expect(await find(app, "kumquat")).toHaveLength(2)

    // Eight days pass without a message in one of them.
    const path = join(workspaceDir, "spaces", "launch", "threads", `${quietId}.json`)
    const file = JSON.parse(await readFile(path, "utf8"))
    const longAgo = new Date(Date.now() - 8 * 86_400_000).toISOString()
    for (const message of file.messages) message.createdAt = longAgo
    await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, "utf8")
    notifyWorkspaceChange({ type: "thread", location: { kind: "space", spaceId: "launch" }, threadId: quietId })

    const liveId = live.json.threadId as string
    expect((await find(app, "kumquat")).map((result) => result.threadId)).toEqual([liveId])
    const all = await find(app, "kumquat", "&includeArchived=true&archivedLast=true")
    expect(all.map((result) => [result.threadId, result.archived === true])).toEqual([
      [liveId, false],
      [quietId, true],
    ])
  })

  it("keeps thread entries on disk, so a restart reads only a thread that changed", async () => {
    keepSearchIndexOnDisk(true)
    const app = appFor(finn)
    const ids: string[] = []
    for (const [index, body] of ["Quince jam notes.", "Quince tart notes."].entries()) {
      const created = await call(app, "POST", "/api/threads", { to: "Atlas", body, idempotencyKey: `search-restart-${index}` })
      ids.push(created.json.threadId as string)
    }
    // Files changed moments before a read are read again until they settle.
    const hourAgo = new Date(Date.now() - 3_600_000)
    const { utimes } = await import("node:fs/promises")
    for (const id of ids) await utimes(join(workspaceDir, "threads", `${id}.json`), hourAgo, hourAgo)
    invalidateSearchIndex()
    expect(await find(app, "quince")).toHaveLength(2)

    // While the server is down, one thread gets a message.
    keepSearchIndexOnDisk(false)
    const reply = await call(app, "POST", `/api/threads/${ids[0]}/messages`, {
      body: "Add the persimmon batch.",
      idempotencyKey: "search-restart-reply",
    })
    expect(reply.status).toBe(200)
    keepSearchIndexOnDisk(true)
    let reread = 0
    setSearchIndexRebuildHookForTests(async ({ documents }) => {
      reread += documents
    })
    expect((await find(app, "persimmon")).map((result) => result.threadId)).toEqual([ids[0]])
    expect(reread).toBe(1)
  })
})
