// ============================================================
// Writing an uploaded file
// ============================================================
//
// One write path for every upload: the app's Upload and Upload New Version,
// the one-time links agents send files to, directly or through Worktable
// Link, and files attached in ChatGPT. Each body is staged on disk as it
// arrives, so no transfer holds a file in memory, and saved from there. A
// storage quota, when it comes, goes here.

import { DOCUMENT_GENERATION_MAX_ENTRY_BYTES } from "@worktable/types"
import {
  BUILTIN_DOCUMENT_FORMATS,
  createBuiltinDocumentFormatRegistry,
} from "./document-format-registry.ts"
import {
  createRegisteredDocument,
  DocumentWriteError,
  readRegisteredDocumentSource,
  replaceRegisteredDocument,
} from "./document-write-service.ts"
import { contentHashFromHex } from "./file-revision.ts"
import {
  discardStagedFile,
  StagingFile,
  type StagedFile,
} from "./staged-file.ts"
import { DocumentSourceReadError } from "./document-source-errors.ts"

/** The largest file an upload takes: one version entry. */
export const FILE_UPLOAD_MAX_BYTES = DOCUMENT_GENERATION_MAX_ENTRY_BYTES
export const FILE_UPLOAD_TOO_LARGE = "Files can be up to 64 MiB."
const FILE_REPLACE_TOO_LARGE =
  "This file is larger than 64 MiB, so its history can't keep it. Replace it on disk, or upload under a new name."
const FILE_KEEP_BOTH_TRIES = 100
const fileRegistry = createBuiltinDocumentFormatRegistry()

/**
 * A request's or response's body staged on disk as it arrives, hashed on
 * the way, or null once it passes `max`: a sender that leaves out
 * Content-Length, as curl does from stdin, can't make the server keep more.
 * At most one chunk is in memory at a time. A body over the limit, or one
 * that fails or is cut off partway, leaves no staged file behind. The caller
 * discards the staged file once it is saved.
 */
export async function stageUploadBody(
  message: Request | Response,
  max: number = FILE_UPLOAD_MAX_BYTES
): Promise<StagedFile | null> {
  const file = await StagingFile.create()
  try {
    if (message.body) {
      const reader = message.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (file.byteLength + value.byteLength > max) {
          await reader.cancel().catch(() => undefined)
          await file.discard()
          return null
        }
        await file.append(value)
      }
    }
    return await file.finish()
  } catch (error) {
    await file.discard()
    throw error
  }
}

/**
 * Stage a body and give it to `save`, removing the staged file after,
 * whatever happens; null, with nothing kept, when it is over the limit.
 */
export async function withStagedUpload<T>(
  message: Request | Response,
  save: (file: StagedFile) => Promise<T>
): Promise<T | null> {
  const file = await stageUploadBody(message)
  if (!file) return null
  try {
    return await save(file)
  } finally {
    await discardStagedFile(file)
  }
}

/**
 * Whether a new file at this path could be a file rather than a Doc. A
 * `.json` can: it is a Doc only when it holds Doc blocks, which the write
 * checks once it has the bytes.
 */
export function namesAFile(path: string): boolean {
  const leaf = path.split("/").at(-1) ?? ""
  const format = fileRegistry.fileSourceForFilename(leaf, { anyFile: true })
    ?.registration.id
  return (
    format === BUILTIN_DOCUMENT_FORMATS.file ||
    format === BUILTIN_DOCUMENT_FORMATS.richText
  )
}

/** A file's current revision, to replace it with whatever it holds now. */
async function currentFileRevision(
  spaceId: string,
  path: string
): Promise<string> {
  const current = await readRegisteredDocumentSource({ spaceId, path })
  if (current.format.id !== BUILTIN_DOCUMENT_FORMATS.file) {
    throw new DocumentWriteError("unsupported", "This document is not a file")
  }
  return current.sourceRevision
}

/** `name-2.ext`, `name-3.ext`… for keeping both when a name is taken. */
function numberedFilePath(path: string, n: number): string {
  const slash = path.lastIndexOf("/")
  const folder = path.slice(0, slash + 1)
  const leaf = path.slice(slash + 1)
  const dot = leaf.lastIndexOf(".")
  return dot > 0
    ? `${folder}${leaf.slice(0, dot)}-${n}${leaf.slice(dot)}`
    : `${folder}${leaf}-${n}`
}

/**
 * What an upload does when the name is taken: refuse, keep both (`name-2`),
 * or replace the file, keeping its old version in history. `replace` with an
 * expected revision refuses if the file changed since.
 */
export type FileUploadMode =
  | { kind: "create"; keepBoth: boolean }
  | { kind: "replace"; expectedRevision?: string }

export interface FileUploadResult {
  /** 201 when a file was created, 200 when one was replaced. */
  status: 200 | 201
  result:
    | Awaited<ReturnType<typeof createRegisteredDocument>>
    | Awaited<ReturnType<typeof replaceRegisteredDocument>>
  contentHash: string
}

/**
 * Save an uploaded file, staged on disk, by the rules of `mode`. Its content
 * hash is the one computed as it was staged. The caller discards the staged
 * file after.
 */
export async function writeUploadedFile(options: {
  spaceId: string
  path: string
  file: StagedFile
  mode: FileUploadMode
  actor: string
  source: string
}): Promise<FileUploadResult> {
  const { spaceId, path, file: bytes, mode } = options
  const contentHash = contentHashFromHex(bytes.sha256)
  if (mode.kind === "replace") {
    try {
      const expectedRevision =
        mode.expectedRevision ?? (await currentFileRevision(spaceId, path))
      const result = await replaceRegisteredDocument({
        spaceId,
        path,
        bytes,
        expectedRevision,
        updatedBy: options.actor,
        source: options.source,
        reason: "Uploaded a new version",
        expectedFormatId: BUILTIN_DOCUMENT_FORMATS.file,
        separateVersion: true,
      })
      return { status: 200, result, contentHash }
    } catch (error) {
      // The file now is past what a version holds, so replacing it would
      // lose it: nothing could keep it in history.
      if (error instanceof DocumentSourceReadError && error.reason === "too-large") {
        throw new DocumentWriteError("conflict", FILE_REPLACE_TOO_LARGE)
      }
      throw error
    }
  }
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? path : numberedFilePath(path, n)
    try {
      const result = await createRegisteredDocument({
        spaceId,
        path: candidate,
        format: { id: BUILTIN_DOCUMENT_FORMATS.file, sourceVersion: 1 },
        bytes,
        createdBy: options.actor,
        source: options.source,
        reason: "Uploaded",
      })
      return { status: 201, result, contentHash }
    } catch (error) {
      if (
        !mode.keepBoth ||
        n >= FILE_KEEP_BOTH_TRIES ||
        !(error instanceof DocumentWriteError) ||
        error.reason !== "conflict"
      )
        throw error
    }
  }
}
