import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { setAppDirOverride } from "./app-storage.ts"
import { trustedLocalIdentity } from "./auth.ts"
import type { PersonSummary } from "./personal-identity.ts"
import { savePersonalNavigation } from "./personal-navigation-store.ts"
import { profileRouter } from "./routes/profile.ts"
import { workspaceRouter } from "./routes/workspace.ts"
import { writeSpace } from "./store.ts"
import { createToken } from "./token-store.ts"
import {
  prepareWorkspaceTarget,
  setWorkspaceRootOverride,
  workspaceCacheKey,
} from "./workspace.ts"

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
  return (await response.json()) as {
    navigation?: unknown
    person?: PersonSummary
  }
}

function save(body: Record<string, unknown>, headers: HeadersInit = {}) {
  return app().fetch(
    new Request("http://localhost/api/profile/navigation", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ knownSpaces: ["atlas"], ...body }),
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
    expect(await summary()).toMatchObject({
      person: { name: "Owner", role: "owner", signOut: null },
    })
    const firstPerson = (await summary()).person!
    expect(firstPerson.id).toMatch(/^ptc_/)
    await app().fetch(
      new Request("http://localhost/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Alex" }),
      })
    )
    expect(await summary()).toMatchObject({
      person: { id: firstPerson.id, name: "Alex" },
    })

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

    // A Space that no longer exists is not kept.
    const gone = await save({
      expectedRevision: 1,
      ...arrangement,
      pins: ["atlas", "deleted"],
      knownSpaces: ["atlas", "deleted"],
    })
    expect((await gone.json()).navigation.pins).toEqual(["atlas"])

    // A device that read an older revision gets the current one back.
    const stale = await save({ expectedRevision: 0, ...arrangement, pins: [] })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({
      code: "NAVIGATION_CONFLICT",
      navigation: { revision: 2, pins: ["atlas"] },
    })
  })

  it("keeps the app working, and refuses saves, while the file can't be read", async () => {
    await mkdir(join(root, "app", "participants"), { recursive: true })
    await writeFile(
      join(root, "app", "participants", `${workspaceCacheKey()}.preferences.json`),
      "{ not json"
    )
    expect((await summary()).navigation).toBeNull()
    const refused = await save({ expectedRevision: 0, ...arrangement })
    expect(refused.status).toBe(503)
    expect(await refused.json()).toMatchObject({ code: "PREFERENCES_UNREADABLE" })
  })

  it("refuses a save that the kept entries would push past the limits", async () => {
    const ids = Array.from({ length: 501 }, (_, index) => `space-${index}`)
    const all = () => true
    const first = await savePersonalNavigation(
      "person",
      0,
      { groups: [], spaceGroups: {}, pins: ids.slice(0, 500) },
      ids,
      all,
      ids
    )
    expect(first.saved).toBe(true)
    // A tab that knows none of those Spaces pins another one.
    const second = await savePersonalNavigation(
      "person",
      1,
      { groups: [], spaceGroups: {}, pins: [ids[500]!] },
      [ids[500]!],
      all,
      ids
    )
    expect(second).toEqual({ saved: false, tooLarge: true })
  })

  it("refuses agents and inconsistent arrangements", async () => {
    const credential = await createToken({
      scopes: ["*"],
      agent: "codex@test",
    })
    const agent = { Authorization: `Bearer ${credential.token}` }
    expect((await save({ expectedRevision: 0, ...arrangement }, agent)).status).toBe(403)
    expect(await summary(agent)).not.toHaveProperty("navigation")
    expect(await summary(agent)).not.toHaveProperty("person")

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
