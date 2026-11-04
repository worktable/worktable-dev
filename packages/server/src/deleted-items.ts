// ============================================================
// Deleted items: out of the workspace folder, then gone after the window
//
// Deleting a Doc or file is permanent in the product, but a delete first
// retires its history inside the workspace folder, so an interrupted delete
// can still be undone:
//
//   versions/<space>/.retired/documents/<document-id>/<dsv2 job id>/
//     the document's version generations (Storage V2)
//   versions/<space>/.retired/<docs|widgets>/<key digest>/<dlc operation id>/
//     legacy snapshots, moved by the document lifecycle journal
//
// Deleting a Space moves `spaces/<id>` to `spaces/.trash/<id>-<ms>` and its
// history to `versions/.trash/<id>-<ms>` (store.ts deleteSpace).
//
// Everything in the workspace folder is captured by backups and exports, so a
// pass moves each of these out of it as soon as its delete has settled, into
// a trash folder in app data (`<app>/trash/<workspace key>/<id>/`), which is
// neither exported nor backed up. A delete schedules a pass a moment later
// (deleted-item-events.ts), and every server start runs one, which also moves
// out what older versions left in the workspace folder. The daily retention
// pass empties trash entries older than the history window: `maxAgeDays`
// under an age policy, and the default 30 days under a count policy, which
// sets no age. The window runs from the deletion of a Space and from the move
// of retired history, which follows its delete within moments (or, for
// history older versions left behind, from the move at upgrade). An item
// already past the window when it is found is removed, not moved.
//
// A deleted document's visitor comments are erased with it: by the delete
// itself (document-data-lifecycle-v2.ts) and again when its history or Space
// moves out. An erase the comment store refuses is recorded and retried by
// every pass (pending-comment-erase.ts); the history moves out regardless.
//
// The trash of every workspace under app data is emptied, not only the one
// being served, so a workspace switched away from or moved still loses its
// deleted items on schedule. A pass that a capture or replacement deferred
// is retried with a short backoff (deleted-item-events.ts).
//
// An archived Space or Doc is not deleted: its content and history stay in
// place under the ordinary retention policy, and nothing here touches them.
// The product has no restore for deleted items. A trash entry keeps its
// original path in `entry.json`, so an operator can move one back by hand.
//
// Invariant: a pass never moves or removes retired history that a lifecycle
// operation could still read or move back. Only two writers move history in
// or out of `.retired`, and each names the directory by its own id:
//   - the document lifecycle journal (exact and folder deletes) uses its
//     operation id. While its journal is active, applying or committed, or
//     waiting as a reconciliation marker, recovery may move that history
//     back or verify it. Its catalog checkpoints and folder cursors live in
//     the same journal, so they are covered with it.
//   - a Storage V2 data lifecycle job uses its job id, and moves history only
//     forward while its job file exists.
// Both run under the lifecycle journal lock. Each batch holds that lock, so no
// operation starts or advances meanwhile, and skips every directory named by
// an unsettled operation or job, and every Space trash entry for a Space one
// of them names. If that state cannot be read, the pass stops without moving
// anything. Restoring a version reads only active history, never these.
//
// Coordination. Each batch is admitted like a write request, so workspace
// exports, snapshot captures and replacements drain it before they read or
// swap the tree, and a batch never starts while they run. Batches are small,
// and the lifecycle lock is held only while directories are renamed.
//
// Crash safety. An item leaves its place in the workspace in one rename, to a
// tombstone beside it that exports skip: `.sweep-<id>` on its way to trash
// entry <id>, whose `entry.json` is written first, or `.erase-<id>` when it is
// being removed. The tombstone then moves into app data in one rename, or by
// copying into `data.partial` and renaming that to `data` when app data is on
// another filesystem. Every pass first finishes any tombstone left behind,
// and drops an `entry.json` whose item never left its place.
// ============================================================

import { randomBytes } from "node:crypto"
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
} from "node:fs/promises"
import { join } from "node:path"
import { DocumentIdSchema } from "@worktable/types"
import { ensureAppDir } from "./app-storage.ts"
import { atomicWriteText } from "./atomic-file.ts"
import { logError } from "./debug-log.ts"
import { discoverDocumentDataV2LifecycleRecovery } from "./document-data-lifecycle-v2.ts"
import { withUnsettledDocumentLifecycles } from "./document-lifecycle-journal.ts"
import {
  getServerSettings,
  RETENTION_DEFAULT,
  type RetentionPolicy,
} from "./settings-store.ts"
import {
  retryDeletedItemsSoon,
  settleDeletedItemsRetry,
} from "./deleted-item-events.ts"
import {
  eraseVisitorCommentsOrRecord,
  retryPendingCommentErase,
} from "./pending-comment-erase.ts"
import { getWorkspaceRoot, workspaceCacheKey } from "./workspace.ts"
import { admitWorkspaceRequest } from "./workspace-request-lifecycle.ts"
import { workspaceRecoveryRequired } from "./workspace-safety.ts"

const DAY_MS = 24 * 60 * 60 * 1000
/** Items renamed under one hold of the lifecycle lock. */
const BATCH_SIZE = 8
const ENTRY_ID = /^[0-9a-f]{16}$/
const WORKSPACE_KEY = /^[0-9a-f]{16}$/
const TOMBSTONE = /^\.(sweep|erase)-([0-9a-f]{16})$/
const EMPTYING = /^\.empty-[0-9a-f]{16}$/
const V2_RETIREMENT_ID = /^dsv2_[A-Za-z0-9_-]{22}$/
const JOURNAL_OPERATION_ID = /^dlc_[A-Za-z0-9_-]{22}$/
const KEY_DIGEST = /^[0-9a-f]{64}$/
const SPACE_TRASH_NAME = /^(.+)-(\d{12,})$/

interface WorkspaceItem {
  /** Workspace-relative path, kept in the trash entry. */
  relative: string
  path: string
  /** Where its tombstone goes, on the same filesystem. */
  tombstoneParent: string
  /** Directories to remove after it when empty, innermost first. */
  emptyParents: string[]
  spaceId: string
  /** The journal operation or V2 job that retired it; none for a Space. */
  retirementId: string | null
  /** When it was deleted, when its name says so. */
  deletedAt: number | null
  /** The documents it held, whose visitor comments go with it. */
  documentIds: () => Promise<string[]>
}

interface Tombstone {
  path: string
  id: string
  erase: boolean
}

interface TrashEntry {
  version: 1
  /** Workspace-relative path the item came from. */
  origin: string
  spaceId: string
  /** When the window started. */
  retiredAt: number
}

export interface DeletedItemsPassResult {
  /** Items moved out of the workspace folder into app-data trash. */
  moved: number
  /** Items and trash entries removed for good. */
  removed: number
  /** Items left in place because an unsettled operation still names them. */
  protected: number
  /** True when a capture or replacement held the workspace; retried soon. */
  deferred: boolean
}

let testHooks: {
  /** Called after each item leaves its place, before it reaches app data. */
  afterTombstone?: () => void
  /** Copy into app data as if it were on another filesystem. */
  crossDevice?: boolean
} = {}

export function setDeletedItemsHooksForTests(hooks: typeof testHooks): void {
  testHooks = hooks
}

/** How long deleted items are kept, or null to keep them. */
export function deletedItemsWindowMs(policy: RetentionPolicy): number | null {
  switch (policy.mode) {
    case "all":
      return null
    case "age":
      return policy.maxAgeDays * DAY_MS
    case "count":
      return (
        (RETENTION_DEFAULT.mode === "age" ? RETENTION_DEFAULT.maxAgeDays : 30) *
        DAY_MS
      )
  }
}

function currentWindow(): number | null {
  return deletedItemsWindowMs(getServerSettings().history.retention)
}

export function deletedItemsTrashDir(): string {
  return join(ensureAppDir(), "trash", workspaceCacheKey())
}

async function realDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch {
    return false
  }
}

/** Names of real subdirectories; symlinks and files are never followed. */
async function childDirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    await rmdir(path)
  } catch {
    // Not empty, already gone, or busy: leave it.
  }
}

function newEntryId(): string {
  return randomBytes(8).toString("hex")
}

// ── Finding items in the workspace folder ───────────────────

async function inventoryDocumentIds(spaceDir: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(
      await readFile(join(spaceDir, "documents.meta.json"), "utf8")
    ) as { documents?: Record<string, unknown> }
    return Object.keys(parsed.documents ?? {}).filter(
      (id) => DocumentIdSchema.safeParse(id).success
    )
  } catch {
    return []
  }
}

async function historyDocumentIds(versionsDir: string): Promise<string[]> {
  return (await childDirectories(join(versionsDir, "documents"))).filter(
    (id) => DocumentIdSchema.safeParse(id).success
  )
}

interface Discovery {
  items: WorkspaceItem[]
  tombstones: Tombstone[]
}

function noteTombstone(parent: string, name: string, found: Discovery): boolean {
  const match = TOMBSTONE.exec(name)
  if (!match) return false
  found.tombstones.push({
    path: join(parent, name),
    id: match[2]!,
    erase: match[1] === "erase",
  })
  return true
}

async function discoverSpaceTrash(
  root: string,
  tree: "spaces" | "versions",
  found: Discovery
): Promise<void> {
  const trash = join(root, tree, ".trash")
  if (!(await realDirectory(trash))) return
  for (const name of await childDirectories(trash)) {
    if (noteTombstone(trash, name, found)) continue
    const match = SPACE_TRASH_NAME.exec(name)
    if (!match) continue
    const path = join(trash, name)
    found.items.push({
      relative: `${tree}/.trash/${name}`,
      path,
      tombstoneParent: trash,
      emptyParents: [],
      spaceId: match[1]!,
      retirementId: null,
      deletedAt: Number(match[2]),
      documentIds: () =>
        tree === "spaces" ? inventoryDocumentIds(path) : historyDocumentIds(path),
    })
  }
}

async function discoverWorkspace(root: string): Promise<Discovery> {
  const found: Discovery = { items: [], tombstones: [] }
  const versions = join(root, "versions")
  if (await realDirectory(versions)) {
    for (const spaceId of await childDirectories(versions)) {
      if (spaceId === ".trash") continue
      const retired = join(versions, spaceId, ".retired")
      if (!(await realDirectory(retired))) continue
      for (const name of await childDirectories(retired)) {
        if (noteTombstone(retired, name, found)) continue
        const isV2 = name === "documents"
        if (!isV2 && name !== "docs" && name !== "widgets") continue
        for (const owner of await childDirectories(join(retired, name))) {
          if (
            isV2
              ? !DocumentIdSchema.safeParse(owner).success
              : !KEY_DIGEST.test(owner)
          ) {
            continue
          }
          const ownerDir = join(retired, name, owner)
          for (const id of await childDirectories(ownerDir)) {
            if (!(isV2 ? V2_RETIREMENT_ID : JOURNAL_OPERATION_ID).test(id)) {
              continue
            }
            found.items.push({
              relative: `versions/${spaceId}/.retired/${name}/${owner}/${id}`,
              path: join(ownerDir, id),
              tombstoneParent: retired,
              emptyParents: [ownerDir],
              spaceId,
              retirementId: id,
              deletedAt: null,
              documentIds: async () => (isV2 ? [owner] : []),
            })
          }
        }
      }
    }
  }
  await discoverSpaceTrash(root, "spaces", found)
  await discoverSpaceTrash(root, "versions", found)
  return found
}

// ── The app-data trash ──────────────────────────────────────

async function readEntry(entryDir: string): Promise<TrashEntry | null> {
  try {
    const parsed = JSON.parse(
      await readFile(join(entryDir, "entry.json"), "utf8")
    ) as Partial<TrashEntry>
    return parsed.version === 1 &&
      typeof parsed.retiredAt === "number" &&
      Number.isFinite(parsed.retiredAt)
      ? (parsed as TrashEntry)
      : null
  } catch {
    return null
  }
}

async function writeEntry(entryDir: string, entry: TrashEntry): Promise<void> {
  await mkdir(entryDir, { recursive: true, mode: 0o700 })
  await atomicWriteText(join(entryDir, "entry.json"), `${JSON.stringify(entry)}\n`)
}

/** Finish one tombstone: into its trash entry, or gone. Idempotent. */
async function settleTombstone(tombstone: Tombstone, now: number): Promise<void> {
  if (tombstone.erase) {
    await rm(tombstone.path, { recursive: true, force: true })
    return
  }
  const entryDir = join(deletedItemsTrashDir(), tombstone.id)
  const data = join(entryDir, "data")
  if (await realDirectory(data)) {
    // The move finished; only the copy's source is left.
    await rm(tombstone.path, { recursive: true, force: true })
    return
  }
  if (!(await readEntry(entryDir))) {
    // Its entry was lost with the app data folder: start its window now.
    await writeEntry(entryDir, {
      version: 1,
      origin: "",
      spaceId: "",
      retiredAt: now,
    })
  }
  if (!testHooks.crossDevice) {
    try {
      await rename(tombstone.path, data)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error
    }
  }
  const partial = join(entryDir, "data.partial")
  await rm(partial, { recursive: true, force: true })
  await cp(tombstone.path, partial, {
    recursive: true,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
  })
  await rename(partial, data)
  await rm(tombstone.path, { recursive: true, force: true })
}

/** Drop the active workspace's entries whose item never left its place. */
async function tidyTrash(): Promise<void> {
  const trash = deletedItemsTrashDir()
  for (const name of await childDirectories(trash)) {
    const path = join(trash, name)
    if (ENTRY_ID.test(name) && !(await realDirectory(join(path, "data")))) {
      // Every tombstone was settled before this runs, so the item is still
      // in place and will be found again.
      await rm(path, { recursive: true, force: true })
    }
  }
}

/**
 * Empty expired entries in every workspace's trash, not only the one being
 * served: a workspace switched away from, or moved to another path (which
 * changes its key), would otherwise keep its trash forever. Each entry
 * carries its own retirement time. An entry without data is left alone: its
 * item may still be on its way out of a workspace that is not served now.
 */
async function emptyAllTrash(now: number, window: number): Promise<number> {
  const base = join(ensureAppDir(), "trash")
  let removed = 0
  for (const key of await childDirectories(base)) {
    if (!WORKSPACE_KEY.test(key)) continue
    const trash = join(base, key)
    for (const name of await childDirectories(trash)) {
      const path = join(trash, name)
      if (EMPTYING.test(name)) {
        await rm(path, { recursive: true, force: true })
        continue
      }
      if (!ENTRY_ID.test(name) || !(await realDirectory(join(path, "data")))) {
        continue
      }
      const entry = await readEntry(path)
      if (!entry) {
        // Unreadable: start its window again rather than guess.
        await writeEntry(path, { version: 1, origin: "", spaceId: "", retiredAt: now })
        continue
      }
      if (entry.retiredAt + window > now) continue
      const emptying = join(trash, `.empty-${name}`)
      await rename(path, emptying)
      await rm(emptying, { recursive: true, force: true })
      removed += 1
    }
  }
  return removed
}

// ── The pass ────────────────────────────────────────────────

/**
 * Move deleted items out of the workspace folder and empty the app-data
 * trash past the history window. Background work only, never on a request.
 */
export async function runDeletedItemsPass(options?: {
  now?: () => number
}): Promise<DeletedItemsPassResult> {
  const now = options?.now ?? Date.now
  const result: DeletedItemsPassResult = {
    moved: 0,
    removed: 0,
    protected: 0,
    deferred: false,
  }
  // A workspace that needs recovery is left alone until a restart recovers
  // it; that start's pass continues. App-data trash is emptied regardless.
  if (!workspaceRecoveryRequired()) {
    await moveOutOfWorkspace(now, result)
  }
  const window = currentWindow()
  if (window !== null) result.removed += await emptyAllTrash(now(), window)

  if (result.moved > 0 || result.removed > 0) {
    console.log(
      `[deleted-items] moved ${result.moved} out of the workspace folder, removed ${result.removed} past the history window`
    )
  }
  return result
}

async function moveOutOfWorkspace(
  now: () => number,
  result: DeletedItemsPassResult
): Promise<void> {
  const root = getWorkspaceRoot()
  // Erases that could not run before; under the lock deletes record under.
  await withUnsettledDocumentLifecycles(() => retryPendingCommentErase())

  const found = await discoverWorkspace(root)
  if (found.tombstones.length > 0) {
    const release = admitWorkspaceRequest("write")
    if (!release) {
      result.deferred = true
      return
    }
    try {
      for (const tombstone of found.tombstones) {
        await settleTombstone(tombstone, now())
      }
    } finally {
      release()
    }
  }
  await tidyTrash()

  for (let start = 0; start < found.items.length; start += BATCH_SIZE) {
    // The workspace may have been swapped or need recovery since this began.
    if (workspaceRecoveryRequired() || getWorkspaceRoot() !== root) {
      result.deferred = true
      break
    }
    const release = admitWorkspaceRequest("write")
    if (!release) {
      result.deferred = true
      break
    }
    try {
      const window = currentWindow()
      const tombstones = await withUnsettledDocumentLifecycles(
        async (unsettled) => {
          const jobs = discoverDocumentDataV2LifecycleRecovery()
          const protectedIds = new Set([
            ...unsettled.map((operation) => operation.operationId),
            ...jobs.map((recovery) => recovery.job.id),
          ])
          const protectedSpaces = new Set([
            ...unsettled.flatMap((operation) => operation.spaceIds),
            ...jobs.map((recovery) => recovery.job.spaceId),
          ])
          const left: Tombstone[] = []
          for (const item of found.items.slice(start, start + BATCH_SIZE)) {
            if (
              item.retirementId
                ? protectedIds.has(item.retirementId)
                : protectedSpaces.has(item.spaceId)
            ) {
              result.protected += 1
              continue
            }
            if (!(await realDirectory(item.path))) continue
            // Recorded for the next pass when the comment store refuses, so
            // the history still leaves the workspace folder now.
            await eraseVisitorCommentsOrRecord(await item.documentIds())
            const retiredAt = item.deletedAt ?? now()
            const id = newEntryId()
            const erase = window !== null && retiredAt + window <= now()
            if (!erase) {
              await writeEntry(join(deletedItemsTrashDir(), id), {
                version: 1,
                origin: item.relative,
                spaceId: item.spaceId,
                retiredAt,
              })
            }
            const tombstone = join(
              item.tombstoneParent,
              `.${erase ? "erase" : "sweep"}-${id}`
            )
            await rename(item.path, tombstone)
            left.push({ path: tombstone, id, erase })
            testHooks.afterTombstone?.()
            for (const parent of item.emptyParents) {
              await removeEmptyDirectory(parent)
            }
          }
          return left
        }
      )
      for (const tombstone of tombstones) {
        await settleTombstone(tombstone, now())
        if (tombstone.erase) result.removed += 1
        else result.moved += 1
      }
    } finally {
      release()
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

let running: Promise<void> | null = null
let again = false

/** One pass at a time; a request during a pass runs another after it. */
export function runDeletedItemsInBackground(): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      try {
        const result = await runDeletedItemsPass()
        // An export, snapshot or replacement held the workspace: try again
        // shortly after it lets go, instead of waiting for the daily pass.
        if (result.deferred) retryDeletedItemsSoon()
        else settleDeletedItemsRetry()
      } catch (error) {
        // The next delete, restart or daily pass tries again.
        console.error("[deleted-items] pass failed:", logError(error))
      }
    } while (again)
  })().finally(() => {
    running = null
  })
  return running
}
