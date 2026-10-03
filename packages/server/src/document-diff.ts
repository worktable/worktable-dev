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
import { getDocVersion } from "./store.ts"
import {
  DOCUMENT_DIFF_DEFAULT_CONTEXT,
  DOCUMENT_DIFF_MAX_CONTEXT,
  unifiedLineDiff,
} from "./text-diff.ts"
import { getWidgetVersion } from "./widget-version-store.ts"
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

interface HistoryReader {
  version(id: string): Promise<VersionContent | null>
  revision(revision: string): Promise<VersionContent | null>
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
      // A source revision hashes the document's identity with its exact
      // bytes, so a stored generation of the same format reproduces it.
      async revision(revision) {
        const manifests = await listDocumentGenerationsV2({
          workspaceRoot,
          spaceId,
          documentId: handle.documentId,
        })
        for (const manifest of manifests) {
          if (manifest.format.id !== formatId) continue
          const generation = await readDocumentGenerationV2({
            workspaceRoot,
            spaceId,
            documentId: handle.documentId,
            generationId: manifest.id,
          })
          const bytes = generation ? generationBytes(generation) : null
          if (!bytes) continue
          const candidate = await registeredDocumentSourceRevision({
            documentId: handle.documentId,
            path: handle.document.path,
            format: handle.document.format,
            source: handle.source,
            bytes,
          })
          if (candidate === revision) return generationContent(generation!)
        }
        return null
      },
    }
  }
  // Older storage and not-yet-registered documents keep history in the
  // Doc and HTML Doc version stores, addressed by version id only.
  return {
    async version(id) {
      const snapshot =
        legacyKind === "docs"
          ? await getDocVersion(spaceId, handle.document.path, id)
          : await getWidgetVersion(spaceId, handle.document.path, id)
      return snapshot ? contentFromSnapshot(snapshot.after.content) : null
    },
    async revision() {
      return null
    },
  }
}

/**
 * Compare a document's readable text between two points in its history.
 * `from` and `to` accept a version id from action versions or a
 * sourceRevision returned by an earlier read or write; `to` defaults to the
 * current source.
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
      const current = contentFromBytes(formatId, currentBytes)
      const history = historyFor(options.spaceId, handle, storageV2)
      const contentAt = async (ref: string): Promise<VersionContent> => {
        if (ref === currentRevision) return current
        if (ref.startsWith("rev_")) {
          const content = await history.revision(ref)
          if (!content) throw notInHistory(`Revision ${ref}`)
          return content
        }
        assertSafeVersionId(ref)
        const content = await history.version(ref)
        if (!content) throw notInHistory(`Version ${ref}`)
        return content
      }
      return {
        path: handle.document.path,
        from: await contentAt(options.from),
        to: options.to === undefined ? current : await contentAt(options.to),
        toLabel: options.to ?? currentRevision ?? "current",
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
