import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { drainActivity } from "./activity-log.ts"
import { setAppDirOverride } from "./app-storage.ts"
import { createAnnotation } from "./annotation-store.ts"
import {
  CLOUD_TASK_ERRORS,
  startCloudTaskRuntime,
} from "./cloud-task-runtime.ts"
import { cloudTaskFor, type CloudTask } from "./cloud-task-store.ts"
import { resolveParticipant } from "./participant-store.ts"
import { pendingList } from "./pending-list.ts"
import { readPending } from "./pending-read.ts"
import { agentConnectionsRouter } from "./routes/agent-connections.ts"
import { authSessionRouter } from "./routes/auth-session.ts"
import { SESSION_COOKIE_NAME, setOwnerPassword } from "./session-store.ts"
import { writeDoc, writeSpace } from "./store.ts"
import { verifyToken, type TokenIdentity } from "./token-store.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"

// Claude gets Auto-reply from a Claude Code scheduled task that Worktable
// fires. These tests stand in for Anthropic's API with a fetch, so nothing
// leaves the process, and move the clock instead of waiting.

const URL_OK =
  "https://api.anthropic.com/v1/claude_code/routines/trig_01abc/fire"
const TOKEN = "sk-ant-oat01-test-token"
const SESSION = "https://claude.ai/code/session_01"

let appDir: string
let root: string
let app: Hono
let cookie: string
let claude: TokenIdentity
let connectionId: string
let participantId: string
let stop: (() => Promise<void>) | undefined
const saved: Record<string, string | undefined> = {}

interface Call {
  url: string
  headers: Record<string, string>
  body: string
}
let calls: Call[]
/** What the API answers, in turn; then it starts a run. */
let answers: Array<() => Response | Promise<Response>>

const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  calls.push({
    url: String(url),
    headers: init?.headers as Record<string, string>,
    body: String(init?.body),
  })
  const answer = answers.shift()
  return answer
    ? answer()
    : Response.json({
        type: "routine_fire",
        claude_code_session_id: "session_01",
        claude_code_session_url: SESSION,
      })
}) as typeof fetch

let waiters: Array<() => void> = []
const settled = () => new Promise<void>((resolve) => waiters.push(resolve))

/** Wait until `check` holds, looking again each time the runtime settles. */
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (;;) {
    const next = settled()
    if (await check()) return
    await next
  }
}

/** Start the runtime, or start it again as after a restart, and let it run once. */
async function restart(): Promise<void> {
  await stop?.()
  const done = settled()
  stop = startCloudTaskRuntime({
    fetch: fakeFetch,
    onSettled: () => {
      for (const resolve of waiters.splice(0)) resolve()
    },
  })
  await done
}

/** Move the clock on, then restart so what is due now runs. */
async function later(ms: number): Promise<void> {
  setSystemTime(new Date(Date.now() + ms))
  await restart()
}

const task = async (): Promise<CloudTask> =>
  (await cloudTaskFor(participantId))!

async function api(
  method: string,
  path: string,
  body?: unknown
): Promise<Response> {
  return await app.fetch(
    new Request(`http://localhost/api/agent-connections${path}`, {
      method,
      headers: {
        Cookie: cookie,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  )
}

/** The Claude agent's auto-reply, and the whole answer as text. */
async function listed(): Promise<{ autoReply: unknown; text: string }> {
  const text = await (await api("GET", "")).text()
  const { connections } = JSON.parse(text) as {
    connections: Array<{ id: string; autoReply?: unknown }>
  }
  return {
    autoReply: connections.find((c) => c.id === connectionId)?.autoReply,
    text,
  }
}

async function comment(body: string): Promise<void> {
  await createAnnotation("pricing", {
    target: { type: "doc", docPath: "plan" },
    category: "comment",
    body,
    author: { type: "user", id: "user", name: "Owner" },
    byPerson: true,
    to: [{ id: participantId, kind: "agent", name: "Claude" }],
  })
}

beforeEach(async () => {
  for (const name of [
    "WORKTABLE_REQUIRE_AUTH",
    "WORKTABLE_HOSTED",
    "WORKTABLE_MCP_PREVIEW",
  ])
    saved[name] = process.env[name]
  delete process.env["WORKTABLE_HOSTED"]
  process.env["WORKTABLE_MCP_PREVIEW"] = "1"
  appDir = await mkdtemp(join(tmpdir(), "worktable-cloud-task-app-"))
  root = await mkdtemp(join(tmpdir(), "worktable-cloud-task-work-"))
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(root)
  ensureWorkspaceManifest()
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: "pricing",
    name: "Pricing",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  })
  await writeDoc("pricing", "plan", "# Plan\n\nTeam is $49 a month.\n")

  app = new Hono()
  app.route("/auth", authSessionRouter)
  app.route("/api/agent-connections", agentConnectionsRouter)
  await setOwnerPassword("correct-horse-battery")
  const login = await app.fetch(
    new Request("http://localhost/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "correct-horse-battery" }),
    })
  )
  const value = login.headers
    .get("Set-Cookie")
    ?.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))?.[1]
  cookie = `${SESSION_COOKIE_NAME}=${value}`
  process.env["WORKTABLE_REQUIRE_AUTH"] = "1"

  const created = (await (
    await api("POST", "", { client: "claude-desktop" })
  ).json()) as { token: string; connection: { id: string } }
  connectionId = created.connection.id
  claude = (await verifyToken(created.token))!
  participantId = (await resolveParticipant(claude)).participant.id
  await pendingList()

  calls = []
  answers = []
  waiters = []
  await restart()
})

afterEach(async () => {
  await stop?.()
  stop = undefined
  setSystemTime()
  await drainActivity()
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  await rm(appDir, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
})

describe("Claude's cloud task", () => {
  it("takes only an Anthropic task trigger, and never shows its URL or token", async () => {
    expect((await listed()).autoReply).toEqual({ kind: "task", state: "off" })
    for (const url of [
      "http://api.anthropic.com/v1/claude_code/routines/trig_01abc/fire",
      "https://api.anthropic.com.example/v1/claude_code/routines/trig_01abc/fire",
      "https://api.anthropic.com/v1/claude_code/routines/01abc/fire",
      "https://api.anthropic.com/v1/messages",
      `${URL_OK}?redirect=1`,
    ])
      expect(
        (await api("PUT", `/${connectionId}/cloud-task`, { url, token: TOKEN }))
          .status
      ).toBe(400)
    expect(
      (
        await api("PUT", `/${connectionId}/cloud-task`, {
          url: URL_OK,
          token: "not a token",
        })
      ).status
    ).toBe(400)
    expect(calls).toHaveLength(0)

    expect(
      (
        await api("PUT", `/${connectionId}/cloud-task`, {
          url: URL_OK,
          token: TOKEN,
        })
      ).status
    ).toBe(200)
    await until(async () => Boolean((await task()).sessionUrl))
    const { autoReply, text } = await listed()
    expect(autoReply).toEqual({ kind: "task", state: "off", testing: true })
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain("trig_")

    // The preview holds it back, and only Claude has one.
    process.env["WORKTABLE_MCP_PREVIEW"] = "0"
    expect((await listed()).autoReply).toBeUndefined()
    expect((await api("POST", `/${connectionId}/cloud-task/test`)).status).toBe(
      404
    )
    process.env["WORKTABLE_MCP_PREVIEW"] = "1"

    expect((await api("DELETE", `/${connectionId}/cloud-task`)).status).toBe(
      200
    )
    expect((await listed()).autoReply).toEqual({ kind: "task", state: "off" })
  })

  it("is on once a test reaches Claude, and fires once per run for a burst", async () => {
    await api("PUT", `/${connectionId}/cloud-task`, {
      url: URL_OK,
      token: TOKEN,
    })
    await until(async () => Boolean((await task()).sessionUrl))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(URL_OK)
    expect(calls[0]!.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      "anthropic-version": "2023-06-01",
    })
    // Only a signal: the run reads what was sent with its own sign-in.
    expect(JSON.parse(calls[0]!.body)).toEqual({
      text: "Something was sent to you in Worktable.",
    })

    // The run checks Worktable as Claude, which finds the test thread.
    const shown = await readPending(claude, { mode: "notices" })
    expect(shown.items?.map((item) => item.kind)).toEqual(["threadRequest"])
    await until(async () => Boolean((await task()).verifiedAt))
    expect((await listed()).autoReply).toEqual({ kind: "task", state: "on" })

    // A burst gathers into one fire.
    await comment("Team at 49 feels high.")
    await comment("Try 39?")
    await comment("Or 45.")
    await until(async () => (await task()).nextAt !== undefined)
    expect(calls).toHaveLength(1)
    await later(11_000)
    expect(calls).toHaveLength(2)

    // Nothing more fires until that run checks in.
    await comment("One more while it runs.")
    await later(11_000)
    expect(calls).toHaveLength(2)

    // It checks in having seen only a count: what came after its fire fires again.
    await readPending(claude)
    await until(async () => (await task()).nextAt !== undefined)
    await later(11_000)
    expect(calls).toHaveLength(3)

    // A run that never checks in stops it until the owner looks.
    await later(15 * 60_000)
    expect((await listed()).autoReply).toEqual({
      kind: "task",
      state: "attention",
      error: CLOUD_TASK_ERRORS.silent,
    })
    await comment("Still there?")
    await later(11_000)
    expect(calls).toHaveLength(3)
  })

  it("never fires twice for one batch, waits when told to, and stops when refused", async () => {
    // The send fails without an answer: a run may have started.
    answers.push(() => {
      throw new Error("connection reset")
    })
    await api("PUT", `/${connectionId}/cloud-task`, {
      url: URL_OK,
      token: TOKEN,
    })
    await until(() => calls.length === 1)
    await restart()
    expect(calls).toHaveLength(1)

    // Testing again is the owner's call. Too many runs: wait as asked.
    answers.push(
      () =>
        new Response(null, { status: 429, headers: { "retry-after": "120" } })
    )
    await api("POST", `/${connectionId}/cloud-task/test`)
    await until(async () => (await task()).attempts === 1)
    await restart()
    expect(calls).toHaveLength(2)

    // A refused token stops it, with what to fix.
    answers.push(() => new Response(null, { status: 401 }))
    await later(121_000)
    expect(calls).toHaveLength(3)
    expect((await listed()).autoReply).toEqual({
      kind: "task",
      state: "attention",
      error: CLOUD_TASK_ERRORS[401],
    })
    await comment("Team at 49 feels high.")
    await later(11_000)
    expect(calls).toHaveLength(3)
  })
})
