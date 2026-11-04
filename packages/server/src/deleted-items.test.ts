import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { spawnSync } from "node:child_process"
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as fsp from "node:fs/promises"
import { join } from "node:path"
import type { SpaceFile } from "@worktable/types"
import { setAppDirOverride } from "./app-storage.ts"
import {
  createRegisteredDocument,
  deleteRegisteredDocument,
} from "./document-write-service.ts"
import { mintDocumentId, updateDocumentInventory } from "./document-inventory.ts"
import {
  reconcileRecoveredDocumentLifecycles,
  recoverInterruptedDocumentLifecycles,
  setDocumentLifecycleStepHookForTests,
  SimulatedDocumentLifecycleCrash,
} from "./document-lifecycle-journal.ts"
import {
  deletedItemsTrashDir,
  listTrashToPrune,
  removeTrashEntry,
  runDeletedItemsInBackground,
  runDeletedItemsPass,
  setDeletedItemsHooksForTests,
} from "./deleted-items.ts"
import {
  setDeletedItemsDelaysForTests,
  setDeletedItemsRunner,
} from "./deleted-item-events.ts"
import {
  invalidateServerSettingsCache,
  updateServerSettings,
} from "./settings-store.ts"
import {
  deleteDoc,
  deleteSpace,
  listDocVersions,
  writeDoc,
  writeSpace,
} from "./store.ts"
import {
  closeVisitorCommentStores,
  holdVisitorCommentWrites,
  readVisitorComment,
  receiveVisitorComment,
  visitorCommentStoreFile,
} from "./visitor-comment-store.ts"
import {
  resetWorkspaceRequestLifecycleForTests,
  resumeWorkspaceRequestAdmission,
  stopWorkspaceMutationsAndDrain,
} from "./workspace-request-lifecycle.ts"
import {
  ensureWorkspaceManifest,
  setWorkspaceRootOverride,
  writeWorkspaceManifest,
} from "./workspace.ts"
import { resetWorkspaceSafetyForTests } from "./workspace-safety.ts"
import { yjsManager } from "./yjs-manager.ts"

const DAY = 24 * 60 * 60 * 1000
let workspace: string
let app: string

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

/** Every entry under `versions/<space>/.retired/`, two levels down. */
function retired(spaceId: string): string[] {
  const root = join(workspace, "versions", spaceId, ".retired")
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((kind) =>
    kind.startsWith(".")
      ? [kind]
      : readdirSync(join(root, kind)).flatMap((owner) =>
          readdirSync(join(root, kind, owner)).map(
            (id) => `${kind}/${owner}/${id}`
          )
        )
  )
}

/** App-data trash entries, by where they came from. */
function trash(): Array<{ origin: string; data: boolean }> {
  const root = deletedItemsTrashDir()
  if (!existsSync(root)) return []
  return readdirSync(root)
    .map((id) => ({
      origin: (
        JSON.parse(readFileSync(join(root, id, "entry.json"), "utf8")) as {
          origin: string
        }
      ).origin,
      data: existsSync(join(root, id, "data")),
    }))
    .sort((a, b) => a.origin.localeCompare(b.origin))
}

async function create(spaceId: string, path: string) {
  return createRegisteredDocument({
    spaceId,
    path,
    format: { id: "worktable.markdown", sourceVersion: 1 },
    bytes: new TextEncoder().encode(`# ${path}\n`),
    createdBy: "test",
    source: "test",
  })
}

function plantComment(documentId: string, requestId = "request-1") {
  return receiveVisitorComment({
    worktableId: "wt_test",
    linkId: "link_test",
    linkLabel: "Review",
    linkCreator: "owner",
    documentId,
    spaceId: "notes",
    kind: "html",
    visitorName: "Visitor",
    visitorKey: "visitor-key",
    clientKey: "client-key",
    body: "Looks good",
    requestId,
  })
}

async function createAndDelete(spaceId: string, path: string): Promise<void> {
  await create(spaceId, path)
  await deleteRegisteredDocument({ spaceId, path })
}

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "wt-deleted-ws-"))
  app = mkdtempSync(join(tmpdir(), "wt-deleted-app-"))
  setWorkspaceRootOverride(workspace)
  setAppDirOverride(app)
  invalidateServerSettingsCache()
  await updateServerSettings({
    history: { retention: { mode: "age", maxAgeDays: 30 } },
  })
})

afterEach(() => {
  setDeletedItemsRunner(null)
  setDeletedItemsDelaysForTests(null)
  resumeWorkspaceRequestAdmission()
  resetWorkspaceRequestLifecycleForTests()
  setDeletedItemsHooksForTests({})
  setDocumentLifecycleStepHookForTests(null)
  closeVisitorCommentStores()
  resetWorkspaceSafetyForTests()
  setWorkspaceRootOverride(null)
  setAppDirOverride(null)
  invalidateServerSettingsCache()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(app, { recursive: true, force: true })
})

describe("deleted items", () => {
  it("take their live editing state with them", async () => {
    ensureWorkspaceManifest()
    await writeSpace(space("notes"))
    await writeDoc(
      "notes",
      "board",
      [
        {
          id: "p1",
          type: "paragraph",
          props: {},
          content: [{ type: "text", text: "Draft", styles: {} }],
          children: [],
        },
      ],
      { updatedBy: "test", source: "rest-api" }
    )
    let editorClosed = false
    await yjsManager.handleConnection(
      { send() {}, close: () => (editorClosed = true) } as never,
      "notes",
      "board"
    )
    await deleteRegisteredDocument({ spaceId: "notes", path: "board" })
    // No one goes on editing a deleted Doc, nor is a new Doc at its path
    // served from its room.
    expect(editorClosed).toBe(true)
    expect(yjsManager.isLoaded("notes", "board")).toBe(false)
  })

  it("move out of the workspace folder at once and are removed after the window", async () => {
    ensureWorkspaceManifest()
    await writeSpace(space("notes"))
    const start = Date.now()
    const older = await create("notes", "older")
    const comment = plantComment(older.documentId)
    await deleteRegisteredDocument({ spaceId: "notes", path: "older" })
    // The delete erases the document's visitor comments itself.
    expect(readVisitorComment("wt_test", comment.id)).toBeNull()

    await runDeletedItemsPass({ now: () => start })
    expect(retired("notes")).toEqual([])
    const [entry] = trash()
    expect(entry).toMatchObject({ data: true })
    expect(entry!.origin).toStartWith(
      `versions/notes/.retired/documents/${older.documentId}/`
    )

    await createAndDelete("notes", "newer")
    await runDeletedItemsPass({ now: () => start + 20 * DAY })
    expect(trash()).toHaveLength(2)

    // An entry holding another filesystem, as a mount that slipped past
    // planning would, is never emptied, by the window or by pruning: it stays
    // for an operator.
    const firstId = readdirSync(deletedItemsTrashDir()).find(
      (id) =>
        JSON.parse(
          readFileSync(join(deletedItemsTrashDir(), id, "entry.json"), "utf8")
        ).origin === entry!.origin
    )!
    const mounted = join(deletedItemsTrashDir(), firstId, "data", "mnt")
    mkdirSync(mounted)
    writeFileSync(join(mounted, "theirs.txt"), "not ours")
    const realLstat = fsp.lstat
    const elsewhere = spyOn(fsp, "lstat").mockImplementation((async (
      path: Parameters<typeof fsp.lstat>[0]
    ) => {
      const info = await realLstat(path)
      if (String(path) !== mounted) return info
      const moved = Object.create(info) as typeof info
      Object.defineProperty(moved, "dev", { value: info.dev + 1 })
      return moved
    }) as typeof fsp.lstat)
    try {
      expect(
        await runDeletedItemsPass({ now: () => start + 31 * DAY })
      ).toMatchObject({ removed: 0 })
      const blocked = (await listTrashToPrune()).find(
        (candidate) => candidate.name === firstId
      )
      expect(await removeTrashEntry(blocked!)).toBe(false)
    } finally {
      elsewhere.mockRestore()
    }
    expect(trash()).toHaveLength(2)
    expect(readFileSync(join(mounted, "theirs.txt"), "utf8")).toBe("not ours")

    // 31 days after the first deletion, 11 after the second.
    expect(
      await runDeletedItemsPass({ now: () => start + 31 * DAY })
    ).toMatchObject({ removed: 1, deferred: false })
    const left = trash()
    expect(left).toHaveLength(1)
    expect(left[0]!.origin).not.toBe(entry!.origin)

    // A longer window chosen later keeps what is left for longer.
    await updateServerSettings({
      history: { retention: { mode: "age", maxAgeDays: 90 } },
    })
    await runDeletedItemsPass({ now: () => start + 60 * DAY })
    expect(trash()).toEqual(left)
    await runDeletedItemsPass({ now: () => start + 111 * DAY })
    expect(trash()).toEqual([])
  })

  it("leave in place history that an interrupted delete may still move back", async () => {
    // A legacy-history workspace, where the lifecycle journal itself retires
    // the history it may compensate.
    writeWorkspaceManifest({ ...ensureWorkspaceManifest(), version: 1 })
    await writeSpace(space("space"))
    await writeDoc("space", "old", "# Old\n")
    await updateDocumentInventory("space", {
      upsert: [
        {
          documentId: mintDocumentId(),
          path: "old",
          format: { id: "worktable.markdown", sourceVersion: 1 },
          source: { kind: "file", relativePath: "docs/old.md" },
        },
      ],
    })
    const versions = (await listDocVersions("space", "old")).map((v) => v.id)
    expect(versions.length).toBeGreaterThan(0)
    setDocumentLifecycleStepHookForTests((step) => {
      if (step === "history") throw new SimulatedDocumentLifecycleCrash(step)
    })
    await expect(deleteDoc("space", "old")).rejects.toThrow("history")
    setDocumentLifecycleStepHookForTests(null)
    expect(retired("space")).toHaveLength(1)

    const result = await runDeletedItemsPass({
      now: () => Date.now() + 365 * DAY,
    })
    expect(result).toMatchObject({ moved: 0, removed: 0, protected: 1 })
    expect(retired("space")).toHaveLength(1)
    expect(trash()).toEqual([])

    // Recovery undoes the delete with the history the pass left in place.
    await reconcileRecoveredDocumentLifecycles(
      recoverInterruptedDocumentLifecycles()
    )
    expect((await listDocVersions("space", "old")).map((v) => v.id)).toEqual(
      versions
    )
    expect(retired("space")).toEqual([])
  })

  it("a crash mid-move leaves the store consistent, and the next pass finishes", async () => {
    ensureWorkspaceManifest()
    await writeSpace(space("notes"))
    await createAndDelete("notes", "first")
    await createAndDelete("notes", "second")
    const before = retired("notes")
    expect(before).toHaveLength(2)
    // A deleted folder's link and FIFO go too: the link as itself, the FIFO,
    // which holds no bytes and can't be copied, with its tombstone.
    for (const item of before) {
      const path = join(workspace, "versions", "notes", ".retired", item)
      symlinkSync("elsewhere", join(path, ".link"))
      expect(spawnSync("mkfifo", [join(path, ".pipe")]).status).toBe(0)
    }

    // App data on another filesystem: the move is a copy, then a removal.
    setDeletedItemsHooksForTests({
      crossDevice: true,
      afterTombstone: () => {
        throw new Error("simulated crash")
      },
    })
    await expect(runDeletedItemsPass()).rejects.toThrow("simulated crash")
    // One item left its place whole, as a tombstone exports skip; the other
    // is untouched, and nothing has reached the trash yet.
    const during = retired("notes")
    expect(during.filter((name) => name.startsWith(".sweep-"))).toHaveLength(1)
    expect(during.filter((name) => before.includes(name))).toHaveLength(1)
    expect(trash().filter((entry) => entry.data)).toEqual([])

    setDeletedItemsHooksForTests({ crossDevice: true })
    expect(await runDeletedItemsPass()).toMatchObject({
      moved: 1,
      deferred: false,
    })
    expect(retired("notes")).toEqual([])
    expect(trash()).toHaveLength(2)
    expect(trash().every((entry) => entry.data)).toBe(true)
    for (const id of readdirSync(deletedItemsTrashDir())) {
      const data = join(deletedItemsTrashDir(), id, "data")
      expect(readlinkSync(join(data, ".link"))).toBe("elsewhere")
      expect(() => lstatSync(join(data, ".pipe"))).toThrow()
    }
  })

  it("move a deleted Space with its history, and clear what older versions left behind", async () => {
    ensureWorkspaceManifest()
    await writeSpace(space("plans"))
    await create("plans", "roadmap")
    await deleteSpace("plans")
    // A new Space with the same id starts without the old history.
    expect(existsSync(join(workspace, "versions", "plans"))).toBe(false)
    // A Space an older version deleted 40 days ago, still in the folder.
    const old = join(
      workspace,
      "spaces",
      ".trash",
      `archive-${Date.now() - 40 * DAY}`
    )
    mkdirSync(join(old, "docs"), { recursive: true })
    writeFileSync(join(old, "docs", "note.md"), "# Old\n")

    const result = await runDeletedItemsPass()
    expect(result).toMatchObject({ moved: 2, removed: 1 })
    for (const tree of ["spaces", "versions"]) {
      expect(readdirSync(join(workspace, tree, ".trash"))).toEqual([])
    }
    const moved = trash()
    expect(moved.map((entry) => entry.origin.split("/").slice(0, 2).join("/")))
      .toEqual(["spaces/.trash", "versions/.trash"])

    await runDeletedItemsPass({ now: () => Date.now() + 29 * DAY })
    expect(trash()).toEqual(moved)
    await runDeletedItemsPass({ now: () => Date.now() + 31 * DAY })
    expect(trash()).toEqual([])
  })

  it("retry a visitor comment erase the comment store refused", async () => {
    ensureWorkspaceManifest()
    await writeSpace(space("notes"))
    const doc = await create("notes", "reviewed")
    const comment = plantComment(doc.documentId)
    const release = holdVisitorCommentWrites()
    try {
      await deleteRegisteredDocument({ spaceId: "notes", path: "reviewed" })
      await runDeletedItemsPass()
    } finally {
      release()
    }
    // The history left the workspace folder; the comment is still owed.
    expect(retired("notes")).toEqual([])
    expect(readVisitorComment("wt_test", comment.id)).not.toBeNull()

    // A capture holds writes: the retry waits for it, as moves do.
    await stopWorkspaceMutationsAndDrain()
    expect(await runDeletedItemsPass()).toMatchObject({ deferred: true })
    expect(readVisitorComment("wt_test", comment.id)).not.toBeNull()
    resumeWorkspaceRequestAdmission()

    await runDeletedItemsPass()
    expect(readVisitorComment("wt_test", comment.id)).toBeNull()
  })

  it("drop an owed comment erase when a restore brings the document back", async () => {
    ensureWorkspaceManifest()
    await writeSpace(space("notes"))
    const doc = await create("notes", "reviewed")
    const comment = plantComment(doc.documentId)
    // A snapshot of the workspace and its comment store, taken before the
    // delete.
    closeVisitorCommentStores()
    const snapshot = mkdtempSync(join(tmpdir(), "wt-deleted-snap-"))
    cpSync(workspace, join(snapshot, "workspace"), { recursive: true })
    copyFileSync(visitorCommentStoreFile(), join(snapshot, "comments.sqlite"))
    try {
      const release = holdVisitorCommentWrites()
      try {
        await deleteRegisteredDocument({ spaceId: "notes", path: "reviewed" })
      } finally {
        release()
      }
      const owed = join(deletedItemsTrashDir(), "pending-comment-erase.json")
      expect(JSON.parse(readFileSync(owed, "utf8"))).toMatchObject({
        documentIds: [doc.documentId],
      })
      // Restore the snapshot before the owed erase is retried.
      closeVisitorCommentStores()
      rmSync(workspace, { recursive: true, force: true })
      cpSync(join(snapshot, "workspace"), workspace, { recursive: true })
      copyFileSync(join(snapshot, "comments.sqlite"), visitorCommentStoreFile())

      await runDeletedItemsPass()
      expect(readVisitorComment("wt_test", comment.id)).not.toBeNull()
      // The owed erase was dropped, so it never runs later either.
      expect(JSON.parse(readFileSync(owed, "utf8"))).toMatchObject({
        documentIds: [],
      })
    } finally {
      rmSync(snapshot, { recursive: true, force: true })
    }
  })

  it("empty expired trash of a workspace that is not being served", async () => {
    ensureWorkspaceManifest()
    const other = join(app, "trash", "0123456789abcdef")
    const plant = (id: string, retiredAt: number, data: boolean) => {
      mkdirSync(join(other, id), { recursive: true })
      writeFileSync(
        join(other, id, "entry.json"),
        JSON.stringify({ version: 1, origin: "", spaceId: "s", retiredAt })
      )
      if (data) mkdirSync(join(other, id, "data"))
    }
    plant("aaaaaaaaaaaaaaaa", Date.now() - 31 * DAY, true)
    plant("bbbbbbbbbbbbbbbb", Date.now() - 10 * DAY, true)
    // Still on its way out of that workspace: nothing to remove yet.
    plant("cccccccccccccccc", Date.now() - 31 * DAY, false)

    expect(await runDeletedItemsPass()).toMatchObject({ removed: 1 })
    expect(readdirSync(other).sort()).toEqual([
      "bbbbbbbbbbbbbbbb",
      "cccccccccccccccc",
    ])
  })

  it("run a pass a capture deferred again once the capture lets go", async () => {
    ensureWorkspaceManifest()
    await writeSpace(space("notes"))
    setDeletedItemsDelaysForTests({ moveMs: 5, firstRetryMs: 20, maxRetryMs: 40 })
    // Each scheduled pass says when it has finished, so the test waits on
    // passes rather than on time.
    let passes = 0
    let finished: (() => void) | null = null
    const nextPassFinished = () =>
      new Promise<void>((resolve) => {
        finished = resolve
      })
    setDeletedItemsRunner(() => {
      passes += 1
      void runDeletedItemsInBackground().finally(() => finished?.())
    })
    await stopWorkspaceMutationsAndDrain()
    await createAndDelete("notes", "captured")
    while (passes < 3) await nextPassFinished()
    expect(retired("notes")).toHaveLength(1)

    resumeWorkspaceRequestAdmission()
    while (retired("notes").length > 0) await nextPassFinished()
    expect(trash()).toHaveLength(1)
  })
})
