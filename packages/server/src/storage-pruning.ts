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
  /** A capture, replacement or recovery held the workspace; try again later. */
  deferred: boolean
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
    if (result.bytes < wantBytes && !stopped()) {
      await pruneOldestVersions(wantBytes - result.bytes, stopped, result, items)
    }
  } catch (error) {
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
  for (let start = 0; start < candidates.length; start += BATCH) {
    if (freed >= wantBytes || stopped()) return
    if (workspaceRecoveryRequired() || getWorkspaceRoot() !== root) {
      result.deferred = true
      return
    }
    // Only as many of this batch as still need to go.
    const batch: PrunableVersion[] = []
    let planned = freed
    for (const candidate of candidates.slice(start, start + BATCH)) {
      if (planned >= wantBytes) break
      batch.push(candidate)
      planned += candidate.bytes
    }
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
          if (busy.has(first.spaceId)) continue
          const removed = await removeVersions(first, versions)
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
