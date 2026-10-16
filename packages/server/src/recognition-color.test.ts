import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { setAppDirOverride } from "./app-storage.ts"
import { trustedLocalIdentity } from "./auth.ts"
import { spacesRouter } from "./routes/spaces.ts"
import { workspaceRouter } from "./routes/workspace.ts"
import { readSpace, writeSpace } from "./store.ts"
import { prepareWorkspaceTarget, setWorkspaceRootOverride } from "./workspace.ts"

let root: string

function request(path: string, body: unknown) {
  const app = new Hono()
  app.use("/api/*", trustedLocalIdentity())
  app.route("/api/spaces", spacesRouter)
  app.route("/api/workspace", workspaceRouter)
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-recognition-"))
  setAppDirOverride(join(root, "app"))
  setWorkspaceRootOverride(join(root, "workspace"))
  prepareWorkspaceTarget(join(root, "workspace"), "create")
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id: "atlas",
    name: "Atlas",
    createdAt: now,
    updatedAt: now,
    createdBy: "user",
    settings: { docSort: "custom" },
  })
})

afterEach(async () => {
  setAppDirOverride(null)
  setWorkspaceRootOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("recognition colors", () => {
  it("are chosen for a Space beside its other settings, and cleared back to the default", async () => {
    expect((await request("/api/spaces/atlas", { color: "violet" })).status).toBe(200)
    expect((await readSpace("atlas")).data?.settings).toEqual({
      docSort: "custom",
      color: "violet",
    })
    expect((await request("/api/spaces/atlas", { color: "red" })).status).toBe(400)
    expect((await request("/api/spaces/atlas", { color: "" })).status).toBe(200)
    expect((await readSpace("atlas")).data?.settings).toEqual({ docSort: "custom" })
  })

  it("are chosen for the Worktable, and the update answers with the whole summary", async () => {
    const response = await request("/api/workspace", { color: "teal" })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      color: "teal",
      navigation: null,
      person: { role: "owner" },
    })
    expect((await request("/api/workspace", { color: "cobalt" })).status).toBe(400)
  })
})
