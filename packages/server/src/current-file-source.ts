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
} from "./file-revision.ts"
import { assertSpaceAccess } from "./team-policy.ts"

/** Reads of a file that keeps changing before one completes. */
const READ_ATTEMPTS = 3

export interface CurrentFileSource {
  current: CurrentFile
  /** The revision a replace of the file names, of the bytes read. */
  sourceRevision: string
  /** The bytes at `current.pinned.revision`, when asked for. */
  bytes?: Uint8Array
}

/**
 * A plain file's sourceRevision, and its bytes with `bytes`, at one
 * revision; null when `path` names no plain file. With `revision`, a file's
 * on-disk version as its page gives it, only that version: one changed since,
 * or while it is read, throws FileRevisionError "changed". Throws
 * DocumentSourceReadError "too-large" for a file past what a version holds.
 */
export async function readCurrentFileSource(options: {
  spaceId: string
  path: string
  revision?: string
  bytes?: boolean
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
    if (current.pinned.size > FILE_VERSION_MAX_BYTES) {
      throw new DocumentSourceReadError(
        "too-large",
        "document source exceeds its read budget"
      )
    }
    try {
      return { current, ...(await readPinned(current, options.bytes === true)) }
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
  keepBytes: boolean
): Promise<{ sourceRevision: string; bytes?: Uint8Array }> {
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
      bytes?.set(chunk, position)
      position += chunk.byteLength
    }
    return {
      sourceRevision: revision.revision(),
      ...(bytes ? { bytes } : {}),
    }
  } finally {
    await file.close()
  }
}
