import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { setAppDirOverride } from "./app-storage.ts"
import { trustedLocalIdentity } from "./auth.ts"
import { spacesRouter } from "./routes/spaces.ts"
import { workspaceRouter } from "./routes/workspace.ts"
import { isRecognitionColor } from "@worktable/types/recognition"
import { assignMissingSpaceColors, readSpace, writeSpace } from "./store.ts"
import { prepareWorkspaceTarget, setWorkspaceRootOverride } from "./workspace.ts"

let root: string

function request(path: string, body: unknown, method = "PUT") {
  const app = new Hono()
  app.use("/api/*", trustedLocalIdentity())
  app.route("/api/spaces", spacesRouter)
  app.route("/api/workspace", workspaceRouter)
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method,
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
  it("are chosen for a Space beside its other settings, and cleared to a saved default", async () => {
    expect((await request("/api/spaces/atlas", { color: "violet" })).status).toBe(200)
    expect((await readSpace("atlas")).data?.settings).toEqual({
      docSort: "custom",
      color: "violet",
    })
    expect((await request("/api/spaces/atlas", { color: "red" })).status).toBe(400)
    // Clearing saves the default now, so a later startup leaves it alone.
    expect((await request("/api/spaces/atlas", { color: "" })).status).toBe(200)
    const cleared = (await readSpace("atlas")).data?.settings
    expect(cleared?.["docSort"]).toBe("custom")
    expect(isRecognitionColor(cleared?.["color"])).toBe(true)
    expect(await assignMissingSpaceColors()).toBe(0)
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

  it("go to new Spaces spread apart: every hue before any repeats", async () => {
    const colors: unknown[] = []
    for (let index = 1; index <= 9; index += 1) {
      const response = await request("/api/spaces", { name: `Space ${index}` }, "POST")
      const { spaceId } = (await response.json()) as { spaceId: string }
      colors.push((await readSpace(spaceId)).data?.settings["color"])
    }
    expect(new Set(colors.slice(0, 8)).size).toBe(8)
    expect(colors).not.toContain("slate")
    expect(colors).not.toContain(undefined)
  })

  it("are given once to Spaces that have none, keeping the ones chosen", async () => {
    await request("/api/spaces/atlas", { color: "violet" })
    const now = Date.now()
    for (const [index, id] of ["beta", "gamma", "delta"].entries()) {
      const createdAt = new Date(now + index).toISOString()
      await writeSpace({
        type: "worktable.space",
        version: 1,
        id,
        name: id,
        createdAt,
        updatedAt: createdAt,
        createdBy: "user",
        settings: {},
      })
    }
    expect(await assignMissingSpaceColors()).toBe(3)
    const colors = await Promise.all(
      ["atlas", "beta", "gamma", "delta"].map(
        async (id) => (await readSpace(id)).data?.settings["color"]
      )
    )
    expect(colors[0]).toBe("violet")
    expect(new Set(colors).size).toBe(4)
    expect(await assignMissingSpaceColors()).toBe(0)
  })
})

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
  ),
  (char) => char.charCodeAt(0)
)

function upload(path: string, body: BodyInit, type = "image/png") {
  const app = new Hono()
  app.use("/api/*", trustedLocalIdentity())
  app.route("/api/workspace", workspaceRouter)
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "PUT",
      headers: { "Content-Type": type },
      body,
    })
  )
}

function get(path: string) {
  const app = new Hono()
  app.use("/api/*", trustedLocalIdentity())
  app.route("/api/workspace", workspaceRouter)
  return app.fetch(new Request(`http://localhost${path}`))
}

describe("Worktable logos", () => {
  it("keep an uploaded image in the Worktable folder and serve it by its content", async () => {
    const response = await upload("/api/workspace/logo", PNG)
    expect(response.status).toBe(200)
    const summary = (await response.json()) as { logo: { kind: string; hash: string } }
    expect(summary.logo).toEqual({ kind: "image", hash: expect.stringMatching(/^[a-f0-9]{32}$/) })
    expect(await readFile(join(root, "workspace", "worktable-logo.png"))).toEqual(Buffer.from(PNG))

    const served = await get(`/api/workspace/logo/${summary.logo.hash}`)
    expect(served.status).toBe(200)
    expect(served.headers.get("Content-Type")).toBe("image/png")
    expect(served.headers.get("Cache-Control")).toContain("immutable")
    expect(served.headers.get("X-Content-Type-Options")).toBe("nosniff")
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG)
    // A replaced logo's old address no longer answers.
    expect((await get(`/api/workspace/logo/${"0".repeat(32)}`)).status).toBe(404)
  })

  it("refuse anything that is not a small raster image", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    expect((await upload("/api/workspace/logo", svg, "image/svg+xml")).status).toBe(400)
    const huge = PNG.slice()
    new DataView(huge.buffer).setUint32(16, 5000)
    expect((await upload("/api/workspace/logo", huge)).status).toBe(400)
    expect((await get("/api/workspace")).status).toBe(200)
    expect(((await (await get("/api/workspace")).json()) as { logo: unknown }).logo).toBeNull()
  })

  it("become an icon or go back to the initial, removing the image", async () => {
    await upload("/api/workspace/logo", PNG)
    const icon = await request("/api/workspace", { logo: { kind: "icon", icon: "leaf" } })
    expect(((await icon.json()) as { logo: unknown }).logo).toEqual({ kind: "icon", icon: "leaf" })
    expect(existsSync(join(root, "workspace", "worktable-logo.png"))).toBe(false)
    expect((await request("/api/workspace", { logo: { kind: "icon", icon: "../x" } })).status).toBe(400)
    const cleared = await request("/api/workspace", { logo: null })
    expect(((await cleared.json()) as { logo: unknown }).logo).toBeNull()
  })
})
