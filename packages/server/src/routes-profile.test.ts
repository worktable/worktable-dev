import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { setAppDirOverride } from "./app-storage.ts"
import { trustedLocalIdentity } from "./auth.ts"
import { profileRouter } from "./routes/profile.ts"
import { createToken } from "./token-store.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"

let appDir: string
let workspaceDir: string

function app(): Hono {
  const next = new Hono()
  next.use("/api/*", trustedLocalIdentity())
  next.route("/api/profile", profileRouter)
  return next
}

beforeEach(async () => {
  appDir = await mkdtemp(join(tmpdir(), "worktable-profile-app-"))
  workspaceDir = await mkdtemp(join(tmpdir(), "worktable-profile-work-"))
  setAppDirOverride(appDir)
  setWorkspaceRootOverride(workspaceDir)
})

afterEach(async () => {
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  await Promise.all([
    rm(appDir, { recursive: true, force: true }),
    rm(workspaceDir, { recursive: true, force: true }),
  ])
})

describe("profile routes", () => {
  it("updates the human participant used by Threads", async () => {
    const before = await app().fetch(
      new Request("http://localhost/api/profile")
    )
    expect(await before.json()).toMatchObject({ name: "Owner" })

    const updated = await app().fetch(
      new Request("http://localhost/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "  Alex  " }),
      })
    )
    expect(updated.status).toBe(200)
    const profile = (await updated.json()) as { id: string; name: string }
    expect(profile).toMatchObject({ name: "Alex" })
    expect(profile.id).toMatch(/^ptc_/)

    const after = await app().fetch(new Request("http://localhost/api/profile"))
    expect(await after.json()).toEqual(profile)
  })

  it("rejects agent credentials and invalid names", async () => {
    const credential = await createToken({
      scopes: ["threads:*"],
      agent: "codex@test",
    })
    const forbidden = await app().fetch(
      new Request("http://localhost/api/profile", {
        headers: { Authorization: `Bearer ${credential.token}` },
      })
    )
    expect(forbidden.status).toBe(403)

    const invalid = await app().fetch(
      new Request("http://localhost/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: " ".repeat(5) }),
      })
    )
    expect(invalid.status).toBe(400)
  })
})
