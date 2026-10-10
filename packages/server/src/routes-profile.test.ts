import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { setAppDirOverride } from "./app-storage.ts"
import { trustedLocalIdentity } from "./auth.ts"
import { profileRouter } from "./routes/profile.ts"
import { createThread, readThread } from "./thread-store.ts"
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
    const owner = (await before.json()) as { id: string; name: string }
    expect(owner).toMatchObject({ name: "Owner" })
    const { thread } = await createThread(
      { kind: "worktable" },
      {
        author: { id: owner.id, kind: "human", name: owner.name },
        recipient: { id: "ptc_profile_agent", kind: "agent", name: "Atlas" },
        body: "Hello",
        idempotencyKey: "profile-rename",
      }
    )

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

    // Existing threads show the new name, and @Alex reaches the owner there.
    const renamed = await readThread({ kind: "worktable" }, thread.id)
    expect(renamed.members.find((m) => m.id === owner.id)?.name).toBe("Alex")
    expect(
      renamed.identities.find((i) => i.memberId === owner.id && i.default)?.name
    ).toBe("Alex")
    expect(renamed.updatedAt).toBe(thread.updatedAt)
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
