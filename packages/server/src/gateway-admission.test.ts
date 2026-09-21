import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import {
  ACTOR_HEADERS,
  GATEWAY_HEADER,
  gatewayAdmits,
  gatewaySecret,
  trustedGatewayPrincipal,
} from "./hosted.ts"

// Gateway admission: a hosted tenant's sprite URL is public, so a valid bearer
// could otherwise reach the instance directly and skip the cloud gateway —
// which is also how a past-due tenant would evade billing enforcement. The
// guard is admission control, never authentication.

const SECRET = "s".repeat(43)

const ENV_KEYS = ["WORKTABLE_HOSTED", "WORKTABLE_GATEWAY_SECRET"]
let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function req(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://tenant.example${path}`, { headers })
}

describe("gatewayAdmits", () => {
  it("is a no-op for local/self-hosted installs (not hosted)", () => {
    process.env["WORKTABLE_GATEWAY_SECRET"] = SECRET
    expect(gatewayAdmits(req("/api/spaces"))).toBe(true)
  })

  it("fails closed when hosted but no secret is configured", () => {
    process.env["WORKTABLE_HOSTED"] = "1"
    expect(gatewaySecret()).toBeNull()
    expect(gatewayAdmits(req("/api/spaces"))).toBe(false)
    expect(gatewayAdmits(req("/health"))).toBe(true)
  })

  describe("hosted with a secret configured", () => {
    beforeEach(() => {
      process.env["WORKTABLE_HOSTED"] = "1"
      process.env["WORKTABLE_GATEWAY_SECRET"] = SECRET
    })

    it("admits a request carrying the matching secret", () => {
      expect(
        gatewayAdmits(req("/api/spaces", { [GATEWAY_HEADER]: SECRET }))
      ).toBe(true)
    })

    it("REJECTS a direct request with no gateway header (the bypass)", () => {
      expect(gatewayAdmits(req("/api/spaces"))).toBe(false)
      expect(gatewayAdmits(req("/api/mcp"))).toBe(false)
      expect(gatewayAdmits(req("/"))).toBe(false)
    })

    it("rejects a wrong secret, including a prefix of the real one", () => {
      expect(
        gatewayAdmits(req("/api/mcp", { [GATEWAY_HEADER]: "wrong" }))
      ).toBe(false)
      expect(
        gatewayAdmits(
          req("/api/mcp", { [GATEWAY_HEADER]: SECRET.slice(0, -1) })
        )
      ).toBe(false)
      expect(
        gatewayAdmits(req("/api/mcp", { [GATEWAY_HEADER]: SECRET + "x" }))
      ).toBe(false)
    })

    it("exempts /health — the unauthenticated liveness probe", () => {
      // The provisioner polls /health before the tenant is reachable through
      // any gateway; it leaks nothing.
      expect(gatewayAdmits(req("/health"))).toBe(true)
    })

    it("does not exempt paths merely PREFIXED with /health", () => {
      expect(gatewayAdmits(req("/healthz"))).toBe(false)
      expect(gatewayAdmits(req("/health/../api/mcp"))).toBe(false)
    })

    it("matches the header case-insensitively (HTTP headers are)", () => {
      expect(
        gatewayAdmits(req("/api/mcp", { "X-Worktable-Gateway": SECRET }))
      ).toBe(true)
    })
  })
})

describe("trustedGatewayPrincipal", () => {
  it("accepts actor context only with hosted admission", () => {
    const actor = {
      [ACTOR_HEADERS.ID]: "oauth:claude:user_1",
      [ACTOR_HEADERS.TYPE]: "agent",
      [ACTOR_HEADERS.NAME]: "Claude",
      [ACTOR_HEADERS.AUTHORIZED_BY]: "workos:user_1",
    }
    expect(trustedGatewayPrincipal(req("/api/mcp", actor))).toBeNull()

    process.env["WORKTABLE_HOSTED"] = "1"
    process.env["WORKTABLE_GATEWAY_SECRET"] = SECRET
    expect(trustedGatewayPrincipal(req("/api/mcp", actor))).toBeNull()
    expect(
      trustedGatewayPrincipal(
        req("/api/mcp", { ...actor, [GATEWAY_HEADER]: SECRET })
      )
    ).toEqual({
      id: "oauth:claude:user_1",
      type: "agent",
      displayName: "Claude",
      authorizedBy: "workos:user_1",
    })
  })
})

describe("HTTP surface", () => {
  it("403s an un-admitted request before any route runs", async () => {
    process.env["WORKTABLE_HOSTED"] = "1"
    process.env["WORKTABLE_GATEWAY_SECRET"] = SECRET

    const app = new Hono()
    app.use("*", async (c, next) => {
      if (!gatewayAdmits(c.req.raw)) {
        return c.json({ error: "Forbidden", code: "GATEWAY_REQUIRED" }, 403)
      }
      return next()
    })
    app.get("/api/spaces", (c) => c.json({ reached: true }))

    const denied = await app.fetch(new Request("http://t.example/api/spaces"))
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ code: "GATEWAY_REQUIRED" })

    const allowed = await app.fetch(
      new Request("http://t.example/api/spaces", {
        headers: { [GATEWAY_HEADER]: SECRET },
      })
    )
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ reached: true })
  })
})
