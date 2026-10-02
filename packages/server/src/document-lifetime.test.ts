import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import type { DocumentSummary, SpaceFile } from "@worktable/types"
import { ownerIdentity } from "./auth.ts"
import { createAnnotation } from "./annotation-store.ts"
import { runLifetimeSweep, LIFETIME_ACTOR } from "./document-lifetime.ts"
import { setRegisteredDocumentArchived } from "./document-write-service.ts"
import { listRecentDocuments } from "./recent-documents.ts"
import { documentsRouter } from "./routes/documents.ts"
import { widgetsRouter } from "./routes/widgets.ts"
import { getDocArchiveInfo, setDocArchived, setSpaceArchived, writeDoc, writeSpace } from "./store.ts"
import { ensureWorkspaceManifest, setWorkspaceRootOverride } from "./workspace.ts"

const spaceId = "lifetime"
const DAY = 86_400_000
let root = ""

function space(): SpaceFile {
  const now = new Date().toISOString()
  return {
    type: "worktable.space",
    version: 1,
    id: spaceId,
    name: "Lifetime",
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  }
}

function app() {
  const instance = new Hono()
  instance.use("*", async (c, next) => {
    c.set("identity", { ...ownerIdentity(), scopes: ["*"] })
    return next()
  })
  instance.route("/api/spaces/:spaceId/documents", documentsRouter)
  instance.route("/api/spaces/:spaceId/widgets", widgetsRouter)
  return instance
}

async function call(
  method: string,
  route: string,
  body?: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const base = route.startsWith("/widgets") ? "" : "/documents"
  const response = await app().request(`/api/spaces/${spaceId}${base}${route}`, {
    method,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  })
  const text = await response.text()
  let json: Record<string, unknown> = {}
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: response.status, json }
}

async function create(path: string, extra: Record<string, unknown> = {}) {
  return call("POST", "", {
    path,
    format: { id: "worktable.markdown", sourceVersion: 1 },
    source: `# ${path}\n`,
    ...extra,
  })
}

async function edit(path: string, text: string) {
  const { json } = await call("GET", `/editable-source?path=${encodeURIComponent(path)}`)
  const revision = json["sourceRevision"] as string
  const response = await call("PUT", "", {
    path,
    source: text,
    expectedRevision: revision,
  })
  expect(response.status).toBe(200)
}

async function summary(path: string): Promise<DocumentSummary | undefined> {
  const { json } = await call("GET", "?includeArchived=true")
  return (json["documents"] as DocumentSummary[]).find(
    (item) => item.kind === "document" && item.path === path
  )
}

function expectAbout(iso: string | undefined, expectedMs: number) {
  expect(iso).toBeDefined()
  expect(Math.abs(Date.parse(iso!) - expectedMs)).toBeLessThan(60_000)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-lifetime-"))
  setWorkspaceRootOverride(root)
  await ensureWorkspaceManifest()
  await writeSpace(space())
})

afterEach(async () => {
  setWorkspaceRootOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("document lifetime", () => {
  it("creates durable documents by default and records when they were created", async () => {
    const created = await create("notes/plan")
    expect(created.status).toBe(201)
    expect(created.json["lifetime"]).toBe("durable")

    const before = await summary("notes/plan")
    expect(before?.archiveOn).toBeUndefined()
    expectAbout(before?.createdAt, Date.now())

    await edit("notes/plan", "# Plan\n\nRevised.\n")
    expect((await summary("notes/plan"))?.createdAt).toBe(before?.createdAt)
  })

  it("keeps a temporary document for the grace period and honors an explicit date until its content changes", async () => {
    const created = await create("notes/scratch", { lifetime: "temporary" })
    expect(created.json["lifetime"]).toBe("temporary")
    expectAbout((await summary("notes/scratch"))?.archiveOn, Date.now() + 7 * DAY)

    const tomorrow = new Date(Date.now() + DAY).toISOString()
    await call("POST", "/lifetime", {
      path: "notes/scratch",
      lifetime: "temporary",
      archiveOn: tomorrow,
    })
    expect((await summary("notes/scratch"))?.archiveOn).toBe(tomorrow)

    await edit("notes/scratch", "# Scratch\n\nStill in use.\n")
    expectAbout((await summary("notes/scratch"))?.archiveOn, Date.now() + 7 * DAY)

    await call("POST", "/lifetime", { path: "notes/scratch", lifetime: "durable" })
    expect((await summary("notes/scratch"))?.archiveOn).toBeUndefined()
  })

  it("extends temporary documents on renames and people's comments, not system comments", async () => {
    await create("notes/handoff", { lifetime: "temporary" })
    const tomorrow = new Date(Date.now() + DAY).toISOString()
    await call("POST", "/lifetime", {
      path: "notes/handoff",
      lifetime: "temporary",
      archiveOn: tomorrow,
    })

    await createAnnotation(spaceId, {
      target: { type: "doc", docPath: "notes/handoff" },
      category: "comment",
      body: "Generated",
      author: { type: "system", id: "worktable" },
    })
    expect((await summary("notes/handoff"))?.archiveOn).toBe(tomorrow)

    await createAnnotation(spaceId, {
      target: { type: "doc", docPath: "notes/handoff" },
      category: "comment",
      body: "Still needed?",
      author: { type: "user", id: "user" },
    })
    expectAbout((await summary("notes/handoff"))?.archiveOn, Date.now() + 7 * DAY)

    await call("POST", "/lifetime", {
      path: "notes/handoff",
      lifetime: "temporary",
      archiveOn: tomorrow,
    })
    const moved = await call("POST", "/move", { path: "notes/handoff", to: "notes/next" })
    expect(moved.status).toBe(200)
    expectAbout((await summary("notes/next"))?.archiveOn, Date.now() + 7 * DAY)
  })

  it("archives documents whose date passed, keeps edited ones, and restores them as durable", async () => {
    await create("notes/done", { lifetime: "temporary" })
    await create("notes/active", { lifetime: "temporary" })
    const yesterday = new Date(Date.now() - DAY).toISOString()
    for (const path of ["notes/done", "notes/active"]) {
      await call("POST", "/lifetime", { path, lifetime: "temporary", archiveOn: yesterday })
    }
    await edit("notes/active", "# Active\n\nEdited after the date was chosen.\n")

    const receipts = await runLifetimeSweep()
    expect(receipts).toEqual([{ spaceId, archived: ["notes/done"], failed: [] }])
    expect((await getDocArchiveInfo(spaceId, "notes/done"))?.archivedBy).toBe(LIFETIME_ACTOR)
    expect((await summary("notes/active"))?.archived).toBeUndefined()

    const blocked = await call("POST", "/lifetime", { path: "notes/done", lifetime: "durable" })
    expect(blocked.status).toBe(409)

    // The archive itself re-checks the date under its lock.
    const raced = await setRegisteredDocumentArchived({
      spaceId,
      path: "notes/active",
      archived: true,
      archivedBy: LIFETIME_ACTOR,
      onlyIfDueBy: Date.now(),
    })
    expect(raced.notDue).toBe(true)
    expect((await summary("notes/active"))?.archived).toBeUndefined()

    expect((await call("POST", "/restore", { path: "notes/done" })).status).toBe(200)
    const restored = await summary("notes/done")
    expect(restored?.archived).toBeUndefined()
    expect(restored?.archiveOn).toBeUndefined()
    expect(await runLifetimeSweep()).toEqual([])
  })

  it("restoring a folder makes archived documents durable and leaves active ones alone", async () => {
    await create("notes/old", { lifetime: "temporary" })
    await create("notes/current", { lifetime: "temporary" })
    const before = (await summary("notes/current"))?.archiveOn
    expect((await call("POST", "/archive", { path: "notes/old" })).status).toBe(200)

    expect((await call("POST", "/restore-folder", { path: "notes" })).status).toBe(200)
    expect((await summary("notes/old"))?.archiveOn).toBeUndefined()
    expect((await summary("notes/current"))?.archiveOn).toBe(before)
  })

  it("creates temporary HTML documents and rejects dates without a temporary lifetime", async () => {
    const html = await call("POST", "/widgets", {
      id: "boards/status",
      name: "Status",
      html: "<!doctype html><html><head></head><body><p>Status</p></body></html>",
      lifetime: "temporary",
    })
    expect(html.status).toBe(201)
    expect(html.json["lifetime"]).toBe("temporary")
    expectAbout((await summary("boards/status"))?.archiveOn, Date.now() + 7 * DAY)

    const dated = await create("notes/dated", { archiveOn: "2030-01-01" })
    expect(dated.status).toBe(400)
    expect(await summary("notes/dated")).toBeUndefined()
  })

  it("does not rewrite document metadata for activity on durable documents", async () => {
    await create("notes/durable")
    const metaPath = join(root, "spaces", spaceId, "docs.meta.json")
    const before = (await stat(metaPath)).mtimeMs
    await createAnnotation(spaceId, {
      target: { type: "doc", docPath: "notes/durable" },
      category: "comment",
      body: "Looks good",
      author: { type: "user", id: "user" },
    })
    expect((await stat(metaPath)).mtimeMs).toBe(before)
  })

  it("applies one lifetime to a folder and rejects invalid dates", async () => {
    await create("notes/a")
    await create("notes/b")
    const folder = await call("POST", "/lifetime-folder", {
      path: "notes",
      lifetime: "temporary",
    })
    expect(folder.json["changed"]).toEqual(["notes/a", "notes/b"])
    expectAbout((await summary("notes/b"))?.archiveOn, Date.now() + 7 * DAY)

    for (const archiveOn of ["someday", "March 3", "5"]) {
      const invalid = await call("POST", "/lifetime", {
        path: "notes/a",
        lifetime: "temporary",
        archiveOn,
      })
      expect(invalid.status).toBe(400)
    }
  })

  it("preserves document metadata fields it does not interpret", async () => {
    await writeDoc(spaceId, "notes/kept", "# Kept", { updatedBy: "test", source: "rest-api" })
    const metaPath = join(root, "spaces", spaceId, "docs.meta.json")
    const meta = await readFile(metaPath, "utf8")
      .then((text) => JSON.parse(text))
      .catch(() => ({ version: 1, docs: {} }))
    meta.docs["notes/kept"] = { ...meta.docs["notes/kept"], futureField: { kept: true } }
    await writeFile(metaPath, JSON.stringify(meta))

    await setDocArchived(spaceId, "notes/kept", true, "test")
    await setDocArchived(spaceId, "notes/kept", false, "test")

    const after = JSON.parse(await readFile(metaPath, "utf8"))
    expect(after.docs["notes/kept"].futureField).toEqual({ kept: true })
  })

  it("lists recent durable documents, with temporary ones on request, never from archived Spaces", async () => {
    await create("notes/first")
    await create("notes/scratch", { lifetime: "temporary" })
    await create("notes/second")
    await writeDoc(spaceId, "notes/external", "# External", { updatedBy: "test", source: "filesystem" })

    const updated = await listRecentDocuments({ sort: "updated" })
    expect(updated.items.map((item) => item.document.path)).not.toContain("notes/scratch")
    expect(updated.items[0]?.spaceName).toBe("Lifetime")
    expect(updated.spaces).toEqual([{ spaceId, lastActivityAt: expect.any(String) }])

    const withTemporary = await listRecentDocuments({ sort: "updated", includeTemporary: true })
    expect(withTemporary.items.map((item) => item.document.path)).toContain("notes/scratch")

    // Created order uses recorded creation times; unknown ones are left out.
    const created = await listRecentDocuments({ sort: "created" })
    expect(created.items.map((item) => item.document.path)).toEqual(["notes/second", "notes/first"])

    await setSpaceArchived(spaceId, true, "test")
    expect((await listRecentDocuments({ sort: "updated" })).items).toEqual([])
  })
})
