// ============================================================
// A plain file's bytes at one revision, read outside the lock
// ============================================================
//
// An agent's read of a file, a Records import and a replace based on a
// page's version need a plain file's whole bytes, or the sourceRevision they
// name. The file is resolved and its revision pinned while its Space's lock
// is held (resolveCurrentFile), and its bytes are read once the lock is
// released, so reading a large file never holds up the Space's other work.
// Every chunk is checked against the pinned revision: a file that changes
// while it is read is read again from the start, a few times at most, and
// its bytes never mix two revisions.

import type { DocumentId } from "@worktable/types"
import { resolveCurrentFile, type CurrentFile } from "./document-page-service.ts"
import { DocumentSourceReadError } from "./document-source-errors.ts"
import {
  DocumentWriteError,
  registeredDocumentSourceRevisionHasher,
} from "./document-write-service.ts"
import { FILE_VERSION_MAX_BYTES } from "./file-limits.ts"
import {
  FILE_READ_CHUNK_BYTES,
  FileRevisionError,
  OpenFileRevision,
  readIsKeepable,
} from "./file-revision.ts"
import { assertSpaceAccess } from "./team-policy.ts"

/** Reads of a file that keeps changing before one completes. */
const READ_ATTEMPTS = 3

/**
 * Source revisions worked out from a whole read, by the file as its source
 * and its revision, so a file read again unchanged, such as a PDF paged from
 * its kept contents, isn't hashed again. Kept only for a settled revision.
 */
const sourceRevisions = new Map<string, string>()
const SOURCE_REVISIONS_MAX = 4096

/** Forgets every kept source revision, so a test sees each read. */
export function forgetSourceRevisionsForTests(): void {
  sourceRevisions.clear()
}

function sourceRevisionKey(current: CurrentFile): string {
  return JSON.stringify([
    current.documentId,
    current.path,
    current.format.id,
    current.format.sourceVersion,
    current.pinned.path,
    current.pinned.revision,
  ])
}

export interface CurrentFileSource {
  current: CurrentFile
  /** The revision a replace of the file names, of the bytes read. */
  sourceRevision: string
  /** The bytes at `current.pinned.revision`, when asked for. */
  bytes?: Uint8Array
}

/**
 * A plain file's sourceRevision, and its bytes with `bytes`, at one
 * revision; null when `path` names no plain file. Without its bytes the
 * file is hashed a chunk at a time and never held whole. With `revision`, a file's
 * on-disk version as its page gives it, only that version: one changed since,
 * or while it is read, throws FileRevisionError "changed". Throws
 * DocumentSourceReadError "too-large" for a file past what a version holds.
 */
export async function readCurrentFileSource(options: {
  spaceId: string
  path: string
  revision?: string
  /** Whether to keep the bytes: decided for the file found, by its size. */
  bytes?: boolean | ((current: CurrentFile) => boolean)
  /**
   * The most bytes this read takes: a larger file throws
   * DocumentSourceReadError "too-large" before any of it is read.
   */
  maxBytes?: number
  /**
   * Sees every chunk of the bytes, in order, without their being kept. A
   * fresh one is made for each attempt, so a file read again after it
   * changed is seen from its start.
   */
  consume?: () => { update(chunk: Uint8Array): void }
}): Promise<CurrentFileSource | null> {
  assertSpaceAccess(options.spaceId)
  for (let attempt = 1; ; attempt += 1) {
    const resolved = await resolveCurrentFile({
      spaceId: options.spaceId,
      path: options.path,
      ...(options.revision !== undefined ? { revision: options.revision } : {}),
    })
    switch (resolved.kind) {
      case "not-found":
        return null
      case "changed":
        throw new FileRevisionError("changed", "file changed since that version")
      case "conflict":
        throw new DocumentWriteError(
          "conflict",
          "This file must be repaired before it can be read"
        )
      case "unavailable":
        throw new DocumentSourceReadError(
          "temporarily-unavailable",
          "document source could not be read consistently"
        )
    }
    const { current } = resolved
    if (current.pinned.size > Math.min(options.maxBytes ?? Infinity, FILE_VERSION_MAX_BYTES)) {
      throw new DocumentSourceReadError(
        "too-large",
        "document source exceeds its read budget"
      )
    }
    try {
      const keepBytes =
        typeof options.bytes === "function"
          ? options.bytes(current)
          : options.bytes === true
      return {
        current,
        ...(await readPinned(current, keepBytes, options.consume?.())),
      }
    } catch (error) {
      if (!(error instanceof FileRevisionError) || error.reason !== "changed") {
        throw error
      }
      if (options.revision !== undefined) throw error
      if (attempt >= READ_ATTEMPTS) {
        throw new DocumentSourceReadError(
          "temporarily-unavailable",
          "document source kept changing while it was read"
        )
      }
    }
  }
}

async function readPinned(
  current: CurrentFile,
  keepBytes: boolean,
  consumer?: { update(chunk: Uint8Array): void }
): Promise<{ sourceRevision: string; bytes?: Uint8Array }> {
  const key = sourceRevisionKey(current)
  const known = keepBytes || consumer ? undefined : sourceRevisions.get(key)
  if (known !== undefined) return { sourceRevision: known }
  const startedAt = Date.now()
  const revision = await registeredDocumentSourceRevisionHasher({
    documentId: current.documentId as DocumentId,
    path: current.path,
    format: current.format,
    source: current.source,
  })
  const file = await OpenFileRevision.open(
    current.pinned.path,
    current.pinned.revision
  )
  try {
    const bytes = keepBytes ? new Uint8Array(file.size) : null
    for (let position = 0; position < file.size; ) {
      const chunk = await file.read(
        position,
        Math.min(FILE_READ_CHUNK_BYTES, file.size - position)
      )
      revision.update(chunk)
      consumer?.update(chunk)
      bytes?.set(chunk, position)
      position += chunk.byteLength
    }
    const sourceRevision = revision.revision()
    if (readIsKeepable(current.pinned.path, current.pinned.revision, file.changedAtNs, startedAt)) {
      if (sourceRevisions.size >= SOURCE_REVISIONS_MAX) {
        const oldest = sourceRevisions.keys().next().value
        if (oldest !== undefined) sourceRevisions.delete(oldest)
      }
      sourceRevisions.set(key, sourceRevision)
    }
    return {
      sourceRevision,
      ...(bytes ? { bytes } : {}),
    }
  } finally {
    await file.close()
  }
}
