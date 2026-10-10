import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { ownerIdentity } from "./auth.ts"
import { compressApiResponse } from "./http-compression.ts"
import { serverTiming, timing } from "./request-timing.ts"
import { diagnosticsRouter } from "./routes/diagnostics.ts"
import type { TokenIdentity } from "./token-store.ts"

const documents = {
  documents: Array.from({ length: 500 }, (_, i) => ({ path: `doc-${i}` })),
}

const agent: TokenIdentity = {
  ...ownerIdentity(),
  credentialClass: "local",
  scopes: ["documents:read", "documents:write"],
  agent: "test-agent",
  principal: { id: "agent:test", type: "agent", displayName: "Test agent" },
}

function fixture() {
  const app = new Hono()
  app.use("*", serverTiming)
  app.use("/api/*", compressApiResponse)
  app.use("/api/*", async (c, next) => {
    const who = c.req.header("X-Test-Identity")
    if (who === "owner") c.set("identity", ownerIdentity())
    if (who === "agent") c.set("identity", agent)
    await next()
  })
  app.get("/api/spaces/:spaceId/documents", async (c) =>
    c.json(await timing.span("catalog", async () => documents))
  )
  app.route("/api/diagnostics", diagnosticsRouter)
  return app
}

function spans(header: string | null): Map<string, number> {
  return new Map(
    (header ?? "").split(", ").map((metric) => {
      const [name, ...params] = metric.split(";")
      const duration = params.find((param) => param.startsWith("dur="))
      return [name!, Number(duration?.slice(4))]
    })
  )
}

describe("request timing", () => {
  it("reports named spans and the total in Server-Timing, including compression", async () => {
    const response = await fixture().request("/api/spaces/alpha/documents", {
      headers: { "Accept-Encoding": "gzip" },
    })
    expect(response.headers.get("Content-Encoding")).toBe("gzip")
    const timings = spans(response.headers.get("Server-Timing"))
    for (const name of ["catalog", "serialize", "gzip", "total"]) {
      expect(timings.get(name)).toBeGreaterThanOrEqual(0)
    }
    expect(timings.get("total")!).toBeGreaterThanOrEqual(
      timings.get("catalog")! + timings.get("gzip")!
    )
  })

  it("serves diagnostics only to the workspace owner, with latency by route pattern", async () => {
    const app = fixture()
    await app.request("/api/spaces/alpha/documents")
    await app.request("/api/spaces/beta/documents")

    for (const identity of [undefined, "agent"]) {
      const denied = await app.request("/api/diagnostics/perf", {
        headers: identity ? { "X-Test-Identity": identity } : {},
      })
      expect(denied.status).toBe(403)
    }

    const response = await app.request("/api/diagnostics/perf", {
      headers: { "X-Test-Identity": "owner" },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      eventLoopLag: { intervalMs: number; p99Ms: number }
      routes: { method: string; route: string; count: number }[]
      memory: { rssBytes: number; heapUsedBytes: number }
    }
    const documentsRoute = body.routes.find(
      (route) => route.route === "/api/spaces/:spaceId/documents"
    )
    expect(documentsRoute?.method).toBe("GET")
    expect(documentsRoute?.count).toBeGreaterThanOrEqual(2)
    expect(body.routes.some((route) => route.route.includes("alpha"))).toBe(
      false
    )
    expect(body.eventLoopLag.intervalMs).toBe(50)
    expect(body.memory.rssBytes).toBeGreaterThan(0)
    expect(body.memory.heapUsedBytes).toBeGreaterThan(0)
  })
})
