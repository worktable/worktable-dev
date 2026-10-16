import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { setAppDirOverride } from "./app-storage.ts"
import { trustedLocalIdentity } from "./auth.ts"
import { profileRouter } from "./routes/profile.ts"
import { workspaceRouter } from "./routes/workspace.ts"
import { writeSpace } from "./store.ts"
import { createToken } from "./token-store.ts"
import { prepareWorkspaceTarget, setWorkspaceRootOverride } from "./workspace.ts"

let root: string

function app(): Hono {
  const next = new Hono()
  next.use("/api/*", trustedLocalIdentity())
  next.route("/api/workspace", workspaceRouter)
  next.route("/api/profile", profileRouter)
  return next
}

async function summary(headers: HeadersInit = {}) {
  const response = await app().fetch(
    new Request("http://localhost/api/workspace", { headers })
  )
  return (await response.json()) as { navigation?: unknown }
}

function save(body: unknown, headers: HeadersInit = {}) {
  return app().fetch(
    new Request("http://localhost/api/profile/navigation", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  )
}

const arrangement = {
  groups: [{ id: "g1", name: "Products" }],
  spaceGroups: { atlas: "g1" },
  pins: ["atlas"],
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-navigation-"))
  setAppDirOverride(join(root, "app"))
  setWorkspaceRootOverride(join(root, "workspace"))
  prepareWorkspaceTarget(join(root, "workspace"), "create")
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: "atlas",
    name: "Atlas",
    group: "research",
    createdAt: now,
    updatedAt: now,
    createdBy: "user",
    settings: {},
  })
})

afterEach(async () => {
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("personal navigation", () => {
  it("is saved for the person, arrives with the workspace, and leaves the Space untouched", async () => {
    const spaceFile = join(root, "workspace", "spaces", "atlas", "space.json")
    const before = await readFile(spaceFile, "utf8")
    expect((await summary()).navigation).toBeNull()

    const saved = await save({ expectedRevision: 0, ...arrangement })
    expect(saved.status).toBe(200)
    expect(await saved.json()).toEqual({
      navigation: { revision: 1, ...arrangement },
    })
    expect((await summary()).navigation).toEqual({
      revision: 1,
      ...arrangement,
    })
    expect(await readFile(spaceFile, "utf8")).toBe(before)

    // A device that read an older revision gets the current one back.
    const stale = await save({ expectedRevision: 0, ...arrangement, pins: [] })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({
      code: "NAVIGATION_CONFLICT",
      navigation: { revision: 1, pins: ["atlas"] },
    })
  })

  it("refuses agents and inconsistent arrangements", async () => {
    const credential = await createToken({
      scopes: ["*"],
      agent: "codex@test",
    })
    const agent = { Authorization: `Bearer ${credential.token}` }
    expect((await save({ expectedRevision: 0, ...arrangement }, agent)).status).toBe(403)
    expect(await summary(agent)).not.toHaveProperty("navigation")

    const unknownGroup = await save({
      expectedRevision: 0,
      ...arrangement,
      spaceGroups: { atlas: "missing" },
    })
    expect(unknownGroup.status).toBe(400)
    const sameName = await save({
      expectedRevision: 0,
      ...arrangement,
      groups: [
        { id: "g1", name: "Products" },
        { id: "g2", name: "products" },
      ],
    })
    expect(sameName.status).toBe(400)
  })
})
