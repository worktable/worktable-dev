import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { startServer } from "./index.ts"
import { wsManager } from "./ws.ts"
import {
  issueSessionCookie,
  setOwnerPassword,
  SESSION_COOKIE_NAME,
} from "./session-store.ts"
import { resolveParticipant } from "./participant-store.ts"
import { postThreadMessage } from "./thread-service.ts"
import { createToken, verifyToken, revokeToken } from "./token-store.ts"
import {
  convertDocToMarkdownStorage,
  getDocCollaborationCacheEpoch,
  writeDoc,
  writeSpace,
} from "./store.ts"
import {
  invalidateServerSettingsCache,
  updateServerSettings,
} from "./settings-store.ts"
import { Hono } from "hono"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"

// Real-socket coverage of the exposed-surface gates: the WS/yjs upgrade gate, the
// CORS split, and the server-refuses-without-password rule. Boots startServer on
// an ephemeral port with WORKTABLE_REQUIRE_AUTH=1.

let appDir: string
let workspaceDir: string
let savedRequireAuth: string | undefined
let savedHost: string | undefined
let savedPublicUrl: string | undefined
const servers: ReturnType<typeof startServer>[] = []

beforeEach(() => {
  appDir = mkdtempSync(join(tmpdir(), "worktable-app-"))
  workspaceDir = mkdtempSync(join(tmpdir(), "worktable-ws-"))
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(workspaceDir)
  savedRequireAuth = process.env["WORKTABLE_REQUIRE_AUTH"]
  savedHost = process.env["HOST"]
  savedPublicUrl = process.env["WORKTABLE_PUBLIC_URL"]
  delete process.env["WORKTABLE_REQUIRE_AUTH"]
  delete process.env["HOST"]
  delete process.env["WORKTABLE_PUBLIC_URL"]
  invalidateServerSettingsCache()
})

afterEach(async () => {
  for (const s of servers.splice(0)) {
    try {
      await s.stop(true)
    } catch {
      // already stopped
    }
  }
  if (savedRequireAuth === undefined)
    delete process.env["WORKTABLE_REQUIRE_AUTH"]
  else process.env["WORKTABLE_REQUIRE_AUTH"] = savedRequireAuth
  if (savedHost === undefined) delete process.env["HOST"]
  else process.env["HOST"] = savedHost
  if (savedPublicUrl === undefined) delete process.env["WORKTABLE_PUBLIC_URL"]
  else process.env["WORKTABLE_PUBLIC_URL"] = savedPublicUrl
  invalidateServerSettingsCache()
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  for (const dir of [appDir, workspaceDir]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

function boot(): { port: number } {
  const server = startServer(0, "127.0.0.1")
  servers.push(server)
  return { port: server.port ?? 0 }
}

// Produce a valid session cookie value through the production issuer.
async function makeCookie(): Promise<string> {
  const app = new Hono()
  app.get("/", async (c) => {
    await issueSessionCookie(c)
    return c.json({ ok: true })
  })
  const res = await app.fetch(new Request("https://localhost/"))
  const setCookie = res.headers.get("Set-Cookie") ?? ""
  const m = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`))
  if (!m) throw new Error("no cookie")
  return `${SESSION_COOKIE_NAME}=${m[1]}`
}

/**
 * Attempt a raw WebSocket upgrade against the server and resolve with the result:
 * "open" if the socket connected, or { status } from the HTTP rejection.
 */
function tryUpgrade(
  port: number,
  path: string,
  headers: Record<string, string>
): Promise<{ ok: true } | { ok: false; status: number }> {
  return new Promise((resolve) => {
    const url = `ws://127.0.0.1:${port}${path}`
    // Bun's WebSocket allows custom headers via the second arg's `headers`.
    const ws = new WebSocket(url, { headers } as unknown as string[])
    let settled = false
    const done = (r: { ok: true } | { ok: false; status: number }) => {
      if (settled) return
      settled = true
      try {
        ws.close()
      } catch {
        // ignore
      }
      resolve(r)
    }
    ws.onopen = () => done({ ok: true })
    ws.onerror = () => done({ ok: false, status: 403 })
    ws.onclose = (ev) => {
      // A handshake rejection closes before open. Treat any pre-open close as a
      // rejection; the exact status is opaque to the WS client, so we report 403.
      done({ ok: false, status: ev.code === 1000 ? 200 : 403 })
    }
    setTimeout(() => done({ ok: false, status: 0 }), 2000)
  })
}

async function withCollaborationEpoch(path: string): Promise<string> {
  const url = new URL(path, "http://worktable.test")
  const [, route, spaceId, ...docSegments] = url.pathname.split("/")
  if (route !== "yjs" || !spaceId || docSegments.length === 0) {
    throw new Error(`Expected a Yjs doc path, received ${path}`)
  }
  const docPath = decodeURIComponent(docSegments.join("/"))
  url.searchParams.set(
    "collaborationEpoch",
    await getWorkspaceCollaborationEpoch()
  )
  url.searchParams.set(
    "collaborationCacheEpoch",
    await getDocCollaborationCacheEpoch(spaceId, docPath)
  )
  return `${url.pathname}${url.search}`
}

function openCollectingSocket(
  port: number,
  token: string | Record<string, string>,
  spaceId: string
): Promise<{
  socket: WebSocket
  messages: Array<Record<string, unknown>>
  waitFor(type: string): Promise<Record<string, unknown>>
}> {
  return new Promise((resolve, reject) => {
    const messages: Array<Record<string, unknown>> = []
    const waiters = new Map<
      string,
      Array<(message: Record<string, unknown>) => void>
    >()
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/ws?spaceId=${encodeURIComponent(spaceId)}`,
      {
        headers: typeof token === "string" ? { Authorization: `Bearer ${token}` } : token,
      } as unknown as string[]
    )
    const timeout = setTimeout(
      () => reject(new Error("Timed out opening authenticated WebSocket")),
      2000
    )
    const waitFor = (type: string): Promise<Record<string, unknown>> => {
      const existing = messages.find((message) => message.type === type)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolveMessage, rejectMessage) => {
        const timer = setTimeout(
          () => rejectMessage(new Error(`Timed out waiting for ${type}`)),
          2000
        )
        const pending = waiters.get(type) ?? []
        pending.push((message) => {
          clearTimeout(timer)
          resolveMessage(message)
        })
        waiters.set(type, pending)
      })
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>
      messages.push(message)
      for (const complete of waiters.get(String(message.type)) ?? []) {
        complete(message)
      }
      waiters.delete(String(message.type))
      if (message.type === "subscribed") {
        clearTimeout(timeout)
        resolve({ socket, messages, waitFor })
      }
    }
    socket.onerror = () => {
      clearTimeout(timeout)
      reject(new Error("Authenticated WebSocket failed"))
    }
  })
}

describe("server refuses an exposed bind without an owner password", () => {
  it("throws when WORKTABLE_REQUIRE_AUTH=1 and no owner password is set", () => {
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    expect(() => startServer(0, "0.0.0.0")).toThrow(/owner password/i)
  })

  it("serves on loopback with no password (byte-for-byte today)", async () => {
    // Loopback always serves even with the flag set and no password.
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()
    const res = await fetch(`http://127.0.0.1:${port}/health`)
    expect(res.ok).toBe(true)
  })

  it("throws when a public URL is configured and no owner password is set", () => {
    process.env["WORKTABLE_PUBLIC_URL"] = "https://tunnel.example.com"
    expect(() => startServer(0, "127.0.0.1")).toThrow(/owner password/i)
  })

  it("throws when a stored public URL is configured and no owner password is set", async () => {
    await updateServerSettings({
      network: { publicUrl: "https://tunnel.example.com" },
    })
    expect(() => startServer(0, "127.0.0.1")).toThrow(/owner password/i)
  })
})

describe("WS upgrade gate", () => {
  it("flag OFF: /ws upgrades with no cookie and no Origin (open today)", async () => {
    const { port } = boot()
    const r = await tryUpgrade(port, "/ws?spaceId=demo", {})
    expect(r.ok).toBe(true)
  })

  it("flag ON: /ws with no cookie is rejected", async () => {
    await setOwnerPassword("owner-password")
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()
    const r = await tryUpgrade(port, "/ws?spaceId=demo", {
      Origin: `http://127.0.0.1:${port}`,
    })
    expect(r.ok).toBe(false)
  })

  it("configured public URL: /ws with no cookie is rejected on loopback", async () => {
    await setOwnerPassword("owner-password")
    process.env["WORKTABLE_PUBLIC_URL"] = "https://worktable.example.com"
    const { port } = boot()
    const r = await tryUpgrade(port, "/ws?spaceId=demo", {
      Origin: `http://127.0.0.1:${port}`,
    })
    expect(r.ok).toBe(false)
  })

  it("configured public URL: /ws with a valid same-origin cookie upgrades", async () => {
    await setOwnerPassword("owner-password")
    const cookie = await makeCookie()
    process.env["WORKTABLE_PUBLIC_URL"] = "https://worktable.example.com"
    const { port } = boot()
    const r = await tryUpgrade(port, "/ws?spaceId=demo", {
      Origin: `http://127.0.0.1:${port}`,
      Cookie: cookie,
    })
    expect(r.ok).toBe(true)
  })

  it("configured public URL: /ws honors a forwarded public host", async () => {
    await setOwnerPassword("owner-password")
    const cookie = await makeCookie()
    process.env["WORKTABLE_PUBLIC_URL"] = "https://worktable.example.com"
    const { port } = boot()
    const r = await tryUpgrade(port, "/ws?spaceId=demo", {
      Origin: "https://worktable.example.com",
      "X-Forwarded-Host": "worktable.example.com",
      Cookie: cookie,
    })
    expect(r.ok).toBe(true)
  })

  it("flag ON: /ws with a valid same-origin cookie upgrades", async () => {
    await setOwnerPassword("owner-password")
    const cookie = await makeCookie()
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()
    const r = await tryUpgrade(port, "/ws?spaceId=demo", {
      Origin: `http://127.0.0.1:${port}`,
      Cookie: cookie,
    })
    expect(r.ok).toBe(true)
  })

  it("flag ON: a valid cookie with an ABSENT Origin is rejected", async () => {
    await setOwnerPassword("owner-password")
    const cookie = await makeCookie()
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()
    const r = await tryUpgrade(port, "/ws?spaceId=demo", { Cookie: cookie })
    expect(r.ok).toBe(false)
  })

  it("flag ON: a valid cookie from a CROSS-ORIGIN Origin is rejected", async () => {
    await setOwnerPassword("owner-password")
    const cookie = await makeCookie()
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()
    const r = await tryUpgrade(port, "/ws?spaceId=demo", {
      Origin: "http://evil.example.com",
      Cookie: cookie,
    })
    expect(r.ok).toBe(false)
  })

  it("flag ON: /yjs with ?token=<bearer> upgrades (non-browser tooling, may omit Origin)", async () => {
    await setOwnerPassword("owner-password")
    const { token } = await createToken({ scopes: ["*"] })
    ensureWorkspaceManifest()
    await writeDoc("demo", "notes.md", [])
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()
    const r = await tryUpgrade(
      port,
      await withCollaborationEpoch(
        `/yjs/demo/notes.md?token=${encodeURIComponent(token)}`
      ),
      {}
    )
    expect(r.ok).toBe(true)
  })

  it("flag ON: /yjs with a garbage token is rejected", async () => {
    await setOwnerPassword("owner-password")
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()
    const r = await tryUpgrade(port, "/yjs/demo/notes.md?token=wt_bogus", {})
    expect(r.ok).toBe(false)
  })

  it("rejects a thread-only bearer from Yjs document rooms", async () => {
    await setOwnerPassword("owner-password")
    const { token } = await createToken({ scopes: ["threads:*"] })
    ensureWorkspaceManifest()
    await writeDoc("demo", "notes.md", [])
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()
    const r = await tryUpgrade(port, "/yjs/demo/notes.md", {
      Authorization: `Bearer ${token}`,
    })
    expect(r.ok).toBe(false)
  })

  // The hosted browser path. A browser cannot set headers on a WS handshake,
  // but the GATEWAY can on its upstream connect — and that header is the only
  // credential the proxied socket carries, because the gateway strips the
  // cookie (it is the gateway's own session, meaningless to the tenant) and
  // deliberately keeps the token out of the query string, where it would leak
  // into logs. Without this the hosted editor connects and is silently refused.
  it("flag ON: /yjs with an Authorization bearer upgrades (the gateway's WS path)", async () => {
    await setOwnerPassword("owner-password")
    const { token } = await createToken({ scopes: ["*"] })
    ensureWorkspaceManifest()
    await writeDoc("demo", "notes.md", [])
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()
    const r = await tryUpgrade(
      port,
      await withCollaborationEpoch("/yjs/demo/notes.md"),
      {
        Authorization: `Bearer ${token}`,
      }
    )
    expect(r.ok).toBe(true)
  })

  it("rejects stale or missing collaboration epochs from an authenticated Yjs client", async () => {
    await setOwnerPassword("owner-password")
    const { token } = await createToken({ scopes: ["*"] })
    ensureWorkspaceManifest()
    await writeDoc("demo", "notes.md", [])
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()

    const stale = await tryUpgrade(
      port,
      "/yjs/demo/notes.md?collaborationEpoch=stale",
      {
        Authorization: `Bearer ${token}`,
      }
    )
    const missing = await tryUpgrade(port, "/yjs/demo/notes.md", {
      Authorization: `Bearer ${token}`,
    })

    expect(stale.ok).toBe(false)
    expect(missing.ok).toBe(false)
  })

  it("rejects a stale per-doc cache epoch after a format transition", async () => {
    await setOwnerPassword("owner-password")
    const { token } = await createToken({ scopes: ["*"] })
    ensureWorkspaceManifest()
    await writeDoc("demo", "notes.md", [])
    const stalePath = await withCollaborationEpoch("/yjs/demo/notes.md")
    expect((await convertDocToMarkdownStorage("demo", "notes.md")).ok).toBe(
      true
    )
    await writeDoc("demo", "notes.md", [])
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()

    const stale = await tryUpgrade(port, stalePath, {
      Authorization: `Bearer ${token}`,
    })
    const current = await tryUpgrade(
      port,
      await withCollaborationEpoch("/yjs/demo/notes.md"),
      { Authorization: `Bearer ${token}` }
    )

    expect(stale.ok).toBe(false)
    expect(current.ok).toBe(true)
  })

  it("flag ON: /ws with an Authorization bearer upgrades without Origin or cookie", async () => {
    await setOwnerPassword("owner-password")
    const { token } = await createToken({ scopes: ["*"] })
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()
    const r = await tryUpgrade(port, "/ws?spaceId=demo", {
      Authorization: `Bearer ${token}`,
    })
    expect(r.ok).toBe(true)
  })

  it.each([false, true])("preserves thread-only realtime access with required auth = %s", async (required) => {
    await setOwnerPassword("owner-password")
    if (required) process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
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
    const memberCredential = await createToken({
      scopes: ["threads:read", "threads:write"],
      agent: "member@lab",
    })
    const recipientCredential = await createToken({
      scopes: ["threads:read"],
      agent: "recipient@lab",
    })
    const outsiderCredential = await createToken({
      scopes: ["threads:read"],
      agent: "outsider@lab",
    })
    const scopedHumanCredential = await createToken({
      scopes: ["threads:read"],
    })
    const member = (await verifyToken(memberCredential.token))!
    const recipient = (
      await resolveParticipant(
        (await verifyToken(recipientCredential.token))!,
        { name: "Recipient" }
      )
    ).participant
    await resolveParticipant((await verifyToken(outsiderCredential.token))!, {
      name: "Outsider",
    })

    const { port } = boot()
    const memberSocket = await openCollectingSocket(
      port,
      memberCredential.token,
      "demo"
    )
    const outsiderSocket = await openCollectingSocket(
      port,
      outsiderCredential.token,
      "demo"
    )
    const scopedHumanSocket = await openCollectingSocket(
      port,
      scopedHumanCredential.token,
      "demo"
    )
    try {
      wsManager.broadcast("demo", {
        type: "doc_update",
        spaceId: "demo",
        docPath: "private.md",
        data: { content: "This body requires docs:read." },
      })
      wsManager.broadcast("demo", {
        type: "record_update",
        spaceId: "demo",
        collectionId: "private",
        recordId: "record",
        data: { title: "This body requires records:read." },
      })
      wsManager.broadcast("demo", {
        type: "participants_update",
        spaceId: "demo",
      })
      await memberSocket.waitFor("participants_update")
      expect(
        memberSocket.messages.some(
          (message) =>
            message.type === "doc_update" || message.type === "record_update"
        )
      ).toBe(false)

      const posted = await postThreadMessage(member, {
        spaceId: "demo",
        to: recipient.id,
        body: "Workspace collaborators may see this body.",
        idempotencyKey: "ws-workspace-thread",
      })
      const update = await memberSocket.waitFor("thread_update")
      const outsiderUpdate = await outsiderSocket.waitFor("thread_update")
      const scopedHumanUpdate =
        await scopedHumanSocket.waitFor("thread_update")
      const scopedHumanRead = await fetch(
        `http://127.0.0.1:${port}/api/spaces/demo/threads`,
        {
          headers: {
            Authorization: `Bearer ${scopedHumanCredential.token}`,
          },
        }
      )

      expect(update).toMatchObject({
        threadId: posted.threadId,
        data: {
          messages: [{ body: "Workspace collaborators may see this body." }],
        },
      })
      expect(outsiderUpdate).toMatchObject({
        threadId: posted.threadId,
        data: {
          messages: [{ body: "Workspace collaborators may see this body." }],
        },
      })
      expect(scopedHumanRead.status).toBe(200)
      expect(
        (await scopedHumanRead.json()) as { threads: unknown[] }
      ).toMatchObject({ threads: [{ id: posted.threadId }] })
      expect(scopedHumanUpdate).toMatchObject({
        threadId: posted.threadId,
        data: {
          messages: [{ body: "Workspace collaborators may see this body." }],
        },
      })
      const revoked = scopedHumanSocket.waitFor("error")
      await revokeToken(scopedHumanCredential.metadata.id)
      expect(await revoked).toMatchObject({ error: "Credential revoked" })
      expect(wsManager.subscriberCount("demo")).toBe(2)
      expect(memberSocket.socket.readyState).toBe(WebSocket.OPEN)
      expect((await tryUpgrade(port, `/ws?spaceId=demo&token=${encodeURIComponent(scopedHumanCredential.token)}`, {})).ok).toBe(false)
      if (required) {
        const cookie = await makeCookie()
        const headers = { Cookie: cookie, Origin: `http://127.0.0.1:${port}` }
        const ownerSocket = await openCollectingSocket(port, headers, "demo")
        try {
          const signedOut = ownerSocket.waitFor("error")
          const response = await fetch(`http://127.0.0.1:${port}/auth/logout-everywhere`, { method: "POST", headers })
          expect(response.status).toBe(200)
          expect(await signedOut).toMatchObject({ error: "Credential revoked" })
          expect(wsManager.subscriberCount("demo")).toBe(2)
        } finally {
          ownerSocket.socket.close()
        }
      }
    } finally {
      memberSocket.socket.close()
      outsiderSocket.socket.close()
      scopedHumanSocket.socket.close()
    }
  })

  it("flag ON: /yjs with a garbage Authorization bearer is rejected", async () => {
    await setOwnerPassword("owner-password")
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()
    const r = await tryUpgrade(port, "/yjs/demo/notes.md", {
      Authorization: "Bearer wt_bogus",
    })
    expect(r.ok).toBe(false)
  })

  it("flag ON: a malformed Authorization header does not bypass the gate", async () => {
    await setOwnerPassword("owner-password")
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()
    // Not "Bearer <token>" — must fall through to the Origin/cookie path and
    // be refused, never treated as authenticated.
    const r = await tryUpgrade(port, "/yjs/demo/notes.md", {
      Authorization: "Bearer",
    })
    expect(r.ok).toBe(false)
  })
})

describe("CORS split", () => {
  it("session mode: /api/* preflight reflects a same-origin Origin with credentials:true", async () => {
    await setOwnerPassword("owner-password")
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()
    const origin = `http://127.0.0.1:${port}`
    const res = await fetch(`http://127.0.0.1:${port}/api/spaces`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
      },
    })
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin)
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true")
  })

  it("configured public URL: /api/* preflight uses same-origin credentialed CORS", async () => {
    await setOwnerPassword("owner-password")
    process.env["WORKTABLE_PUBLIC_URL"] = "https://worktable.example.com"
    const { port } = boot()
    const origin = `http://127.0.0.1:${port}`
    const res = await fetch(`http://127.0.0.1:${port}/api/spaces`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
      },
    })
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin)
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true")
  })

  it("configured public URL: /api/* preflight honors forwarded public host", async () => {
    await setOwnerPassword("owner-password")
    process.env["WORKTABLE_PUBLIC_URL"] = "https://worktable.example.com"
    const { port } = boot()
    const res = await fetch(`http://127.0.0.1:${port}/api/spaces`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://worktable.example.com",
        "X-Forwarded-Host": "worktable.example.com",
        "Access-Control-Request-Method": "GET",
      },
    })
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://worktable.example.com"
    )
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true")
  })

  it("session mode: /api/* does NOT reflect a foreign Origin", async () => {
    await setOwnerPassword("owner-password")
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()
    const res = await fetch(`http://127.0.0.1:${port}/api/spaces`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://evil.example.com",
        "Access-Control-Request-Method": "GET",
      },
    })
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe(
      "http://evil.example.com"
    )
  })

  it("/mcp stays origin:* with no credentials even when exposed", async () => {
    await setOwnerPassword("owner-password")
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    const { port } = boot()
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://evil.example.com",
        "Access-Control-Request-Method": "POST",
      },
    })
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*")
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull()
  })
})


// The model is the same on both listeners: credentials retain their authority,
// and ambient local trust belongs only to the local app / non-browser tooling.
describe("local access boundary model", () => {
  it("does not grant ambient owner access to foreign or opaque browser requests", async () => {
    const { port } = boot()
    const origin = `http://127.0.0.1:${port}`
    for (const headers of [
      { Origin: "https://other.example.test" },
      { Origin: "null" },
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
      { "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" },
      { "Sec-Fetch-Mode": "navigate" },
      { Host: "other.example.test" },
    ] as Record<string, string>[]) {
      const res = await fetch(`${origin}/api/spaces`, { headers })
      expect(res.status).toBe(401)
      const mint = await fetch(`${origin}/api/tokens`, {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ scopes: ["*"] }),
      })
      expect(mint.status).toBe(401)
      expect((await tryUpgrade(port, "/ws?spaceId=demo", headers)).ok).toBe(false)
    }
    for (const headers of [{ Origin: "null" }, { Origin: "https://other.example.test" }, { "Sec-Fetch-Site": "same-site" }] as Record<string, string>[]) {
      const res = await fetch(`${origin}/auth/password`, {
        method: "POST", headers: { ...headers, "Content-Type": "text/plain" },
        body: JSON.stringify({ password: "synthetic-audit-password" }),
      })
      expect(res.status).toBe(403)
    }
    for (const authorization of ["Bearer", "Bearer ", "Basic invalid"]) {
      expect((await fetch(`${origin}/api/spaces`, { headers: { Authorization: authorization } })).status).toBe(401)
      expect((await tryUpgrade(port, "/ws?spaceId=demo", { Authorization: authorization })).ok).toBe(false)
    }
    for (const headers of [{}, { "Sec-Fetch-Mode": "cors" }, { Origin: origin, "Sec-Fetch-Site": "same-origin" }] as Record<string, string>[]) {
      expect((await fetch(`${origin}/api/spaces`, { headers })).status).toBe(200)
      expect((await tryUpgrade(port, "/ws?spaceId=demo", headers)).ok).toBe(true)
    }
    expect((await tryUpgrade(port, "/ws?spaceId=demo&token=invalid", {})).ok).toBe(false)
    expect((await tryUpgrade(port, "/ws?spaceId=demo", { Authorization: "Bearer invalid" })).ok).toBe(false)
  })

  it.each([false, true])("enforces legacy REST scopes with required auth = %s", async (required) => {
    await setOwnerPassword("synthetic-owner-password")
    if (required) process.env["WORKTABLE_REQUIRE_AUTH"] = "1"
    ensureWorkspaceManifest()
    const now = new Date().toISOString()
    await writeSpace({ type: "worktable.space", version: 1, id: "demo", name: "Synthetic audit", createdAt: now, updatedAt: now, createdBy: "test", settings: {} })
    await writeDoc("demo", "private", [{ id: "audit", type: "paragraph", props: {}, content: [{ type: "text", text: "SYNTHETIC_BOUNDARY_CONTENT", styles: {} }], children: [] }])
    const { token } = await createToken({ scopes: ["threads:read"] })
    const { token: owner } = await createToken({ scopes: ["*"] })
    const { port } = boot()
    const origin = `http://127.0.0.1:${port}`
    const cases = [
      ["GET", "/api/spaces"], ["GET", "/api/spaces/demo/index"],
      ["GET", "/api/spaces/demo/docs/private"], ["PUT", "/api/spaces/demo/docs/private"],
      ["POST", "/api/spaces/demo/docs/resolve-references"],
      ["GET", "/api/spaces/demo/widgets"], ["PUT", "/api/spaces/demo/widgets/missing/state"],
      ["GET", "/api/spaces/demo/records"], ["POST", "/api/spaces/demo/records/missing/query"],
      ["POST", "/api/spaces/demo/records"], ["GET", "/api/spaces/demo/annotations"],
      ["POST", "/api/spaces/demo/annotations"], ["GET", "/api/spaces/demo/doc-aliases"],
      ["DELETE", "/api/spaces/demo/doc-aliases/exact/missing"],
      ["GET", "/api/spaces/demo/documents/source?path=private"],
      ["DELETE", "/api/spaces/demo"],
    ] as const
    for (const [method, path] of cases) {
      const res = await fetch(`${origin}${path}`, { method, headers: { Authorization: `Bearer ${token}` } })
      expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 })
    }
    const reads = [
      ["docs:read", "/api/spaces/demo/docs/private"],
      ["records:read", "/api/spaces/demo/records"],
      ["widgets:read", "/api/spaces/demo/widgets"],
      ["annotations:read", "/api/spaces/demo/annotations"],
      ["documents:read", "/api/spaces/demo/doc-aliases"],
    ] as const
    // Finite authority model: each domain can read itself, never a sibling;
    // read authority cannot mutate document contents or whole-space state.
    for (const [scope] of reads) {
      const credential = await createToken({ scopes: [scope] })
      const headers = { Authorization: `Bearer ${credential.token}` }
      for (const [requiredScope, path] of reads) {
        expect((await fetch(`${origin}${path}`, { headers })).status).toBe(scope === requiredScope ? 200 : 403)
      }
      for (const [method, path] of [["PUT", "/api/spaces/demo/docs/private"], ["DELETE", "/api/spaces/demo"]]) {
        expect((await fetch(`${origin}${path}`, { method, headers })).status).toBe(403)
      }
    }
    const writer = await createToken({ scopes: ["docs:write"] })
    const writerHeaders = { Authorization: `Bearer ${writer.token}`, "Content-Type": "application/json" }
    expect((await fetch(`${origin}/api/spaces`, { method: "POST", headers: writerHeaders, body: JSON.stringify({ name: "Synthetic writer space" }) })).status).toBe(201)
    expect((await fetch(`${origin}/api/spaces/demo/docs/private`, { headers: writerHeaders })).status).toBe(403)
    expect((await fetch(`${origin}/api/spaces/demo`, { method: "DELETE", headers: writerHeaders })).status).toBe(403)
    const agent = await createToken({ scopes: ["docs:*", "widgets:*", "annotations:*", "records:*"], agent: "synthetic-writer" })
    const agentHeaders = { Authorization: `Bearer ${agent.token}`, "Content-Type": "application/json" }
    const content = [{ type: "paragraph", content: [{ type: "text", text: "SYNTHETIC_BOUNDARY_CONTENT_AGENT", styles: {} }] }]
    expect((await fetch(`${origin}/api/spaces/demo/docs/private`, { method: "PUT", headers: agentHeaders, body: JSON.stringify({ content }) })).status).toBe(200)
    const afterWrite = await fetch(`${origin}/api/spaces/demo/docs/private`, { headers: agentHeaders })
    const document = await afterWrite.json() as { freshness: { humanReviewed: boolean }, provenance: { updatedBy: string } }
    expect(document.freshness.humanReviewed).toBe(false)
    expect(document.provenance.updatedBy).toStartWith("agent:")
    const archivedDoc = await fetch(`${origin}/api/spaces/demo/docs/private/archive`, { method: "POST", headers: agentHeaders, body: JSON.stringify({ archivedBy: "user" }) })
    expect(archivedDoc.status).toBe(200)
    expect((await archivedDoc.json() as { archived: { archivedBy: string } }).archived.archivedBy).toStartWith("agent:")
    const newSpace = await fetch(`${origin}/api/spaces`, { method: "POST", headers: agentHeaders, body: JSON.stringify({ name: "Synthetic agent space", createdBy: "user" }) })
    expect(newSpace.status).toBe(201)
    const createdSpace = await newSpace.json() as { spaceId: string }
    const space = await fetch(`${origin}/api/spaces/${createdSpace.spaceId}`, { headers: agentHeaders })
    expect(JSON.stringify(await space.json())).toContain('"createdBy":"agent:')
    const annotation = await fetch(`${origin}/api/spaces/demo/annotations`, { method: "POST", headers: agentHeaders, body: JSON.stringify({ target: { type: "doc", docPath: "private" }, category: "comment", body: "Synthetic comment", author: { type: "user", id: "user" } }) })
    expect(annotation.status).toBe(200)
    const createdAnnotation = await annotation.json() as { annotationId: string, annotation: { author: { type: string, id: string } } }
    expect(createdAnnotation.annotation.author.type).toBe("agent")
    expect(createdAnnotation.annotation.author.id).not.toBe("user")
    const collectionPath = `${origin}/api/spaces/demo/records`
    for (const status of [201, 200]) {
      const collection = await fetch(collectionPath, { method: "POST", headers: agentHeaders, body: JSON.stringify({ id: "synthetic-records", name: "Synthetic records", createdBy: "user", fields: { title: { type: "text" } } }) })
      expect(collection.status).toBe(status)
      const metadata = await collection.json() as { collection: { createdBy: string, updatedBy?: string } }
      expect(status === 201 ? metadata.collection.createdBy : metadata.collection.updatedBy).toStartWith("agent:")
    }
    const createdRecord = await fetch(`${collectionPath}/synthetic-records`, { method: "POST", headers: agentHeaders, body: JSON.stringify({ id: "synthetic-record", data: { title: "Synthetic row" }, createdBy: "user" }) })
    expect(createdRecord.status).toBe(201)
    expect((await createdRecord.json() as { record: { createdBy: string } }).record.createdBy).toStartWith("agent:")
    const recordPath = `${collectionPath}/synthetic-records/synthetic-record`
    const updatedRecord = await fetch(recordPath, { method: "PATCH", headers: agentHeaders, body: JSON.stringify({ data: { title: "Synthetic changed row" }, updatedBy: "user" }) })
    expect(updatedRecord.status).toBe(200)
    expect((await updatedRecord.json() as { record: { updatedBy: string } }).record.updatedBy).toStartWith("agent:")
    for (const action of ["archive", "restore"]) {
      const result = await fetch(`${recordPath}/${action}`, { method: "POST", headers: agentHeaders, body: JSON.stringify({ archivedBy: "user" }) })
      expect(result.status).toBe(200)
      const metadata = await result.json() as { record: { updatedBy: string, archive: null | { archivedBy: string } } }
      expect(metadata.record.updatedBy).toStartWith("agent:")
      if (action === "archive") expect(metadata.record.archive?.archivedBy).toStartWith("agent:")
      else expect(metadata.record.archive).toBeNull()
    }
    const reply = await fetch(`${origin}/api/spaces/demo/annotations/${createdAnnotation.annotationId}/replies`, { method: "POST", headers: agentHeaders, body: JSON.stringify({ body: "Synthetic reply", author: { type: "user", id: "user" } }) })
    expect(reply.status).toBe(200)
    expect((await reply.json() as { annotation: { thread: Array<{ author: { type: string } }> } }).annotation.thread.at(-1)?.author.type).toBe("agent")
    for (const action of ["review", "versions/checkpoint"]) {
      expect((await fetch(`${origin}/api/spaces/demo/docs/private/${action}`, { method: "POST", headers: agentHeaders, body: "{}" })).status).toBe(403)
    }
    const widgetCreated = await fetch(`${origin}/api/spaces/demo/widgets`, {
      method: "POST", headers: agentHeaders,
      body: JSON.stringify({ id: "synthetic-agent-widget", name: "Synthetic agent widget", createdBy: "user", html: "<!doctype html><html><head></head><body><p>Synthetic widget</p></body></html>" }),
    })
    expect(widgetCreated.status).toBe(201)
    const { widgetId } = await widgetCreated.json() as { widgetId: string }
    const widgetPath = `/api/spaces/demo/widgets/__document/${Buffer.from(widgetId).toString("base64url")}`
    for (const action of ["review", "versions/checkpoint"]) {
      expect((await fetch(`${origin}${widgetPath}/${action}`, { method: "POST", headers: agentHeaders, body: "{}" })).status).toBe(403)
    }
    const widgetResponse = await fetch(`${origin}/api/spaces/demo/widgets`, { headers: agentHeaders })
    const widgetResult = await widgetResponse.json() as { widgets: Array<{ id: string, freshness: { humanReviewed: boolean } }> }
    expect(widgetResult.widgets.find(widget => widget.id === widgetId)?.freshness.humanReviewed).toBe(false)
    for (const action of ["archive", "restore"]) {
      const archivedWidget = await fetch(`${origin}${widgetPath}/${action}`, { method: "POST", headers: agentHeaders, body: JSON.stringify({ archivedBy: "user" }) })
      expect(archivedWidget.status).toBe(200)
      expect((await archivedWidget.json() as { widget: { updatedBy: string } }).widget.updatedBy).toStartWith("agent:")
    }
    expect((await tryUpgrade(port, await withCollaborationEpoch(`/yjs/demo/private?token=${encodeURIComponent(agent.token)}`), {})).ok).toBe(false)
    const fullAgent = await createToken({ scopes: ["*"], agent: "synthetic-owner-scope-agent" })
    expect((await fetch(`${origin}/api/spaces/demo/docs/private/review`, { method: "POST", headers: { Authorization: `Bearer ${fullAgent.token}` } })).status).toBe(403)
    for (const delegatedAgent of [undefined, null, "", "  ", "synthetic-delegated-agent"]) {
      const delegated = await fetch(`${origin}/api/tokens`, { method: "POST", headers: { Authorization: `Bearer ${fullAgent.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ scopes: ["*"], agent: delegatedAgent }) })
      expect(delegated.status).toBe(201)
      const credential = await delegated.json() as { token: string, metadata: { principal: { type: string } } }
      expect(credential.metadata.principal.type).toBe("agent")
      expect((await fetch(`${origin}/api/spaces/demo/docs/private/review`, { method: "POST", headers: { Authorization: `Bearer ${credential.token}` } })).status).toBe(403)
    }
    expect((await fetch(`${origin}/api/spaces/demo/docs/private/review`, { method: "POST", headers: { Authorization: `Bearer ${owner}` } })).status).toBe(200)
    const control = await fetch(`${origin}/api/spaces/demo/docs/private`, { headers: { Authorization: `Bearer ${owner}` } })
    expect(control.status).toBe(200)
    expect(await control.text()).toContain("SYNTHETIC_BOUNDARY_CONTENT")
    expect((await tryUpgrade(port, await withCollaborationEpoch(`/yjs/demo/private?token=${encodeURIComponent(token)}`), {})).ok).toBe(false)
  })
})
