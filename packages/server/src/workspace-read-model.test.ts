import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  setSystemTime,
} from "bun:test"
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Hono } from "hono"
import { listAnnotations } from "./annotation-store.ts"
import { ownerIdentity } from "./auth.ts"
import { createDocumentAnnotationForPath } from "./document-annotation-service.ts"
import {
  readDocumentAnnotationsV2,
  writeDocumentAnnotationsV2,
} from "./document-data-v2.ts"
import { readDocumentPage } from "./document-page-service.ts"
import { usesDocumentVersionStoreV2 } from "./document-version-compatibility-v2.ts"
import { createRegisteredDocument } from "./document-write-service.ts"
import { listDocuments } from "./document-query.ts"
import { listPending } from "./pending.ts"
import { advanceGenerationOnWrite, shareInFlightReads } from "./shared-reads.ts"
import { setDocArchived, writeDoc, writeSpace } from "./store.ts"
import { updateWidgetMetadata } from "./widget-store.ts"
import { writeManagedFixtureHtml } from "./fixtures/managed-content.ts"
import { WorkspaceWatcher } from "./watcher.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
} from "./workspace.ts"
import { SPACE_SNAPSHOT_MAX_AGE_MS } from "./workspace-read-model.ts"

const spaceId = "read-model"
let root = ""
let watcher: WorkspaceWatcher | null = null

function spacePath(space: string, ...segments: string[]): string {
  return join(root, "spaces", space, ...segments)
}

/** Make a file look settled, as files untouched for a while are. */
async function settle(path: string): Promise<void> {
  const past = new Date(Date.now() - 60_000)
  await utimes(path, past, past)
}

/** A Space holding one Markdown file written outside Worktable. */
async function createSpace(id: string): Promise<void> {
  const now = new Date().toISOString()
  await writeSpace({
    type: "worktable.space",
    version: 1,
    id,
    name: id,
    createdAt: now,
    updatedAt: now,
    createdBy: "test",
    settings: {},
  })
  await mkdir(spacePath(id, "docs", "notes"), { recursive: true })
  await writeFile(spacePath(id, "docs", "notes", "a.md"), "# A\n")
  await settle(spacePath(id, "docs", "notes", "a.md"))
}

async function listed(
  space = spaceId
): Promise<Map<string, { title: string; updatedAt?: string }>> {
  return new Map(
    (await listDocuments({ spaceId: space })).flatMap((item) =>
      item.kind === "document"
        ? [[item.path, { title: item.title, updatedAt: item.updatedAt }]]
        : []
    )
  )
}

function openPage(path: string) {
  return readDocumentPage({
    spaceId,
    path,
    includeArchived: true,
    rawSourceAuthorized: false,
    annotationsAuthorized: false,
    sharingAuthorized: false,
  })
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not reached")
    // test-policy: external-readiness-backoff
    await Bun.sleep(20)
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "worktable-read-model-"))
  setWorkspaceRootOverride(root)
  ensureWorkspaceManifest()
  await createSpace(spaceId)
})

afterEach(async () => {
  watcher?.stop()
  watcher = null
  setSystemTime()
  setWorkspaceRootOverride(null)
  await rm(root, { recursive: true, force: true })
})

describe("workspace read model", () => {
  it("lists the server's own writes as soon as they return", async () => {
    const markdown = { id: "worktable.markdown", sourceVersion: 1 } as const
    const writes = [
      {
        space: "created",
        write: () =>
          createRegisteredDocument({
            spaceId: "created",
            path: "notes/b",
            format: markdown,
            bytes: new TextEncoder().encode("# B"),
            createdBy: "test",
            source: "rest-api",
          }),
        paths: ["notes/a", "notes/b"],
      },
      {
        space: "archived",
        write: () => setDocArchived("archived", "notes/a", true, "test"),
        paths: [],
      },
      {
        space: "written",
        write: () =>
          writeDoc("written", "notes/c", "# C", {
            updatedBy: "test",
            source: "rest-api",
          }),
        paths: ["notes/a", "notes/c"],
      },
      {
        space: "edited",
        write: () =>
          writeDoc("edited", "notes/a", "# A\n\nEdited.", {
            updatedBy: "test",
            source: "rest-api",
          }),
        paths: ["notes/a"],
      },
      {
        space: "renamed",
        write: async () =>
          (
            await updateWidgetMetadata("renamed", "boards/status", {
              name: "Renamed board",
            })
          ).release?.(),
        paths: ["boards/status", "notes/a"],
      },
    ]
    // Each write lands in its own Space after that Space's list is current.
    for (const { space } of writes) await createSpace(space)
    const now = new Date().toISOString()
    const created = await writeManagedFixtureHtml(
      "renamed",
      {
        version: 1,
        kind: "worktable.widget",
        id: "boards/status",
        name: "Status",
        createdAt: now,
        updatedAt: now,
        createdBy: "test",
        metadata: {},
        runtime: { type: "html", entry: "index.html" },
        permissions: {
          network: false,
          records: {},
          state: { read: true, write: true },
        },
      },
      "<h1>Status</h1>"
    )
    created.release?.()
    const before = new Map<string, Awaited<ReturnType<typeof listed>>>()
    for (const { space } of writes) before.set(space, await listed(space))
    expect(before.get("renamed")?.get("boards/status")?.title).toBe("Status")

    for (const { space, write, paths } of writes) {
      await write()
      const after = await listed(space)
      expect([...after.keys()]).toEqual(paths)
      if (space === "edited") {
        expect(after.get("notes/a")?.updatedAt).not.toBe(
          before.get(space)?.get("notes/a")?.updatedAt
        )
      }
      if (space === "renamed") {
        expect(after.get("boards/status")?.title).toBe("Renamed board")
      }
    }
  })

  it("follows other processes' edits to metadata and layout files at once", async () => {
    const metaPath = spacePath(spaceId, "docs.meta.json")
    const manifestPath = join(root, "worktable.workspace.json")
    const aliasPath = spacePath(spaceId, "doc-aliases.json")
    const aliases = (exact: Record<string, string>) =>
      JSON.stringify({ type: "worktable.doc-aliases", version: 1, exact, prefixes: {} })
    await writeFile(
      metaPath,
      JSON.stringify({
        version: 1,
        docs: { "notes/a": { createdAt: "2026-01-01T00:00:00.000Z" } },
      })
    )
    await writeFile(aliasPath, aliases({}))
    // Past the racy window, parsed files are kept while their fingerprints
    // hold, so only the fingerprints can show these edits.
    setSystemTime(new Date(Date.now() + 60_000))
    expect([...(await listed()).keys()]).toEqual(["notes/a"])
    expect(await usesDocumentVersionStoreV2()).toBe(true)
    expect(await openPage("notes/old")).toBeNull()

    // git brings in a rename made on another machine.
    await writeFile(aliasPath, aliases({ "notes/old": "notes/a" }))
    expect(await openPage("notes/old")).toMatchObject({
      kind: "document",
      resolvedFrom: "notes/old",
    })

    // The CLI or a stdio agent archives the document by editing the file in
    // place; no watcher is running to report it.
    const meta = JSON.parse(await readFile(metaPath, "utf8"))
    meta.docs["notes/a"].archived = {
      archivedAt: new Date().toISOString(),
      archivedBy: "cli",
    }
    await writeFile(metaPath, JSON.stringify(meta))
    expect([...(await listed()).keys()]).toEqual([])

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: 1 }))
    expect(await usesDocumentVersionStoreV2()).toBe(false)
  })

  it("lists outside document edits once the watcher reports them", async () => {
    watcher = new WorkspaceWatcher(10)
    watcher.start()
    expect([...(await listed()).keys()]).toEqual(["notes/a"])

    const added = spacePath(spaceId, "docs", "notes", "outside.md")
    await writeFile(added, "# Outside\n")
    await eventually(async () => (await listed()).has("notes/outside"))

    await appendFile(added, "\nAppended by an editor.\n")
    const edited = new Date("2030-01-02T03:04:05.000Z")
    await utimes(added, edited, edited)
    await eventually(
      async () =>
        (await listed()).get("notes/outside")?.updatedAt ===
        edited.toISOString()
    )
  })

  it("checks an expired snapshot against edits nothing reported", async () => {
    const note = (name: string) => spacePath(spaceId, "docs", "notes", name)
    await writeFile(note("b.md"), "# B\n")
    // Past the racy window an unchanged fingerprint is trusted, so only the
    // files themselves can show what changed. No watcher is running.
    let now = Date.now() + 60_000
    setSystemTime(new Date(now))
    expect([...(await listed()).keys()]).toEqual(["notes/a", "notes/b"])

    // An editor saves one file in place.
    await appendFile(note("a.md"), "\nEdited elsewhere.\n")
    const edited = new Date("2020-01-02T03:04:05.000Z")
    await utimes(note("a.md"), edited, edited)
    now += SPACE_SNAPSHOT_MAX_AGE_MS
    setSystemTime(new Date(now))
    expect((await listed()).get("notes/a")?.updatedAt).toBe(
      edited.toISOString()
    )

    // A sync client adds one file and removes another.
    await writeFile(note("unseen.md"), "# Unseen\n")
    await rm(note("b.md"))
    now += SPACE_SNAPSHOT_MAX_AGE_MS
    setSystemTime(new Date(now))
    expect([...(await listed()).keys()]).toEqual(["notes/a", "notes/unseen"])
  })

  it("lists an HTML Doc renamed only in its saved properties", async () => {
    const now = new Date().toISOString()
    const created = await writeManagedFixtureHtml(
      spaceId,
      {
        version: 1,
        kind: "worktable.widget",
        id: "boards/status",
        name: "Status",
        createdAt: now,
        updatedAt: now,
        createdBy: "test",
        metadata: {},
        runtime: { type: "html", entry: "index.html" },
        permissions: {
          network: false,
          records: {},
          state: { read: true, write: true },
        },
      },
      "<h1>Status</h1>"
    )
    created.release?.()
    const rename = async (name: string) =>
      (await updateWidgetMetadata(spaceId, "boards/status", { name })).release?.()
    // The first rename also gives the Doc its durable identity.
    await rename("Renamed once")
    setSystemTime(new Date(Date.now() + 60_000))
    expect((await listed()).get("boards/status")?.title).toBe("Renamed once")

    await rename("Renamed twice")
    expect((await listed()).get("boards/status")?.title).toBe("Renamed twice")
  })

  it("opens a document as its file is now, not as the list last saw it", async () => {
    const page = () => openPage("notes/a")
    setSystemTime(new Date(Date.now() + 60_000))
    expect([...(await listed()).keys()]).toEqual(["notes/a"])

    const source = spacePath(spaceId, "docs", "notes", "a.md")
    await appendFile(source, "\nEdited elsewhere.\n")
    const edited = new Date("2020-01-02T03:04:05.000Z")
    await utimes(source, edited, edited)
    const opened = await page()
    expect(opened?.kind === "document" && opened.document.updatedAt).toBe(
      edited.toISOString()
    )
    expect((await listed()).get("notes/a")?.updatedAt).toBe(
      edited.toISOString()
    )

    await rm(source)
    expect(await page()).toBeNull()
  })

  it("shows annotation replies another process wrote", async () => {
    const { annotation } = await createDocumentAnnotationForPath({
      spaceId,
      path: "notes/a",
      input: {
        category: "comment",
        body: "Is this right?",
        author: { type: "user", id: "owner" },
      },
    })
    setSystemTime(new Date(Date.now() + 60_000))
    const pending = async () =>
      (await listPending(ownerIdentity())).items.map((item) => item.kind)
    expect(await pending()).toEqual([])

    // stdio MCP or the CLI answers from its own process.
    const documentId = annotation.target.documentId
    const file = await readDocumentAnnotationsV2({
      workspaceRoot: root,
      spaceId,
      documentId,
    })
    await writeDocumentAnnotationsV2({
      workspaceRoot: root,
      spaceId,
      documentId,
      logicalPath: "notes/a",
      annotations: [
        {
          ...annotation,
          thread: [
            {
              id: "msg_outside",
              author: { type: "agent", id: "agent-1" },
              body: "Yes.",
              createdAt: new Date().toISOString(),
            },
          ],
        },
      ],
      expectedRevision: file?.revision ?? null,
    })
    const listed = await listAnnotations(spaceId, { status: ["open"] })
    expect(listed.annotations[0]?.thread.map((reply) => reply.body)).toEqual([
      "Yes.",
    ])
    expect(await pending()).toEqual(["commentReply"])
  })
})

describe("shared in-flight reads", () => {
  function app() {
    let calls = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const instance = new Hono()
    instance.use("*", async (c, next) => {
      const scopes = c.req.header("x-test-scopes")?.split(",") ?? ["*"]
      c.set("identity", { ...ownerIdentity(), scopes })
      return next()
    })
    instance.use("*", advanceGenerationOnWrite)
    instance.use("/api/*", shareInFlightReads)
    instance.get("/api/recent", async (c) => {
      calls += 1
      const call = calls
      await gate
      return c.json({ call })
    })
    instance.post("/api/spaces", (c) => c.json({ ok: true }, 201))
    return { instance, calls: () => calls, release: () => release() }
  }

  it("shares one computation among identical requests made while it runs", async () => {
    const server = app()
    const first = server.instance.request("/api/recent?limit=5&sort=updated")
    const same = server.instance.request("/api/recent?sort=updated&limit=5")
    const otherScopes = server.instance.request(
      "/api/recent?limit=5&sort=updated",
      { headers: { "x-test-scopes": "documents:read" } }
    )
    server.release()
    const bodies = await Promise.all(
      [first, same, otherScopes].map(async (response) =>
        (await response).json()
      )
    )
    expect(bodies[0]).toEqual(bodies[1])
    expect(bodies[2]).not.toEqual(bodies[0])
    expect(server.calls()).toBe(2)
  })

  it("never lets a request made after a write join an earlier computation", async () => {
    const server = app()
    const before = server.instance.request("/api/recent")
    const write = await server.instance.request("/api/spaces", {
      method: "POST",
    })
    expect(write.status).toBe(201)
    const after = server.instance.request("/api/recent")
    server.release()
    const [beforeBody, afterBody] = await Promise.all(
      [before, after].map(async (response) => (await response).json())
    )
    expect(beforeBody).toEqual({ call: 1 })
    expect(afterBody).toEqual({ call: 2 })
  })
})
