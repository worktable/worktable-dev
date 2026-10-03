import { createHash } from "node:crypto"
import { resolve } from "node:path"
import {
  DocumentGenerationIdSchema,
  type DocumentFormatClaim,
  type DocumentGenerationManifestV2,
  type DocumentSource,
} from "@worktable/types"
import { useResolvedDocumentHandle, type ResolvedDocumentHandle } from "./document-query.ts"
import {
  BUILTIN_DOCUMENT_FORMATS,
  createBuiltinDocumentFormatRegistry,
} from "./document-format-registry.ts"
import { readDocumentSource } from "./document-source-reader.ts"
import {
  listDocumentGenerationsV2,
  readCompatibleDocumentVersionV2,
  readDocumentGenerationManifestV2,
  readDocumentGenerationSourceEntryV2,
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
// Resolving a revision hashes stored states newest first; stop at whichever
// bound comes first and report the revision as not found.
const LOOKUP_MAX_VERSIONS = 200
const LOOKUP_MAX_BYTES = 64 * 1024 * 1024
const LOOKUP_TIMEOUT_MS = 10_000

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

/** The authored entry holding a generation's readable source, if any. */
function sourceEntryPath(manifest: DocumentGenerationManifestV2): string | null {
  const entries = manifest.authoredSource.entries
  if (manifest.authoredSource.kind === "file") return entries[0]!.path
  return manifest.format.id === BUILTIN_DOCUMENT_FORMATS.html &&
    entries.some((entry) => entry.path === "index.html")
    ? "index.html"
    : null
}

function tooLarge(): DocumentDiffError {
  return new DocumentDiffError(
    "This version is too large to compare; diff a smaller range of versions or read it directly"
  )
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

/** A stored state of the document, read lazily. */
interface HistoryCandidate {
  format: DocumentFormatClaim
  /** The document's logical path when this state was stored. */
  logicalPath: string
  /** Size of the stored source, when known before reading it. */
  size?: number
  /** SHA-256 (hex) of the stored source, when recorded without reading it. */
  sha256?: string
  /** The sourceRevision an agent write recorded for this state. */
  recordedRevision?: string
  /** The exact stored source, or null when it exceeds the size budget. */
  bytes(): Promise<Uint8Array | null>
}

type CandidateMatcher = (
  candidate: HistoryCandidate,
  budget: LookupBudget
) => Promise<boolean> | boolean

class LookupBudget {
  readonly #deadline = performance.now() + LOOKUP_TIMEOUT_MS
  #remainingBytes = LOOKUP_MAX_BYTES

  get expired(): boolean {
    return performance.now() > this.#deadline || this.#remainingBytes <= 0
  }

  /** Reserve bytes to read for hashing; false once the budget is spent. */
  take(bytes: number): boolean {
    if (bytes > this.#remainingBytes) {
      this.#remainingBytes = 0
      return false
    }
    this.#remainingBytes -= bytes
    return true
  }
}

interface HistoryReader {
  version(id: string): Promise<VersionContent | null>
  /** Newest stored state the matcher accepts, within the lookup bounds. */
  find(matches: CandidateMatcher): Promise<VersionContent | null>
}

async function firstMatch(
  candidates: AsyncIterable<HistoryCandidate>,
  matches: CandidateMatcher
): Promise<VersionContent | null> {
  const budget = new LookupBudget()
  let examined = 0
  for await (const candidate of candidates) {
    if (examined >= LOOKUP_MAX_VERSIONS || budget.expired) return null
    examined += 1
    if (await matches(candidate, budget)) {
      const bytes = await candidate.bytes()
      if (!bytes) throw tooLarge()
      return contentFromBytes(candidate.format.id, bytes)
    }
  }
  return null
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
    // Only the authored source entry is read, never companions, and only
    // within the same size budget as the current source.
    const candidate = (
      manifest: DocumentGenerationManifestV2
    ): HistoryCandidate | null => {
      const entryPath = sourceEntryPath(manifest)
      const entry = manifest.authoredSource.entries.find(
        (item) => item.path === entryPath
      )
      if (!entryPath || !entry) return null
      return {
        format: manifest.format,
        logicalPath: manifest.logicalPath,
        size: entry.bytes,
        sha256: entry.sha256,
        ...(manifest.agentMutation
          ? { recordedRevision: manifest.agentMutation.sourceRevision }
          : {}),
        bytes: () =>
          readDocumentGenerationSourceEntryV2({
            workspaceRoot,
            manifest,
            entryPath,
            maxBytes: DIFF_MAX_SOURCE_BYTES,
          }),
      }
    }
    return {
      async version(id) {
        if (DocumentGenerationIdSchema.safeParse(id).success) {
          const manifest = await readDocumentGenerationManifestV2({
            workspaceRoot,
            spaceId,
            documentId: handle.documentId,
            generationId: id,
          })
          if (manifest) {
            const stored = candidate(manifest)
            if (!stored) {
              throw new DocumentDiffError(
                "This version has no readable text to compare"
              )
            }
            const bytes = await stored.bytes()
            if (!bytes) throw tooLarge()
            return contentFromBytes(manifest.format.id, bytes)
          }
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
        // Manifests are small; payloads are read only for candidates the
        // matcher cannot decide from recorded hashes.
        const manifests = await listDocumentGenerationsV2({
          workspaceRoot,
          spaceId,
          documentId: handle.documentId,
        })
        return firstMatch(
          (async function* () {
            for (const manifest of manifests) {
              const stored = candidate(manifest)
              if (stored) yield stored
            }
          })(),
          matches
        )
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
      return firstMatch(
        (async function* () {
          for (const entry of entries) {
            const snapshot = await readSnapshot(entry.id)
            if (!snapshot) continue
            const content = contentFromSnapshot(snapshot.after.content)
            const bytes = new TextEncoder().encode(
              content.kind === "blocks"
                ? JSON.stringify(content.blocks, null, 2)
                : content.text
            )
            yield {
              format: {
                id:
                  content.kind === "blocks"
                    ? BUILTIN_DOCUMENT_FORMATS.richText
                    : content.kind === "html"
                      ? BUILTIN_DOCUMENT_FORMATS.html
                      : BUILTIN_DOCUMENT_FORMATS.markdown,
                sourceVersion: 1,
              },
              logicalPath: handle.document.path,
              bytes: async () =>
                bytes.byteLength > DIFF_MAX_SOURCE_BYTES ? null : bytes,
            } satisfies HistoryCandidate
          }
        })(),
        matches
      )
    },
  }
}

const builtinFormats = createBuiltinDocumentFormatRegistry()

/**
 * Source locators a stored state may have had: the current one when the path
 * and format are unchanged, and the canonical file for its logical path and
 * format, which covers states from before a move or a Doc storage change.
 */
function historicalSources(
  handle: ResolvedDocumentHandle,
  candidate: HistoryCandidate
): DocumentSource[] {
  const sources: DocumentSource[] = []
  if (
    candidate.logicalPath === handle.document.path &&
    candidate.format.id === handle.document.format.id &&
    candidate.format.sourceVersion === handle.document.format.sourceVersion
  ) {
    sources.push(handle.source)
  }
  const extension = builtinFormats.fileSource(candidate.format)?.source.extension
  if (extension) {
    const relativePath = `docs/${candidate.logicalPath}${extension}`
    if (
      !sources.some(
        (source) => source.kind === "file" && source.relativePath === relativePath
      )
    ) {
      sources.push({ kind: "file", relativePath })
    }
  }
  return sources
}

const DOC_REVISION = /^(md|json):sha256:([0-9a-f]{64})$/

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/**
 * A Doc revision names the storage kind and hashes the stored bytes; stored
 * versions record that hash, so most candidates need no read.
 */
function matchesDocRevision(kind: string, sha256: string): CandidateMatcher {
  return async (candidate, budget) => {
    const expectedFormat =
      kind === "md"
        ? BUILTIN_DOCUMENT_FORMATS.markdown
        : BUILTIN_DOCUMENT_FORMATS.richText
    if (candidate.format.id !== expectedFormat) return false
    if (candidate.sha256 !== undefined) return candidate.sha256 === sha256
    const bytes = await candidate.bytes()
    return (
      bytes !== null &&
      budget.take(bytes.byteLength) &&
      sha256Hex(bytes) === sha256
    )
  }
}

/**
 * The blocks a rich Doc had at a Doc revision (`json:sha256:…`), looked up in
 * its retained history within the same bounds as diff. Null when the revision
 * is not a rich Doc revision or is no longer in history.
 */
export async function docBlocksAtRevision(options: {
  spaceId: string
  path: string
  revision: string
}): Promise<unknown[] | null> {
  const docRef = DOC_REVISION.exec(options.revision)
  if (!docRef || docRef[1] !== "json") return null
  const storageV2 =
    (await readWorkspaceStorageLayoutAt(getWorkspaceRoot())).kind === "v2"
  try {
    const resolution = await useResolvedDocumentHandle(
      { spaceId: options.spaceId, path: options.path, includeArchived: true },
      async (handle) => ({
        content: await historyFor(options.spaceId, handle, storageV2).find(
          matchesDocRevision(docRef[1]!, docRef[2]!)
        ),
      })
    )
    return "content" in resolution && resolution.content?.kind === "blocks"
      ? resolution.content.blocks
      : null
  } catch (error) {
    if (error instanceof DocumentDiffError) return null
    throw error
  }
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
      // A sourceRevision hashes the document's identity at the time (path,
      // format and source locator) with its exact bytes, so rebuild that
      // identity from each stored state rather than the current one.
      const matchesSourceRevision =
        (ref: string): CandidateMatcher =>
        async (candidate, budget) => {
          if (candidate.recordedRevision === ref) return true
          if (candidate.size !== undefined && !budget.take(candidate.size)) {
            return false
          }
          const bytes = await candidate.bytes()
          if (!bytes || (candidate.size === undefined && !budget.take(bytes.byteLength))) {
            return false
          }
          for (const source of historicalSources(handle, candidate)) {
            const revision = await registeredDocumentSourceRevision({
              documentId: handle.documentId,
              path: candidate.logicalPath,
              format: candidate.format,
              source,
              bytes,
            })
            if (revision === ref) return true
          }
          return false
        }
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
          return found
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
