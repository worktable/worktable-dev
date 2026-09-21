import { describe, it, expect } from "bun:test"
import { Hono } from "hono"
import {
  DESKTOP_CONNECTION_PROTOCOL_VERSION,
  healthPayload,
  healthRouter,
} from "./routes/health.ts"

describe("health route", () => {
  it("returns the worktable service marker so clients can identify the server", async () => {
    const app = new Hono()
    app.route("/health", healthRouter)
    const res = await app.fetch(new Request("http://localhost/health"))
    expect(res.status).toBe(200)
    const body = (await res.json()) as ReturnType<typeof healthPayload>
    expect(body.ok).toBe(true)
    // The CLI's healthCheck requires this marker to avoid treating a foreign
    // process answering /health with {"ok":true} as a running Worktable.
    expect(body.service).toBe("worktable")
    expect(body.desktopConnection).toEqual({
      protocolVersion: DESKTOP_CONNECTION_PROTOCOL_VERSION,
      provider: "selfHosted",
    })
  })

  it("marks hosted processes for the separate Worktable Cloud provider", () => {
    const previous = process.env["WORKTABLE_HOSTED"]
    process.env["WORKTABLE_HOSTED"] = "1"
    try {
      expect(healthPayload().desktopConnection).toEqual({
        protocolVersion: DESKTOP_CONNECTION_PROTOCOL_VERSION,
        provider: "cloud",
      })
    } finally {
      if (previous === undefined) delete process.env["WORKTABLE_HOSTED"]
      else process.env["WORKTABLE_HOSTED"] = previous
    }
  })

  it("keeps host instance tokens in an unexposed response header", async () => {
    const previous = process.env["WORKTABLE_HOST_INSTANCE_TOKEN"]
    process.env["WORKTABLE_HOST_INSTANCE_TOKEN"] = "desktop-123"
    try {
      const app = new Hono()
      app.route("/health", healthRouter)
      const res = await app.fetch(new Request("http://localhost/health"))
      expect(res.headers.get("X-Worktable-Host-Instance")).toBe("desktop-123")
      expect(await res.json()).not.toHaveProperty("instanceToken")
      expect(healthPayload()).not.toHaveProperty("instanceToken")
      expect(healthPayload()).not.toHaveProperty("password")
      expect(healthPayload()).not.toHaveProperty("workspace")
      expect(healthPayload()).not.toHaveProperty("path")
    } finally {
      if (previous === undefined) {
        delete process.env["WORKTABLE_HOST_INSTANCE_TOKEN"]
      } else {
        process.env["WORKTABLE_HOST_INSTANCE_TOKEN"] = previous
      }
    }
  })
})
