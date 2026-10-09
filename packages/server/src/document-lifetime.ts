// ============================================================
// Document lifetime: durable, temporary, and the archive sweep
// ============================================================
//
// Durable documents stay until someone archives them. Temporary documents
// carry an archive date and archive themselves once it passes (see
// lifetime-rules.ts for how content changes push that date out). Archived
// documents are never deleted automatically; restoring one makes it durable.

import { recordActivity } from "./activity-log.ts"
import { isArchiveOnValue, type DocumentLifetime } from "@worktable/types"
import { z } from "zod"
import { withDocPathLock } from "./doc-path-lock.ts"
import {
  listDocumentLifetimeTargetsLocked,
  listDocuments,
  type DocumentLifetimeTarget,
} from "./document-query.ts"
import { setRegisteredDocumentArchived } from "./document-write-service.ts"
import { graceEndsAt } from "./lifetime-rules.ts"
import {
  listSpaces,
  sanitizeDocPath,
  setDocsArchiveOn,
  getSpaceArchiveInfo,
} from "./store.ts"
import { notifyWorkspaceChangeAndWait } from "./workspace-events.ts"

/** Actor recorded on documents archived because their date passed. */
export const LIFETIME_ACTOR = "worktable-lifetime"
const SWEEP_REASON = "Reached its archive date"

export type DocumentLifetimeErrorReason =
  | "not-found"
  | "archived"
  | "unsupported"
  | "invalid-date"

export class DocumentLifetimeError extends Error {
  readonly reason: DocumentLifetimeErrorReason

  constructor(reason: DocumentLifetimeErrorReason, message: string) {
    super(message)
    this.name = "DocumentLifetimeError"
    this.reason = reason
  }
}

export interface DocumentLifetimeChange {
  lifetime: DocumentLifetime
  /** Temporary documents only; defaults to the end of the grace period. */
  archiveOn?: string
}

export { isArchiveOnValue }

/** Shared REST input for archive dates. */
export const ArchiveOnSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isArchiveOnValue, "archiveOn must be an ISO date or date-time")

/** Why a lifetime given at creation is invalid, or null when it is usable. */
export function lifetimeCreateError(
  lifetime: DocumentLifetime | undefined,
  archiveOn: string | undefined
): string | null {
  return archiveOn !== undefined && lifetime !== "temporary"
    ? 'archiveOn applies only with lifetime "temporary"'
    : null
}

function parseArchiveOn(value: string): string {
  const parsed = Date.parse(value)
  if (!isArchiveOnValue(value)) {
    throw new DocumentLifetimeError(
      "invalid-date",
      `archiveOn must be an ISO date or date-time: ${value}`
    )
  }
  return new Date(parsed).toISOString()
}

function resolvedArchiveOn(
  change: DocumentLifetimeChange,
  nowMs: number
): string | null {
  if (change.lifetime === "durable") {
    if (change.archiveOn !== undefined) {
      throw new DocumentLifetimeError(
        "invalid-date",
        "A durable document has no archive date"
      )
    }
    return null
  }
  return change.archiveOn !== undefined
    ? parseArchiveOn(change.archiveOn)
    : graceEndsAt(nowMs)
}

async function publishLifetimeChange(spaceId: string): Promise<void> {
  await notifyWorkspaceChangeAndWait({ type: "documentCorpus", spaceId })
}

function requireChangeable(
  target: DocumentLifetimeTarget | undefined,
  path: string
): asserts target is DocumentLifetimeTarget {
  if (!target) {
    throw new DocumentLifetimeError("not-found", `Document not found: ${path}`)
  }
  if (target.archived) {
    throw new DocumentLifetimeError(
      "archived",
      `Document is archived: ${path}. Restore it first; restored documents are durable.`
    )
  }
  if (!target.supported) {
    throw new DocumentLifetimeError(
      "unsupported",
      `This document's storage can't record a lifetime: ${path}`
    )
  }
}

/** Make one active document durable or temporary. */
export async function setDocumentLifetime(options: {
  spaceId: string
  path: string
  change: DocumentLifetimeChange
  now?: number
}): Promise<{ path: string; lifetime: DocumentLifetime; archiveOn?: string }> {
  const nowMs = options.now ?? Date.now()
  const archiveOn = resolvedArchiveOn(options.change, nowMs)
  const path = sanitizeDocPath(options.path)
  // Validate and write under the doc-path lock so a concurrent move or
  // archive cannot leave the date on a path the document no longer has.
  let previous: DocumentLifetime | undefined
  await withDocPathLock(options.spaceId, async () => {
    const target = (
      await listDocumentLifetimeTargetsLocked(options.spaceId)
    ).find((candidate) => candidate.path === path)
    requireChangeable(target, path)
    previous = target.view.lifetime ?? "durable"
    await setDocsArchiveOn(
      options.spaceId,
      [path],
      archiveOn,
      new Date(nowMs).toISOString()
    )
  })
  await publishLifetimeChange(options.spaceId)
  // Repeating the current lifetime (an agent restating it on each write, or a
  // new archive date) is not a change anyone needs to read about.
  if (previous !== options.change.lifetime) {
    recordActivity({
      spaceId: options.spaceId,
      action:
        options.change.lifetime === "durable" ? "doc.kept" : "doc.madeTemporary",
      target: { kind: "doc", path },
    })
  }
  return {
    path,
    lifetime: options.change.lifetime,
    ...(archiveOn ? { archiveOn } : {}),
  }
}

/**
 * Apply one lifetime to every active document in a folder. Archived documents
 * are skipped; documents whose storage can't record a lifetime are reported.
 */
export async function setDocumentFolderLifetime(options: {
  spaceId: string
  path: string
  change: DocumentLifetimeChange
  now?: number
}): Promise<{ changed: string[]; unsupported: string[] }> {
  const nowMs = options.now ?? Date.now()
  const archiveOn = resolvedArchiveOn(options.change, nowMs)
  const prefix = sanitizeDocPath(options.path)
  const result = await withDocPathLock(options.spaceId, async () => {
    const inFolder = (
      await listDocumentLifetimeTargetsLocked(options.spaceId)
    ).filter(
      (target) =>
        !target.archived &&
        (target.path === prefix || target.path.startsWith(`${prefix}/`))
    )
    if (inFolder.length === 0) {
      throw new DocumentLifetimeError(
        "not-found",
        `No active documents in folder: ${prefix}`
      )
    }
    const changed = inFolder.filter((t) => t.supported).map((t) => t.path)
    const unsupported = inFolder.filter((t) => !t.supported).map((t) => t.path)
    if (changed.length > 0) {
      await setDocsArchiveOn(
        options.spaceId,
        changed,
        archiveOn,
        new Date(nowMs).toISOString()
      )
    }
    return { changed, unsupported }
  })
  if (result.changed.length > 0) await publishLifetimeChange(options.spaceId)
  return result
}

export interface LifetimeSweepReceipt {
  spaceId: string
  archived: string[]
  failed: string[]
}

/**
 * Archive every temporary document whose date has passed. Each archive
 * re-derives the due date from current state under the archive lock.
 */
export async function runLifetimeSweep(
  options: { now?: number; shouldStop?: () => boolean } = {}
): Promise<LifetimeSweepReceipt[]> {
  const shouldStop = options.shouldStop ?? (() => false)
  const receipts: LifetimeSweepReceipt[] = []
  for (const space of await listSpaces()) {
    if (shouldStop()) break
    if (getSpaceArchiveInfo(space)) continue
    const receipt: LifetimeSweepReceipt = {
      spaceId: space.id,
      archived: [],
      failed: [],
    }
    const dueNow = async (): Promise<string[]> => {
      const nowMs = options.now ?? Date.now()
      return (await listDocuments({ spaceId: space.id }))
        .filter(
          (item) =>
            item.kind === "document" &&
            item.archiveOn !== undefined &&
            Date.parse(item.archiveOn) <= nowMs
        )
        .map((item) => (item as { path: string }).path)
    }
    let due: string[]
    try {
      due = await dueNow()
    } catch (error) {
      console.error(
        `[document-lifetime] could not list documents in ${space.id}:`,
        error
      )
      continue
    }
    for (const path of due) {
      if (shouldStop()) break
      try {
        // The archive re-checks the due date under its own lock, so an edit,
        // rename, or comment since the listing keeps the document active.
        const outcome = await setRegisteredDocumentArchived({
          spaceId: space.id,
          path,
          archived: true,
          archivedBy: LIFETIME_ACTOR,
          reason: SWEEP_REASON,
          onlyIfDueBy: options.now ?? Date.now(),
        })
        if (!outcome.notDue) receipt.archived.push(path)
      } catch (error) {
        receipt.failed.push(path)
        console.error(
          `[document-lifetime] could not archive ${space.id}/${path}:`,
          error
        )
      }
    }
    if (receipt.archived.length > 0 || receipt.failed.length > 0) {
      receipts.push(receipt)
    }
  }
  return receipts
}

/**
 * Apply the lifetime chosen when a document was created. Creation already
 * succeeded, so a failure here is logged and the document stays durable
 * rather than failing a request that a client might retry into a duplicate.
 */
export async function applyLifetimeOnCreate(options: {
  spaceId: string
  path: string
  lifetime?: DocumentLifetime
  archiveOn?: string
}): Promise<{ lifetime: DocumentLifetime; archiveOn?: string }> {
  if (options.lifetime !== "temporary") return { lifetime: "durable" }
  try {
    const result = await setDocumentLifetime({
      spaceId: options.spaceId,
      path: options.path,
      change: {
        lifetime: "temporary",
        ...(options.archiveOn ? { archiveOn: options.archiveOn } : {}),
      },
    })
    return {
      lifetime: result.lifetime,
      ...(result.archiveOn ? { archiveOn: result.archiveOn } : {}),
    }
  } catch (error) {
    console.error(
      `[document-lifetime] could not make new document temporary ${options.spaceId}/${options.path}:`,
      error
    )
    return { lifetime: "durable" }
  }
}
