import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { gunzipSync } from "node:zlib"
import { compressApiResponse } from "./http-compression"

const content = { content: Array.from({ length: 500 }, (_, i) => `Paragraph ${i}`) }
function fixture() {
  const app = new Hono()
  app.use("*", compressApiResponse)
  app.get("/doc", (c) => {
    c.header("Vary", "Origin")
    c.header("Cache-Control", "private, no-cache")
    c.header("ETag", '"revision-1"')
    return c.json(content)
  })
  app.get("/small", (c) => c.json({ ok: true }))
  app.get("/events", (c) => c.body("data: hello\n\n", 200, { "Content-Type": "text/event-stream" }))
  app.get("/api/mcp", (c) => c.json(content))
  app.get("/unchanged", (c) => c.json(content, 200, { "Cache-Control": "private, no-transform" }))
  app.get("/denied", (c) => c.json(content, 401))
  app.get("/html", (c) => c.html("<p>HTML document</p>".repeat(500), 200, {
    "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'",
    "X-Content-Type-Options": "nosniff",
  }))
  return app
}

describe("API response compression", () => {
  it("compresses HTML documents while preserving sandbox policy and exact content", async () => {
    const response = await fixture().request("/html", { headers: { "Accept-Encoding": "gzip" } })
    expect(response.headers.get("Content-Encoding")).toBe("gzip")
    expect(response.headers.get("Content-Security-Policy")).toBe("sandbox allow-scripts; default-src 'none'")
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe("<p>HTML document</p>".repeat(500))
  })
  it("reduces document bytes without changing JSON, cache policy, or validators", async () => {
    const response = await fixture().request("/doc", { headers: { "Accept-Encoding": "br, gzip" } })
    const bytes = Buffer.from(await response.arrayBuffer())
    expect(response.headers.get("Content-Encoding")).toBe("gzip")
    expect(bytes.length).toBeLessThan(JSON.stringify(content).length / 2)
    expect(JSON.parse(gunzipSync(bytes).toString())).toEqual(content)
    expect(response.headers.get("Content-Length")).toBe(String(bytes.length))
    expect(response.headers.get("Vary")).toBe("Origin, Accept-Encoding")
    expect(response.headers.get("Cache-Control")).toBe("private, no-cache")
    expect(response.headers.get("ETag")).toBe('W/"revision-1"')
  })

  it("honors explicit rejection, wildcard negotiation and invalid qualities", async () => {
    for (const accept of ["", "br", "gzip;q=0, *;q=1", "gzip;q=invalid", "gzip;q=2"]) {
      const response = await fixture().request("/doc", { headers: { "Accept-Encoding": accept } })
      expect(response.headers.has("Content-Encoding")).toBe(false)
      expect(response.headers.get("Vary")).toContain("Accept-Encoding")
      expect(await response.json()).toEqual(content)
    }
    const response = await fixture().request("/doc", { headers: { "Accept-Encoding": "*;q=0.5" } })
    expect(response.headers.get("Content-Encoding")).toBe("gzip")
  })

  it("leaves small bodies, event streams, MCP, errors and no-transform responses alone", async () => {
    for (const path of ["/small", "/events", "/api/mcp", "/unchanged", "/denied"]) {
      const response = await fixture().request(path, { headers: { "Accept-Encoding": "gzip" } })
      expect(response.headers.has("Content-Encoding")).toBe(false)
      expect((await response.text()).length).toBeGreaterThan(0)
    }
    const response = await fixture().request("/doc", { method: "HEAD", headers: { "Accept-Encoding": "gzip" } })
    expect(response.headers.has("Content-Encoding")).toBe(false)
    expect(await response.text()).toBe("")
  })
})
