import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { DocumentGenerationIdSchema } from "@worktable/types"
import { useResolvedDocumentHandle, type ResolvedDocumentHandle } from "./document-query.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "./document-format-registry.ts"
import { readDocumentSource } from "./document-source-reader.ts"
import {
  listDocumentGenerationsV2,
  readCompatibleDocumentVersionV2,
  readDocumentGenerationV2,
  type ReadDocumentGenerationV2Result,
} from "./document-version-store-v2.ts"
import { registeredDocumentSourceRevision } from "./document-write-service.ts"
import { blocksToMarkdownSafe } from "./markdown.ts"
import { docRevisionId } from "./doc-markdown-projection.ts"
import { getDocVersion, listDocVersions } from "./store.ts"
import {
  DOCUMENT_DIFF_DEFAULT_CONTEXT,
  DOCUMENT_DIFF_MAX_CONTEXT,
  unifiedLineDiff,
} from "./text-diff.ts"
import {
  getWidgetVersion,
  listWidgetVersions,
} from "./widget-version-store.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { readWorkspaceStorageLayoutAt } from "./workspace-storage-v2.ts"

const DIFF_MAX_OUTPUT_BYTES = 64 * 1024
const DIFF_MAX_SOURCE_BYTES = 8 * 1024 * 1024
const DIFF_SOURCE_TIMEOUT_MS = 30_000

export class DocumentDiffError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DocumentDiffError"
  }
}

export interface DocumentDiffResult {
  path: string
  from: string
  to: string
  unified: string
  stats: { added: number; removed: number }
  truncated: boolean
}

/** Content in the representation each format's reader projects to text. */
type VersionContent =
  | { kind: "markdown" | "html"; text: string }
  | { kind: "blocks"; blocks: unknown[] }

const TEXT_FORMATS = new Set<string>([
  BUILTIN_DOCUMENT_FORMATS.markdown,
  BUILTIN_DOCUMENT_FORMATS.richText,
  BUILTIN_DOCUMENT_FORMATS.html,
])

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

function contentFromBytes(formatId: string, bytes: Uint8Array): VersionContent {
  if (formatId === BUILTIN_DOCUMENT_FORMATS.markdown) {
    return { kind: "markdown", text: decode(bytes) }
  }
  if (formatId === BUILTIN_DOCUMENT_FORMATS.html) {
    return { kind: "html", text: decode(bytes) }
  }
  if (formatId === BUILTIN_DOCUMENT_FORMATS.richText) {
    const blocks = JSON.parse(decode(bytes)) as unknown
    if (Array.isArray(blocks)) return { kind: "blocks", blocks }
  }
  throw new DocumentDiffError("This version has no readable text to compare")
}

/** Legacy snapshots store Doc text or blocks, or HTML Doc content with its HTML. */
function contentFromSnapshot(content: unknown): VersionContent {
  if (typeof content === "string") return { kind: "markdown", text: content }
  if (Array.isArray(content)) return { kind: "blocks", blocks: content }
  const html =
    content && typeof content === "object"
      ? (content as Record<string, unknown>)["html"]
      : undefined
  if (typeof html === "string") return { kind: "html", text: html }
  throw new DocumentDiffError("This version has no readable text to compare")
}

function generationBytes(
  generation: ReadDocumentGenerationV2Result
): Uint8Array | null {
  const entries = generation.authoredSource.entries
  if (generation.authoredSource.kind === "file") {
    return entries.length === 1 ? entries[0]!.bytes : null
  }
  if (generation.manifest.format.id === BUILTIN_DOCUMENT_FORMATS.html) {
    return entries.find((entry) => entry.path === "index.html")?.bytes ?? null
  }
  return null
}

function generationContent(
  generation: ReadDocumentGenerationV2Result
): VersionContent {
  const bytes = generationBytes(generation)
  if (!bytes) {
    throw new DocumentDiffError("This version has no readable text to compare")
  }
  return contentFromBytes(generation.manifest.format.id, bytes)
}

/** Docs compare as the Markdown that worktable_docs_read returns; HTML as source. */
async function projectText(content: VersionContent): Promise<string> {
  if (content.kind !== "blocks") return content.text
  return (
    (await blocksToMarkdownSafe(content.blocks)) ??
    `${JSON.stringify(content.blocks, null, 2)}\n`
  )
}

function assertSafeVersionId(ref: string): void {
  if (
    ref.length > 200 ||
    ref === "." ||
    ref === ".." ||
    /[/\\\0]/.test(ref)
  ) {
    throw new DocumentDiffError(
      `"${ref}" is not a revision or version id; use action versions to list version ids`
    )
  }
}

function notInHistory(ref: string): DocumentDiffError {
  return new DocumentDiffError(
    `${ref} is not in this document's version history (it may have been pruned). Use action versions and pass one of its version ids.`
  )
}

/** A stored state of the document: its format and exact source bytes. */
interface StoredSource {
  formatId: string
  bytes: Uint8Array
}

type SourceMatcher = (source: StoredSource) => Promise<boolean> | boolean

// Revision lookups hash every candidate, so stop after a bounded history.
const REVISION_SCAN_LIMIT = 500

interface HistoryReader {
  version(id: string): Promise<VersionContent | null>
  /** Newest stored state the matcher accepts, scanning a bounded history. */
  find(matches: SourceMatcher): Promise<StoredSource | null>
}

function historyFor(
  spaceId: string,
  handle: ResolvedDocumentHandle,
  storageV2: boolean
): HistoryReader {
  const workspaceRoot = getWorkspaceRoot()
  const formatId = handle.document.format.id
  const legacyKind =
    formatId === BUILTIN_DOCUMENT_FORMATS.html ? "widgets" : "docs"
  if (storageV2 && handle.identity === "durable") {
    return {
      async version(id) {
        if (DocumentGenerationIdSchema.safeParse(id).success) {
          const generation = await readDocumentGenerationV2({
            workspaceRoot,
            spaceId,
            documentId: handle.documentId,
            generationId: id,
          })
          if (generation) return generationContent(generation)
        }
        const legacy = await readCompatibleDocumentVersionV2({
          workspaceRoot,
          spaceId,
          documentId: handle.documentId,
          versionId: id,
          store: "legacy-v1",
          legacy: { kind: legacyKind, key: handle.document.path },
        })
        if (legacy?.store !== "legacy-v1") return null
        const after = legacy.snapshot["after"]
        return contentFromSnapshot(
          after && typeof after === "object"
            ? (after as Record<string, unknown>)["content"]
            : undefined
        )
      },
      async find(matches) {
        const manifests = await listDocumentGenerationsV2({
          workspaceRoot,
          spaceId,
          documentId: handle.documentId,
        })
        for (const manifest of manifests.slice(0, REVISION_SCAN_LIMIT)) {
          const generation = await readDocumentGenerationV2({
            workspaceRoot,
            spaceId,
            documentId: handle.documentId,
            generationId: manifest.id,
          })
          const bytes = generation ? generationBytes(generation) : null
          if (!bytes) continue
          const source = { formatId: manifest.format.id, bytes }
          if (await matches(source)) return source
        }
        return null
      },
    }
  }
  // Older storage and not-yet-registered documents keep history in the
  // Doc and HTML Doc version stores, which hold parsed content rather than
  // bytes; re-serialize it the way those stores write sources.
  const readSnapshot = (id: string) =>
    legacyKind === "docs"
      ? getDocVersion(spaceId, handle.document.path, id)
      : getWidgetVersion(spaceId, handle.document.path, id)
  return {
    async version(id) {
      const snapshot = await readSnapshot(id)
      return snapshot ? contentFromSnapshot(snapshot.after.content) : null
    },
    async find(matches) {
      const entries =
        legacyKind === "docs"
          ? await listDocVersions(spaceId, handle.document.path)
          : await listWidgetVersions(spaceId, handle.document.path)
      for (const entry of entries.slice(0, REVISION_SCAN_LIMIT)) {
        const snapshot = await readSnapshot(entry.id)
        if (!snapshot) continue
        const content = contentFromSnapshot(snapshot.after.content)
        const source: StoredSource =
          content.kind === "blocks"
            ? {
                formatId: BUILTIN_DOCUMENT_FORMATS.richText,
                bytes: new TextEncoder().encode(
                  JSON.stringify(content.blocks, null, 2)
                ),
              }
            : {
                formatId:
                  content.kind === "html"
                    ? BUILTIN_DOCUMENT_FORMATS.html
                    : BUILTIN_DOCUMENT_FORMATS.markdown,
                bytes: new TextEncoder().encode(content.text),
              }
        if (await matches(source)) return source
      }
      return null
    },
  }
}

const DOC_REVISION = /^(md|json):sha256:([0-9a-f]{64})$/

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** The Doc revision worktable_docs_read returns for a file source. */
function currentDocRevision(
  handle: ResolvedDocumentHandle,
  bytes: Uint8Array
): string | null {
  if (
    handle.source.kind !== "file" ||
    (handle.document.format.id !== BUILTIN_DOCUMENT_FORMATS.markdown &&
      handle.document.format.id !== BUILTIN_DOCUMENT_FORMATS.richText)
  ) {
    return null
  }
  return docRevisionId({
    relativePath: handle.source.relativePath,
    size: bytes.byteLength,
    sha256: sha256Hex(bytes),
  })
}

/**
 * Compare a document's readable text between two points in its history.
 * `from` and `to` accept a version id from action versions, a sourceRevision
 * (`rev_...`) from the document tools, or a Doc revision (`md:sha256:...`,
 * `json:sha256:...`) from the Doc tools. `to` defaults to the current source
 * and is reported in the same revision scheme as `from`.
 */
export async function diffDocumentText(options: {
  spaceId: string
  path: string
  from: string
  to?: string
  context?: number
}): Promise<DocumentDiffResult> {
  const context = Math.min(
    DOCUMENT_DIFF_MAX_CONTEXT,
    Math.max(0, options.context ?? DOCUMENT_DIFF_DEFAULT_CONTEXT)
  )
  const storageV2 =
    (await readWorkspaceStorageLayoutAt(getWorkspaceRoot())).kind === "v2"
  const resolution = await useResolvedDocumentHandle(
    { spaceId: options.spaceId, path: options.path, includeArchived: true },
    async (handle) => {
      const formatId = handle.document.format.id
      if (!TEXT_FORMATS.has(formatId)) {
        throw new DocumentDiffError(
          `Diff is not available for ${formatId} documents because they have no text projection`
        )
      }
      if (handle.document.health !== "supported") {
        throw new DocumentDiffError("Document source cannot be read")
      }
      const currentBytes = await readDocumentSource({
        spaceRoot: resolve(getWorkspaceRoot(), "spaces", options.spaceId),
        documentId: handle.documentId,
        format: handle.document.format,
        source: handle.source,
        maxBytes: DIFF_MAX_SOURCE_BYTES,
        signal: AbortSignal.timeout(DIFF_SOURCE_TIMEOUT_MS),
      })
      const currentRevision =
        handle.source.kind === "file"
          ? await registeredDocumentSourceRevision({
              documentId: handle.documentId,
              path: handle.document.path,
              format: handle.document.format,
              source: handle.source,
              bytes: currentBytes,
            })
          : null
      const docRevision = currentDocRevision(handle, currentBytes)
      const current = contentFromBytes(formatId, currentBytes)
      const history = historyFor(options.spaceId, handle, storageV2)
      // A sourceRevision hashes the document's identity with its exact bytes,
      // so only a stored state of the current format can reproduce it.
      const matchesSourceRevision =
        (ref: string): SourceMatcher =>
        async (source) =>
          source.formatId === formatId &&
          (await registeredDocumentSourceRevision({
            documentId: handle.documentId,
            path: handle.document.path,
            format: handle.document.format,
            source: handle.source,
            bytes: source.bytes,
          })) === ref
      // A Doc revision names the storage kind and hashes the stored bytes.
      const matchesDocRevision =
        (kind: string, sha256: string): SourceMatcher =>
        (source) =>
          source.formatId ===
            (kind === "md"
              ? BUILTIN_DOCUMENT_FORMATS.markdown
              : BUILTIN_DOCUMENT_FORMATS.richText) &&
          sha256Hex(source.bytes) === sha256
      const contentAt = async (ref: string): Promise<VersionContent> => {
        if (ref === currentRevision || ref === docRevision) return current
        const docRef = DOC_REVISION.exec(ref)
        if (ref.startsWith("rev_") || docRef) {
          const found = await history.find(
            docRef
              ? matchesDocRevision(docRef[1]!, docRef[2]!)
              : matchesSourceRevision(ref)
          )
          if (!found) throw notInHistory(`Revision ${ref}`)
          return contentFromBytes(found.formatId, found.bytes)
        }
        assertSafeVersionId(ref)
        const content = await history.version(ref)
        if (!content) throw notInHistory(`Version ${ref}`)
        return content
      }
      const currentLabel =
        (DOC_REVISION.test(options.from) ? docRevision : null) ??
        currentRevision ??
        "current"
      return {
        path: handle.document.path,
        from: await contentAt(options.from),
        to: options.to === undefined ? current : await contentAt(options.to),
        toLabel: options.to ?? currentLabel,
      }
    }
  )
  if (!("from" in resolution)) {
    throw new DocumentDiffError(
      resolution.kind === "not-found"
        ? "Document not found"
        : "Document path cannot be resolved"
    )
  }
  const diff = unifiedLineDiff({
    before: await projectText(resolution.from),
    after: await projectText(resolution.to),
    fromLabel: options.from,
    toLabel: resolution.toLabel,
    context,
    maxBytes: DIFF_MAX_OUTPUT_BYTES,
  })
  return {
    path: resolution.path,
    from: options.from,
    to: resolution.toLabel,
    unified: diff.unified,
    stats: { added: diff.added, removed: diff.removed },
    truncated: diff.truncated,
  }
}
