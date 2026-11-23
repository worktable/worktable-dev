import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type { SpaceFile } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import { ownerIdentity } from "./auth.ts"
import { writeManagedFixtureDoc as writeDoc } from "./fixtures/managed-content.ts"
import { docsRouter } from "./routes/docs.ts"
import { documentsRouter } from "./routes/documents.ts"
import { recordsRouter } from "./routes/records.ts"
import { sidebarRouter } from "./routes/sidebar.ts"
import { spacesRouter } from "./routes/spaces.ts"
import { writeSpace } from "./store.ts"
import { noteSpaceChanged } from "./workspace-read-model.ts"
import { getSpaceLinkGraph, invalidateLinkGraph, onEmbeddedFilesChanged } from "./link-graph.ts"
import {
  ensureWorkspaceManifest,
  getWorkspaceRoot,
  setWorkspaceRootOverride,
} from "./workspace.ts"

function space(id: string): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

function app() {
  const app = new Hono()
  app.use("*", async (c, next) => {
    const scopes = c.req.header("x-test-scopes")?.split(",")
    c.set("identity", scopes ? { ...ownerIdentity(), scopes } : ownerIdentity())
    await next()
  })
  app.route("/api/sidebar", sidebarRouter)
  app.route("/api/spaces", spacesRouter)
  app.route("/api/spaces/:spaceId/documents", documentsRouter)
  app.route("/api/spaces/:spaceId/docs", docsRouter)
  app.route("/api/spaces/:spaceId/records", recordsRouter)
  return app
}

async function get(path: string, scopes?: string[]) {
  const response = await app().fetch(
    new Request(`http://localhost${path}`, {
      headers: scopes ? { "x-test-scopes": scopes.join(",") } : {},
    })
  )
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

let root = ""
let appDir = ""

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "worktable-sidebar-"))
  appDir = mkdtempSync(join(tmpdir(), "worktable-sidebar-app-"))
  setWorkspaceRootOverride(root)
  setAppDirOverride(appDir)
  invalidateLinkGraph()
  ensureWorkspaceManifest()
  for (const id of ["alpha", "beta"]) {
    await writeSpace(space(id))
    await writeDoc(id, "notes/first", "# First\n")
    await writeDoc(id, "plans/second", "# Second\n")
  }
})

afterEach(() => {
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  rmSync(root, { recursive: true, force: true })
  rmSync(appDir, { recursive: true, force: true })
})

describe("GET /api/sidebar", () => {
  it("sends each Space's contents exactly as its own routes do", async () => {
    const { spaces } = (await get("/api/sidebar")) as {
      spaces: Record<string, unknown>[]
    }
    expect(spaces.map((entry) => entry["id"]).sort()).toEqual(["alpha", "beta"])
    for (const entry of spaces) {
      const id = String(entry["id"])
      expect(entry["page"]).toEqual(await get(`/api/spaces/${id}`))
      expect(entry["docs"]).toEqual(
        (await get(`/api/spaces/${id}/docs?includeArchived=true`))["docs"]
      )
      expect(entry["documents"]).toEqual(
        (await get(`/api/spaces/${id}/documents?includeArchived=true`))[
          "documents"
        ]
      )
      // No record index runs here: collections would be counted by reading
      // every record file, so the opened Space reads its own instead.
      expect(entry["collections"]).toBeUndefined()
      expect((entry["documents"] as unknown[]).length).toBeGreaterThan(0)
    }
  })

  it("leaves out what the caller's scopes don't cover", async () => {
    const { spaces } = (await get("/api/sidebar", ["docs:read"])) as {
      spaces: Record<string, unknown>[]
    }
    expect(spaces).toHaveLength(2)
    for (const entry of spaces) {
      expect(entry["documents"]).toBeUndefined()
      expect(entry["collections"]).toBeUndefined()
      expect((entry["page"] as { pins: unknown[] }).pins).toEqual([])
    }
  })
})

describe("GET /api/spaces/:id/documents", () => {
  it("marks the files a Doc shows, without waiting for the Space's links", async () => {
    const folder = join(getWorkspaceRoot(), "spaces", "alpha", "docs", "notes")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "shown.png"), "png")
    writeFileSync(join(folder, "linked.png"), "png")
    writeFileSync(join(folder, "loose.png"), "png")
    await writeDoc(
      "alpha",
      "notes/first",
      "# First\n\n![Shot](shown.png)\n\nSee [the other](linked.png).\n"
    )
    noteSpaceChanged("alpha")
    const embedded = async () => {
      const { documents } = (await get("/api/spaces/alpha/documents")) as {
        documents: Array<{ path: string; embedded?: true }>
      }
      return documents.flatMap((item) => (item.embedded ? [item.path] : []))
    }
    // The first list answers at once; the links are read behind it.
    const changed: string[] = []
    const stop = onEmbeddedFilesChanged((spaceId) => changed.push(spaceId))
    await embedded()
    await getSpaceLinkGraph("alpha")
    stop()
    expect(changed).toContain("alpha")
    // Shown, not merely linked or loose.
    expect(await embedded()).toEqual(["notes/shown.png"])
  })
})
