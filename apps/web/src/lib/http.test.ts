import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { authenticatedFetch, getFreshBrowserCsrfToken } from "./http.ts"

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

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("authenticatedFetch", () => {
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
