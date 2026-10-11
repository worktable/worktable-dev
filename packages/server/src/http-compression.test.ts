import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Hono } from "hono"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brotliDecompressSync, gunzipSync } from "node:zlib"
import { setAppDirOverride } from "./app-storage.ts"
import { compressApiResponse } from "./http-compression"
import { rememberPeer } from "./request-source.ts"
import { invalidateServerSettingsCache } from "./settings-store.ts"

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
    for (const [accept, encoding, decode] of [
      ["br, gzip", "br", brotliDecompressSync],
      ["gzip", "gzip", gunzipSync],
    ] as const) {
      const response = await fixture().request("/doc", { headers: { "Accept-Encoding": accept } })
      const bytes = Buffer.from(await response.arrayBuffer())
      expect(response.headers.get("Content-Encoding")).toBe(encoding)
      expect(bytes.length).toBeLessThan(JSON.stringify(content).length / 2)
      expect(JSON.parse(decode(bytes).toString())).toEqual(content)
      expect(response.headers.get("Content-Length")).toBe(String(bytes.length))
      expect(response.headers.get("Vary")).toBe("Origin, Accept-Encoding")
      expect(response.headers.get("Cache-Control")).toBe("private, no-cache")
      expect(response.headers.get("ETag")).toBe('W/"revision-1"')
    }
  })

  it("honors explicit rejection, wildcard negotiation and invalid qualities", async () => {
    for (const accept of ["", "identity", "br;q=0, gzip;q=0", "gzip;q=invalid", "gzip;q=2"]) {
      const response = await fixture().request("/doc", { headers: { "Accept-Encoding": accept } })
      expect(response.headers.has("Content-Encoding")).toBe(false)
      expect(response.headers.get("Vary")).toContain("Accept-Encoding")
      expect(await response.json()).toEqual(content)
    }
    for (const [accept, encoding] of [
      ["*;q=0.5", "br"],
      ["gzip;q=0, *;q=1", "br"],
      ["br;q=0.5, gzip", "gzip"],
    ]) {
      const response = await fixture().request("/doc", { headers: { "Accept-Encoding": accept } })
      expect(response.headers.get("Content-Encoding")).toBe(encoding)
    }
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

describe("compression for a browser on this computer", () => {
  const ENV_KEYS = ["HOST", "WORKTABLE_REQUIRE_AUTH", "WORKTABLE_HOSTED", "WORKTABLE_PUBLIC_URL"]
  let saved: Record<string, string | undefined>
  let appDir: string
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
    for (const key of ENV_KEYS) delete process.env[key]
    appDir = mkdtempSync(join(tmpdir(), "wt-compression-"))
    setAppDirOverride(appDir)
    invalidateServerSettingsCache()
  })
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    setAppDirOverride(null)
    invalidateServerSettingsCache()
    rmSync(appDir, { recursive: true, force: true })
  })
  const fromPeer = (address: string) => {
    const request = new Request("http://localhost/doc", { headers: { "Accept-Encoding": "br, gzip" } })
    rememberPeer(request, address)
    return fixture().fetch(request)
  }

  it("sends loopback bodies as they are, and still compresses for the network", async () => {
    for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      const response = await fromPeer(address)
      expect(response.headers.has("Content-Encoding")).toBe(false)
      expect(response.headers.get("Vary")).toContain("Accept-Encoding")
      expect(await response.json()).toEqual(content)
    }
    expect((await fromPeer("192.168.1.20")).headers.get("Content-Encoding")).toBe("br")
  })

  it("compresses loopback traffic that a tunnel, proxy or the Cloud gateway forwards", async () => {
    for (const [key, value] of [
      ["WORKTABLE_PUBLIC_URL", "https://work.example.com"],
      ["WORKTABLE_HOSTED", "1"],
      ["WORKTABLE_REQUIRE_AUTH", "1"],
    ]) {
      process.env[key] = value
      expect((await fromPeer("127.0.0.1")).headers.get("Content-Encoding")).toBe("br")
      delete process.env[key]
    }
  })
})
