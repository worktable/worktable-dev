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
import { ownerIdentity } from "./auth.ts"
import { usesDocumentVersionStoreV2 } from "./document-version-compatibility-v2.ts"
import { createRegisteredDocument } from "./document-write-service.ts"
import { listDocuments } from "./document-query.ts"
import { advanceGenerationOnWrite, shareInFlightReads } from "./shared-reads.ts"
import { setDocArchived, writeDoc, writeSpace } from "./store.ts"
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
): Promise<Map<string, string | undefined>> {
  return new Map(
    (await listDocuments({ spaceId: space })).flatMap((item) =>
      item.kind === "document" ? [[item.path, item.updatedAt] as const] : []
    )
  )
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
    ]
    // Each write lands in its own Space after that Space's list is current.
    for (const { space } of writes) await createSpace(space)
    const before = new Map<string, Map<string, string | undefined>>()
    for (const { space } of writes) before.set(space, await listed(space))

    for (const { space, write, paths } of writes) {
      await write()
      const after = await listed(space)
      expect([...after.keys()]).toEqual(paths)
      if (space === "edited") {
        expect(after.get("notes/a")).not.toBe(before.get(space)?.get("notes/a"))
      }
    }
  })

  it("follows other processes' edits to metadata and layout files at once", async () => {
    const metaPath = spacePath(spaceId, "docs.meta.json")
    const manifestPath = join(root, "worktable.workspace.json")
    await writeFile(
      metaPath,
      JSON.stringify({
        version: 1,
        docs: { "notes/a": { createdAt: "2026-01-01T00:00:00.000Z" } },
      })
    )
    await settle(metaPath)
    await settle(manifestPath)
    expect([...(await listed()).keys()]).toEqual(["notes/a"])
    expect(await usesDocumentVersionStoreV2()).toBe(true)

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
      async () => (await listed()).get("notes/outside") === edited.toISOString()
    )
  })

  it("rebuilds a snapshot older than its maximum age without any signal", async () => {
    expect([...(await listed()).keys()]).toEqual(["notes/a"])
    await writeFile(
      spacePath(spaceId, "docs", "notes", "unseen.md"),
      "# Unseen\n"
    )

    setSystemTime(new Date(Date.now() + SPACE_SNAPSHOT_MAX_AGE_MS))
    expect([...(await listed()).keys()]).toEqual(["notes/a", "notes/unseen"])
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
