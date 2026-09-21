import { lstat } from "node:fs/promises"
import type {
  DocumentFormatClaim,
  DocumentId,
  DocumentSource,
} from "@worktable/types"
import {
  BoundedFileReadError,
  readBoundedRegularFileBytes,
} from "./bounded-file.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import {
  inspectDocumentSource,
  readDocumentBundleManifest,
} from "./document-inventory.ts"
import { DocumentSourceReadError } from "./document-source-errors.ts"
export {
  DocumentSourceReadError,
  type DocumentSourceReadFailure,
} from "./document-source-errors.ts"

function sameIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function readFailure(error: unknown): DocumentSourceReadError {
  if (error instanceof DocumentSourceReadError) return error
  if (error instanceof BoundedFileReadError && error.reason === "too-large") {
    return new DocumentSourceReadError(
      "too-large",
      "document source exceeds its read budget"
    )
  }
  return new DocumentSourceReadError(
    "temporarily-unavailable",
    "document source could not be read consistently"
  )
}

async function sourceStillMatches(input: {
  spaceRoot: string
  source: DocumentSource
  before: Awaited<ReturnType<typeof lstat>>
}): Promise<boolean> {
  const inspected = await inspectDocumentSource(input.spaceRoot, input.source)
  if (!inspected.safe) return false
  const after = await lstat(inspected.absolutePath).catch(() => null)
  return Boolean(after && sameIdentity(input.before, after))
}

async function readFileSource(input: {
  spaceRoot: string
  source: DocumentSource & { kind: "file" }
  maxBytes: number
  signal: AbortSignal
}): Promise<Uint8Array> {
  if (input.signal.aborted) throw readFailure(input.signal.reason)
  const inspected = await inspectDocumentSource(input.spaceRoot, input.source)
  if (!inspected.safe) {
    throw new DocumentSourceReadError("invalid-source", inspected.message)
  }
  const before = await lstat(inspected.absolutePath)
  try {
    const content = await readBoundedRegularFileBytes(
      inspected.absolutePath,
      input.maxBytes,
      input.signal
    )
    if (
      input.signal.aborted ||
      !(await sourceStillMatches({
        spaceRoot: input.spaceRoot,
        source: input.source,
        before,
      }))
    ) {
      throw new DocumentSourceReadError(
        "temporarily-unavailable",
        "document source changed while it was read"
      )
    }
    return content
  } catch (error) {
    throw readFailure(error)
  }
}

async function readLegacyHtmlBundle(input: {
  spaceRoot: string
  source: DocumentSource & { kind: "bundle" }
  maxBytes: number
  signal: AbortSignal
}): Promise<Uint8Array> {
  if (!input.source.relativePath.startsWith("widgets/")) {
    throw new DocumentSourceReadError(
      "invalid-source",
      "legacy HTML source is outside widget storage"
    )
  }
  const inspected = await inspectDocumentSource(input.spaceRoot, input.source)
  if (!inspected.safe) {
    throw new DocumentSourceReadError("invalid-source", inspected.message)
  }
  const before = await lstat(inspected.absolutePath)
  const content = await readFileSource({
    spaceRoot: input.spaceRoot,
    source: {
      kind: "file",
      relativePath: `${input.source.relativePath}/index.html`,
    },
    maxBytes: input.maxBytes,
    signal: input.signal,
  })
  if (
    !(await sourceStillMatches({
      spaceRoot: input.spaceRoot,
      source: input.source,
      before,
    }))
  ) {
    throw new DocumentSourceReadError(
      "temporarily-unavailable",
      "HTML document changed while it was read"
    )
  }
  return content
}

async function readCoreBundle(input: {
  spaceRoot: string
  documentId: DocumentId
  format: DocumentFormatClaim
  source: DocumentSource & { kind: "bundle" }
  maxBytes: number
  signal: AbortSignal
}): Promise<Uint8Array> {
  if (input.signal.aborted) throw readFailure(input.signal.reason)
  const inspected = await inspectDocumentSource(input.spaceRoot, input.source)
  if (!inspected.safe) {
    throw new DocumentSourceReadError("invalid-source", inspected.message)
  }
  const before = await lstat(inspected.absolutePath)
  const first = await readDocumentBundleManifest(
    inspected.absolutePath,
    input.signal
  )
  const manifest = first.manifest
  if (input.signal.aborted) throw readFailure(input.signal.reason)
  if (
    !manifest ||
    manifest.documentId !== input.documentId ||
    manifest.format.id !== input.format.id ||
    manifest.format.sourceVersion !== input.format.sourceVersion
  ) {
    throw new DocumentSourceReadError(
      "invalid-source",
      "document bundle manifest does not match its catalog claim"
    )
  }
  let content: Uint8Array
  try {
    content = await readFileSource({
      spaceRoot: input.spaceRoot,
      source: {
        kind: "file",
        relativePath: `${input.source.relativePath}/${manifest.content}`,
      },
      maxBytes: input.maxBytes,
      signal: input.signal,
    })
  } catch (error) {
    throw readFailure(error)
  }
  const second = await readDocumentBundleManifest(
    inspected.absolutePath,
    input.signal
  )
  if (
    input.signal.aborted ||
    !(await sourceStillMatches({
      spaceRoot: input.spaceRoot,
      source: input.source,
      before,
    })) ||
    !second.manifest ||
    second.manifest.documentId !== manifest.documentId ||
    second.manifest.format.id !== manifest.format.id ||
    second.manifest.format.sourceVersion !== manifest.format.sourceVersion ||
    second.manifest.content !== manifest.content
  ) {
    throw new DocumentSourceReadError(
      "temporarily-unavailable",
      "document bundle changed while it was read"
    )
  }
  return content
}

export async function readDocumentSource(input: {
  spaceRoot: string
  documentId: DocumentId
  format: DocumentFormatClaim
  source: DocumentSource
  maxBytes: number
  signal: AbortSignal
}): Promise<Uint8Array> {
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1) {
    throw new DocumentSourceReadError(
      "invalid-source",
      "document read budget is invalid"
    )
  }
  const source = input.source
  if (source.kind === "file") return readFileSource({ ...input, source })
  if (
    input.format.id === BUILTIN_DOCUMENT_FORMATS.html &&
    !source.relativePath.endsWith(".wtdoc")
  ) {
    return readLegacyHtmlBundle({ ...input, source })
  }
  if (!source.relativePath.endsWith(".wtdoc")) {
    throw new DocumentSourceReadError(
      "invalid-source",
      "document bundle does not use a supported core container"
    )
  }
  return readCoreBundle({ ...input, source })
}
