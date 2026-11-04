// ============================================================
// Pruning at the storage limit: the oldest history goes first
// ============================================================
//
// When a Worktable reaches its storage limit (storage-limit.ts), this frees
// room from history, never from what people see now:
//
//   1. Deleted items. The deleted-items pass first moves what it can out of
//      the workspace folder, with its usual lifecycle-journal guards; then
//      the trash is emptied oldest first, before its window runs out.
//   2. Old versions, oldest first across the whole Worktable: Storage V2
//      generations and legacy Doc snapshots alike.
//
// Never removed: an item's current version, the newest version a save may
// continue, any meaningful checkpoint (versions saved by hand, restore
// points, the version before an agent took over, reviewed versions: what a
// restore goes back to), the version a document's provenance points at, a
// version a running restore holds (version-holds.ts), and history in a
// Space an unsettled lifecycle operation names (a delete or move that
// recovery could still roll back). Each batch is admitted like a write, so
// exports, captures and replacements drain it and it never runs while they
// do; a workspace that needs recovery is left alone.
//
// What went is recorded (storage-pruned.ts) and shown in Settings and in
// each item's version history. Background work only, never on a request's
// hot path; storage-limit.ts runs it and may wait a few seconds for it.

import { DocumentIdSchema } from "@worktable/types"
import { logError } from "./debug-log.ts"
import { discoverDocumentDataV2LifecycleRecovery } from "./document-data-lifecycle-v2.ts"
import { withUnsettledDocumentLifecycles } from "./document-lifecycle-journal.ts"
import { removeDocumentGenerationsV2 } from "./document-version-store-v2.ts"
import {
  lastDeletedItemsPassKeptSome,
  removeOldestTrash,
  runDeletedItemsInBackground,
} from "./deleted-items.ts"
import { recordPruning } from "./storage-pruned.ts"
import { versionHeld } from "./version-holds.ts"
import {
  listPrunableVersions,
  removeLegacyDocVersions,
  type PrunableVersion,
} from "./version-retention.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { admitWorkspaceRequest } from "./workspace-request-lifecycle.ts"
import { workspaceRecoveryRequired } from "./workspace-safety.ts"

/** Oldest versions removed under one admission and lifecycle lock. */
const BATCH = 32

export interface PruneResult {
  deletedItems: number
  versions: number
  bytes: number
  /**
   * Something removable was kept for now: a capture, replacement or
   * recovery held the workspace, a restore held a version, or an unsettled
   * lifecycle operation named its Space. Try again later; this is not
   * "nothing left to prune".
   */
  deferred: boolean
}

let testHooks: {
  /** Called once a pass has emptied the trash, before it prunes versions. */
  beforeVersions?: () => void
} = {}

export function setStoragePruningHooksForTests(hooks: typeof testHooks): void {
  testHooks = hooks
}

/** Free about `wantBytes` from the oldest history; see the header. */
export async function pruneOldestHistory(
  wantBytes: number,
  stopped: () => boolean = () => false
): Promise<PruneResult> {
  const result: PruneResult = { deletedItems: 0, versions: 0, bytes: 0, deferred: false }
  const items = new Map<string, number>()
  if (wantBytes <= 0) return result
  if (workspaceRecoveryRequired()) return { ...result, deferred: true }
  try {
    // Moves retired history into the trash, where the next step finds it.
    await runDeletedItemsInBackground()
    const trash = await removeOldestTrash(wantBytes, stopped)
    result.deletedItems = trash.removed
    result.bytes += trash.bytes
    // One rule: anything kept for a temporary reason makes the run deferred,
    // never "nothing left to prune".
    if (trash.skipped > 0 || lastDeletedItemsPassKeptSome()) result.deferred = true
    testHooks.beforeVersions?.()
    if (result.bytes < wantBytes && !stopped()) {
      await pruneOldestVersions(wantBytes - result.bytes, stopped, result, items)
    }
  } catch (error) {
    // Failed partway: not proof that nothing is left.
    result.deferred = true
    console.error("[storage-limit] pruning failed:", logError(error))
  } finally {
    await recordPruning({ ...result, items })
  }
  if (result.deletedItems > 0 || result.versions > 0) {
    console.log(
      `[storage-limit] removed ${result.deletedItems} deleted item(s) and ${result.versions} old version(s), freed ${result.bytes} bytes`
    )
  }
  return result
}

async function pruneOldestVersions(
  wantBytes: number,
  stopped: () => boolean,
  result: PruneResult,
  items: Map<string, number>
): Promise<void> {
  const root = getWorkspaceRoot()
  const candidates = (await listPrunableVersions(stopped)).sort(
    (a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)
  )
  let freed = 0
  // The next candidate not yet tried: the cursor moves only past those a
  // batch tried, so one that turns out to be kept leaves the rest in line.
  let next = 0
  while (next < candidates.length && freed < wantBytes) {
    if (stopped()) return
    if (workspaceRecoveryRequired() || getWorkspaceRoot() !== root) {
      result.deferred = true
      return
    }
    // The oldest candidates, as many as still need to go, at most BATCH.
    const batch: PrunableVersion[] = []
    let planned = freed
    while (next < candidates.length && batch.length < BATCH && planned < wantBytes) {
      const candidate = candidates[next++]!
      if (versionHeld(candidate.id)) {
        // A running restore reads it: kept now, removable once it ends.
        result.deferred = true
        continue
      }
      batch.push(candidate)
      planned += candidate.bytes
    }
    if (batch.length === 0) continue
    const release = admitWorkspaceRequest("write")
    if (!release) {
      result.deferred = true
      return
    }
    try {
      freed += await withUnsettledDocumentLifecycles(async (unsettled) => {
        const busy = new Set([
          ...unsettled.flatMap((operation) => operation.spaceIds),
          ...discoverDocumentDataV2LifecycleRecovery().map(
            (recovery) => recovery.job.spaceId
          ),
        ])
        let bytes = 0
        for (const [owner, versions] of groupByOwner(batch)) {
          const first = versions[0]!
          if (busy.has(first.spaceId)) {
            // A delete or move recovery could still roll back: kept for now.
            result.deferred = true
            continue
          }
          const removed = await removeVersions(first, versions)
          if (versions.some((version) => versionHeld(version.id))) {
            result.deferred = true
          }
          if (removed.count === 0) continue
          bytes += removed.bytes
          result.versions += removed.count
          result.bytes += removed.bytes
          items.set(owner, (items.get(owner) ?? 0) + removed.count)
        }
        return bytes
      })
    } finally {
      release()
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/** Versions of one item, keyed as storage-pruned.ts records them. */
function groupByOwner(batch: PrunableVersion[]): Map<string, PrunableVersion[]> {
  const groups = new Map<string, PrunableVersion[]>()
  for (const version of batch) {
    const key =
      version.store === "v2"
        ? `${version.spaceId}/${version.owner}`
        : `${version.spaceId}/path:${version.owner}`
    groups.set(key, [...(groups.get(key) ?? []), version])
  }
  return groups
}

async function removeVersions(
  first: PrunableVersion,
  versions: PrunableVersion[]
): Promise<{ count: number; bytes: number }> {
  try {
    if (first.store === "legacy") {
      const removed = await removeLegacyDocVersions(
        first.spaceId,
        first.owner,
        new Set(versions.map((version) => version.id)),
        versionHeld
      )
      return { count: removed.filesDeleted, bytes: removed.bytesFreed }
    }
    const documentId = DocumentIdSchema.parse(first.owner)
    const removed = await removeDocumentGenerationsV2({
      workspaceRoot: getWorkspaceRoot(),
      spaceId: first.spaceId,
      documentId,
      generationIds: versions.map((version) => version.id),
      keep: versionHeld,
    })
    return {
      count: removed.length,
      bytes: removed.reduce((total, manifest) => total + manifest.totalBytes, 0),
    }
  } catch (error) {
    console.warn(
      `[storage-limit] could not prune versions in ${first.spaceId}:`,
      logError(error)
    )
    return { count: 0, bytes: 0 }
  }
}
