import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import {
  abandonableRead,
  authenticatedFetch,
  CSRF_WAIT_MS,
  fetchJSON,
  getFreshBrowserCsrfToken,
  prefetchBrowserCsrfToken,
} from "./http.ts"
import { acceptWorkspaceContentEpoch } from "./workspace-content-epoch"

const realFetch = globalThis.fetch

// http.ts caches the Cloud CSRF token for the page's lifetime, and test files
// share one process. Start each test with no cached token through the public
// API: a session without a token clears it.
async function forgetCachedCsrfToken() {
  globalThis.fetch = (async () =>
    Response.json({ authenticated: false })) as unknown as typeof fetch
  await getFreshBrowserCsrfToken()
  globalThis.fetch = realFetch
}

beforeEach(forgetCachedCsrfToken)

/**
 * A Cloud gateway whose session read answers `token` only when released, and
 * which refuses a change without that token.
 */
function slowCloudSession(token: string) {
  const requests: Request[] = []
  let releaseSession!: () => void
  const sessionReleased = new Promise<void>((resolve) => {
    releaseSession = resolve
  })
  globalThis.fetch = (async (input, init) => {
    const request = new Request(
      input instanceof Request
        ? input
        : new URL(String(input), "https://app.worktable.cloud"),
      init
    )
    requests.push(request)
    if (new URL(request.url).pathname === "/gateway/session") {
      await sessionReleased
      return Response.json({ authenticated: true, csrfToken: token })
    }
    return request.headers.get("X-Worktable-CSRF") === token
      ? Response.json({ ok: true })
      : Response.json({ code: "CSRF_REQUIRED" }, { status: 403 })
  }) as typeof fetch
  const changes = () => requests.filter((request) => request.method === "POST")
  return { requests, changes, releaseSession }
}

async function settle(done: () => boolean) {
  for (let turn = 0; turn < 100 && !done(); turn++) await Promise.resolve()
}

afterEach(() => {
  jest.useRealTimers()
  globalThis.fetch = realFetch
})

describe("authenticatedFetch", () => {
  it("recovers removed and switched members on ordinary reads", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
    const location = {pathname: "/spaces/private", replace: jest.fn()}
    Object.defineProperty(globalThis, "window", {configurable: true, value: {location, dispatchEvent: () => true}})
    try {
      for (const [code, status] of [["MEMBERSHIP_REQUIRED", 403], ["MEMBER_CHANGED", 409]] as const) {
        location.replace.mockClear()
        globalThis.fetch = (async () => Response.json({code}, {status})) as typeof fetch
        expect((await authenticatedFetch("https://app.worktable.cloud/api/spaces")).status).toBe(status)
        await settle(() => location.replace.mock.calls.length > 0)
        expect(location.replace).toHaveBeenCalledWith("/")
        await acceptWorkspaceContentEpoch("recovery-test", "same-content")
      }
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "window", descriptor)
      else Reflect.deleteProperty(globalThis, "window")
    }
  })

  it("acquires Cloud CSRF and retries an unsafe request exactly once", async () => {
    const requests: Request[] = []
    globalThis.fetch = (async (input, init) => {
      const request = new Request(
        input instanceof Request
          ? input
          : new URL(String(input), "https://app.worktable.cloud"),
        init
      )
      requests.push(request)
      if (new URL(request.url).pathname === "/gateway/session") {
        return Response.json({
          authenticated: true,
          csrfToken: "csrf-from-session",
          accessTokenExpiresAt: 123,
        })
      }
      if (requests.filter((entry) => entry.method === "POST").length === 1) {
        return Response.json(
          { error: "CSRF validation failed", code: "CSRF_REQUIRED" },
          { status: 403 }
        )
      }
      return Response.json({ ok: true })
    }) as typeof fetch

    const response = await authenticatedFetch(
      "https://app.worktable.cloud/api/spaces",
      { method: "POST", body: "{}" }
    )
    expect(response.status).toBe(200)
    expect(requests).toHaveLength(3)
    expect(requests[0]?.headers.get("X-Worktable-CSRF")).toBeNull()
    expect(requests[2]?.headers.get("X-Worktable-CSRF")).toBe(
      "csrf-from-session"
    )
  })

  it("sends the first change on Cloud with the token read at boot", async () => {
    const { requests, releaseSession } = slowCloudSession("csrf-boot")

    prefetchBrowserCsrfToken()
    // A change made while the session read is still in flight waits for it.
    const change = authenticatedFetch(
      "https://app.worktable.cloud/api/spaces",
      { method: "POST", body: "{}" }
    )
    releaseSession()
    expect((await change).status).toBe(200)
    expect(
      (
        await authenticatedFetch("https://app.worktable.cloud/api/spaces", {
          method: "POST",
          body: "{}",
        })
      ).status
    ).toBe(200)
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/gateway/session",
      "/api/spaces",
      "/api/spaces",
    ])
  })

  it("sends a change without the token when the session read stalls, then retries", async () => {
    jest.useFakeTimers()
    const { changes, releaseSession } = slowCloudSession("csrf-late")
    void getFreshBrowserCsrfToken()

    const change = authenticatedFetch(
      "https://app.worktable.cloud/api/spaces",
      { method: "POST", body: "{}" }
    )
    jest.advanceTimersByTime(CSRF_WAIT_MS - 1)
    await settle(() => changes().length > 0)
    expect(changes()).toHaveLength(0)
    jest.advanceTimersByTime(1)
    await settle(() => changes().length > 0)
    expect(changes()[0]?.headers.get("X-Worktable-CSRF")).toBeNull()

    releaseSession()
    expect((await change).status).toBe(200)
    expect(changes().map((c) => c.headers.get("X-Worktable-CSRF"))).toEqual([
      null,
      "csrf-late",
    ])
  })

  it("stops waiting for the session read when the change is abandoned", async () => {
    const { changes, releaseSession } = slowCloudSession("csrf-unused")
    const session = getFreshBrowserCsrfToken()
    const controller = new AbortController()

    const change = authenticatedFetch(
      "https://app.worktable.cloud/api/spaces",
      { method: "POST", body: "{}", signal: controller.signal }
    )
    controller.abort()
    await expect(change).rejects.toThrow()
    releaseSession()
    await session
    expect(changes()).toHaveLength(0)
  })

  it("does not involve Cloud CSRF for safe requests", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return Response.json({ ok: true })
    }) as typeof fetch
    await authenticatedFetch("https://app.worktable.cloud/api/spaces")
    expect(calls).toBe(1)
  })
})

describe("fetchJSON", () => {
  it("sends reads as plain GETs that a cancelled query can abort", async () => {
    const requests: Array<{ init?: RequestInit }> = []
    globalThis.fetch = (async (_input, init) => {
      requests.push({ init })
      if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError")
      return Response.json({ ok: true })
    }) as typeof fetch

    await fetchJSON("/api/spaces")
    await fetchJSON("/api/spaces", { method: "POST", body: "{}" })
    expect(new Headers(requests[0]?.init?.headers).has("Content-Type")).toBe(
      false
    )
    expect(new Headers(requests[1]?.init?.headers).get("Content-Type")).toBe(
      "application/json"
    )

    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchJSON("/api/spaces", { signal: controller.signal })
    ).rejects.toThrow()
    expect(requests[2]?.init?.signal).toBe(controller.signal)
  })
})

describe("abandonableRead", () => {
  it("lets a read survive a remount and aborts one abandoned after its grace period", async () => {
    const query = new AbortController()
    let taken = 0
    const context = {
      get signal() {
        taken++
        return query.signal
      },
    }

    // A quick read never takes the query's signal, so an unmount meanwhile
    // does not cancel it.
    expect(await abandonableRead(context, async () => "read", 60_000)).toBe(
      "read"
    )
    expect(taken).toBe(0)

    const slow = abandonableRead(
      context,
      ({ signal }) =>
        new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("aborted")))
        ),
      0
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(taken).toBe(1)
    query.abort()
    await expect(slow).rejects.toThrow("aborted")
  })
})
