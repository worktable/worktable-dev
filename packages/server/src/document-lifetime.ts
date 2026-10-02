// ============================================================
// Document lifetime: durable, temporary, and the archive sweep
// ============================================================
//
// Durable documents stay until someone archives them. Temporary documents
// carry an archive date and archive themselves once it passes (see
// lifetime-rules.ts for how content changes push that date out). Archived
// documents are never deleted automatically; restoring one makes it durable.

import type { DocumentLifetime } from "@worktable/types"
import { listDocumentLifetimeTargets, listDocuments } from "./document-query.ts"
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

function parseArchiveOn(value: string): string {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) {
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
  const target = (await listDocumentLifetimeTargets(options.spaceId)).find(
    (candidate) => candidate.path === path
  )
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
  await setDocsArchiveOn(
    options.spaceId,
    [path],
    archiveOn,
    new Date(nowMs).toISOString()
  )
  await publishLifetimeChange(options.spaceId)
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
  const inFolder = (
    await listDocumentLifetimeTargets(options.spaceId)
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
  const changed = inFolder.filter((target) => target.supported).map((t) => t.path)
  const unsupported = inFolder
    .filter((target) => !target.supported)
    .map((t) => t.path)
  if (changed.length > 0) {
    await setDocsArchiveOn(
      options.spaceId,
      changed,
      archiveOn,
      new Date(nowMs).toISOString()
    )
    await publishLifetimeChange(options.spaceId)
  }
  return { changed, unsupported }
}

export interface LifetimeSweepReceipt {
  spaceId: string
  archived: string[]
  failed: string[]
}

/**
 * Archive every temporary document whose date has passed. The due date is
 * re-derived from current state for each document, so a document edited
 * moments before the sweep stays active.
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
    let due: string[]
    try {
      const nowMs = options.now ?? Date.now()
      due = (await listDocuments({ spaceId: space.id }))
        .filter(
          (item) =>
            item.kind === "document" &&
            item.archiveOn !== undefined &&
            Date.parse(item.archiveOn) <= nowMs
        )
        .map((item) => (item as { path: string }).path)
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
        // Re-check against the latest state: an edit, rename, or comment may
        // have moved the date since the listing.
        const current = (await listDocuments({ spaceId: space.id })).find(
          (item) => item.kind === "document" && item.path === path
        )
        const nowMs = options.now ?? Date.now()
        if (
          !current ||
          current.kind !== "document" ||
          current.archiveOn === undefined ||
          Date.parse(current.archiveOn) > nowMs
        ) {
          continue
        }
        await setRegisteredDocumentArchived({
          spaceId: space.id,
          path,
          archived: true,
          archivedBy: LIFETIME_ACTOR,
          reason: SWEEP_REASON,
        })
        receipt.archived.push(path)
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

/** Accepts ISO dates and date-times; shared by REST and MCP inputs. */
export function isArchiveOnValue(value: string): boolean {
  return !Number.isNaN(Date.parse(value))
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
