import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import {
  emptyQuickdrawDocument,
  QUICKDRAW_FORMAT,
  type DocumentId,
  type SpaceFile,
} from "@worktable/types"
import {
  BILLING_HEADER,
  encodeTenantBilling,
  ENV,
  GATEWAY_HEADER,
} from "@worktable/hosted-contract"
import { setAppDirOverride } from "./app-storage.ts"
import { notePlanStorage } from "./hosted-billing.ts"
import { runDeletedItemsPass } from "./deleted-items.ts"
import { listDocumentGenerationsV2 } from "./document-version-store-v2.ts"
import {
  checkpointRegisteredDocument,
  createRegisteredDocument,
  deleteRegisteredDocument,
  readRegisteredDocumentSource,
  replaceRegisteredDocument,
  restoreRegisteredDocumentVersion,
} from "./document-write-service.ts"
import { withStagedUpload, writeUploadedFile } from "./file-uploads.ts"
import {
  invalidateServerSettingsCache,
  updateServerSettings,
} from "./settings-store.ts"
import { stagingDirectory } from "./staged-file.ts"
import {
  DEFAULT_STORAGE_LIMIT_BYTES,
  setStorageLimitForTests,
  startStorageLimits,
  storageGraceBytes,
  STORAGE_LIMIT_CEILING_BYTES,
  StorageLimitError,
  formatStorageBytes,
  storageLimitBytes,
  storagePruningSettled,
  storageSummary,
  storageTotalLimitBytes,
} from "./storage-limit.ts"
import { prunedHistoryFor, resetPrunedRecordForTests } from "./storage-pruned.ts"
import {
  setStoragePruningHooksForTests,
  storagePruningPlansForTests,
} from "./storage-pruning.ts"
import {
  activeStorageAccount,
  noteStorageChange,
  startStorageAccounting,
  storageUsage,
} from "./storage-usage.ts"
import { restoreDocVersion, writeDoc, writeSpace } from "./store.ts"
import { Hono } from "hono"
import { apiErrorResponse } from "./api-error-response.ts"
import { ownerIdentity } from "./auth.ts"
import { documentsRouter } from "./routes/documents.ts"
import type { TokenIdentity } from "./token-store.ts"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createWorktableMcpServer } from "./mcp/server.ts"
import { appendThreadMessage, createThread } from "./thread-store.ts"
import { WorkspaceWatcher } from "./watcher.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
  workspaceCacheKey,
} from "./workspace.ts"

const KB = 1024
let workspace: string
let app: string
let stops: (() => Promise<void>)[] = []
let watcher: WorkspaceWatcher | null = null
let listeners = new Map<string, (eventType: string, filename: string) => void>()

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

/** About `size` bytes of Markdown, different for each `fill`. */
const bytes = (size: number, fill: string) =>
  new TextEncoder().encode(
    `# ${fill}\n\n${fill.repeat(Math.ceil(size / fill.length)).slice(0, size)}\n`
  )

async function createDoc(path: string, size: number) {
  return createRegisteredDocument({
    spaceId: "notes",
    path,
    format: { id: "worktable.markdown", sourceVersion: 1 },
    bytes: bytes(size, path),
    createdBy: "test",
    source: "test",
  })
}

/** A Doc with `versions` versions of `size` bytes each, oldest first. */
async function docWithVersions(path: string, versions: number, size: number) {
  let written = await createDoc(path, size)
  for (let index = 1; index < versions; index += 1) {
    written = await replaceRegisteredDocument({
      spaceId: "notes",
      path,
      bytes: bytes(size, `${path}${index}`),
      expectedRevision: written.sourceRevision,
      updatedBy: "test",
      source: "test",
      separateVersion: true,
    })
  }
  return written.documentId as DocumentId
}

const generations = async (documentId: DocumentId) =>
  (
    await listDocumentGenerationsV2({
      workspaceRoot: workspace,
      spaceId: "notes",
      documentId,
    })
  ).map((manifest) => manifest.id)

/**
 * Limits `room` above what everything takes now, for the total limit, and,
 * for people's files, `filesRoom` above what they take (a gibibyte when not
 * given, so only the total limit is in play).
 */
async function limitsAbove(room: number, filesRoom?: number) {
  const total = await settled()
  setStorageLimitForTests(
    filesRoom === undefined
      ? 1024 ** 3
      : storageSummary()!.limit.countedBytes + filesRoom,
    { promptPruneMs: 10_000, totalBytes: total + room }
  )
}

/** Once the count, and any pruning a count started, have caught up. */
async function settled(): Promise<number> {
  await storagePruningSettled()
  await activeStorageAccount()!.settled()
  await storagePruningSettled()
  await activeStorageAccount()!.settled()
  return storageUsage()!.total.bytes
}

/** Every file under the workspace folder, relative to it. */
function workspaceFiles(): string[] {
  const found: string[] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else found.push(relative(workspace, path))
    }
  }
  visit(workspace)
  return found.sort()
}

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "wt-limit-ws-"))
  app = mkdtempSync(join(tmpdir(), "wt-limit-app-"))
  setWorkspaceRootOverride(workspace)
  setAppDirOverride(app)
  invalidateServerSettingsCache()
  await updateServerSettings({
    history: { retention: { mode: "age", maxAgeDays: 30 } },
  })
  ensureWorkspaceManifest()
  await writeSpace(space("notes"))
  resetPrunedRecordForTests()
  setStorageLimitForTests(null, { promptPruneMs: 10_000 })
  stops = [startStorageLimits(), startStorageAccounting()]
})

afterEach(async () => {
  watcher?.stop()
  watcher = null
  for (const stop of stops) await stop()
  setStorageLimitForTests(null)
  resetPrunedRecordForTests()
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  invalidateServerSettingsCache()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(app, { recursive: true, force: true })
})

describe("storage limit", () => {
  it("prunes deleted items first, then the oldest versions, enough for writes asking at once and no more", async () => {
    const older = await docWithVersions("older", 3, 16 * KB)
    const newer = await docWithVersions("newer", 2, 16 * KB)
    await createDoc("gone", 16 * KB)
    await deleteRegisteredDocument({ spaceId: "notes", path: "gone" })
    await runDeletedItemsPass()
    const olderBefore = await generations(older)
    const newerBefore = await generations(newer)
    expect(olderBefore).toHaveLength(3)

    // Room for a little less than the next Doc and its version.
    await limitsAbove(6 * KB)

    // The deleted item's trash goes first; every version stays.
    await createDoc("first", 4 * KB)
    let usage = await settled()
    expect(storageUsage()!.parts.trash.bytes).toBe(0)
    expect(await generations(older)).toEqual(olderBefore)
    expect(await generations(newer)).toEqual(newerBefore)
    expect(usage).toBeLessThanOrEqual(storageTotalLimitBytes())

    // Then the oldest versions in the whole Worktable, never a current one
    // or the one it replaced. Two writes ask at once, the second while the
    // first one's pass runs; pruning makes room for both, from the oldest,
    // and stops there.
    await limitsAbove(2 * KB)
    let second: Promise<unknown> | null = null
    setStoragePruningHooksForTests({
      beforeVersions: () => {
        second ??= createDoc("third", 4 * KB)
      },
    })
    await createDoc("second", 4 * KB)
    await second
    setStoragePruningHooksForTests({})
    usage = await settled()
    expect(usage).toBeLessThanOrEqual(storageTotalLimitBytes())
    expect(await generations(older)).toEqual(olderBefore.slice(0, 2))
    expect(await generations(newer)).toEqual(newerBefore)
    expect(
      (await readRegisteredDocumentSource({ spaceId: "notes", path: "older" }))
        .bytes
    ).toEqual(bytes(16 * KB, "older2"))

    // What went is recorded for the item, for its history route, and for
    // Settings.
    expect(prunedHistoryFor("notes", { documentId: older })?.versions).toBe(1)
    const api = new Hono()
      .use("*", async (c, next) => {
        c.set("identity", { ...ownerIdentity(), scopes: ["*"] })
        return next()
      })
      .route("/api/spaces/:spaceId/documents", documentsRouter)
    const history = (await (
      await api.request("/api/spaces/notes/documents/versions?path=older&all=true")
    ).json()) as { versions: unknown[]; pruned?: { versions: number } }
    expect(history.versions).toHaveLength(2)
    expect(history.pruned?.versions).toBe(1)
    expect(storageSummary()!.pruned).toMatchObject({ versions: 1, deletedItems: 1 })

    // Agents on the preview surface are told too, and that the Worktable is
    // at its limit when they orient; the released surface is unchanged.
    const agentReads = async (surface: "released" | "preview") => {
      const server = createWorktableMcpServer({ version: "test", scopes: ["*"], surface })
      const client = new Client({ name: "storage-test", version: "1" })
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
      await Promise.all([server.connect(serverSide), client.connect(clientSide)])
      try {
        const state = await client.callTool({ name: "worktable_state", arguments: {} })
        const versions = await client.callTool({
          name: "worktable_files_read",
          arguments: { spaceId: "notes", path: "older", versions: true, all: true },
        })
        return {
          state: state.structuredContent as { storage?: unknown },
          versions: versions.structuredContent as { pruned?: unknown },
        }
      } finally {
        await client.close()
      }
    }
    // The notice is about people's files: with them at 90% of the limit.
    setStorageLimitForTests(Math.ceil(storageSummary()!.limit.countedBytes / 0.9), {
      promptPruneMs: 10_000,
      totalBytes: storageTotalLimitBytes(),
    })
    const preview = await agentReads("preview")
    expect(preview.versions.pruned).toEqual({ versions: 1, at: expect.any(String) })
    expect(preview.state.storage).toEqual({
      usedBytes: storageSummary()!.limit.countedBytes,
      limitBytes: storageLimitBytes(),
      message: expect.stringContaining(`${Math.round(storageLimitBytes() / KB)} KB limit`),
    })
    const released = await agentReads("released")
    expect(released.versions).not.toHaveProperty("pruned")
    expect(released.state).not.toHaveProperty("storage")
  })

  it("admits restores and saved versions for what they keep, prunes a version once no restore holds it, and refuses when nothing is left", async () => {
    // Three versions. The oldest is neither current nor the one the current
    // version replaced, so it can go.
    const first = await createDoc("kept", 16 * KB)
    let written = first
    for (const [size, fill] of [[2 * KB, "kept1"], [16 * KB, "kept2"]] as const) {
      written = await replaceRegisteredDocument({
        spaceId: "notes",
        path: "kept",
        bytes: bytes(size, fill),
        expectedRevision: written.sourceRevision,
        updatedBy: "test",
        source: "test",
        separateVersion: true,
      })
    }
    const kept = first.documentId as DocumentId
    const oldest = (await generations(kept)).at(-1)!
    await limitsAbove(4 * KB)
    let before = workspaceFiles()

    // A restore keeps its checkpoint, and the version before it, for good:
    // it needs room for the restored version, on both restore paths, and
    // holds the version it reads, so pruning can't take that one meanwhile.
    const current = await readRegisteredDocumentSource({ spaceId: "notes", path: "kept" })
    const restore = await restoreRegisteredDocumentVersion({
      spaceId: "notes",
      path: "kept",
      versionId: oldest,
      expectedRevision: current.sourceRevision,
      restoredBy: "test",
      source: "test",
    }).catch((error) => error)
    expect(restore).toBeInstanceOf(StorageLimitError)
    expect(
      await restoreDocVersion("notes", "kept", oldest).catch((error) => error)
    ).toBeInstanceOf(StorageLimitError)
    expect(workspaceFiles()).toEqual(before)
    expect(await generations(kept)).toContain(oldest)

    // A write that couldn't fit even if all history went removes nothing,
    // however often it is tried.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await createDoc("huge", 64 * KB).catch((error) => error)).toBeInstanceOf(
        StorageLimitError
      )
    }
    expect(await generations(kept)).toContain(oldest)
    expect(storageSummary()!.pruned).toBeNull()

    // Once no restore holds it, that version goes to make room.
    await createDoc("after", 4 * KB)
    expect(await generations(kept)).not.toContain(oldest)

    // Now nothing is prunable: writes that add bytes are refused.
    await settled()
    before = workspaceFiles()
    const refused = await createDoc("refused", 8 * KB).catch((error) => error)
    expect(refused).toBeInstanceOf(StorageLimitError)
    expect(refused.code).toBe("STORAGE_LIMIT")
    expect(refused.message).toBe(
      // The files fit; what Worktable keeps with them doesn't.
      `This Worktable is close to its ${formatStorageBytes(storageLimitBytes())} limit. Delete something to make room.`
    )
    // Over REST, the server answers it with 507, the limit and what is used.
    const api = new Hono()
      .use("*", async (c, next) => {
        c.set("identity", { ...ownerIdentity(), scopes: ["*"] })
        return next()
      })
      .route("/api/spaces/:spaceId/documents", documentsRouter)
      .onError(apiErrorResponse)
    const overLimit = await api.request("/api/spaces/notes/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "refused-rest",
        format: { id: "worktable.markdown", sourceVersion: 1 },
        source: new TextDecoder().decode(bytes(8 * KB, "refused-rest")),
      }),
    })
    expect(overLimit.status).toBe(507)
    expect(await overLimit.json()).toEqual({
      error: refused.message,
      code: "STORAGE_LIMIT",
      limitBytes: storageLimitBytes(),
      usedBytes: expect.any(Number),
    })
    // An upload is staged first; a refused one leaves no file behind either.
    const upload = await withStagedUpload(new Response(new Uint8Array(8 * KB)), (file) =>
      writeUploadedFile({
        spaceId: "notes",
        path: "photo.bin",
        file,
        mode: { kind: "create", keepBoth: false },
        actor: "test",
        source: "test",
      })
    ).catch((error) => error)
    expect(upload).toBeInstanceOf(StorageLimitError)
    // A saved version is a whole copy kept for good.
    const now = await readRegisteredDocumentSource({ spaceId: "notes", path: "kept" })
    expect(
      await checkpointRegisteredDocument({
        spaceId: "notes",
        path: "kept",
        expectedRevision: now.sourceRevision,
        createdBy: "test",
        source: "test",
      }).catch((error) => error)
    ).toBeInstanceOf(StorageLimitError)
    expect(workspaceFiles()).toEqual(before)
    expect(existsSync(stagingDirectory()) ? readdirSync(stagingDirectory()) : []).toEqual([])

    // Reads, smaller replacements and deletes still work at the limit.
    await replaceRegisteredDocument({
      spaceId: "notes",
      path: "kept",
      bytes: bytes(2 * KB, "kept"),
      expectedRevision: now.sourceRevision,
      updatedBy: "test",
      source: "test",
    })
    await deleteRegisteredDocument({ spaceId: "notes", path: "kept" })
    // Deleting makes room for the very next write, before the deleted item
    // has moved to the trash: one that fits only once it goes.
    const prunedItems = storageSummary()!.pruned?.deletedItems ?? 0
    await createDoc("after-delete", 6.5 * KB)
    expect(storageSummary()!.pruned?.deletedItems).toBe(prunedItems + 1)
  })

  it("keeps the version a replace supersedes, and lets a person keep drawing, at the limit", async () => {
    const older = await docWithVersions("older", 3, 16 * KB)
    const report = await createDoc("report", 16 * KB)
    const reportId = report.documentId as DocumentId
    const single = await createDoc("single", 16 * KB)
    const singleId = single.documentId as DocumentId
    const original = await generations(reportId)
    const sketchSource = (text: string) =>
      new TextEncoder().encode(
        JSON.stringify({
          ...emptyQuickdrawDocument("Sketch"),
          snapshot: {
            document: {
              store: {
                note: {
                  id: "note",
                  typeName: "shape",
                  type: "text",
                  x: 0,
                  y: 0,
                  rot: 0,
                  z: 0,
                  props: { color: "black", size: "m", text, font: "draw" },
                },
              },
            },
          },
        })
      )
    let sketch = await createRegisteredDocument({
      spaceId: "notes",
      path: "sketch",
      format: { id: QUICKDRAW_FORMAT, sourceVersion: 1 },
      bytes: sketchSource("a"),
      createdBy: "test",
      source: "test",
    })
    await limitsAbove(4 * KB, 64 * KB)
    const replaceReport = (fill: string, basedOn: string) =>
      replaceRegisteredDocument({
        spaceId: "notes",
        path: "report",
        bytes: bytes(16 * KB, fill),
        expectedRevision: basedOn,
        updatedBy: "test",
        source: "test",
        separateVersion: true,
      })

    // Replacing the report makes room from the oldest history elsewhere;
    // the version it replaced stays.
    const second = await replaceReport("report2", report.sourceRevision)
    expect(await generations(reportId)).toEqual([second.versionId, ...original])
    expect((await generations(older)).length).toBe(2)
    // Each later replace lets the version before the one it replaces go,
    // never that one.
    const third = await replaceReport("report3", second.sourceRevision)
    await settled()
    expect(await generations(reportId)).toEqual([third.versionId, second.versionId])

    // With no other history left, a replace that would need the version it
    // replaces gone is refused, and that version stays.
    const before = await generations(singleId)
    const refused = await replaceRegisteredDocument({
      spaceId: "notes",
      path: "single",
      bytes: bytes(16 * KB, "single2"),
      expectedRevision: single.sourceRevision,
      updatedBy: "test",
      source: "test",
      separateVersion: true,
    }).catch((error) => error)
    expect(refused).toBeInstanceOf(StorageLimitError)
    expect(await generations(singleId)).toEqual(before)
    expect(
      (await readRegisteredDocumentSource({ spaceId: "notes", path: "single" })).bytes
    ).toEqual(bytes(16 * KB, "single"))
    // So is restoring the version before the current one: a restore can mark
    // the version it replaces as a checkpoint, which keeps that older one
    // too, so it can't count on making room. Both restore paths.
    const olderVersions = await generations(older)
    const olderNow = await readRegisteredDocumentSource({ spaceId: "notes", path: "older" })
    expect(
      await restoreRegisteredDocumentVersion({
        spaceId: "notes",
        path: "older",
        versionId: olderVersions[1]!,
        expectedRevision: olderNow.sourceRevision,
        restoredBy: "test",
        source: "test",
      }).catch((error) => error)
    ).toBeInstanceOf(StorageLimitError)
    expect(
      await restoreDocVersion("notes", "older", olderVersions[1]!).catch((error) => error)
    ).toBeInstanceOf(StorageLimitError)
    expect(await generations(older)).toEqual(olderVersions)
    expect(await settled()).toBeLessThanOrEqual(storageTotalLimitBytes())

    // A person's drawing keeps saving a little past the limit; an agent's
    // save is refused, and so is a person's that would go past the allowance.
    const save = async (identity: TokenIdentity, text: string) => {
      const api = new Hono()
        .use("*", async (c, next) => {
          c.set("identity", identity)
          return next()
        })
        .route("/api/spaces/:spaceId/documents", documentsRouter)
        .onError(apiErrorResponse)
      return api.request("/api/spaces/notes/documents", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "sketch",
          source: new TextDecoder().decode(sketchSource(text)),
          expectedRevision: sketch.sourceRevision,
        }),
      })
    }
    const agent = { ...ownerIdentity(), agent: "claude-code" }
    const stroke = "c".repeat(Math.round(storageGraceBytes() / 3))
    expect((await save(agent, stroke)).status).toBe(507)
    const drawn = await save(ownerIdentity(), stroke)
    expect(drawn.status).toBe(200)
    sketch = (await drawn.json()) as typeof sketch
    await settled()
    expect(storageSummary()!.limit.totalBytes).toBeGreaterThan(storageTotalLimitBytes())
    expect(
      new TextDecoder().decode(
        (await readRegisteredDocumentSource({ spaceId: "notes", path: "sketch" })).bytes
      )
    ).toContain(stroke)
    // A quick next save continues that version, so it is charged only for
    // what it adds, even near the end of the allowance.
    const next = await save(ownerIdentity(), `${stroke}${"e".repeat(Math.round(storageGraceBytes() / 3))}`)
    expect(next.status).toBe(200)
    sketch = (await next.json()) as typeof sketch
    await settled()
    const tooMuch = await save(ownerIdentity(), "d".repeat(storageGraceBytes() * 2))
    expect(tooMuch.status).toBe(507)
    await settled()
    expect(storageSummary()!.limit.totalBytes).toBeLessThanOrEqual(
      storageTotalLimitBytes() + storageGraceBytes()
    )
  })

  it("prunes history to fit a person's drawing save within its allowance", async () => {
    // Old history elsewhere that pruning may remove.
    const spare = await docWithVersions("spare", 3, 16 * KB)
    const drawing = (text: string) =>
      JSON.stringify({
        ...emptyQuickdrawDocument("Sketch"),
        snapshot: {
          document: {
            store: {
              note: {
                id: "note",
                typeName: "shape",
                type: "text",
                x: 0,
                y: 0,
                rot: 0,
                z: 0,
                props: { color: "black", size: "m", text, font: "draw" },
              },
            },
          },
        },
      })
    const sketch = await createRegisteredDocument({
      spaceId: "notes",
      path: "sketch",
      format: { id: QUICKDRAW_FORMAT, sourceVersion: 1 },
      bytes: new TextEncoder().encode(drawing("a")),
      createdBy: "test",
      source: "test",
    })
    await limitsAbove(1 * KB, 64 * KB)
    const before = await generations(spare)
    // The save needs more than the room plus the oldest version elsewhere,
    // so it fits only within its allowance, and only once that version goes.
    const stroke = "c".repeat(Math.round((17 * KB + storageGraceBytes() / 2) / 2))
    const api = new Hono()
      .use("*", async (c, next) => {
        c.set("identity", ownerIdentity())
        return next()
      })
      .route("/api/spaces/:spaceId/documents", documentsRouter)
      .onError(apiErrorResponse)
    const saved = await api.request("/api/spaces/notes/documents", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "sketch",
        source: drawing(stroke),
        expectedRevision: sketch.sourceRevision,
      }),
    })
    expect(saved.status).toBe(200)
    expect(await generations(spare)).toEqual(before.slice(0, 2))
    expect(await settled()).toBeLessThanOrEqual(storageTotalLimitBytes() + storageGraceBytes())
  })

  it("leaves transfers out, counts a write on disk past the limit, and refuses the next new write", async () => {
    listeners = new Map()
    watcher = new WorkspaceWatcher({
      watch: (directory, listener) => {
        listeners.set(directory, listener)
        return { close: () => listeners.delete(directory), on: () => undefined }
      },
      schedule: () => setTimeout(() => undefined, 0),
      cancel: () => undefined,
    })
    watcher.start()
    await createDoc("plan", 2 * KB)
    const people = {
      author: { id: "ptc_storage_author", kind: "human" as const, name: "Ada" },
      recipient: { id: "ptc_storage_agent", kind: "agent" as const, name: "Atlas" },
    }
    const posted = await createThread("notes", {
      ...people,
      body: "Status?",
      idempotencyKey: "status-1",
    })
    setStorageLimitForTests((await settled()) + 16 * KB)

    // An export package waiting to be downloaded is shown, not counted.
    const job = join(app, "workspace-transfers", "jobs", "wtx_storage_test")
    mkdirSync(job, { recursive: true })
    writeFileSync(join(job, "job.json"), JSON.stringify({ workspaceKey: workspaceCacheKey() }))
    writeFileSync(join(job, "package.wtb"), new Uint8Array(64 * KB))
    noteStorageChange(job)
    expect(await settled()).toBeGreaterThan(storageLimitBytes())
    await createDoc("small", 1 * KB)
    expect(storageSummary()!.pruned).toBeNull()

    // An agent with a shell writes straight into the Space's folder.
    const folder = join(workspace, "spaces", "notes", "exports")
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, "dump.bin"), new Uint8Array(32 * KB))
    listeners.get(join(workspace, "spaces"))!("rename", "notes/exports/dump.bin")
    await settled()
    expect(storageSummary()!.limit.countedBytes).toBeGreaterThan(storageLimitBytes())
    expect(existsSync(join(folder, "dump.bin"))).toBe(true)

    expect(await createDoc("next", 1 * KB).catch((error) => error)).toBeInstanceOf(
      StorageLimitError
    )
    // Someone keeps typing past the limit: saves are counted, and with
    // nothing more to remove, history isn't walked again for each of them.
    const type = (text: string) =>
      writeDoc("notes", "plan", `# Plan\n\n${text}\n`, {
        updatedBy: "ptc_storage_author",
        source: "browser-human",
        managedIdentity: true,
        storage: "counted",
      })
    expect((await type("Draft")).ok).toBe(true)
    await settled()
    const plans = storagePruningPlansForTests()
    for (const text of ["Draft one", "Draft one two", "Draft one two three"]) {
      expect((await type(text)).ok).toBe(true)
      await settled()
    }
    expect(storagePruningPlansForTests()).toBe(plans)
    // A retried message is answered as before; only a new one is refused.
    const retried = await createThread("notes", {
      ...people,
      body: "Status?",
      idempotencyKey: "status-1",
    })
    expect(retried).toMatchObject({ created: false, message: { id: posted.message.id } })
    expect(
      await appendThreadMessage("notes", posted.thread.id, {
        ...people,
        body: "Any news?",
        idempotencyKey: "status-2",
      }).catch((error) => error)
    ).toBeInstanceOf(StorageLimitError)
  })

  it("counts people's files toward the limit, not their history", async () => {
    const kept = await docWithVersions("kept", 3, 16 * KB)
    await settled()
    const files = storageSummary()!.limit.countedBytes
    // A limit just above the files: with their history, everything is well
    // over it, and writes that fit the files still go.
    setStorageLimitForTests(files + 20 * KB, { promptPruneMs: 10_000, totalBytes: 1024 ** 3 })
    expect(storageSummary()!.limit.totalBytes).toBeGreaterThan(storageLimitBytes())
    await createDoc("fits", 8 * KB)
    expect(storageSummary()!.limit.countedBytes).toBeLessThanOrEqual(storageLimitBytes())
    // Past the limit for files: refused at once, and nothing is pruned for
    // it, though old history could go: removing history can't make room for
    // files.
    const before = await generations(kept)
    const refused = await createDoc("too-much", 16 * KB).catch((error) => error)
    expect(refused).toBeInstanceOf(StorageLimitError)
    expect(refused.message).toContain("is at its")
    expect(refused.details.limitBytes).toBe(storageLimitBytes())
    expect(await generations(kept)).toEqual(before)
    expect(storageSummary()!.pruned).toBeNull()
  })

  it("prunes nothing for a lower limit, and keeps what the Worktable holds until it fits", async () => {
    let written = await createDoc("kept", 16 * KB)
    const replace = async (text: string) => {
      written = await replaceRegisteredDocument({
        spaceId: "notes",
        path: "kept",
        bytes: bytes(16 * KB, text),
        expectedRevision: written.sourceRevision,
        updatedBy: "test",
        source: "test",
        separateVersion: true,
      })
    }
    for (const text of ["one", "two", "three"]) await replace(text)
    const doc = written.documentId as DocumentId
    const folder = join(workspace, "spaces", "notes", "exports")
    mkdirSync(folder, { recursive: true })
    const dump = join(folder, "dump.bin")
    const writeOnDisk = async (write: () => void) => {
      write()
      noteStorageChange(folder)
      await settled()
    }
    await writeOnDisk(() => writeFileSync(dump, new Uint8Array(32 * KB)))
    const before = await generations(doc)
    const summary = () => storageSummary()!.limit

    // The limit goes down to well under what the Worktable holds, as when a
    // plan lapses: nothing is pruned, and it may keep what it holds.
    setStorageLimitForTests(8 * KB, { promptPruneMs: 1_000, totalBytes: 20 * KB, lowered: true })
    await writeOnDisk(() => undefined)
    expect(summary().totalLimitBytes).toBe(summary().totalBytes)
    const held = summary().totalLimitBytes
    expect(held).toBeGreaterThan(20 * KB)
    const refused = await createDoc("more", 1 * KB).catch((error) => error)
    expect(refused).toBeInstanceOf(StorageLimitError)
    expect(refused.message).toContain("is over its")
    expect(await generations(doc)).toEqual(before)
    expect(storageSummary()!.pruned).toBeNull()

    // A write that adds only history gets room within what is kept, from
    // the oldest version, though the count catches up while pruning runs;
    // and what is kept neither rises with it nor falls with what pruning
    // freed.
    setStoragePruningHooksForTests({
      afterVersions: async () => {
        await activeStorageAccount()!.settled()
      },
    })
    await replace("four")
    setStoragePruningHooksForTests({})
    await settled()
    expect(summary().totalLimitBytes).toBe(held)
    expect(summary().totalBytes).toBeLessThanOrEqual(held)
    expect(storageSummary()!.pruned!.versions).toBeGreaterThan(0)
    expect((await generations(doc)).length).toBeLessThanOrEqual(before.length)

    // A server started again keeps the same figure, and a write that needs
    // room right after start gets it within that: a restore, which keeps a
    // checkpoint as well.
    for (const stop of stops) await stop()
    stops = [startStorageLimits(), startStorageAccounting({ firstCountDelayMs: 60_000 })]
    const versions = await generations(doc)
    await restoreDocVersion("notes", "kept", versions.at(-1)!)
    await settled()
    expect((await generations(doc)).length).toBeGreaterThanOrEqual(versions.length)
    expect(summary().totalLimitBytes).toBe(held)
    expect(summary().totalBytes).toBeLessThanOrEqual(held)
    expect(summary().totalBytes).toBeGreaterThan(20 * KB)

    // Back up: the limit applies as before.
    setStorageLimitForTests(null, { lowered: true })
    await writeOnDisk(() => undefined)
    expect(summary().totalLimitBytes).toBe(storageTotalLimitBytes())
    await createDoc("more", 1 * KB)
  })

  it("refuses a write that doesn't fit from the first moment after start", async () => {
    await createDoc("big", 32 * KB)
    // A server just started: nothing counted yet, the first count still a
    // minute away.
    for (const stop of stops) await stop()
    setStorageLimitForTests(40 * KB, { promptPruneMs: 1_000 })
    stops = [startStorageLimits(), startStorageAccounting({ firstCountDelayMs: 60_000 })]
    expect(storageUsage()).toBeNull()
    const started = Date.now()
    expect(await createDoc("more", 16 * KB).catch((error) => error)).toBeInstanceOf(
      StorageLimitError
    )
    // The write started the count instead of waiting out its delay.
    expect(Date.now() - started).toBeLessThan(30_000)
    expect(storageUsage()).not.toBeNull()
    await createDoc("small", 1 * KB)
  })

  it("takes the plan's limit from requests the gateway admitted, at most the proven size", () => {
    const saved = {
      hosted: process.env[ENV.HOSTED],
      secret: process.env.WORKTABLE_GATEWAY_SECRET,
    }
    process.env[ENV.HOSTED] = "1"
    process.env.WORKTABLE_GATEWAY_SECRET = "synthetic-gateway-secret-for-storage"
    const send = (storageLimitBytes: number, path = "/api/state", secret = true) =>
      notePlanStorage(
        new Request(`http://tenant.test${path}`, {
          headers: {
            ...(secret ? { [GATEWAY_HEADER]: process.env.WORKTABLE_GATEWAY_SECRET! } : {}),
            [BILLING_HEADER]: encodeTenantBilling({
              plan: "team",
              peopleLimit: 12,
              storageLimitBytes,
              access: "active",
            }),
          },
        })
      )
    try {
      setStorageLimitForTests(null)
      send(1024 ** 3)
      expect(storageLimitBytes()).toBe(1024 ** 3)
      // A plan change applies on the next request.
      send(512 * 1024 ** 2)
      expect(storageLimitBytes()).toBe(512 * 1024 ** 2)
      // Never past what backups and exports are proven to carry.
      send(16 * 1024 ** 3)
      expect(storageLimitBytes()).toBe(DEFAULT_STORAGE_LIMIT_BYTES)
      // Without the gateway's secret, even where admission needs none, nothing changes.
      send(64 * 1024 ** 2, "/api/state", false)
      send(64 * 1024 ** 2, "/health", false)
      expect(storageLimitBytes()).toBe(DEFAULT_STORAGE_LIMIT_BYTES)
    } finally {
      for (const [key, value] of [
        [ENV.HOSTED, saved.hosted],
        ["WORKTABLE_GATEWAY_SECRET", saved.secret],
      ] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      setStorageLimitForTests(null)
    }
  })

  it("takes its limit from the environment, within the ceiling outside Cloud", () => {
    const saved = { limit: process.env[ENV.STORAGE_LIMIT_BYTES], hosted: process.env[ENV.HOSTED] }
    const limitWith = (value: string | undefined, hosted: boolean) => {
      if (value === undefined) delete process.env[ENV.STORAGE_LIMIT_BYTES]
      else process.env[ENV.STORAGE_LIMIT_BYTES] = value
      if (hosted) process.env[ENV.HOSTED] = "1"
      else delete process.env[ENV.HOSTED]
      setStorageLimitForTests(null)
      return storageLimitBytes()
    }
    try {
      expect(limitWith(undefined, false)).toBe(DEFAULT_STORAGE_LIMIT_BYTES)
      expect(limitWith(String(512 * 1024 * 1024), false)).toBe(512 * 1024 * 1024)
      expect(limitWith(String(STORAGE_LIMIT_CEILING_BYTES * 4), false)).toBe(
        STORAGE_LIMIT_CEILING_BYTES
      )
      expect(limitWith("lots", false)).toBe(DEFAULT_STORAGE_LIMIT_BYTES)
      // On Cloud the plan's storage applies as given.
      expect(limitWith(String(STORAGE_LIMIT_CEILING_BYTES * 4), true)).toBe(
        STORAGE_LIMIT_CEILING_BYTES * 4
      )
      expect(limitWith(undefined, true)).toBe(DEFAULT_STORAGE_LIMIT_BYTES)
    } finally {
      for (const [name, value] of [
        [ENV.STORAGE_LIMIT_BYTES, saved.limit],
        [ENV.HOSTED, saved.hosted],
      ] as const) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      setStorageLimitForTests(null)
    }
  })
})
