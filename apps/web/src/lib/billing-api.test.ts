import { afterEach, describe, expect, it, mock } from "bun:test"
import { openCloudBillingCheckout } from "./billing-api.ts"
import { UnauthorizedError } from "./http.ts"

const realFetch = globalThis.fetch
const realWindow = Object.getOwnPropertyDescriptor(globalThis, "window")

afterEach(() => {
  globalThis.fetch = realFetch
  if (realWindow) {
    Object.defineProperty(globalThis, "window", realWindow)
  } else {
    Reflect.deleteProperty(globalThis, "window")
  }
})

describe("Cloud billing API", () => {
  it("opens checkout through the authenticated CSRF-protected gateway route", async () => {
    const requests: Request[] = []
    const assign = mock(() => {})
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { assign } },
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
        return Response.json({
          authenticated: true,
          csrfToken: "csrf-billing",
        })
      }
      if (request.headers.get("X-Worktable-CSRF") !== "csrf-billing") {
        return Response.json(
          { error: "CSRF validation failed", code: "CSRF_REQUIRED" },
          { status: 403 }
        )
      }
      return Response.json({
        url: "https://sandbox.polar.sh/checkout/checkout_123",
      })
    }) as typeof fetch

    await openCloudBillingCheckout()

    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/billing/checkout",
      "/gateway/session",
      "/api/billing/checkout",
    ])
    expect(requests[2]?.headers.get("X-Worktable-CSRF")).toBe("csrf-billing")
    expect(assign).toHaveBeenCalledWith(
      "https://sandbox.polar.sh/checkout/checkout_123"
    )
  })

  it("returns an expired billing session to sign-in", async () => {
    const assign = mock(() => {})
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          assign,
          pathname: "/spaces/space_123",
          search: "?settings=account",
        },
      },
    })
    globalThis.fetch = (async () =>
      Response.json(
        { error: "Unauthorized", code: "UNAUTHORIZED" },
        { status: 401 }
      )) as typeof fetch

    await expect(openCloudBillingCheckout()).rejects.toBeInstanceOf(
      UnauthorizedError
    )
    expect(assign).toHaveBeenCalledWith(
      "/login?next=%2Fspaces%2Fspace_123%3Fsettings%3Daccount"
    )
  })
})
