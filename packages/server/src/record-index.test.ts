import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fc from "fast-check"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setAppDirOverride } from "./app-storage.ts"
import { recordIndex } from "./record-index.ts"
import {
  buildRecordFile,
  createRecord,
  deleteRecord,
  updateRecord,
  writeRecord,
  writeRecordCollectionSchema,
  buildRecordCollectionSchema,
} from "./record-store.ts"
import { setWorkspaceRootOverride } from "./workspace.ts"
import { stringifyCanonicalYaml } from "./yaml.ts"
import { runRecordReconcileSweep } from "./index.ts"
import { wsManager } from "./ws.ts"

let workspaceDir: string
let appDir: string

function recordFilePath(
  spaceId: string,
  collectionId: string,
  recordId: string
): string {
  return join(
    workspaceDir,
    "spaces",
    spaceId,
    "records",
    collectionId,
    `${recordId}.yaml`
  )
}

function writeRecordFileDirectly(
  spaceId: string,
  collectionId: string,
  recordId: string,
  data: Record<string, unknown>
): void {
  const record = buildRecordFile({
    id: recordId,
    collectionId,
    data,
    createdBy: "external",
  })
  mkdirSync(join(workspaceDir, "spaces", spaceId, "records", collectionId), {
    recursive: true,
  })
  writeFileSync(
    recordFilePath(spaceId, collectionId, recordId),
    stringifyCanonicalYaml(record)
  )
}

// Rows normalized for deep comparison: json key order differs between the
// write-through path (builder object) and the file-parse path (zod shape), so
// compare parsed objects, not strings.
function normalizedRows() {
  return recordIndex
    .dumpRowsForTests()
    .map((row) => ({ ...row, json: row.json ? JSON.parse(row.json) : null }))
}

describe("record index", () => {
  beforeEach(async () => {
    workspaceDir = mkdtempSync(join(tmpdir(), "worktable-recidx-ws-"))
    appDir = mkdtempSync(join(tmpdir(), "worktable-recidx-app-"))
    mkdirSync(join(workspaceDir, "spaces"), { recursive: true })
    setWorkspaceRootOverride(workspaceDir)
    setAppDirOverride(appDir)
    recordIndex.start()
    await recordIndex.whenReady()
  })

  afterEach(async () => {
    await recordIndex.whenIdle()
    recordIndex.stop()
    setWorkspaceRootOverride(null)
    setAppDirOverride(null)
    for (const dir of [workspaceDir, appDir]) {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  })

  it("applies store writes synchronously (write-through, read-your-writes)", async () => {
    const created = await createRecord("meta", "tasks", {
      id: "alpha",
      data: { title: "Alpha" },
    })
    expect(created.error).toBeNull()
    const rows = recordIndex.listCollection("meta", "tasks", true)
    expect(rows).toHaveLength(1)
    expect(rows?.[0]?.id).toBe("alpha")

    await updateRecord("meta", "tasks", "alpha", { data: { title: "Alpha 2" } })
    expect(
      recordIndex.listCollection("meta", "tasks", true)?.[0]?.data["title"]
    ).toBe("Alpha 2")

    await deleteRecord("meta", "tasks", "alpha")
    expect(recordIndex.listCollection("meta", "tasks", true)).toHaveLength(0)
  })

  it("ignores unpublished space directories when rebuilding", async () => {
    const stagingId = "welcome-seed-abandoned"
    const now = new Date().toISOString()
    mkdirSync(join(workspaceDir, "spaces", stagingId), { recursive: true })
    writeFileSync(
      join(workspaceDir, "spaces", stagingId, "space.json"),
      JSON.stringify({
        type: "worktable.space",
        version: 1,
        id: "welcome",
        name: "Welcome to Worktable",
        createdAt: now,
        updatedAt: now,
        createdBy: "worktable",
        settings: {},
      })
    )
    writeRecordFileDirectly(stagingId, "tasks", "ghost", {
      title: "Unpublished starter record",
    })

    recordIndex.stop()
    recordIndex.start()
    await recordIndex.whenReady()

    expect(
      recordIndex
        .dumpRowsForTests()
        .some((row) => row.space_id === stagingId)
    ).toBe(false)
  })

  it("waits for store-triggered collection refreshes before becoming idle", async () => {
    const originalRefresh = recordIndex.refreshCollection.bind(recordIndex)
    let release!: () => void
    let started!: () => void
    const refreshStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const refreshReleased = new Promise<void>((resolve) => {
      release = resolve
    })
    recordIndex.refreshCollection = async () => {
      started()
      await refreshReleased
    }

    try {
      await writeRecordCollectionSchema(
        "meta",
        buildRecordCollectionSchema({ id: "tasks", name: "Tasks" })
      )
      await refreshStarted
      let idle = false
      const waiting = recordIndex.whenIdle().then(() => {
        idle = true
      })
      await Promise.resolve()
      expect(idle).toBe(false)

      release()
      await waiting
      expect(idle).toBe(true)
    } finally {
      recordIndex.refreshCollection = originalRefresh
      release()
    }
  })

  it("treats the watcher echo of an internal write as a no-op (hash-idempotent)", async () => {
    await createRecord("meta", "tasks", {
      id: "alpha",
      data: { title: "Alpha" },
    })
    const before = normalizedRows()
    // The watcher would call exactly this after the debounce.
    await recordIndex.ingestFile("meta", "tasks", "alpha")
    await recordIndex.ingestFile("meta", "tasks", "alpha")
    expect(normalizedRows()).toEqual(before)
  })

  it("ingests external edits: valid file, corrupt file, and deletion", async () => {
    writeRecordFileDirectly("meta", "tasks", "ext", { title: "External" })
    await recordIndex.ingestFile("meta", "tasks", "ext")
    expect(recordIndex.listCollection("meta", "tasks", true)).toHaveLength(1)

    writeFileSync(
      recordFilePath("meta", "tasks", "ext"),
      "title: [broken\n  nope: {\n"
    )
    await recordIndex.ingestFile("meta", "tasks", "ext")
    expect(recordIndex.listCollection("meta", "tasks", true)).toHaveLength(0)
    const diagnostics = recordIndex.listDiagnostics("meta", "tasks")
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics?.[0]?.file).toBe("ext.yaml")

    rmSync(recordFilePath("meta", "tasks", "ext"), { force: true })
    await recordIndex.ingestFile("meta", "tasks", "ext")
    expect(recordIndex.dumpRowsForTests()).toHaveLength(0)
  })

  it("rebuild repairs a missed deletion (drift heal)", async () => {
    await createRecord("meta", "tasks", {
      id: "alpha",
      data: { title: "Alpha" },
    })
    await createRecord("meta", "tasks", { id: "beta", data: { title: "Beta" } })
    // Simulate a missed watcher event: file removed, no ingest call.
    rmSync(recordFilePath("meta", "tasks", "beta"), { force: true })
    expect(recordIndex.listCollection("meta", "tasks", true)).toHaveLength(2)
    await recordIndex.rebuild()
    const rows = recordIndex.listCollection("meta", "tasks", true)
    expect(rows).toHaveLength(1)
    expect(rows?.[0]?.id).toBe("alpha")
  })

  it("populates collection health before the initial index becomes ready", async () => {
    recordIndex.stop()
    await writeRecordCollectionSchema(
      "meta",
      buildRecordCollectionSchema({ id: "tasks", name: "Tasks" })
    )
    await createRecord("meta", "tasks", {
      id: "alpha",
      data: { title: "Alpha" },
    })

    recordIndex.start()
    await recordIndex.whenReady()

    expect(recordIndex.cachedCollectionHealth("meta", "tasks")).toMatchObject({
      state: "ready",
      canonicalFileCount: 1,
      indexedFileCount: 1,
    })
  })

  it("reports collection drift and reconciles missed creates, updates, and deletes", async () => {
    writeRecordFileDirectly("meta", "tasks", "external", { title: "Created" })
    expect(await recordIndex.collectionHealth("meta", "tasks")).toMatchObject({
      state: "drifted",
      canonicalFileCount: 1,
      indexedFileCount: 0,
    })

    const created = await recordIndex.reconcileCollection("meta", "tasks")
    expect(created).toMatchObject({
      state: "ready",
      canonicalFileCount: 1,
      indexedFileCount: 1,
      validRecordCount: 1,
      changedRecordCount: 1,
    })
    expect(created.lastReconciledAt).not.toBeNull()

    writeRecordFileDirectly("meta", "tasks", "external", { title: "Updated" })
    const updated = await recordIndex.reconcileCollection("meta", "tasks")
    expect(updated.changedRecordCount).toBe(1)
    expect(
      recordIndex.listCollection("meta", "tasks", true)?.[0]?.data["title"]
    ).toBe("Updated")

    rmSync(recordFilePath("meta", "tasks", "external"), { force: true })
    const deleted = await recordIndex.reconcileCollection("meta", "tasks")
    expect(deleted).toMatchObject({
      state: "ready",
      canonicalFileCount: 0,
      indexedFileCount: 0,
      changedRecordCount: 1,
    })
  })

  it("detects count-neutral id and content drift", async () => {
    await createRecord("meta", "tasks", {
      id: "alpha",
      data: { title: "Alpha" },
    })
    await createRecord("meta", "tasks", { id: "beta", data: { title: "Beta" } })
    expect(await recordIndex.collectionHealth("meta", "tasks")).toMatchObject({
      state: "ready",
      canonicalFileCount: 2,
      indexedFileCount: 2,
    })

    rmSync(recordFilePath("meta", "tasks", "beta"), { force: true })
    writeRecordFileDirectly("meta", "tasks", "gamma", { title: "Gamma" })
    expect(await recordIndex.collectionHealth("meta", "tasks")).toMatchObject({
      state: "drifted",
      canonicalFileCount: 2,
      indexedFileCount: 2,
    })
    await recordIndex.reconcileCollection("meta", "tasks")

    writeRecordFileDirectly("meta", "tasks", "alpha", {
      title: "Alpha changed without an event",
    })
    expect(await recordIndex.collectionHealth("meta", "tasks")).toMatchObject({
      state: "drifted",
      canonicalFileCount: 2,
      indexedFileCount: 2,
    })
  })

  it("detects a schema edit missed by the watcher", async () => {
    await writeRecordCollectionSchema(
      "meta",
      buildRecordCollectionSchema({
        id: "tasks",
        name: "Tasks",
        fields: { project: { type: "relation", references: "projects" } },
      })
    )
    await recordIndex.refreshCollection("meta", "tasks")
    expect(await recordIndex.collectionHealth("meta", "tasks")).toMatchObject({
      state: "ready",
    })

    const schemaPath = join(
      workspaceDir,
      "spaces",
      "meta",
      "records",
      "tasks",
      "schema.yaml"
    )
    writeFileSync(
      schemaPath,
      (await Bun.file(schemaPath).text()).replace(
        /name: "?Tasks"?/,
        'name: "Changed without an event"'
      )
    )
    expect(await recordIndex.collectionHealth("meta", "tasks")).toMatchObject({
      state: "drifted",
    })

    expect(
      await recordIndex.reconcileCollection("meta", "tasks")
    ).toMatchObject({ state: "ready" })
  })

  it("rejects non-canonical projection-health identities before filesystem access", async () => {
    expect(await recordIndex.collectionHealth("meta", "..")).toMatchObject({
      state: "disabled",
      canonicalFileCount: 0,
      indexedFileCount: 0,
    })
    expect(recordIndex.cachedCollectionHealth("meta", "..")).toBeNull()
  })

  it("indexes a path/embedded-identity mismatch as an actionable diagnostic", async () => {
    const mismatched = buildRecordFile({
      id: "other-id",
      collectionId: "other-collection",
      data: { title: "Mismatch" },
    })
    mkdirSync(join(workspaceDir, "spaces", "meta", "records", "tasks"), {
      recursive: true,
    })
    writeFileSync(
      recordFilePath("meta", "tasks", "expected-id"),
      stringifyCanonicalYaml(mismatched)
    )

    await recordIndex.reconcileCollection("meta", "tasks")
    expect(recordIndex.listCollection("meta", "tasks", true)).toEqual([])
    expect(recordIndex.listDiagnostics("meta", "tasks")).toEqual([
      {
        file: "expected-id.yaml",
        error:
          "Record identity does not match its canonical path (expected tasks/expected-id, found other-collection/other-id)",
      },
    ])
    expect(await recordIndex.collectionHealth("meta", "tasks")).toMatchObject({
      state: "degraded",
      canonicalFileCount: 1,
      indexedFileCount: 1,
      invalidRecordCount: 1,
    })
  })

  it("starts fresh for a different workspace root (no cache bleed)", async () => {
    await createRecord("meta", "tasks", {
      id: "alpha",
      data: { title: "Alpha" },
    })
    expect(recordIndex.listCollection("meta", "tasks", true)).toHaveLength(1)

    const otherWorkspace = mkdtempSync(join(tmpdir(), "worktable-recidx-ws2-"))
    try {
      recordIndex.stop()
      setWorkspaceRootOverride(otherWorkspace)
      mkdirSync(join(otherWorkspace, "spaces"), { recursive: true })
      recordIndex.start()
      await recordIndex.whenReady()
      expect(recordIndex.listCollection("meta", "tasks", true)).toHaveLength(0)
    } finally {
      rmSync(otherWorkspace, { recursive: true, force: true })
    }
  })

  it("searches records by data, title, and collection name; archived excluded", async () => {
    await writeRecordCollectionSchema(
      "meta",
      buildRecordCollectionSchema({ id: "tasks", name: "Launch Tasks" })
    )
    await createRecord("meta", "tasks", {
      id: "alpha",
      data: { title: "Fix the bridge", status: "open" },
    })
    await createRecord("meta", "tasks", {
      id: "beta",
      data: { title: "Paint the shed", status: "done" },
    })
    const archived = buildRecordFile({
      id: "gone",
      collectionId: "tasks",
      data: { title: "Old bridge notes" },
    })
    archived.archive = {
      archivedAt: new Date().toISOString(),
      archivedBy: "user",
    }
    await writeRecord("meta", archived)

    const byData = recordIndex.searchRecords("bridge", 10)
    expect(byData?.map((h) => h.recordId)).toEqual(["alpha"])
    const byCollection = recordIndex.searchRecords("launch", 10)
    expect(byCollection?.map((h) => h.recordId).sort()).toEqual([
      "alpha",
      "beta",
    ])
    const byPrefix = recordIndex.searchRecords("pain", 10)
    expect(byPrefix?.map((h) => h.recordId)).toEqual(["beta"])
  })

  it("keeps archived records out of search after a collection rename", async () => {
    await writeRecordCollectionSchema(
      "meta",
      buildRecordCollectionSchema({ id: "tasks", name: "Tasks" })
    )
    await createRecord("meta", "tasks", {
      id: "live",
      data: { title: "Live bridge work" },
    })
    const archived = buildRecordFile({
      id: "gone",
      collectionId: "tasks",
      data: { title: "Archived bridge memo" },
    })
    archived.archive = {
      archivedAt: new Date().toISOString(),
      archivedBy: "user",
    }
    await writeRecord("meta", archived)
    expect(
      recordIndex.searchRecords("bridge", 10)?.map((h) => h.recordId)
    ).toEqual(["live"])

    // Renaming the collection rewrites the FTS rows; archived must stay out.
    await writeRecordCollectionSchema(
      "meta",
      buildRecordCollectionSchema({ id: "tasks", name: "Renamed Tasks" })
    )
    await recordIndex.refreshCollection("meta", "tasks")
    expect(
      recordIndex.searchRecords("bridge", 10)?.map((h) => h.recordId)
    ).toEqual(["live"])
    expect(
      recordIndex.searchRecords("renamed", 10)?.map((h) => h.recordId)
    ).toEqual(["live"])
  })

  it("a stale build from before stop() cannot mark a restarted index ready", async () => {
    await createRecord("meta", "tasks", {
      id: "alpha",
      data: { title: "Alpha" },
    })
    // Restart without awaiting builds: an old build's completion must not
    // flip ready on the new instance while its own build runs.
    recordIndex.stop()
    recordIndex.start()
    recordIndex.stop()
    expect(recordIndex.isReady()).toBe(false)
    recordIndex.start()
    await recordIndex.whenReady()
    expect(recordIndex.isReady()).toBe(true)
    expect(recordIndex.listCollection("meta", "tasks", true)).toHaveLength(1)
  })

  it("a row ingested while a rebuild is scanning survives the end-of-build prune", async () => {
    await createRecord("meta", "tasks", {
      id: "alpha",
      data: { title: "Alpha" },
    })
    // Kick a drift-repair rebuild and, while it is in flight, ingest a file
    // its directory listing may never have seen.
    const rebuilding = recordIndex.rebuild()
    writeRecordFileDirectly("meta", "tasks", "mid-build", {
      title: "Created mid-build",
    })
    await recordIndex.ingestFile("meta", "tasks", "mid-build")
    await rebuilding
    const ids = recordIndex
      .listCollection("meta", "tasks", true)
      ?.map((r) => r.id)
      .sort()
    expect(ids).toEqual(["alpha", "mid-build"])
  })

  it("collection metadata created while a rebuild scans survives its stale-metadata prune", async () => {
    await createRecord("meta", "tasks", {
      id: "alpha",
      data: { title: "Alpha" },
    })
    const originalIngest = recordIndex.ingestFile.bind(recordIndex)
    let entered!: () => void
    let release!: () => void
    const ingestEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const continueIngest = new Promise<void>((resolve) => {
      release = resolve
    })
    recordIndex.ingestFile = async (spaceId, collectionId, recordId) => {
      if (collectionId === "tasks" && recordId === "alpha") {
        entered()
        await continueIngest
      }
      await originalIngest(spaceId, collectionId, recordId)
    }
    try {
      const rebuilding = recordIndex.rebuild()
      await ingestEntered
      await writeRecordCollectionSchema(
        "meta",
        buildRecordCollectionSchema({ id: "projects", name: "Projects" })
      )
      await recordIndex.refreshCollection("meta", "projects")
      release()
      await rebuilding
      expect(recordIndex.projectedCollections()).toContainEqual({
        spaceId: "meta",
        collectionId: "projects",
      })
    } finally {
      recordIndex.ingestFile = originalIngest
      release()
    }
  })

  it("a store write racing collection reconciliation survives its stale-listing prune", async () => {
    await createRecord("meta", "tasks", {
      id: "alpha",
      data: { title: "Alpha" },
    })
    const originalIngest = recordIndex.ingestFile.bind(recordIndex)
    let entered!: () => void
    let release!: () => void
    const ingestEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const continueIngest = new Promise<void>((resolve) => {
      release = resolve
    })
    recordIndex.ingestFile = async (spaceId, collectionId, recordId) => {
      if (recordId === "alpha") {
        entered()
        await continueIngest
      }
      await originalIngest(spaceId, collectionId, recordId)
    }
    try {
      const reconciling = recordIndex.reconcileCollection("meta", "tasks")
      await ingestEntered
      await createRecord("meta", "tasks", {
        id: "mid-reconcile",
        data: { title: "Created during reconcile" },
      })
      release()
      await reconciling
      expect(
        recordIndex
          .listCollection("meta", "tasks", true)
          ?.map((record) => record.id)
          .sort()
      ).toEqual(["alpha", "mid-reconcile"])
    } finally {
      recordIndex.ingestFile = originalIngest
      release()
    }
  })

  it("the periodic sweep invalidates a collection removed from canonical files", async () => {
    await writeRecordCollectionSchema(
      "meta",
      buildRecordCollectionSchema({ id: "tasks", name: "Tasks" })
    )
    await recordIndex.refreshCollection("meta", "tasks")
    await createRecord("meta", "tasks", {
      id: "alpha",
      data: { title: "Alpha" },
    })
    const broadcasts: { spaceId: string; collectionId?: string }[] = []
    const originalBroadcast = wsManager.broadcast.bind(wsManager)
    wsManager.broadcast = ((spaceId, message) => {
      broadcasts.push({
        spaceId,
        collectionId:
          "collectionId" in message ? message.collectionId : undefined,
      })
    }) as typeof wsManager.broadcast
    try {
      rmSync(join(workspaceDir, "spaces", "meta", "records", "tasks"), {
        recursive: true,
        force: true,
      })
      await runRecordReconcileSweep()
      expect(broadcasts).toContainEqual({
        spaceId: "meta",
        collectionId: "tasks",
      })
      expect(recordIndex.listCollection("meta", "tasks", true)).toEqual([])
      expect(recordIndex.projectedCollections()).not.toContainEqual({
        spaceId: "meta",
        collectionId: "tasks",
      })
      expect(recordIndex.cachedCollectionHealth("meta", "tasks")).toBeNull()
    } finally {
      wsManager.broadcast = originalBroadcast
    }
  })

  it("overlapping rebuild calls serialize instead of pruning each other's rows", async () => {
    await createRecord("meta", "tasks", {
      id: "alpha",
      data: { title: "Alpha" },
    })
    await createRecord("meta", "tasks", { id: "beta", data: { title: "Beta" } })
    // Fire two rebuilds concurrently and ingest a brand-new file mid-flight;
    // unserialized rebuilds would let one scan's prune delete rows the other
    // (or the ingest) just wrote.
    const first = recordIndex.rebuild()
    const second = recordIndex.rebuild()
    writeRecordFileDirectly("meta", "tasks", "gamma", { title: "Gamma" })
    await recordIndex.ingestFile("meta", "tasks", "gamma")
    await Promise.all([first, second])
    const ids = recordIndex
      .listCollection("meta", "tasks", true)
      ?.map((r) => r.id)
      .sort()
    expect(ids).toEqual(["alpha", "beta", "gamma"])
  })

  it("an ingest racing store writes converges the index to the final file content", async () => {
    await createRecord("meta", "tasks", { id: "alpha", data: { title: "v0" } })
    // Interleave unawaited watcher-style ingests with store updates; the
    // shared per-path lock forces read-then-upsert to serialize with writes,
    // so the last completed operation must win.
    const work: Promise<unknown>[] = []
    for (let i = 1; i <= 10; i++) {
      work.push(recordIndex.ingestFile("meta", "tasks", "alpha"))
      work.push(
        updateRecord("meta", "tasks", "alpha", { data: { title: `v${i}` } })
      )
    }
    await Promise.all(work)
    await recordIndex.ingestFile("meta", "tasks", "alpha")
    const row = recordIndex.listCollection("meta", "tasks", true)?.[0]
    const onDisk = await Bun.file(
      recordFilePath("meta", "tasks", "alpha")
    ).text()
    expect(onDisk).toContain(`title: "${row?.data["title"]}"`)
    expect(row?.data["title"]).toBe("v10")
  })

  it("rebuilds search rows when FTS becomes available after a no-FTS run", async () => {
    await createRecord("meta", "tasks", {
      id: "alpha",
      data: { title: "Fix the bridge" },
    })
    expect(
      recordIndex.searchRecords("bridge", 10)?.map((h) => h.recordId)
    ).toEqual(["alpha"])
    recordIndex.stop()

    // Simulate a database written by a run where the FTS self-test failed:
    // records populated, no FTS table, meta says fts=0.
    const { Database } = await import("bun:sqlite")
    const dbPath = join(appDir, "records-index")
    const dirs = (await import("node:fs")).readdirSync(dbPath)
    const db = new Database(join(dbPath, dirs[0]!, "index.db"))
    db.run("UPDATE meta SET value = '0' WHERE key = 'fts'")
    db.run("DROP TABLE IF EXISTS records_fts")
    db.run("DROP TABLE IF EXISTS records_fts_data")
    db.run("DROP TABLE IF EXISTS records_fts_idx")
    db.run("DROP TABLE IF EXISTS records_fts_content")
    db.run("DROP TABLE IF EXISTS records_fts_docsize")
    db.run("DROP TABLE IF EXISTS records_fts_config")
    db.close()

    recordIndex.start()
    await recordIndex.whenReady()
    // The FTS-mode change wiped and rebuilt the file; search works again.
    expect(
      recordIndex.searchRecords("bridge", 10)?.map((h) => h.recordId)
    ).toEqual(["alpha"])
  })

  it("property: incremental maintenance is equivalent to a rebuild from files", async () => {
    const ids = ["a", "b", "c"] as const
    const opArb = fc.oneof(
      fc.record({
        op: fc.constant("store-write" as const),
        id: fc.constantFrom(...ids),
        value: fc.string({ maxLength: 8 }),
      }),
      fc.record({
        op: fc.constant("store-update" as const),
        id: fc.constantFrom(...ids),
        value: fc.string({ maxLength: 8 }),
      }),
      fc.record({
        op: fc.constant("store-delete" as const),
        id: fc.constantFrom(...ids),
      }),
      fc.record({
        op: fc.constant("external-write" as const),
        id: fc.constantFrom(...ids),
        value: fc.string({ maxLength: 8 }),
      }),
      fc.record({
        op: fc.constant("external-corrupt" as const),
        id: fc.constantFrom(...ids),
      }),
      fc.record({
        op: fc.constant("external-delete" as const),
        id: fc.constantFrom(...ids),
      })
    )

    await fc.assert(
      fc.asyncProperty(
        fc.array(opArb, { minLength: 1, maxLength: 12 }),
        async (ops) => {
          // Clean collection per run (same index instance, same workspace).
          rmSync(join(workspaceDir, "spaces", "meta", "records", "prop"), {
            recursive: true,
            force: true,
          })
          await recordIndex.rebuild()

          for (const op of ops) {
            if (op.op === "store-write") {
              await writeRecord(
                "meta",
                buildRecordFile({
                  id: op.id,
                  collectionId: "prop",
                  data: { title: op.value },
                })
              )
            } else if (op.op === "store-update") {
              await updateRecord("meta", "prop", op.id, {
                data: { note: op.value },
              })
            } else if (op.op === "store-delete") {
              await deleteRecord("meta", "prop", op.id)
            } else if (op.op === "external-write") {
              writeRecordFileDirectly("meta", "prop", op.id, {
                title: op.value,
              })
              await recordIndex.ingestFile("meta", "prop", op.id)
            } else if (op.op === "external-corrupt") {
              mkdirSync(
                join(workspaceDir, "spaces", "meta", "records", "prop"),
                { recursive: true }
              )
              writeFileSync(
                recordFilePath("meta", "prop", op.id),
                "data: [broken\n  x: {\n"
              )
              await recordIndex.ingestFile("meta", "prop", op.id)
            } else {
              rmSync(recordFilePath("meta", "prop", op.id), { force: true })
              await recordIndex.ingestFile("meta", "prop", op.id)
            }
          }

          const incremental = normalizedRows()
          await recordIndex.rebuild()
          expect(normalizedRows()).toEqual(incremental)
        }
      ),
      { numRuns: 25 }
    )
  })
})
