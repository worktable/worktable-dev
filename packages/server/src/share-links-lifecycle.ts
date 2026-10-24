import type { DocumentId } from "@worktable/types"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { withDocPathLock } from "./doc-path-lock.ts"
import { analyzeDocumentPath } from "./document-path.ts"
import {
  activeSpaceShareLinks,
  revokeAllShareLinks,
  revokeDocumentShareLinks,
  revokeSpaceShareLinks,
  ShareLinksStoreError,
} from "./share-links-store.ts"
import type { ShareArtifact } from "./share-store.ts"
import { onWorkspaceChange } from "./workspace-events.ts"
import { getSpacesDir } from "./workspace.ts"

// ============================================================
// Links (v2) through document and Space lifecycles
// ============================================================
//
// Links follow a document by id, so renames and moves leave them alone.
// Archiving or removing a document, archiving or removing its Space, and
// replacing the workspace revoke them for good: restoring brings the
// document back, not its links. Changes made outside this process are
// caught by a per-Space reconcile after the watcher reports them.
//
// The readers below are imported when used: they load store.ts, which loads
// this module through the share lifecycle adapter.

export type DocumentShareChange = "renamed" | "archived" | "removed"

/** A document whose links a lifecycle change affects. */
export interface DocumentShareTarget extends ShareArtifact {
  /** The durable id, when the caller has it; otherwise found by path. */
  documentId?: string
}

function comparisonKey(path: string): string {
  return analyzeDocumentPath(path).comparisonKey ?? path
}

/**
 * A store this binary cannot open (a later version's) serves nothing here,
 * so there is nothing in it to revoke. That must not stop the document
 * change itself.
 */
async function unlessStoreUnavailable(
  revoke: () => Promise<void> | void
): Promise<void> {
  try {
    await revoke()
  } catch (error) {
    if (!(error instanceof ShareLinksStoreError)) throw error
  }
}

/** Revoke links to documents that were archived or removed. */
export function revokeLinksForDocuments(
  targets: readonly DocumentShareTarget[],
  change: DocumentShareChange
): Promise<void> {
  if (change === "renamed" || targets.length === 0) return Promise.resolve()
  return unlessStoreUnavailable(() =>
    revokeDocumentLinks(
      targets,
      change === "archived" ? "document-archived" : "document-removed"
    )
  )
}

async function revokeDocumentLinks(
  targets: readonly DocumentShareTarget[],
  reason: "document-archived" | "document-removed"
): Promise<void> {
  const bySpace = new Map<string, DocumentShareTarget[]>()
  for (const target of targets) {
    bySpace.set(target.spaceId, [
      ...(bySpace.get(target.spaceId) ?? []),
      target,
    ])
  }
  for (const [spaceId, inSpace] of bySpace) {
    const active = activeSpaceShareLinks(spaceId)
    if (active.length === 0) continue
    const ids = new Set(
      inSpace.flatMap((target) =>
        target.documentId ? [target.documentId] : []
      )
    )
    const paths = new Set(
      inSpace
        .filter((target) => !target.documentId)
        .map((target) => comparisonKey(target.artifactKey))
    )
    if (paths.size > 0) {
      // Every linked document has a durable id, so the inventory knows it.
      const { readDocumentInventory } = await import("./document-inventory.ts")
      const inventory = await readDocumentInventory(spaceId)
      for (const entry of inventory.entries.values()) {
        if (paths.has(comparisonKey(entry.path))) ids.add(entry.documentId)
      }
    }
    const linked = [
      ...new Set(
        active
          .filter((link) => ids.has(link.documentId))
          .map((link) => link.documentId)
      ),
    ]
    if (linked.length > 0) revokeDocumentShareLinks(spaceId, linked, reason)
  }
}

/** Revoke every link into a Space that was archived or removed. */
export function revokeLinksForSpace(
  spaceId: string,
  change: "archived" | "removed"
): Promise<void> {
  return unlessStoreUnavailable(() => {
    revokeSpaceShareLinks(
      spaceId,
      change === "archived" ? "space-archived" : "space-removed"
    )
  })
}

/** Revoke every link, when the workspace is replaced or Link disconnects. */
export function revokeAllLinks(
  reason: "workspace-reset" | "link-disconnected"
): Promise<void> {
  return unlessStoreUnavailable(() => {
    revokeAllShareLinks(reason)
  })
}

// ── Changes made elsewhere ───────────────────────────────────

const RECONCILE_DELAY_MS = 1_000
const reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>()
const reconciling = new Set<Promise<void>>()

/**
 * Revoke links whose Space or document is gone or archived, after a change
 * this process may not have made: as with archives made here, restoring
 * brings back the document, not its links, and a document removed on disk
 * does not come back by writing a file at its path. A linked document always
 * has a durable id, so the Space's inventory says where its source is. Files
 * that cannot be read decide nothing; their links serve nothing meanwhile.
 */
export async function reconcileSpaceShareLinks(spaceId: string): Promise<void> {
  if (activeSpaceShareLinks(spaceId).length === 0) return
  const [
    { readDocumentIdentities },
    { inspectDocumentSource, readDocumentInventory },
    { runWithoutTeamIdentity },
  ] = await Promise.all([
    import("./document-query.ts"),
    import("./document-inventory.ts"),
    import("./team-policy.ts"),
  ])
  // Upkeep for the whole Space, whoever's change set it off. Moves inside
  // this process hold the Space's path lock while a source and its inventory
  // entry disagree.
  await runWithoutTeamIdentity(() =>
    withDocPathLock(spaceId, async () => {
      const active = activeSpaceShareLinks(spaceId)
      if (active.length === 0) return
      const spaceRoot = join(getSpacesDir(), spaceId)
      if (!existsSync(join(spaceRoot, "space.json"))) {
        revokeSpaceShareLinks(spaceId, "space-removed")
        return
      }
      let identities
      try {
        ;({ identities } = await readDocumentIdentities(spaceId, {
          lockHeld: true,
        }))
      } catch {
        return
      }
      if (identities.spaceArchived) {
        revokeSpaceShareLinks(spaceId, "space-archived")
        return
      }
      const linked = new Set(active.map((link) => link.documentId))
      const archived = [...linked].filter((id) => identities.archived.has(id))
      if (archived.length > 0) {
        revokeDocumentShareLinks(spaceId, archived, "document-archived")
      }
      const inventory = await readDocumentInventory(spaceId)
      const unreadable = new Set(
        inventory.diagnostics.map((diagnostic) => diagnostic.documentId)
      )
      // Without an inventory, or with one that cannot be read whole, nothing
      // says which documents are gone.
      if (!inventory.exists || unreadable.has(undefined)) return
      const removed: string[] = []
      for (const documentId of linked) {
        if (unreadable.has(documentId) || identities.archived.has(documentId)) {
          continue
        }
        const entry = inventory.entries.get(documentId as DocumentId)
        if (
          !entry ||
          !(await inspectDocumentSource(spaceRoot, entry.source)).safe
        ) {
          removed.push(documentId)
        }
      }
      if (removed.length > 0) {
        revokeDocumentShareLinks(spaceId, removed, "document-removed")
      }
    })
  )
}

function logFailure(what: string, error: unknown): void {
  console.error(
    `[share-links] ${what} failed:`,
    error instanceof Error ? error.name : "error"
  )
}

/** One reconcile a second at most per Space, however busy it is. */
function scheduleReconcile(spaceId: string): void {
  if (reconcileTimers.has(spaceId)) return
  const timer = setTimeout(() => {
    reconcileTimers.delete(spaceId)
    const run = reconcileSpaceShareLinks(spaceId)
      .catch((error: unknown) => logFailure("reconcile", error))
      .finally(() => reconciling.delete(run))
    reconciling.add(run)
  }, RECONCILE_DELAY_MS)
  timer.unref?.()
  reconcileTimers.set(spaceId, timer)
}

/** Run pending reconciles now, for tests and shutdown. */
export async function settleShareLinkReconciles(): Promise<void> {
  const spaces = [...reconcileTimers.keys()]
  for (const timer of reconcileTimers.values()) clearTimeout(timer)
  reconcileTimers.clear()
  await Promise.all([...reconciling])
  await Promise.all(spaces.map((spaceId) => reconcileSpaceShareLinks(spaceId)))
}

onWorkspaceChange((event) => {
  if (event.type === "workspaceReset") {
    // Replaced content rotates the epoch too, so old links fail either way.
    return revokeAllLinks("workspace-reset").catch((error: unknown) =>
      logFailure("revoking on reset", error)
    )
  }
  if (
    event.type !== "space" &&
    event.type !== "doc" &&
    event.type !== "widget" &&
    event.type !== "documentCorpus"
  ) {
    return
  }
  try {
    if (activeSpaceShareLinks(event.spaceId).length === 0) return
    scheduleReconcile(event.spaceId)
  } catch (error) {
    // Link upkeep never fails the change that triggered it.
    if (!(error instanceof ShareLinksStoreError)) logFailure("reconcile", error)
  }
})
