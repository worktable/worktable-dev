// ============================================================
// Writing an uploaded file
// ============================================================
//
// One write path for every upload: the app's Upload and Upload New Version,
// and the one-time links agents send files to. A storage quota, when it
// comes, goes here.

import { createHash } from "node:crypto"
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

/** The largest file an upload takes: one version entry. */
export const FILE_UPLOAD_MAX_BYTES = DOCUMENT_GENERATION_MAX_ENTRY_BYTES
export const FILE_UPLOAD_TOO_LARGE = "Files can be up to 64 MiB."
const FILE_KEEP_BOTH_TRIES = 100
const fileRegistry = createBuiltinDocumentFormatRegistry()

/**
 * A request body up to `max` bytes, counted as it arrives, or null past it:
 * a sender that leaves out Content-Length, as curl does from stdin, can't
 * make the server hold more.
 */
export async function readLimitedBody(
  request: Request,
  max: number
): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export function fileContentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("base64url")
}

/** Whether a new file at this path would be a file rather than a Doc. */
export function namesAFile(path: string): boolean {
  const leaf = path.split("/").at(-1) ?? ""
  return (
    fileRegistry.fileSourceForFilename(leaf, { anyFile: true })?.registration
      .id === BUILTIN_DOCUMENT_FORMATS.file
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

/** Write an uploaded file's bytes, by the rules of `mode`. */
export async function writeUploadedFile(options: {
  spaceId: string
  path: string
  bytes: Uint8Array
  mode: FileUploadMode
  actor: string
  source: string
}): Promise<FileUploadResult> {
  const { spaceId, path, bytes, mode } = options
  if (mode.kind === "replace") {
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
    return { status: 200, result, contentHash: fileContentHash(bytes) }
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
      return { status: 201, result, contentHash: fileContentHash(bytes) }
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
