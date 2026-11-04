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
// A run first plans: it lists what it could remove now and what that frees,
// so storage-limit.ts can tell a write that can't fit anyway from one that
// can, and remove nothing for the first. Then it removes, oldest first,
// only as much as is due.
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
  lastDeletedItemsPassKept,
  listTrashToPrune,
  removeTrashEntry,
  runDeletedItemsInBackground,
  type TrashEntryToPrune,
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

/** What a run could remove now, oldest first, and what that frees. */
export interface PrunePlan {
  trash: TrashEntryToPrune[]
  versions: PrunableVersion[]
  bytes: number
  /**
   * Unsettled lifecycle operations that kept history in their Spaces for
   * now. More becomes removable once one of them settles.
   */
  blockedBy: string[]
  /**
   * A capture, replacement, recovery or failure held the workspace or the
   * deleted-items pass: the plan may miss what could go, so it is not
   * remembered as all there is.
   */
  held: boolean
}

export interface PruneResult {
  deletedItems: number
  versions: number
  bytes: number
  /** Something planned was kept after all (held, busy, gone); plan again. */
  deferred: boolean
}

let testHooks: {
  /** Called once a run has emptied the trash, before it prunes versions. */
  beforeVersions?: () => void
} = {}
let plansMade = 0

export function setStoragePruningHooksForTests(hooks: typeof testHooks): void {
  testHooks = hooks
}

/** How many plans were made: each walks all history. For tests. */
export function storagePruningPlansForTests(): number {
  return plansMade
}

async function unsettledLifecycles(): Promise<{ ids: string[]; spaces: Set<string> }> {
  return withUnsettledDocumentLifecycles(async (unsettled) => {
    const jobs = discoverDocumentDataV2LifecycleRecovery()
    return {
      ids: [
        ...unsettled.map((operation) => operation.operationId),
        ...jobs.map((recovery) => recovery.job.id),
      ],
      spaces: new Set([
        ...unsettled.flatMap((operation) => operation.spaceIds),
        ...jobs.map((recovery) => recovery.job.spaceId),
      ]),
    }
  })
}

/** Whether every one of these lifecycle operations is still unsettled. */
export async function lifecyclesStillUnsettled(ids: readonly string[]): Promise<boolean> {
  const current = new Set((await unsettledLifecycles()).ids)
  return ids.every((id) => current.has(id))
}

/**
 * List what could go now, oldest first: the trash, then versions. Moves
 * retired history into the trash first, which removes nothing. Walks all
 * history: storage-limit.ts plans only when what it knows may be stale.
 */
export async function planPruning(
  stopped: () => boolean = () => false
): Promise<PrunePlan> {
  plansMade += 1
  const plan: PrunePlan = { trash: [], versions: [], bytes: 0, blockedBy: [], held: false }
  if (workspaceRecoveryRequired()) return { ...plan, held: true }
  try {
    await runDeletedItemsInBackground()
    const kept = lastDeletedItemsPassKept()
    if (kept === "held") plan.held = true
    plan.trash = await listTrashToPrune()
    const versions = (await listPrunableVersions(stopped)).sort(
      (a, b) => a.at - b.at || (a.id < b.id ? -1 : 1)
    )
    const lifecycles = await unsettledLifecycles()
    let blocked = kept === "named"
    for (const version of versions) {
      // A version a restore holds goes once it lets go, which notes it.
      if (versionHeld(version.id)) continue
      if (lifecycles.spaces.has(version.spaceId)) {
        blocked = true
        continue
      }
      plan.versions.push(version)
    }
    if (blocked) plan.blockedBy = lifecycles.ids
  } catch (error) {
    plan.held = true
    console.error("[storage-limit] planning failed:", logError(error))
  }
  plan.bytes =
    plan.trash.reduce((total, entry) => total + entry.bytes, 0) +
    plan.versions.reduce((total, version) => total + version.bytes, 0)
  return plan
}

/** Remove the oldest of a plan until `wantBytes` are freed; see the header. */
export async function prunePlanned(
  plan: PrunePlan,
  wantBytes: number,
  stopped: () => boolean = () => false
): Promise<PruneResult> {
  const result: PruneResult = { deletedItems: 0, versions: 0, bytes: 0, deferred: false }
  const items = new Map<string, number>()
  if (wantBytes <= 0) return result
  try {
    for (const entry of plan.trash) {
      if (result.bytes >= wantBytes || stopped()) break
      if (await removeTrashEntry(entry)) {
        result.deletedItems += 1
        result.bytes += entry.bytes
      } else result.deferred = true
    }
    testHooks.beforeVersions?.()
    if (result.bytes < wantBytes && !stopped()) {
      await pruneOldestVersions(plan.versions, wantBytes - result.bytes, stopped, result, items)
    }
  } catch (error) {
    // Failed partway: not proof of what is left.
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
  candidates: PrunableVersion[],
  wantBytes: number,
  stopped: () => boolean,
  result: PruneResult,
  items: Map<string, number>
): Promise<void> {
  const root = getWorkspaceRoot()
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
        // A restore began reading it since the plan.
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
            // A delete or move began since the plan: kept for now.
            result.deferred = true
            continue
          }
          const removed = await removeVersions(first, versions)
          if (removed.count < versions.length) result.deferred = true
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
