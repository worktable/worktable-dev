import {
  setLinkEnabled,
  disconnectLink,
  startLinkedRuntime,
  linkedStatus,
} from "./linked-runtime.ts"
import { createDocumentShare, resolveDocumentShare } from "./share-store.ts"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import fc from "fast-check"
import { setAppDirOverride } from "./app-storage.ts"
import { setWorkspaceRootOverride, workspaceCacheKey } from "./workspace.ts"
import {
  cloudAccountStatus,
  cloudLinkRequest,
  completeCloudSignIn,
  signOutCloudAccount,
  startCloudSignIn,
} from "./cloud-account.ts"

let root: string
const realFetch = globalThis.fetch
let exchanges = 0
let refreshes = 0
let linkActions = 0
let expiry = new Date(Date.now() + 300_000).toISOString()
let refreshStatus = 200
let exchangeStatus = 200
const origin = "http://127.0.0.1:49180"
const cloud = "https://app.worktable.cloud"
let state = ""
let paused = false
let heartbeatAttempted: Promise<void>
let resolveHeartbeatAttempted: () => void
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-cloud-account-"))
  setAppDirOverride(join(root, "app"))
  setWorkspaceRootOverride(join(root, "workspace"))
  exchanges = refreshes = linkActions = 0
  expiry = new Date(Date.now() + 300_000).toISOString()
  refreshStatus = 200
  exchangeStatus = 200
  paused = false
  heartbeatAttempted = new Promise((resolve) => {
    resolveHeartbeatAttempted = resolve
  })
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (url === `${cloud}/linked/heartbeat`) {
      resolveHeartbeatAttempted()
      throw new Error("Cloud unavailable")
    }
    if (!url.startsWith(`${cloud}/gateway/local/`))
      throw new Error("Unexpected network request")
    const body = JSON.parse(String(init?.body))
    if (url.endsWith("auth/start")) {
      state = crypto.randomUUID()
      return Response.json({
        authorizationUrl: `https://api.workos.com/user_management/authorize?state=${state}&code_challenge_method=S256`,
        state,
        codeVerifier: "v".repeat(43),
        expiresAt: Date.now() + 600_000,
      })
    }
    if (url.endsWith("auth/exchange")) {
      exchanges++
      expect(body.state).toBe(state)
      expect(body.codeVerifier).toBe("v".repeat(43))
      if (exchangeStatus === 503)
        return Response.json(
          { refreshToken: "private-continuation", expectedUserId: "owner" },
          { status: 503 }
        )
      return Response.json({
        accessToken: "private-access",
        refreshToken: "private-refresh",
        accessTokenExpiresAt: expiry,
        user: { id: "owner", email: "owner@example.com" },
      })
    }
    if (url.endsWith("auth/refresh")) {
      refreshes++
      expect(body.expectedUserId).toBe("owner")
      return Response.json(
        refreshStatus === 200
          ? {
              accessToken: "private-refreshed",
              refreshToken: "private-rotated",
              accessTokenExpiresAt: new Date(
                Date.now() + 300_000
              ).toISOString(),
              user: { id: "owner", email: "owner@example.com" },
            }
          : refreshStatus === 503
            ? { refreshToken: "private-rotated" }
            : {},
        { status: refreshStatus }
      )
    }
    if (url.endsWith("/link")) {
      linkActions++
      if (body.action === "pause") paused = body.paused
      return Response.json({
        destinationId: "a".repeat(32),
        state: paused ? "paused" : "online",
      })
    }
    throw new Error("Unknown endpoint")
  }) as typeof fetch
})
afterEach(async () => {
  await signOutCloudAccount()
  globalThis.fetch = realFetch
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  await rm(root, { recursive: true, force: true })
})
const callback = (s = state) =>
  new URL(`${origin}/api/linked/account/callback?state=${s}&code=one-use-code`)

test("local sign-in consumes only the matching callback and does not enable Link", async () => {
  await startCloudSignIn(origin)
  await fc.assert(
    fc.asyncProperty(
      fc.string().filter((value) => value !== state),
      async (value) => {
        expect(
          await completeCloudSignIn(callback(encodeURIComponent(value)))
        ).toBe(false)
      }
    ),
    { numRuns: 30 }
  )
  expect(exchanges).toBe(0)
  const wrongOrigin = callback()
  wrongOrigin.host = "other.example"
  expect(await completeCloudSignIn(wrongOrigin)).toBe(false)
  expect(
    await Promise.all([
      completeCloudSignIn(callback()),
      completeCloudSignIn(callback()),
    ])
  ).toEqual([true, false])
  expect(exchanges).toBe(1)
  expect(linkActions).toBe(0)
  const visible = await cloudAccountStatus()
  expect(visible.user?.email).toBe("owner@example.com")
  expect(JSON.stringify(visible)).not.toContain("private-")
  const file = join(
    root,
    "app",
    "linked",
    `${workspaceCacheKey()}.account.json`
  )
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  await startCloudSignIn("https://self-hosted.example")
  const proxied = new Request(
    `http://127.0.0.1:7480/api/linked/account/callback?state=${state}&code=one-use-code`,
    {
      headers: {
        "X-Forwarded-Host": "self-hosted.example",
        "X-Forwarded-Proto": "https",
      },
    }
  )
  expect(await completeCloudSignIn(proxied)).toBe(true)
})

test("cancellation and workspace changes invalidate callbacks, and concurrent actions serialize rotating refresh credentials", async () => {
  await startCloudSignIn(origin)
  const cancelledByBrowser = callback()
  cancelledByBrowser.searchParams.delete("code")
  cancelledByBrowser.searchParams.set("error", "sign_in_cancelled")
  expect(await completeCloudSignIn(cancelledByBrowser)).toBe(false)
  expect((await cloudAccountStatus()).signingIn).toBe(false)
  await startCloudSignIn(origin)
  const cancelled = callback()
  await signOutCloudAccount()
  expect(await completeCloudSignIn(cancelled)).toBe(false)
  await startCloudSignIn(origin)
  const previousWorkspace = callback()
  setWorkspaceRootOverride(join(root, "replacement"))
  expect(await completeCloudSignIn(previousWorkspace)).toBe(false)
  expect(exchanges).toBe(0)
  expiry = new Date(0).toISOString()
  await startCloudSignIn(origin)
  expect(await completeCloudSignIn(callback())).toBe(true)
  await Promise.all([
    cloudLinkRequest(cloud, { action: "pause" }),
    cloudLinkRequest(cloud, { action: "pause" }),
  ])
  expect(refreshes).toBe(1)
  const file = join(
    root,
    "app",
    "linked",
    `${workspaceCacheKey()}.account.json`
  )
  expect(JSON.parse(await readFile(file, "utf8")).refreshToken).toBe(
    "private-rotated"
  )
  await signOutCloudAccount()
  await expect(cloudLinkRequest(cloud, {})).rejects.toThrow("Sign in")
})

test("an expired account is cleared only on provider rejection, not a transient outage", async () => {
  exchangeStatus = refreshStatus = 503
  await startCloudSignIn(origin)
  expect(await completeCloudSignIn(callback())).toBe(false)
  expect((await cloudAccountStatus()).user).toBeNull()
  const file = join(
    root,
    "app",
    "linked",
    `${workspaceCacheKey()}.account.json`
  )
  expect(JSON.parse(await readFile(file, "utf8")).refreshToken).toBe(
    "private-rotated"
  )
  const failedRefreshes = refreshes
  refreshStatus = 200
  const recovered = await Promise.all([
    cloudAccountStatus(),
    cloudAccountStatus(),
  ])
  for (const status of recovered) {
    expect(status.user?.email).toBe("owner@example.com")
    expect(status.error).toBeUndefined()
    expect(JSON.stringify(status)).not.toContain("private-")
  }
  expect(refreshes).toBe(failedRefreshes + 1)
  expect(exchanges).toBe(1)
  exchangeStatus = 200
  expiry = new Date(0).toISOString()
  await startCloudSignIn(origin)
  await completeCloudSignIn(callback())
  refreshStatus = 503
  await expect(cloudLinkRequest(cloud, {})).rejects.toThrow("unavailable")
  expect((await cloudAccountStatus()).user?.id).toBe("owner")
  refreshStatus = 401
  await expect(cloudLinkRequest(cloud, {})).rejects.toThrow("Sign in")
  expect((await cloudAccountStatus()).user).toBeNull()
})

test("the Settings toggle preserves the MCP URL and share capability, while Unlink invalidates it", async () => {
  await startCloudSignIn(origin)
  await completeCloudSignIn(callback())
  const first = await setLinkEnabled(true)
  const share = await createDocumentShare({
    kind: "doc",
    spaceId: "notes",
    artifactKey: "plan",
  })
  const off = await setLinkEnabled(false)
  expect(off.enabled).toBe(false)
  expect(off.mcpUrl).toBe(first.mcpUrl)
  expect(await resolveDocumentShare(share.token)).not.toBeNull()
  // On a fresh runtime, a failed first heartbeat cannot claim that access is off.
  const stop = startLinkedRuntime()
  try {
    await heartbeatAttempted
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(linkedStatus()).toMatchObject({ state: "offline", enabled: null })
  } finally {
    await stop()
  }
  const on = await setLinkEnabled(true)
  expect(on.enabled).toBe(true)
  expect(on.mcpUrl).toBe(first.mcpUrl)
  expect(await resolveDocumentShare(share.token)).not.toBeNull()
  await disconnectLink()
  expect(await resolveDocumentShare(share.token)).toBeNull()
})
