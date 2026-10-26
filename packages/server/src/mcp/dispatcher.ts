import { runAsActivityActor } from "../activity-log.ts"
import { commentReplier, commentRecipients } from "../comment-recipients.ts"
import { markOpened, readPending } from "../pending-read.ts"
import { reservedAnnotationInput } from "../annotation-origin.ts"
import { assertCurrentTeamIdentity, assertSpaceAccess, currentRequestIdentity } from "../team-policy.ts"
import {
  renderDocumentPreview,
  renderFrozenHtmlPreview,
  previewFailure,
} from "../document-preview-service.ts"
import {
  applyLifetimeOnCreate,
  lifetimeCreateError,
  setDocumentFolderLifetime,
  setDocumentLifetime,
  type DocumentLifetimeChange,
} from "../document-lifetime.ts"
import { resolveStartHere, setStartHere } from "../space-start-here.ts"
import {
  freezeHtmlPreviewSnapshotLocked,
  freezeSavedHtmlPreviewSnapshotLocked,
  type HtmlPreviewSnapshot,
} from "../html-preview.ts"
import type { DocumentPreviewOptions } from "@worktable/types"
import { dispatchDrawingOperation } from "./drawings.ts"
import { DRAWING_GUIDE } from "./drawing-guide.ts"
// ============================================================
// Worktable MCP operation dispatcher. Public capability tools adapt to these
// transport-agnostic operation ids in tools.ts.
// ============================================================

import {
  listSpaces,
  mutateSpace,
  nextSpaceColor,
  readSpace,
  setSpaceArchived,
  writeSpace,
  slugify,
  deduplicateSlug,
  occupiedSpaceIds,
  listDocsDetailed,
  readDoc,
  readDocSourceSnapshot,
  type DocSourceRevision,
  type DocWriteOptions,
  type DocWriteResult,
  sanitizeDocPath,
  writeDoc,
  deleteDoc,
  docExists,
  docStat,
  getDocArchiveInfo,
  getDocLifetimeView,
  getDocProvenance,
  getSpaceArchiveInfo,
} from "../store.ts"
import {
  ensureWorkspaceManifest,
  workspaceProvenanceMode,
} from "../workspace.ts"
import {
  listWidgets,
  readWidget,
  readWidgetDocument,
  setWidgetArchived,
  updateWidgetMetadata,
  withWidgetReadLock,
  withWidgetWriteLock,
  writeWidget,
} from "../widget-store.ts"
import {
  captureWidgetVersionContent,
  recordWidgetVersion,
} from "../widget-version-store.ts"
import { deleteHtmlDocument } from "../html-document-delete.ts"
import { moveHtmlDocument } from "../html-document-move.ts"
import { createHtmlDocument } from "../html-document-create.ts"
import { withCanonicalHtmlDocumentPath } from "../html-document-path.ts"
import {
  buildRecordCollectionSchema,
  checkRecordData,
  undeclaredFieldsError,
  createRecord,
  deleteRecord,
  findRecordBounded,
  getRecordDiagnostics,
  listRecordCollections,
  queryRecords,
  readRecord,
  readRecordCollectionSchema,
  updateRecord,
  writeRecordCollectionSchema,
} from "../record-store.ts"
import {
  buildWidgetFile,
  getHtmlAuthoringGuide,
  getBlockingWidgetIssue,
  validateWidgetHtml,
  WIDGET_STYLE_TOKENS,
} from "../widget-authoring.ts"
import {
  authorizeHtmlPermissions,
  NETWORK_REQUEST_WARNING,
} from "../html-permission-authority.ts"
import {
  CanonicalIdSchema,
  DOCUMENT_LIFETIME_REQUIRED_MESSAGE,
  WidgetIdSchema,
  type AnnotationAuthor,
  type DocumentLifetime,
  type StartHerePin,
  type RecordCollectionSchema,
  type SpaceFile,
  type WidgetFile,
} from "@worktable/types"
import {
  htmlDocumentLifetimeV2,
  isHtmlDocumentPath,
  usesHtmlDocumentStorageV2,
} from "../html-document-storage-v2.ts"
import { DEFAULT_AGENT_PRINCIPAL } from "./helpers.ts"
import {
  noteAgentCallForSetup,
  noteAgentPairedForSetup,
  setupKeyForIdentity,
} from "../personal-setup.ts"
import {
  listDocumentLifetimeTargetsLocked,
  listDocuments,
  readDocument,
  readDocumentCatalogSnapshot,
  type DocumentLifetimeTarget,
} from "../document-query.ts"
import { readDocumentVersions } from "../document-page-service.ts"
import { randomUUID } from "node:crypto"
import { diffDocumentText, docBlocksAtRevision } from "../document-diff.ts"
import {
  canonicalizeBlocks,
  canonicalizeBlocksForWrite,
  inheritBlockIds,
  unknownPropKeys,
} from "../blocknote.ts"
import {
  narrowRegions,
  rebaseRegions,
  type BlockRegion,
  type RebaseResult,
} from "../block-regions.ts"
import { compilePathGlob } from "../path-glob.ts"
import {
  checkpointRegisteredDocument,
  createRegisteredDocument,
  deleteRegisteredDocument,
  moveRegisteredDocument,
  readRegisteredDocumentSource,
  replaceRegisteredDocument,
  restoreRegisteredDocumentVersion,
  setRegisteredDocumentArchived,
} from "../document-write-service.ts"
import {
  hasScope,
  type RequestPrincipal,
  type TokenIdentity,
} from "../token-store.ts"
import { resolveDocAlias } from "../doc-aliases.ts"
import { withDocPathLock } from "../doc-path-lock.ts"
import {
  MermaidDocumentValidationError,
  extractMarkdownMermaid,
  repairEscapedMermaidFences,
} from "../mermaid-document.ts"
import type { MermaidDocumentRepair, PassageSelector } from "@worktable/types"
import {
  locateMarkdownPassage,
  markdownReadingText,
} from "../markdown-passage.ts"
import type { McpSurface } from "./surface.ts"
import {
  DELIMITED_NAME,
  delimitedChanges,
  readableFileSource,
} from "./file-results.ts"
import { withResultMedia } from "./media.ts"
import { filesPreviewEnabled } from "../files-preview.ts"
import { fileDownloadLink, fileUploadLink } from "./file-links.ts"
import {
  FILE_UPLOAD_MAX_BYTES,
  namesAFile,
  writeUploadedFile,
  type FileUploadMode,
} from "../file-uploads.ts"
import { fetchChatGptFile, type ChatGptFile } from "./chatgpt-files.ts"
import { analyzeDocumentPath } from "../document-path.ts"
import {
  importIntoRecords,
  proposeImport,
  type ImportColumn,
} from "../records-import.ts"
import { keepEarlierImagesAfterRestore } from "../file-history.ts"
import { BUILTIN_DOCUMENT_FORMATS } from "../document-format-registry.ts"
import {
  logRecordPracticeWarnings,
  recordPracticeIdentitiesMatch,
  recordPracticeIdentity,
  reviewRecordCreate,
  reviewRecordSchema,
} from "./record-practices.ts"
import {
  OPERATION_DEFINITIONS,
  PREVIEW_OPERATIONS,
  type OperationId,
} from "./operations.ts"
import {
  searchWithStatus,
  invalidateSearchIndex,
  noteRecordMutated,
} from "../search-index.ts"
import { decorateDocsWithBacklinkCounts, getDocLinks } from "../link-graph.ts"
import {
  countMarkdownLines,
  docMarkdownProjection,
  docRevisionId,
  grepDocs,
  sliceMarkdownLines,
  validateGrepPattern,
} from "../doc-markdown-projection.ts"
import { buildSpaceIndex } from "../space-index.ts"
import {
  validateDocConventions,
  type DocConventionIssue,
} from "../doc-conventions.ts"
import { yjsManager } from "../yjs-manager.ts"
import { renameDocAndSync } from "../doc-rename.ts"
import { moveDocumentFolder } from "../document-folder-move.ts"
import { setDocumentFolderArchived } from "../document-folder-archive.ts"
import { deleteDocumentFolder } from "../document-folder-delete.ts"
import { wsManager } from "../ws.ts"
import { docSnapshotRevision } from "../document-content-revision.ts"
import { FORMAT_SPEC } from "./format-spec.ts"
import { withPreviewToolNames } from "./preview-names.ts"
import {
  isMarkdownSafe,
  extractMarkdownHeadings,
  extractHeadings,
  containsMermaidBlock,
  getRichBlockTypes,
} from "../markdown.ts"
import {
  DocEditError,
  applyTextEdits,
  blocksPlainText,
  editSnippet,
  projectBlocks,
  regionSnippet,
  spliceBlockEdits,
  spliceBlockReplacement,
  type FormattingDrop,
  type TextEdit,
} from "../markdown-edit.ts"
import { previewMermaid, validateMermaid } from "../mermaid.ts"
import {
  createAnnotation,
  getAnnotationContext,
  listAnnotations,
  readAnnotation,
  replyAnnotation,
  resolveAnnotation,
  updateAnnotation,
} from "../annotation-store.ts"
import {
  DEFAULT_ICON,
  SpaceIndexInput,
  ListAnnotationsInput,
  ReadAnnotationInput,
  CreateAnnotationInput,
  CreateAnnotationInputPreview,
  PendingInput,
  ReplyAnnotationInput,
  ReplyAnnotationInputPreview,
  UpdateAnnotationInput,
  ResolveAnnotationInput,
  GetAnnotationContextInput,
  ListThreadsInput,
  ReadThreadInput,
  ReadThreadMessageInput,
  WaitThreadInput,
  PostThreadInput,
  PostThreadInputPreview,
  RenameThreadInput,
  AssignResponseRequestInput,
  ClaimThreadDeliveryInput,
  AcceptThreadDeliveryInput,
  ProgressThreadDeliveryInput,
  FailThreadDeliveryInput,
  GrepDocsInput,
  MoveDocumentFolderInput,
  ArchiveDocumentFolderInput,
  RestoreDocumentFolderInput,
  DeleteDocumentFolderInput,
  RECORD_BATCH_LIMIT,
} from "./schemas.ts"

import { ensureParticipant, resolveParticipant } from "../participant-store.ts"
import {
  acceptDelivery,
  assignResponseRequest,
  claimNextThreadDelivery,
  failDelivery,
  listThreadParticipants,
  listThreadSummaries,
  postThreadMessage,
  renameThreadTitle,
  progressDelivery,
  readThreadMessages,
  readThreadMessage,
  waitForThreadReply,
  type ThreadProgressUpdate,
} from "../thread-service.ts"

function decodeGenericDocumentSource(
  source: string,
  encoding: "utf8" | "base64"
): Uint8Array {
  if (encoding === "utf8") return new TextEncoder().encode(source)
  const normalized = source.replace(/=+$/u, "")
  const bytes = Buffer.from(source, "base64")
  if (bytes.toString("base64").replace(/=+$/u, "") !== normalized) {
    throw new Error("Document source is not valid base64")
  }
  return bytes
}

function buildBlockDocMetadata(blocks: unknown[]) {
  const lossyFields = isMarkdownSafe(blocks).lossyFields
  return {
    headings: extractHeadings(blocks),
    blockCount: blocks.length,
    lossyFields,
    note:
      lossyFields.length > 0
        ? `This Doc has formatting Markdown cannot show (${lossyFields.join(", ")}). Edit it with action edit: formatting outside the text you change is kept.`
        : "Edit it with action edit: formatting outside the text you change is kept.",
    richBlockTypes: getRichBlockTypes(blocks),
    containsMermaid: containsMermaidBlock(blocks),
  }
}

function buildMarkdownDocMetadata(markdown: string) {
  return {
    headings: extractMarkdownHeadings(markdown),
    blockCount: null,
    lossyFields: [] as string[],
    richBlockTypes: [] as string[],
    containsMermaid: extractMarkdownMermaid(markdown).length > 0,
  }
}

/**
 * Current source of a Doc with its revision. Refuses a stale
 * `expectedRevision`, and a missing one when `required`.
 */
async function docSourceAtRevision(
  spaceId: string,
  docPath: string,
  expectedRevision: string | undefined,
  required: boolean
) {
  const snapshot = await readDocSourceSnapshot(spaceId, docPath)
  if (
    snapshot.result.error ||
    snapshot.result.data === null ||
    !snapshot.revision
  ) {
    throw new Error(snapshot.result.error ?? "Failed to read document")
  }
  const revision = docRevisionId(snapshot.revision)
  if (required && !expectedRevision) {
    throw new DocEditError(
      "revision_required",
      `${docPath} already exists. Read it and pass its revision as expectedRevision to replace it, or use action edit to change part of it.`
    )
  }
  if (expectedRevision && expectedRevision !== revision) {
    throw new DocEditError(
      "revision_conflict",
      `${docPath} changed since revision ${expectedRevision}. Read it again and reapply your change.`,
      { currentRevision: revision }
    )
  }
  return { snapshot, sourceRevision: snapshot.revision, revision }
}

/**
 * What an agent's edit or write of an existing Doc applies to, with the
 * current source revision.
 *
 * Without `expectedRevision` the change matches the current content: what
 * people see now when the Doc is open in Worktable, else the stored source.
 * With it, the change matches the content at that revision: the stored
 * source when it is still at that revision; otherwise, while the Doc is open
 * (where people's typing moves the revision on), the stored version with
 * that revision. A Doc that is not open must still be at `expectedRevision`.
 * Whether the open Doc's blocks the change replaces are still as they were
 * is checked when it commits (`commitAgentBlocks`).
 */
export async function agentChangeBase(
  spaceId: string,
  docPath: string,
  expectedRevision: string | undefined,
  required: boolean
) {
  const snapshot = await readDocSourceSnapshot(spaceId, docPath)
  if (
    snapshot.result.error ||
    snapshot.result.data === null ||
    !snapshot.revision
  ) {
    throw new Error(snapshot.result.error ?? "Failed to read document")
  }
  const revision = docRevisionId(snapshot.revision)
  if (required && !expectedRevision) {
    throw new DocEditError(
      "revision_required",
      `${docPath} already exists. Read it and pass its revision as expectedRevision to replace it, or use action edit to change part of it.`
    )
  }
  const stored = snapshot.result.data
  const live = Array.isArray(stored)
    ? await yjsManager.liveBlocks(spaceId, docPath)
    : null
  let base: unknown[] | string | null = null
  if (!expectedRevision) {
    base = live ?? stored
  } else if (expectedRevision === revision) {
    base = stored
  } else if (live) {
    base = await docBlocksAtRevision({
      spaceId,
      path: docPath,
      revision: expectedRevision,
    })
  }
  if (base === null) {
    throw new DocEditError(
      "revision_conflict",
      `${docPath} changed since revision ${expectedRevision}. Read it again and reapply your change.`,
      { currentRevision: revision }
    )
  }
  const baseIsSource = base === stored
  // Blocks match the open Doc by id; give id-less legacy blocks the ids the
  // session gave them.
  if (live && Array.isArray(base)) base = inheritBlockIds(base, live)
  return {
    snapshot,
    sourceRevision: snapshot.revision,
    revision,
    base,
    baseIsSource,
  }
}

/** Blocks by id, as JSON of their canonical form. */
async function canonicalById(blocks: unknown[]): Promise<Map<string, string>> {
  let canonical: unknown[]
  try {
    canonical = await canonicalizeBlocks(blocks)
  } catch {
    canonical = blocks
  }
  return new Map(
    (canonical as Array<Record<string, unknown>>).map((block) => [
      String(block?.["id"]),
      JSON.stringify(block),
    ])
  )
}

/**
 * Write the blocks of an agent's change to a rich Doc.
 *
 * `blocks` is `base` with the change applied, and `regions` the top-level
 * blocks of `base` it replaced. When `base` is the stored source at
 * `sourceRevision` and the Doc is not open, `blocks` is written as is.
 * Otherwise the change is applied to the current blocks at commit time —
 * what people see when the Doc is open, else the stored source: the blocks
 * it replaces must still be as they were in `base` (else revision_conflict)
 * and every other block is written as it is now. An open Doc's session
 * receives only the replaced blocks. Nested changes replace their top-level
 * block.
 */
export async function commitAgentBlocks(input: {
  spaceId: string
  docPath: string
  base: unknown[]
  baseIsSource: boolean
  blocks: unknown[]
  regions: ReadonlyArray<{
    replacedBlockIds: readonly string[]
    blocks: readonly unknown[]
    followingBlockId?: string
  }>
  sourceRevision: DocSourceRevision
  writeOptions: Omit<DocWriteOptions, "sourceRevision">
}): Promise<DocWriteResult> {
  const { spaceId, docPath, base } = input
  let regions: BlockRegion[] | null
  try {
    regions = narrowRegions(
      base as Array<Record<string, unknown>>,
      input.regions as Parameters<typeof narrowRegions>[1]
    )
  } catch {
    // Blocks without ids cannot be applied by block; a session that opens
    // meanwhile receives the whole document.
    regions = null
  }
  return yjsManager.commitAgentWrite(spaceId, docPath, regions, async (live) => {
    if (!live && input.baseIsSource) {
      return writeDoc(spaceId, docPath, input.blocks, {
        ...input.writeOptions,
        sourceRevision: input.sourceRevision,
      })
    }
    const current = await readDocSourceSnapshot(spaceId, docPath)
    if (!current.revision) {
      throw new Error(current.result.error ?? "Failed to read document")
    }
    const target = live ?? current.result.data
    let rebased: RebaseResult = { ok: false, reason: "its blocks have no ids" }
    if (!Array.isArray(target)) {
      rebased = { ok: false, reason: "it is no longer a rich Doc" }
    } else if (regions) {
      // Compare blocks in canonical form; live blocks already are.
      const before = await canonicalById(base)
      const now = live ? undefined : await canonicalById(target)
      rebased = rebaseRegions(target as Array<Record<string, unknown>>, regions, (block) => {
        const id = String(block["id"])
        return before.get(id) === (now ? now.get(id) : JSON.stringify(block))
      })
    }
    if (!rebased.ok) {
      throw new DocEditError(
        "revision_conflict",
        `${docPath} changed where this change applies: ${rebased.reason}. Read it again and reapply your change.`,
        {
          currentRevision: docRevisionId(current.revision),
          ...(rebased.blockId ? { blockId: rebased.blockId } : {}),
        }
      )
    }
    const blocks =
      live && Array.isArray(current.result.data)
        ? await keepStoredProps(rebased.blocks, current.result.data, regions!)
        : rebased.blocks
    return writeDoc(spaceId, docPath, blocks, {
      ...input.writeOptions,
      sourceRevision: current.revision,
    })
  })
}

function hasUnknownProps(block: unknown): boolean {
  const children = (block as { children?: unknown })?.children
  return (
    unknownPropKeys(block).length > 0 ||
    (Array.isArray(children) && children.some(hasUnknownProps))
  )
}

/**
 * The open Doc cannot hold block props the schema does not define. Write the
 * stored block instead of the live one for every block the change leaves
 * alone that only differs by those props.
 */
async function keepStoredProps(
  blocks: Array<Record<string, unknown>>,
  stored: unknown[],
  regions: readonly BlockRegion[]
): Promise<Array<Record<string, unknown>>> {
  const withProps = (stored as Array<Record<string, unknown>>).filter(hasUnknownProps)
  if (withProps.length === 0) return blocks
  const changed = new Set(
    regions.flatMap((region) => region.blocks.map((block) => block["id"]))
  )
  const storedById = new Map(withProps.map((block) => [block["id"], block]))
  const canonical = await canonicalById(withProps)
  return blocks.map((block) => {
    const id = block["id"]
    const original = storedById.get(id)
    return original &&
      !changed.has(id) &&
      canonical.get(String(id)) === JSON.stringify(block)
      ? original
      : block
  })
}

/** The Doc's current revision, or null when it no longer exists. */
async function currentDocRevision(
  spaceId: string,
  docPath: string
): Promise<string | null> {
  const snapshot = await readDocSourceSnapshot(spaceId, docPath)
  return snapshot.revision ? docRevisionId(snapshot.revision) : null
}

/** The revision a successful write committed, never a later re-read. */
function committedDocRevision(result: { revision?: DocSourceRevision }): string {
  if (!result.revision) throw new Error("Write did not report its revision")
  return docRevisionId(result.revision)
}

/** A failed guarded write: a concurrent change is a revision conflict. */
async function docWriteFailure(
  spaceId: string,
  docPath: string,
  result: { error?: string; errorCode?: string }
): Promise<Error> {
  if (result.errorCode === "SOURCE_CHANGED") {
    return new DocEditError(
      "revision_conflict",
      `${docPath} changed while this write was being applied. Read it again and reapply your change.`,
      { currentRevision: await currentDocRevision(spaceId, docPath) }
    )
  }
  return new Error(result.error ?? "Write failed")
}

function parseTextEdits(raw: unknown): TextEdit[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("edits must contain at least one { oldText, newText }")
  }
  return raw.map((value, index) => {
    const edit = value as Partial<TextEdit> | null
    if (
      !edit ||
      typeof edit.oldText !== "string" ||
      typeof edit.newText !== "string"
    ) {
      throw new Error(`Edit ${index + 1} needs string oldText and newText`)
    }
    return {
      oldText: edit.oldText,
      newText: edit.newText,
      replaceAll: edit.replaceAll === true,
    }
  })
}

/**
 * Repair over-escaped Mermaid fences in replacement text, as whole writes do.
 * Only replacement text is touched; the rest of the document is not.
 */
function repairEditTexts(edits: TextEdit[]): {
  edits: TextEdit[]
  repairs: Array<MermaidDocumentRepair & { editIndex: number }>
} {
  const repairs: Array<MermaidDocumentRepair & { editIndex: number }> = []
  const repaired = edits.map((edit, editIndex) => {
    const result = repairEscapedMermaidFences(edit.newText)
    if (result.issues.length > 0) {
      throw new MermaidDocumentValidationError(result.issues)
    }
    repairs.push(...result.repairs.map((repair) => ({ ...repair, editIndex })))
    return { ...edit, newText: result.markdown }
  })
  return { edits: repaired, repairs }
}

/**
 * Open annotations whose anchored text an edit changed or removed. `affected`
 * returns null for an untouched annotation, else whether its quote survives.
 */
async function annotationsAffectedByEdit(
  spaceId: string,
  docPath: string,
  affected: (target: {
    blockId?: string
    quote?: string
    prefix?: string
    suffix?: string
  }) => boolean | null
): Promise<Array<{ annotationId: string; quoteStillPresent: boolean }>> {
  try {
    const annotations = []
    for (let offset: number | undefined = 0; offset !== undefined; ) {
      const page = await listAnnotations(spaceId, {
        target: { docPath },
        limit: 1000,
        offset,
      })
      annotations.push(...page.annotations)
      offset = page.nextOffset
    }
    return annotations.flatMap((annotation) => {
      const target = annotation.target as {
        blockId?: string
        quote?: string
        prefix?: string
        suffix?: string
      }
      const quoteStillPresent = affected(target)
      return quoteStillPresent === null
        ? []
        : [{ annotationId: annotation.id, quoteStillPresent }]
    })
  } catch {
    // Reporting must never fail a successful edit.
    return []
  }
}

/** Blocks with a fresh id wherever one is missing. */
function withBlockIds(blocks: unknown[]): unknown[] {
  return blocks.map((value) => {
    if (!value || typeof value !== "object") return value
    const block = value as { id?: unknown; children?: unknown }
    return {
      ...block,
      id: typeof block.id === "string" ? block.id : randomUUID(),
      ...(Array.isArray(block.children)
        ? { children: withBlockIds(block.children) }
        : {}),
    }
  })
}

function blocksById(blocks: unknown[]): Map<string, unknown> {
  const byId = new Map<string, unknown>()
  const walk = (values: unknown[]) => {
    for (const value of values) {
      const block = value as { id?: unknown; children?: unknown }
      if (typeof block?.id === "string") byId.set(block.id, block)
      if (Array.isArray(block?.children)) walk(block.children)
    }
  }
  walk(blocks)
  return byId
}

/**
 * Convention guidance computed on the doc's final written state. Warnings
 * only — agents are guided, never blocked (humans via the UI skip this
 * path entirely). Mirrors the widget-validation result shape.
 */
async function docWriteWarnings(
  spaceId: string,
  docPath: string
): Promise<DocConventionIssue[]> {
  try {
    const doc = await readDoc(spaceId, docPath)
    if (doc.error || doc.data === null) return []
    const { links } = await getDocLinks(spaceId, docPath)
    return validateDocConventions({
      content: doc.data as string | unknown[],
      links,
    })
  } catch {
    // Guidance must never fail a successful write.
    return []
  }
}

/**
 * Announce a committed tool write. An open Doc has already received it from
 * commitAgentBlocks.
 */
export async function syncDocAfterToolWrite(
  spaceId: string,
  docPath: string
): Promise<void> {
  invalidateSearchIndex({ spaceId, path: docPath })

  const snapshot = await readDocSourceSnapshot(spaceId, docPath)
  const statResult = await docStat(spaceId, docPath)
  const provenance = await getDocProvenance(spaceId, docPath)
  // The app keeps this content under its revision.
  const revision = docSnapshotRevision(snapshot)
  wsManager.broadcast(spaceId, {
    type: "doc_update",
    spaceId,
    docPath,
    data: {
      path: docPath,
      content: snapshot.result.data,
      format: snapshot.result.format,
      updatedAt: statResult?.updatedAt ?? Date.now(),
      provenance,
      ...(revision ? { revision } : {}),
    },
  })
}

const LIST_PAGE_SIZE = 200
/** Records an MCP query returns when the agent sets no limit. */
const MCP_DEFAULT_RECORD_PAGE = 100

function normalizePathPrefix(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "")
  return trimmed.length > 0 ? trimmed : undefined
}

function decodeListCursor(value: unknown): number {
  if (value === undefined) return 0
  const offset = typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error("cursor is invalid; pass the nextCursor from a previous page")
  }
  return offset
}

/** Reject an archive date that would not take effect before writing anything. */
function assertLifetimeInput(args: Record<string, unknown>): void {
  const error = lifetimeCreateError(
    args["lifetime"] as DocumentLifetime | undefined,
    args["archiveOn"] as string | undefined
  )
  if (error) throw new Error(error)
}

function lifetimeChange(args: Record<string, unknown>): DocumentLifetimeChange {
  const archiveOn = args["archiveOn"] as string | undefined
  return {
    lifetime: args["lifetime"] as DocumentLifetime,
    ...(archiveOn ? { archiveOn } : {}),
  }
}

/**
 * An HTML Doc's lifetime as document reads report it. HTML Docs already carry
 * their own createdAt, so only the lifetime fields are added.
 */
function htmlLifetime(
  targets: readonly DocumentLifetimeTarget[],
  path: string
): Pick<DocumentLifetimeTarget["view"], "lifetime" | "archiveOn"> {
  const view = targets.find((target) => target.path === path)?.view
  return {
    ...(view?.lifetime ? { lifetime: view.lifetime } : {}),
    ...(view?.archiveOn ? { archiveOn: view.archiveOn } : {}),
  }
}

/** Binary files past this come by download link rather than base64. */
const FILE_INLINE_BINARY_MAX_BYTES = 1024 * 1024

interface ToolDispatchContext {
  signal?: AbortSignal
  principal?: RequestPrincipal
  identity?: Pick<TokenIdentity, "agent" | "credentialClass" | "principal">
  scopes?: string[]
  canReadRecords?: boolean
  /** The tool surface the caller was offered; preview-only inputs need "preview". */
  surface?: McpSurface
  /**
   * Where file links point: the origin the agent reached this Worktable at,
   * or null where links can't reach it (Worktable Link, Cloud).
   */
  fileLinkOrigin?: string | null
  onThreadProgress?: (update: ThreadProgressUpdate) => void | Promise<void>
}

export async function dispatchOperation(
  operationId: OperationId,
  args: Record<string, unknown>,
  context: ToolDispatchContext = {}
): Promise<unknown> {
  if (PREVIEW_OPERATIONS.has(operationId) && context.surface !== "preview") {
    // Defense in depth: the released input schema already rejects these.
    throw new Error(
      `${operationId} is a preview action. Turn on Preview agent tools in Settings → Agents to use it.`
    )
  }
  const caller = currentRequestIdentity()
  const definition = OPERATION_DEFINITIONS[operationId]
  const authorize = () => {
    if (caller) assertCurrentTeamIdentity(caller)
    const access = definition.mutation === "none" ? "read" : "edit"
    if (typeof args["spaceId"] === "string") assertSpaceAccess(args["spaceId"], access)
    const location = args["location"]
    if (location && typeof location === "object" && "kind" in location && location.kind === "space" &&
        "spaceId" in location && typeof location.spaceId === "string") assertSpaceAccess(location.spaceId, access)
  }
  authorize()
  const principal = context.principal ?? DEFAULT_AGENT_PRINCIPAL
  if (principal.type === "agent") {
    noteAgentCallForSetup(caller)
    await ensureParticipant(
      context.identity ?? { agent: principal.displayName, principal }
    )
  }
  const result = await runAsActivityActor(principal, () =>
    _dispatchOperationInner(operationId, args, { ...context, principal })
  )
  authorize()
  const operation = OPERATION_DEFINITIONS[operationId]
  if (operation?.mutation === "records") {
    noteRecordMutated()
  } else if (operation?.mutation === "workspace") {
    // Operations act within the Space they name; the rest re-check every Space.
    const spaceId = args["spaceId"]
    invalidateSearchIndex(typeof spaceId === "string" ? { spaceId } : undefined)
  }
  return result
}

async function _dispatchOperationInner(
  operationId: OperationId,
  args: Record<string, unknown>,
  context: ToolDispatchContext & { principal: RequestPrincipal }
): Promise<unknown> {
  const { principal } = context
  const identity = {
    ...(context.identity ?? {
      agent: principal.type === "agent" ? principal.displayName : null,
      principal,
    }),
    scopes: context.scopes ?? ["*"],
  }
  const actorId = principal.id
  const annotationAuthor: AnnotationAuthor = {
    type: principal.type === "human" ? "user" : principal.type,
    id: actorId,
    name: principal.displayName,
  }
  const threadLocationInput = (
    location:
      | { kind: "worktable" }
      | { kind: "space"; spaceId: string }
      | undefined,
    spaceId: string | undefined
  ) => {
    if (
      location &&
      spaceId &&
      (location.kind !== "space" || location.spaceId !== spaceId)
    ) {
      throw new Error(
        "location and deprecated spaceId must identify the same Space"
      )
    }
    return (
      location ?? (spaceId ? { kind: "space" as const, spaceId } : undefined)
    )
  }
  switch (operationId) {
    case "threads.participants": {
      return { participants: await listThreadParticipants(identity) }
    }
    case "threads.list": {
      const parsed = ListThreadsInput.parse(args)
      return {
        threads: await listThreadSummaries(
          identity,
          threadLocationInput(parsed.location, parsed.spaceId),
          parsed.participantId,
          parsed.deliveryState
        ),
      }
    }
    case "threads.read": {
      const parsed = ReadThreadInput.parse(args)
      if (parsed.after !== undefined && parsed.before !== undefined) {
        throw new Error("Use after or before, not both")
      }
      const result = await readThreadMessages(identity, parsed.threadId, {
        location: threadLocationInput(parsed.location, parsed.spaceId),
        after: parsed.after,
        before: parsed.before,
      })
      // Only the messages this page returned were read.
      await markOpened(identity, {
        kind: "thread",
        threadId: parsed.threadId,
        messageIds: result.messages.map((message) => message.id),
      })
      return result
    }
    case "threads.message": {
      const parsed = ReadThreadMessageInput.parse(args)
      const result = await readThreadMessage(identity, {
        threadId: parsed.threadId,
        messageId: parsed.messageId,
        location: threadLocationInput(parsed.location, parsed.spaceId),
      })
      await markOpened(identity, {
        kind: "thread",
        threadId: parsed.threadId,
        messageIds: [parsed.messageId],
      })
      return result
    }
    case "threads.wait": {
      const parsed = WaitThreadInput.parse(args)
      return await waitForThreadReply(identity, {
        ...parsed,
        location: threadLocationInput(parsed.location, parsed.spaceId),
        onProgress: context.onThreadProgress,
      })
    }
    case "threads.post": {
      if (args.title !== undefined && context.surface !== "preview") {
        throw new Error(
          "Thread titles require Preview agent tools in Settings → Agents."
        )
      }
      const parsed = (
        context.surface === "preview" ? PostThreadInputPreview : PostThreadInput
      ).parse(args)
      return await postThreadMessage(
        identity,
        {
          ...parsed,
          location: threadLocationInput(parsed.location, parsed.spaceId),
        },
        context.onThreadProgress
      )
    }
    case "threads.rename": {
      return await renameThreadTitle(RenameThreadInput.parse(args))
    }
    case "threads.assign_response": {
      const parsed = AssignResponseRequestInput.parse(args)
      const thread = await assignResponseRequest(identity, parsed)
      const message = thread.messages.find(
        (candidate) => candidate.id === parsed.messageId
      )
      if (!message) throw new Error("Assigned thread message was not returned")
      return {
        threadId: thread.id,
        revision: thread.revision,
        messageId: message.id,
        responseRequest: message.responseRequest ?? null,
      }
    }
    case "thread_delivery.register_participant": {
      const name = String(args["name"] ?? "").trim()
      if (!name || name.length > 120) {
        throw new Error("name is required to register a participant")
      }
      void noteAgentPairedForSetup(setupKeyForIdentity(currentRequestIdentity()))
      return await resolveParticipant(identity, {
        name,
        // Self-registration is a new adapter-only operation, so it always opts
        // into Worktable-wide V2 thread locations without another public flag.
        threadLocationVersion: 2,
      })
    }
    case "thread_delivery.claim": {
      const parsed = ClaimThreadDeliveryInput.parse(args)
      return {
        delivery: await claimNextThreadDelivery(
          identity,
          parsed.waitSeconds,
          parsed.threadLocationVersion
        ),
      }
    }
    case "thread_delivery.accept": {
      const parsed = AcceptThreadDeliveryInput.parse(args)
      return {
        activity: await acceptDelivery(
          identity,
          parsed.messageId,
          parsed.leaseId
        ),
      }
    }
    case "thread_delivery.progress": {
      const parsed = ProgressThreadDeliveryInput.parse(args)
      return {
        activity: await progressDelivery(identity, parsed),
      }
    }
    case "thread_delivery.fail": {
      const parsed = FailThreadDeliveryInput.parse(args)
      return {
        activity: await failDelivery(identity, parsed),
      }
    }
    case "spaces.create": {
      const rawName = args["name"] as string
      const description = args["description"] as string | undefined
      const rawIcon = args["icon"] as string | undefined
      const rawGroup = args["group"] as string | undefined

      // Title Case the name
      const name = rawName.replace(/\b\w/g, (c) => c.toUpperCase())

      // Validate icon: must be a Lucide name, no emoji
      let icon = rawIcon ?? DEFAULT_ICON
      if ([...icon].some((character) => character.codePointAt(0)! > 127)) {
        icon = DEFAULT_ICON // reject emoji, use default
      }

      const group = rawGroup || undefined

      const spaceId = await deduplicateSlug(slugify(name), await occupiedSpaceIds())
      const now = new Date().toISOString()
      const space: SpaceFile = {
        type: "worktable.space",
        version: 1,
        id: spaceId,
        name,
        description,
        icon,
        createdAt: now,
        updatedAt: now,
        createdBy: actorId,
        settings: { color: await nextSpaceColor(spaceId) },
        group,
      }
      await writeSpace(space)
      return { spaceId }
    }
    case "spaces.update": {
      const spaceId = args["spaceId"] as string
      const rawIcon = args["icon"] as string | undefined
      const rawGroup = args["group"] as string | undefined
      const metadataChange = ["name", "description", "icon", "group"].some(
        (key) => args[key] !== undefined
      )
      // Changing how the Space appears to everyone needs manage access; check
      // it before pins are saved so a refused update changes nothing.
      if (metadataChange) assertSpaceAccess(spaceId, "manage")
      // Pins validate against current documents; apply them first so an
      // invalid pin fails the whole update before anything is saved.
      if (args["pins"]) {
        await setStartHere(spaceId, args["pins"] as StartHerePin[])
      }
      const { data: updated, error } = await mutateSpace(spaceId, (space) => ({
        ...space,
        ...(args["name"] !== undefined
          ? { name: (args["name"] as string).replace(/\b\w/g, (c) => c.toUpperCase()) }
          : {}),
        ...(args["description"] !== undefined
          ? { description: args["description"] as string }
          : {}),
        ...(rawIcon !== undefined &&
        ![...rawIcon].some((character) => character.codePointAt(0)! > 127)
          ? { icon: rawIcon }
          : {}),
        ...(rawGroup === ""
          ? { group: undefined }
          : rawGroup !== undefined
            ? { group: rawGroup }
            : {}),
        updatedAt: new Date().toISOString(),
      }), metadataChange ? "manage" : "edit")
      if (error || !updated) throw new Error(error ?? `Space not found: ${spaceId}`)
      wsManager.broadcastAll({ type: "spaces_changed" })
      return { space: updated, pins: await resolveStartHere(spaceId, updated) }
    }
    case "spaces.archive":
    case "spaces.restore": {
      const archived = operationId === "spaces.archive"
      const { space, error } = archived
        ? await setSpaceArchived(
            args["spaceId"] as string,
            true,
            actorId,
            args["reason"] as string | undefined
          )
        : await setSpaceArchived(args["spaceId"] as string, false)
      if (error || !space) throw new Error(error ?? "Space not found")
      wsManager.broadcastAll({ type: "spaces_changed" })
      return { ok: true, space }
    }
    case "html.guide": {
      return {
        profile: "runtime" as const,
        guide:
          context.surface === "preview"
            ? withPreviewToolNames(getHtmlAuthoringGuide())
            : getHtmlAuthoringGuide(),
        tokens: WIDGET_STYLE_TOKENS,
      }
    }
    case "drawings.inspect":
    case "drawings.query":
    case "drawings.render":
    case "drawings.changes":
    case "drawings.create":
    case "drawings.edit":
    case "drawings.undo":
    case "drawings.redo":
      return await dispatchDrawingOperation(
        operationId,
        args,
        actorId,
        context.signal
      )
    case "documents.list": {
      const spaceId = args["spaceId"] as string
      const includeArchived =
        (args["includeArchived"] as boolean | undefined) ?? false
      const format = args["format"] as string | undefined
      const pathPrefix = normalizePathPrefix(args["pathPrefix"])
      const lifetime = args["lifetime"] as DocumentLifetime | undefined
      const glob = args["glob"] as string | undefined
      const matchesGlob = glob === undefined ? null : compilePathGlob(glob)
      const limit = (args["limit"] as number | undefined) ?? LIST_PAGE_SIZE
      const offset = decodeListCursor(args["cursor"])
      const matching = (await listDocuments({ spaceId, includeArchived })).filter(
        (document) => {
          const path =
            document.kind === "document" ? document.path : document.pathKey
          if (pathPrefix && path !== pathPrefix && !path.startsWith(`${pathPrefix}/`)) {
            return false
          }
          if (matchesGlob && !matchesGlob(path)) return false
          if (format && (document.kind !== "document" || document.format.id !== format)) {
            return false
          }
          // Documents whose storage records no lifetime never auto-archive,
          // so they count as durable while active.
          if (
            lifetime &&
            (document.kind !== "document" ||
              document.archived ||
              (document.lifetime ?? "durable") !== lifetime)
          ) {
            return false
          }
          return true
        }
      )
      const page = matching.slice(offset, offset + limit)
      return {
        documents: page,
        total: matching.length,
        ...(offset + limit < matching.length
          ? { nextCursor: String(offset + limit) }
          : {}),
        scope: {
          spaceId,
          includeArchived,
          ...(pathPrefix ? { pathPrefix } : {}),
          ...(format ? { format } : {}),
          ...(lifetime ? { lifetime } : {}),
          ...(glob !== undefined ? { glob } : {}),
        },
      }
    }
    case "documents.read": {
      return {
        result: await readDocument({
          spaceId: args["spaceId"] as string,
          path: args["path"] as string,
          includeArchived:
            (args["includeArchived"] as boolean | undefined) ?? false,
        }),
      }
    }
    case "documents.read_source": {
      const result = await readRegisteredDocumentSource({
        spaceId: args["spaceId"] as string,
        path: args["path"] as string,
      })
      // With the preview, a file reads as what it is: an image the model can
      // see, or text, rather than base64.
      if (
        context.surface === "preview" &&
        result.format.id === BUILTIN_DOCUMENT_FORMATS.file
      ) {
        // Every read of a file also gives a link to download it, where the
        // agent can reach this Worktable directly.
        const fields = {
          documentId: result.documentId,
          path: result.path,
          format: result.format,
          byteLength: result.bytes.byteLength,
          sourceRevision: result.sourceRevision,
          ...fileDownloadLink(
            context.fileLinkOrigin,
            principal,
            args["spaceId"] as string,
            result.path
          ),
        }
        const readable = readableFileSource(result.path, result.bytes)
        // A binary file past what a tool result carries well comes by link.
        if (
          !readable &&
          "downloadUrl" in fields &&
          result.bytes.byteLength > FILE_INLINE_BINARY_MAX_BYTES
        ) {
          return { ...fields, encoding: "download" as const }
        }
        if (!readable) {
          return {
            ...fields,
            source: Buffer.from(result.bytes).toString("base64"),
            encoding: "base64" as const,
          }
        }
        return readable.kind === "text"
          ? { ...fields, source: readable.text, encoding: "utf8" as const }
          : withResultMedia(
              { ...fields, encoding: "image" as const, mediaType: readable.mediaType },
              [
                {
                  type: "image",
                  data: Buffer.from(result.bytes).toString("base64"),
                  mimeType: readable.mediaType,
                },
              ]
            )
      }
      return {
        documentId: result.documentId,
        path: result.path,
        format: result.format,
        source: Buffer.from(result.bytes).toString("base64"),
        encoding: "base64" as const,
        byteLength: result.bytes.byteLength,
        sourceRevision: result.sourceRevision,
      }
    }
    case "documents.versions": {
      const result = await readDocumentVersions({
        spaceId: args["spaceId"] as string,
        path: args["path"] as string,
        includeArchived: true,
        checkpointsOnly: !((args["all"] as boolean | undefined) ?? false),
      })
      if (result.kind !== "versions") {
        throw new Error(
          result.kind === "not-found"
            ? "Document not found"
            : result.kind === "unsupported"
              ? "Version history is not available for this document"
              : "Document path cannot be resolved"
        )
      }
      return { versions: result.versions }
    }
    case "documents.diff": {
      return diffDocumentText({
        spaceId: args["spaceId"] as string,
        path: args["path"] as string,
        from: args["from"] as string,
        to: args["to"] as string | undefined,
        context: args["context"] as number | undefined,
      })
    }
    case "documents.upload": {
      const spaceId = args["spaceId"] as string
      const path = args["path"] as string
      if (!filesPreviewEnabled()) {
        throw new Error("Uploads need the files preview, in Settings → System.")
      }
      const file = args["file"] as ChatGptFile | undefined
      if (!analyzeDocumentPath(path).safe || !namesAFile(path)) {
        throw new Error(
          "Upload a file by its path with its extension, such as design/logo.png. Docs are created with create."
        )
      }
      const ifExists = (args["ifExists"] as "fail" | "keep_both" | "replace" | undefined) ?? "fail"
      const expectedRevision = args["expectedRevision"] as string | undefined
      if (expectedRevision !== undefined && ifExists !== "replace") {
        throw new Error("expectedRevision applies with ifExists replace.")
      }
      const mode: FileUploadMode =
        ifExists === "replace"
          ? { kind: "replace", ...(expectedRevision ? { expectedRevision } : {}) }
          : { kind: "create", keepBoth: ifExists === "keep_both" }
      // A file attached in ChatGPT: fetch it and save it now.
      if (file) {
        const bytes = await fetchChatGptFile(file, context.signal)
        const written = await writeUploadedFile({
          spaceId,
          path,
          bytes,
          mode,
          actor: actorId,
          source: "mcp",
        })
        return {
          ok: true as const,
          path: written.result.path,
          sourceRevision: written.result.sourceRevision,
          byteLength: bytes.byteLength,
          contentHash: written.contentHash,
        }
      }
      if (!context.fileLinkOrigin) {
        throw new Error(
          "Upload links reach this Worktable only when you connect to it directly, not through Worktable Link. Write text files with create, or send small files as base64."
        )
      }
      const link = fileUploadLink(
        context.fileLinkOrigin,
        principal,
        spaceId,
        path,
        mode
      )
      return {
        ok: true as const,
        path,
        ...link,
        method: "PUT" as const,
        maxBytes: FILE_UPLOAD_MAX_BYTES,
        command: `curl --fail-with-body -T <local file> '${link.uploadUrl}'`,
      }
    }
    case "documents.create": {
      assertLifetimeInput(args)
      const result = await createRegisteredDocument({
        spaceId: args["spaceId"] as string,
        path: args["path"] as string,
        format: args["format"] as {
          id: string
          sourceVersion: number
        },
        bytes: decodeGenericDocumentSource(
          args["source"] as string,
          (args["encoding"] as "utf8" | "base64" | undefined) ?? "utf8"
        ),
        createdBy: actorId,
        source: "mcp",
        reason: args["reason"] as string | undefined,
      })
      return {
        ok: true,
        ...result,
        ...(await applyLifetimeOnCreate({
          spaceId: args["spaceId"] as string,
          path: result.path,
          lifetime: args["lifetime"] as DocumentLifetime | undefined,
          archiveOn: args["archiveOn"] as string | undefined,
        })),
      }
    }
    case "documents.set_lifetime": {
      return {
        ok: true,
        ...(await setDocumentLifetime({
          spaceId: args["spaceId"] as string,
          path: args["path"] as string,
          change: lifetimeChange(args),
        })),
      }
    }
    case "documents.set_folder_lifetime": {
      const result = await setDocumentFolderLifetime({
        spaceId: args["spaceId"] as string,
        path: args["path"] as string,
        change: lifetimeChange(args),
      })
      return {
        ok: true,
        lifetime: args["lifetime"] as DocumentLifetime,
        count: result.changed.length,
        paths: result.changed,
        ...(result.unsupported.length > 0
          ? { unsupported: result.unsupported }
          : {}),
      }
    }
    case "documents.replace": {
      const bytes = decodeGenericDocumentSource(
        args["source"] as string,
        (args["encoding"] as "utf8" | "base64" | undefined) ?? "utf8"
      )
      // With the preview, overwriting a CSV or TSV says what changed, so an
      // agent sees a dropped row or a changed header at once. The summary
      // reads the old table, so it needs read access too; the old bytes come
      // from the replacement's own read.
      const summarize =
        context.surface === "preview" &&
        DELIMITED_NAME.test(args["path"] as string) &&
        hasScope(identity.scopes, "documents:read")
      const tableBefore: { bytes?: Uint8Array; formatId?: string } = {}
      const result = await replaceRegisteredDocument({
        spaceId: args["spaceId"] as string,
        path: args["path"] as string,
        bytes,
        ...(summarize
          ? {
              onPrevious: (previous: Uint8Array, formatId: string) => {
                tableBefore.bytes = previous
                tableBefore.formatId = formatId
              },
            }
          : {}),
        expectedRevision: args["expectedRevision"] as string,
        updatedBy: actorId,
        source: "mcp",
        reason: args["reason"] as string | undefined,
      })
      return {
        ok: true,
        ...result,
        ...(tableBefore.bytes &&
        tableBefore.formatId === BUILTIN_DOCUMENT_FORMATS.file
          ? (() => {
              const changes = delimitedChanges(result.path, tableBefore.bytes!, bytes)
              return changes ? { changes } : {}
            })()
          : {}),
      }
    }
    case "documents.checkpoint": {
      const result = await checkpointRegisteredDocument({
        spaceId: args["spaceId"] as string,
        path: args["path"] as string,
        expectedRevision: args["expectedRevision"] as string,
        createdBy: actorId,
        source: "mcp",
        label: args["label"] as string | undefined,
        reason: args["reason"] as string | undefined,
      })
      return { ok: true, ...result }
    }
    case "documents.restore_version": {
      const result = await restoreRegisteredDocumentVersion({
        spaceId: args["spaceId"] as string,
        path: args["path"] as string,
        versionId: args["versionId"] as string,
        store: (args["store"] as "v2" | "legacy-v1" | undefined) ?? "v2",
        expectedRevision: args["expectedRevision"] as string,
        restoredBy: actorId,
        source: "mcp",
        reason: args["reason"] as string | undefined,
      })
      // An image changed since keeps its earlier copy with the restored Doc.
      const kept = await keepEarlierImagesAfterRestore(
        args["spaceId"] as string,
        result.path,
        args["versionId"] as string,
        actorId
      )
      return {
        ok: true,
        ...result,
        ...(kept.length > 0
          ? {
              keptImages: kept,
              sourceRevision: (
                await readRegisteredDocumentSource({
                  spaceId: args["spaceId"] as string,
                  path: result.path,
                })
              ).sourceRevision,
            }
          : {}),
      }
    }
    case "documents.move": {
      const moved = await moveRegisteredDocument({
        spaceId: args["spaceId"] as string,
        path: args["path"] as string,
        to: args["to"] as string,
        scopes: identity.scopes,
      })
      return {
        ok: true,
        ...moved,
        path: moved.to,
      }
    }
    case "documents.archive": {
      return {
        ok: true,
        ...(await setRegisteredDocumentArchived({
          spaceId: args["spaceId"] as string,
          path: args["path"] as string,
          archived: true,
          archivedBy: actorId,
          reason: args["reason"] as string | undefined,
        })),
      }
    }
    case "documents.restore": {
      return {
        ok: true,
        ...(await setRegisteredDocumentArchived({
          spaceId: args["spaceId"] as string,
          path: args["path"] as string,
          archived: false,
          archivedBy: actorId,
        })),
      }
    }
    case "documents.delete": {
      return {
        ok: true,
        ...(await deleteRegisteredDocument({
          spaceId: args["spaceId"] as string,
          path: args["path"] as string,
          ...(Array.isArray(args["keep"]) ? { keep: args["keep"] as string[] } : {}),
        })),
      }
    }
    case "documents.render":
    case "html.render": {
      return renderDocumentPreview({
        spaceId: args["spaceId"] as string,
        path: (args["path"] ?? args["widgetId"]) as string,
        expectedRevision: args["expectedRevision"] as string | undefined,
        preview: args["preview"] as DocumentPreviewOptions | undefined,
        scopes: context.scopes ?? ["*"],
        html: operationId === "html.render",
        signal: context.signal,
      })
    }
    case "html.list": {
      const spaceId = args["spaceId"] as string
      const includeArchived =
        (args["includeArchived"] as boolean | undefined) ?? false
      const { data: space, error } = await readSpace(spaceId)
      if (error || !space) throw new Error(error ?? "Space not found")
      // List HTML Docs and their lifetimes from one namespace snapshot.
      return withDocPathLock(spaceId, async () => {
        const widgets = await listWidgets(spaceId, {
          includeArchived,
          catalog: () =>
            readDocumentCatalogSnapshot(spaceId, { lockHeld: true }),
        })
        const lifetimes = await listDocumentLifetimeTargetsLocked(spaceId, {
          snapshot: true,
        })
        return {
          widgets: widgets.map((widget) => ({
            ...widget,
            ...htmlLifetime(lifetimes, widget.id),
          })),
        }
      })
    }
    case "html.read": {
      const spaceId = args["spaceId"] as string
      const requestedWidgetId = args["widgetId"] as string
      const includeHtml = (args["includeHtml"] as boolean | undefined) ?? true
      return withDocPathLock(spaceId, async () => {
        const aliasResolution = await resolveDocAlias(
          spaceId,
          requestedWidgetId
        )
        if (!aliasResolution.path) {
          throw new Error(
            aliasResolution.error ?? "Document alias resolution failed"
          )
        }
        const widgetId = aliasResolution.path
        return withWidgetReadLock(spaceId, widgetId, async () => {
          if (!includeHtml) {
            const { data: widget, error } = await readWidget(spaceId, widgetId)
            if (error || !widget) throw new Error(error ?? "Widget not found")
            return {
              widget: {
                ...widget,
                ...(await htmlDocumentLifetimeV2(spaceId, widget.id)),
              },
            }
          }
          const { data, error } = await readWidgetDocument(spaceId, widgetId)
          if (error || !data)
            throw new Error(error ?? "Widget content not found")
          return {
            widget: {
              ...data.widget,
              ...(await htmlDocumentLifetimeV2(spaceId, data.widget.id)),
            },
            html: data.html,
            warnings: validateWidgetHtml(data.html, data.widget.permissions),
          }
        })
      })
    }
    case "records.list_collections": {
      const spaceId = args["spaceId"] as string
      return { collections: await listRecordCollections(spaceId) }
    }
    case "records.upsert_collection": {
      const spaceId = args["spaceId"] as string
      const collectionId = args["collectionId"] as string
      const existing = await readRecordCollectionSchema(spaceId, collectionId)
      // Fields merge by key: the fields sent are added or replaced, and fields
      // left out stay. Sending only a new field must never drop the rest of
      // the schema. Removing a field is a deliberate edit in the web app.
      const sentFields = args["fields"] as
        | RecordCollectionSchema["fields"]
        | undefined
      const previousFields = existing.data?.fields ?? {}
      const fields = sentFields
        ? { ...previousFields, ...sentFields }
        : undefined
      const fieldChanges = sentFields
        ? {
            added: Object.keys(sentFields).filter(
              (key) => !Object.hasOwn(previousFields, key)
            ),
            changed: Object.keys(sentFields).filter(
              (key) =>
                Object.hasOwn(previousFields, key) &&
                JSON.stringify(previousFields[key]) !==
                  JSON.stringify(sentFields[key])
            ),
            kept: Object.keys(previousFields).filter(
              (key) =>
                !Object.hasOwn(sentFields, key) ||
                JSON.stringify(previousFields[key]) ===
                  JSON.stringify(sentFields[key])
            ),
          }
        : undefined
      const schema = buildRecordCollectionSchema({
        id: collectionId,
        name: args["name"] as string | undefined,
        description: args["description"] as string | undefined,
        wellKnownType: args["wellKnownType"] as string | undefined,
        fields,
        metadata: args["metadata"] as Record<string, unknown> | undefined,
        titleField: args["titleField"] as string | null | undefined,
        createdBy: actorId,
        existing: existing.data ?? undefined,
      })
      const warnings = reviewRecordSchema({
        schema,
        existingSchema: existing.data,
      })
      const result = await writeRecordCollectionSchema(spaceId, schema)
      if (result.error || !result.data)
        throw new Error(result.error ?? "Write failed")
      wsManager.broadcast(spaceId, {
        type: "record_collection_update",
        spaceId,
        collectionId,
        data: result.data,
      })
      logRecordPracticeWarnings("schema_upsert", warnings, {
        fieldCount: Object.keys(schema.fields).length,
      })
      return {
        collection: result.data,
        ...(fieldChanges ? { fieldChanges } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    }
    case "records.query": {
      const spaceId = args["spaceId"] as string
      const collectionId = args["collectionId"] as string
      // An agent that asks for records without a limit gets one page, not
      // the whole collection in one response; nextCursor continues it.
      const pageByDefault = args["limit"] === undefined && !args["aggregate"]
      const result = await queryRecords(
        spaceId,
        collectionId,
        pageByDefault ? { ...args, limit: MCP_DEFAULT_RECORD_PAGE } : args,
        { groupEachValue: true }
      )
      const warnings = [...(result.warnings ?? [])]
      if (pageByDefault && result.nextCursor) {
        warnings.push(
          `Returned the first ${MCP_DEFAULT_RECORD_PAGE} matching records. Pass nextCursor as cursor for the next page, set limit (up to 1000), or use aggregate to count.`
        )
      }
      const diagnostics = await getRecordDiagnostics(spaceId, collectionId)
      if (diagnostics.length > 0) {
        warnings.push(
          `${diagnostics.length} record file(s) in this collection are unreadable and excluded from results. Files: ${diagnostics.map((d) => d.file).join(", ")}`
        )
      }
      return warnings.length > 0 ? { ...result, warnings } : result
    }
    case "records.read": {
      const { data, error } = await readRecord(
        args["spaceId"] as string,
        args["collectionId"] as string,
        args["recordId"] as string
      )
      if (error || !data) throw new Error(error ?? "Record not found")
      return { record: data }
    }
    case "records.create": {
      const spaceId = args["spaceId"] as string
      const collectionId = args["collectionId"] as string
      const data = args["data"] as Record<string, unknown>
      // Agents write fields by name, so a misspelled or never-declared field
      // is refused rather than stored where no column or filter sees it.
      const result = await createRecord(spaceId, collectionId, {
        id: args["recordId"] as string | undefined,
        data,
        metadata: args["metadata"] as Record<string, unknown> | undefined,
        createdBy: actorId,
        strictFields: true,
      })
      if (result.error || !result.data)
        throw new Error(result.error ?? "Write failed")
      // An existing id is left untouched: return the stored record so the
      // agent can skip it, or call update if it meant to change it.
      if (!result.created)
        return {
          record: result.data,
          created: false,
          ...(result.matchedBy ? { matchedBy: result.matchedBy } : {}),
        }
      const createdId = result.data.id
      const schema = await readRecordCollectionSchema(spaceId, collectionId)
      const identity = recordPracticeIdentity(data, schema.data)
      const duplicate =
        context.canReadRecords !== false && identity
          ? await findRecordBounded(
              spaceId,
              collectionId,
              (record) => {
                if (record.id === createdId) return false
                const existing = recordPracticeIdentity(
                  record.data,
                  schema.data
                )
                return (
                  existing !== null &&
                  recordPracticeIdentitiesMatch(existing, identity)
                )
              },
              { includeArchived: true, maxFiles: 100 }
            )
          : null
      const existingRecords = duplicate ? [duplicate] : []
      const warnings = reviewRecordCreate({
        schema: schema.data,
        data,
        existingRecords,
      })
      wsManager.broadcast(spaceId, {
        type: "record_update",
        spaceId,
        collectionId,
        recordId: result.data.id,
        data: result.data,
      })
      logRecordPracticeWarnings("record_create", warnings, {
        duplicateMatchCount: existingRecords.length,
      })
      return {
        record: result.data,
        created: true,
        ...(warnings.length > 0 ? { warnings } : {}),
      }
    }
    case "records.update": {
      const spaceId = args["spaceId"] as string
      const collectionId = args["collectionId"] as string
      const recordId = args["recordId"] as string
      const result = await updateRecord(spaceId, collectionId, recordId, {
        strictFields: true,
        data: args["data"] as Record<string, unknown> | undefined,
        metadata: args["metadata"] as Record<string, unknown> | undefined,
        updatedBy: actorId,
      })
      if (result.error || !result.data)
        throw new Error(result.error ?? "Update failed")
      wsManager.broadcast(spaceId, {
        type: "record_update",
        spaceId,
        collectionId,
        recordId,
        data: result.data,
      })
      return { record: result.data }
    }
    case "records.create_many": {
      const spaceId = args["spaceId"] as string
      const collectionId = args["collectionId"] as string
      const rows = args["records"] as Array<{
        recordId?: string
        data: Record<string, unknown>
        metadata?: Record<string, unknown>
      }>
      // Check every row first, so a bad row never leaves half a batch written.
      const schema = (await readRecordCollectionSchema(spaceId, collectionId))
        .data
      const problems: string[] = []
      for (const [index, row] of rows.entries()) {
        const label = `row ${index + 1}${row.recordId ? ` (${row.recordId})` : ""}`
        if (
          row.recordId !== undefined &&
          !CanonicalIdSchema.safeParse(row.recordId).success
        ) {
          problems.push(
            `${label}: recordId must use lowercase letters, digits and hyphens, starting and ending with a letter or digit`
          )
          continue
        }
        const undeclared = undeclaredFieldsError(
          Object.keys(row.data),
          schema,
          collectionId
        )
        if (undeclared) {
          problems.push(`${label}: ${undeclared}`)
          continue
        }
        const invalid = await checkRecordData(spaceId, collectionId, row.data)
        if (invalid) problems.push(`${label}: ${invalid}`)
      }
      if (problems.length > 0) {
        throw new Error(
          `Nothing was written: ${problems.length} of ${rows.length} rows need fixing. ${problems.slice(0, 10).join("; ")}${problems.length > 10 ? "; …" : ""}`
        )
      }
      const results: Array<{
        row: number
        recordId: string
        created: boolean
        matchedBy?: string
        error?: string
      }> = []
      for (const [index, row] of rows.entries()) {
        const result = await createRecord(spaceId, collectionId, {
          id: row.recordId,
          data: row.data,
          metadata: row.metadata,
          createdBy: actorId,
          strictFields: true,
        })
        results.push(
          result.data
            ? {
                row: index + 1,
                recordId: result.data.id,
                created: result.created === true,
                ...(result.matchedBy ? { matchedBy: result.matchedBy } : {}),
              }
            : {
                row: index + 1,
                recordId: row.recordId ?? "",
                created: false,
                error: result.error ?? "Write failed",
              }
        )
      }
      wsManager.broadcast(spaceId, {
        type: "record_collection_update",
        spaceId,
        collectionId,
      })
      const created = results.filter((row) => row.created).length
      const failed = results.filter((row) => row.error).length
      return {
        results,
        counts: { created, skipped: results.length - created - failed, failed },
      }
    }
    case "records.import": {
      const spaceId = args["spaceId"] as string
      const collectionId = args["collectionId"] as string
      const path = args["path"] as string
      const columns = args["columns"] as ImportColumn[] | undefined
      if (args["dryRun"] === true || !columns) {
        return { proposal: await proposeImport(spaceId, path, collectionId) }
      }
      const result = await importIntoRecords({
        spaceId,
        path,
        collectionId,
        columns,
        ...(typeof args["idColumn"] === "string"
          ? { idColumn: args["idColumn"] }
          : {}),
        ...(typeof args["titleColumn"] === "string"
          ? { titleColumn: args["titleColumn"] }
          : {}),
        createdBy: actorId,
      })
      wsManager.broadcast(spaceId, {
        type: "record_collection_update",
        spaceId,
        collectionId,
      })
      return result
    }
    case "records.update_many": {
      const spaceId = args["spaceId"] as string
      const collectionId = args["collectionId"] as string
      const recordIds = args["recordIds"] as string[] | undefined
      const where = args["where"] as Record<string, unknown> | undefined
      const data = args["data"] as Record<string, unknown> | undefined
      const metadata = args["metadata"] as Record<string, unknown> | undefined
      if ((recordIds ? 1 : 0) + (where ? 1 : 0) !== 1) {
        throw new Error("Give either recordIds or where.")
      }
      if (!data && !metadata) throw new Error("Give data or metadata to set.")
      if (data) {
        const schema = (
          await readRecordCollectionSchema(spaceId, collectionId)
        ).data
        const undeclared = undeclaredFieldsError(
          Object.keys(data),
          schema,
          collectionId
        )
        if (undeclared) throw new Error(`Nothing was written: ${undeclared}`)
        const invalid = await checkRecordData(
          spaceId,
          collectionId,
          data,
          new Set(Object.keys(data))
        )
        if (invalid) throw new Error(`Nothing was written: ${invalid}`)
      }
      let ids = recordIds ? [...new Set(recordIds)] : []
      if (where) {
        const matched = await queryRecords(spaceId, collectionId, {
          where,
          select: [],
          limit: RECORD_BATCH_LIMIT,
        })
        if ((matched.total ?? matched.records.length) > RECORD_BATCH_LIMIT) {
          throw new Error(
            `Nothing was written: the filter matches ${matched.total} records, more than ${RECORD_BATCH_LIMIT}. Narrow it, or update in several calls.`
          )
        }
        ids = matched.records.map((record) => record.id)
      }
      const results: Array<{ recordId: string; updated: boolean; error?: string }> = []
      for (const recordId of ids) {
        const result = await updateRecord(spaceId, collectionId, recordId, {
          data,
          metadata,
          updatedBy: actorId,
          strictFields: true,
        })
        results.push(
          result.data
            ? { recordId, updated: true }
            : { recordId, updated: false, error: result.error ?? "Update failed" }
        )
      }
      wsManager.broadcast(spaceId, {
        type: "record_collection_update",
        spaceId,
        collectionId,
      })
      const updated = results.filter((row) => row.updated).length
      return { results, counts: { updated, failed: results.length - updated } }
    }
    case "records.delete": {
      const spaceId = args["spaceId"] as string
      const collectionId = args["collectionId"] as string
      const recordId = args["recordId"] as string
      const result = await deleteRecord(spaceId, collectionId, recordId)
      if (result.error) throw new Error(result.error)
      wsManager.broadcast(spaceId, {
        type: "record_deleted",
        spaceId,
        collectionId,
        recordId,
      })
      return { ok: true }
    }
    case "html.create": {
      assertLifetimeInput(args)
      const spaceId = args["spaceId"] as string
      const { data: space, error: sErr } = await readSpace(spaceId)
      if (sErr || !space) throw new Error(sErr ?? "Space not found")
      const name = args["name"] as string
      const description = args["description"] as string | undefined
      const html = args["html"] as string
      const metadata = args["metadata"] as Record<string, unknown> | undefined
      const granted =
        context.surface === "preview"
          ? authorizeHtmlPermissions({
              requested: args["permissions"] as WidgetFile["permissions"],
              // Everything over MCP is an agent's write.
              person: false,
              identity,
              scopes: identity.scopes,
            })
          : null
      const permissions = granted
        ? granted.permissions
        : (args["permissions"] as WidgetFile["permissions"])
      const explicitId = args["id"] as string | undefined
      const storageV2 = await usesHtmlDocumentStorageV2()
      if (
        explicitId !== undefined &&
        (storageV2
          ? !isHtmlDocumentPath(explicitId)
          : !WidgetIdSchema.safeParse(explicitId).success)
      ) {
        throw new Error(
          storageV2
            ? `Invalid HTML document path "${explicitId}".`
            : `Invalid widget id "${explicitId}". Ids are slash-separated segments of lowercase letters, digits, and hyphens (nesting it in sidebar folders); nested ids may not use reserved segment names (records, state, content, archive, restore, versions, review).`
        )
      }
      const warnings = validateWidgetHtml(html, permissions)
      const blockingIssue = getBlockingWidgetIssue(warnings)
      if (blockingIssue)
        throw new Error(`${blockingIssue.code}: ${blockingIssue.message}`)
      if (granted?.requests?.network) warnings.push(NETWORK_REQUEST_WARNING)
      let previewSnapshot: HtmlPreviewSnapshot | undefined
      let previewError: unknown
      const captureSaved = async (saved: {
        widget: WidgetFile
        documentId?: string
      }) => {
        if (!args["preview"]) return
        try {
          if (!saved.documentId)
            throw new Error(
              "Preview requires registered HTML document storage."
            )
          previewSnapshot = await freezeSavedHtmlPreviewSnapshotLocked({
            spaceId,
            path: saved.widget.id,
            html,
            widget: saved.widget,
            documentId: saved.documentId,
          })
        } catch (error) {
          previewError = error
        }
      }
      const created = await createHtmlDocument({
        onSaved: captureSaved,
        spaceId,
        explicitId,
        name,
        description,
        html,
        createdBy: actorId,
        metadata,
        permissions,
        requests: granted?.requests,
        versionSource: "mcp",
        versionUpdatedBy: actorId,
      })
      if (!created.data) throw new Error(created.error ?? "Widget write failed")
      const widgetId = created.data.id
      const lifetime = await applyLifetimeOnCreate({
        spaceId,
        path: widgetId,
        lifetime: args["lifetime"] as DocumentLifetime | undefined,
        archiveOn: args["archiveOn"] as string | undefined,
      })
      wsManager.broadcast(spaceId, {
        type: "widget_update",
        spaceId,
        widgetId,
        data: created.data,
      })
      const result = { widgetId, widget: created.data, warnings, ...lifetime }
      if (!args["preview"]) return result
      return previewSnapshot
        ? {
            ...result,
            ...(await renderFrozenHtmlPreview(
              previewSnapshot,
              context.scopes ?? ["*"],
              args["preview"] as DocumentPreviewOptions,
              context.signal
            )),
          }
        : {
            ...result,
            preview: previewFailure(
              null,
              previewError ?? new Error("Saved preview snapshot unavailable.")
            ),
          }
    }
    case "html.update": {
      const spaceId = args["spaceId"] as string
      const widgetId = args["widgetId"] as string
      const html = args["html"] as string
      let previewSnapshot: HtmlPreviewSnapshot | undefined
      let previewError: unknown
      const updated = await withCanonicalHtmlDocumentPath(
        spaceId,
        widgetId,
        () =>
          withWidgetWriteLock(spaceId, widgetId, async () => {
            const { data: existing, error } = await readWidget(
              spaceId,
              widgetId
            )
            if (error || !existing) throw new Error(error ?? "Widget not found")
            const granted =
              context.surface === "preview"
                ? authorizeHtmlPermissions({
                    requested: args["permissions"] as WidgetFile["permissions"],
                    existing,
                    person: false,
                    identity,
                    scopes: identity.scopes,
                  })
                : null
            const permissions =
              (granted
                ? granted.permissions
                : (args["permissions"] as WidgetFile["permissions"])) ??
              existing.permissions
            const warnings = validateWidgetHtml(html, permissions)
            const blockingIssue = getBlockingWidgetIssue(warnings)
            if (blockingIssue)
              throw new Error(`${blockingIssue.code}: ${blockingIssue.message}`)
            if (granted?.requests?.network)
              warnings.push(NETWORK_REQUEST_WARNING)
            const beforeContent = await captureWidgetVersionContent(
              spaceId,
              widgetId
            )
            const result = await writeWidget(
              spaceId,
              buildWidgetFile({
                id: widgetId,
                name: (args["name"] as string | undefined) ?? existing.name,
                description:
                  (args["description"] as string | undefined) ??
                  existing.description,
                updatedBy: actorId,
                metadata: args["metadata"] as
                  | Record<string, unknown>
                  | undefined,
                permissions,
                ...(granted ? { requests: granted.requests ?? null } : {}),
                existing,
              }),
              html
            )
            if (result.error || !result.data)
              throw new Error(result.error ?? "Widget write failed")
            await recordWidgetVersion(spaceId, widgetId, beforeContent, {
              source: "mcp",
              updatedBy: actorId,
            })
            result.release?.()
            if (args["preview"]) {
              try {
                previewSnapshot = await freezeHtmlPreviewSnapshotLocked({
                  spaceId,
                  path: widgetId,
                })
              } catch (error) {
                previewError = error
              }
            }
            return { data: result.data, warnings }
          }),
        { materialize: true }
      )
      wsManager.broadcast(spaceId, {
        type: "widget_update",
        spaceId,
        widgetId,
        data: updated.data,
      })
      const result = {
        widgetId,
        widget: updated.data,
        warnings: updated.warnings,
      }
      if (!args["preview"]) return result
      return previewSnapshot
        ? {
            ...result,
            ...(await renderFrozenHtmlPreview(
              previewSnapshot,
              context.scopes ?? ["*"],
              args["preview"] as DocumentPreviewOptions,
              context.signal
            )),
          }
        : {
            ...result,
            preview: previewFailure(
              null,
              previewError ?? new Error("Saved preview snapshot unavailable.")
            ),
          }
    }
    case "html.rename": {
      const spaceId = args["spaceId"] as string
      const widgetId = args["widgetId"] as string
      const renamed = await withCanonicalHtmlDocumentPath(
        spaceId,
        widgetId,
        () =>
          withWidgetWriteLock(spaceId, widgetId, async () => {
            const beforeContent = await captureWidgetVersionContent(
              spaceId,
              widgetId
            )
            const result = await updateWidgetMetadata(spaceId, widgetId, {
              name: args["name"] as string,
              description: args["description"] as string | null | undefined,
              metadata: args["metadata"] as Record<string, unknown> | undefined,
              updatedBy: actorId,
            })
            if (result.error || !result.data)
              throw new Error(result.error ?? "Widget update failed")
            await recordWidgetVersion(spaceId, widgetId, beforeContent, {
              source: "mcp",
              updatedBy: actorId,
            })
            result.release?.()
            return result.data
          }),
        { materialize: true }
      )
      wsManager.broadcast(spaceId, {
        type: "widget_update",
        spaceId,
        widgetId,
        data: renamed,
      })
      return { widgetId, widget: renamed }
    }
    case "html.move": {
      const spaceId = args["spaceId"] as string
      const widgetId = args["widgetId"] as string
      const newPath = args["newPath"] as string
      const result = await moveHtmlDocument(spaceId, widgetId, newPath, {
        scopes: identity.scopes,
      })
      if (!result.ok) throw new Error(result.error)
      return {
        widgetId: result.to,
        oldPath: result.from,
        newPath: result.to,
      }
    }
    case "html.archive": {
      const spaceId = args["spaceId"] as string
      const widgetId = args["widgetId"] as string
      const result = await withCanonicalHtmlDocumentPath(
        spaceId,
        widgetId,
        () =>
          setWidgetArchived(
            spaceId,
            widgetId,
            true,
            actorId,
            args["reason"] as string | undefined
          ),
        { materialize: true, transactionOwnsPathLock: true }
      )
      if (result.error || !result.data)
        throw new Error(result.error ?? "Widget archive failed")
      wsManager.broadcast(spaceId, {
        type: "widget_update",
        spaceId,
        widgetId,
        data: result.data,
      })
      return { ok: true, widgetId, widget: result.data }
    }
    case "html.restore": {
      const spaceId = args["spaceId"] as string
      const widgetId = args["widgetId"] as string
      const result = await withCanonicalHtmlDocumentPath(
        spaceId,
        widgetId,
        () => setWidgetArchived(spaceId, widgetId, false, actorId),
        { materialize: true, transactionOwnsPathLock: true }
      )
      if (result.error || !result.data)
        throw new Error(result.error ?? "Widget restore failed")
      wsManager.broadcast(spaceId, {
        type: "widget_update",
        spaceId,
        widgetId,
        data: result.data,
      })
      return { ok: true, widgetId, widget: result.data }
    }
    case "html.delete": {
      const spaceId = args["spaceId"] as string
      const widgetId = args["widgetId"] as string
      const result = await deleteHtmlDocument(spaceId, widgetId)
      if (!result.ok) throw new Error(result.error)
      return { ok: true, widgetId }
    }
    case "workspace.state": {
      const spaceId = args["spaceId"] as string | undefined
      const includeArchived =
        (args["includeArchived"] as boolean | undefined) ?? false
      if (!spaceId) {
        const spaces = (await listSpaces()).filter(
          (space) => includeArchived || !getSpaceArchiveInfo(space)
        )
        const spacesWithDetail = await Promise.all(
          spaces.map(async (space) => {
            const docs = hasScope(identity.scopes, "documents:read")
              ? await listDocuments({ spaceId: space.id, includeArchived })
              : await listDocsDetailed(space.id, { includeArchived })
            return {
              id: space.id,
              name: space.name,
              description: space.description,
              docCount: docs.length,
            }
          })
        )
        const manifest = ensureWorkspaceManifest()
        const mode = workspaceProvenanceMode(manifest)
        return {
          // Surface workspace identity + provenance so an orienting agent immediately
          // learns whether this is the real workspace or a disposable sandbox copy.
          workspace: {
            name: manifest.name,
            mode,
            ...(mode !== "daily" && manifest.provenance?.source?.label
              ? { source: { label: manifest.provenance.source.label } }
              : {}),
          },
          spaces: spacesWithDetail,
          hint: (() => {
            const hint = "Use worktable_documents_read action list for every document format, or worktable_discover action search. Drawing previews and objects are available through worktable_drawings_read."
            return context.surface === "preview" ? withPreviewToolNames(hint) : hint
          })(),
        }
      }
      const { data: space, error: spaceErr } = await readSpace(spaceId)
      if (spaceErr || !space) throw new Error(spaceErr ?? "Space not found")
      if (!includeArchived && getSpaceArchiveInfo(space)) {
        throw new Error(
          `Space is archived: ${spaceId}. Re-run with includeArchived=true to inspect it.`
        )
      }
      const docs = await decorateDocsWithBacklinkCounts(
        spaceId,
        await listDocsDetailed(spaceId, { includeArchived })
      )
      const pins = hasScope(identity.scopes, "documents:read")
        ? await resolveStartHere(spaceId, space)
        : []
      return {
        space,
        ...(pins.length > 0 ? { pins } : {}),
        docs,
        ...(hasScope(identity.scopes, "documents:read")
          ? { documents: await listDocuments({ spaceId, includeArchived }) }
          : {}),
      }
    }
    case "workspace.search": {
      const spaceId = args["spaceId"] as string | undefined
      const query = args["query"] as string
      const includeArchived = args["includeArchived"] as boolean | undefined
      const commonDocuments = hasScope(identity.scopes, "documents:read")
      const pathPrefix = normalizePathPrefix(args["pathPrefix"])
      const limit = 50

      // A folder-scoped search ranks across a wider candidate set so the
      // folder's best matches are not crowded out before filtering.
      const candidateLimit = pathPrefix ? 500 : limit
      // Ask for one more than needed so `truncated` means more matches exist.
      const { results: ranked, complete } = await searchWithStatus(query, {
        spaceId,
        searchBlocks: false,
        includeArchived: includeArchived ?? false,
        maxResults: candidateLimit + 1,
        documentAccess: commonDocuments ? "common" : "legacy",
      })
      const candidates = ranked.slice(0, candidateLimit)
      const matching = pathPrefix
        ? candidates.filter(
            (hit) =>
              hit.type === "doc" &&
              hit.path !== undefined &&
              (hit.path === pathPrefix || hit.path.startsWith(`${pathPrefix}/`))
          )
        : candidates
      const results = matching.slice(0, limit)

      return {
        results,
        // While the index is still building, more matches may exist.
        truncated:
          !complete ||
          matching.length > limit ||
          ranked.length > candidateLimit,
        scope: {
          ...(spaceId ? { spaceId } : {}),
          ...(pathPrefix ? { pathPrefix } : {}),
          includeArchived: includeArchived ?? false,
        },
      }
    }
    case "annotations.list": {
      const parsed = ListAnnotationsInput.parse(args)
      return await listAnnotations(parsed.spaceId, {
        target: parsed.docPath
          ? {
              docPath: parsed.docPath,
              ...(parsed.blockId ? { blockId: parsed.blockId } : {}),
            }
          : parsed.widgetId
            ? { widgetId: parsed.widgetId }
            : undefined,
        status: parsed.status as never,
        category: parsed.category as never,
        createdBy: parsed.createdBy,
        labels: parsed.labels,
        includeResolved: parsed.includeResolved,
        limit: parsed.limit,
        offset: parsed.offset,
      })
    }
    case "annotations.read": {
      const parsed = ReadAnnotationInput.parse(args)
      const annotation = await readAnnotation(
        parsed.spaceId,
        parsed.annotationId
      )
      const context = parsed.includeTargetContext
        ? await getAnnotationContext(parsed.spaceId, parsed.annotationId)
        : undefined
      await markOpened(identity, { kind: "comment", annotationId: annotation.id })
      return { annotation, context }
    }
    case "annotations.create": {
      if (args.to !== undefined && context.surface !== "preview") {
        throw new Error(
          "Sending comments requires Preview agent tools in Settings → Agents."
        )
      }
      const parsed = (
        context.surface === "preview"
          ? CreateAnnotationInputPreview
          : CreateAnnotationInput
      ).parse(args)
      if (reservedAnnotationInput(parsed)) throw new Error("Source metadata is set by Worktable")
      const to = await commentRecipients(
        identity,
        parsed.spaceId,
        (parsed as { to?: string[] }).to
      )
      const result = await createAnnotation(parsed.spaceId, {
        target: parsed.target as never,
        category: parsed.category ?? "comment",
        to,
        body: parsed.body,
        title: parsed.title,
        author: annotationAuthor,
        labels: parsed.labels,
        idempotencyKey: parsed.idempotencyKey,
        metadata: parsed.metadata,
      })
      wsManager.broadcast(parsed.spaceId, {
        type: "annotation_update",
        spaceId: parsed.spaceId,
        data: {
          annotationId: result.annotation.id,
          annotation: result.annotation,
          event: "created",
        },
      })
      return {
        ok: true,
        annotationId: result.annotation.id,
        annotation: result.annotation,
        created: result.created,
      }
    }
    case "annotations.reply": {
      if (args.to !== undefined && context.surface !== "preview") {
        throw new Error(
          "Sending comments requires Preview agent tools in Settings → Agents."
        )
      }
      const parsed = (
        context.surface === "preview"
          ? ReplyAnnotationInputPreview
          : ReplyAnnotationInput
      ).parse(args)
      const result = await replyAnnotation(
        parsed.spaceId,
        parsed.annotationId,
        parsed.body,
        annotationAuthor,
        {
          replier: await commentReplier(identity),
          to: await commentRecipients(
            identity,
            parsed.spaceId,
            (parsed as { to?: string[] }).to
          ),
        }
      )
      wsManager.broadcast(parsed.spaceId, {
        type: "annotation_update",
        spaceId: parsed.spaceId,
        data: {
          annotationId: result.annotation.id,
          annotation: result.annotation,
          event: "replied",
        },
      })
      return {
        ok: true,
        replyId: result.replyId,
        annotation: result.annotation,
      }
    }
    case "annotations.update": {
      const parsed = UpdateAnnotationInput.parse(args)
      if (reservedAnnotationInput(parsed.patch)) throw new Error("Source metadata is set by Worktable")
      const annotation = await updateAnnotation(
        parsed.spaceId,
        parsed.annotationId,
        parsed.patch as never,
        actorId
      )
      wsManager.broadcast(parsed.spaceId, {
        type: "annotation_update",
        spaceId: parsed.spaceId,
        data: { annotationId: annotation.id, annotation, event: "updated" },
      })
      return { ok: true, annotation }
    }
    case "annotations.resolve": {
      const parsed = ResolveAnnotationInput.parse(args)
      const annotation = await resolveAnnotation(
        parsed.spaceId,
        parsed.annotationId,
        parsed.reason,
        actorId
      )
      wsManager.broadcast(parsed.spaceId, {
        type: "annotation_update",
        spaceId: parsed.spaceId,
        data: { annotationId: annotation.id, annotation, event: "resolved" },
      })
      return { ok: true, annotation }
    }
    case "annotations.context": {
      const parsed = GetAnnotationContextInput.parse(args)
      const context = await getAnnotationContext(
        parsed.spaceId,
        parsed.annotationId
      )
      await markOpened(identity, {
        kind: "comment",
        annotationId: parsed.annotationId,
      })
      return { context }
    }
    case "docs.read": {
      const spaceId = args["spaceId"] as string
      const requestedDocPath = sanitizeDocPath(args["docPath"] as string)
      const aliasResolution = await resolveDocAlias(spaceId, requestedDocPath)
      if (!aliasResolution.path) {
        throw new Error(
          aliasResolution.error ?? "Document alias resolution failed"
        )
      }
      const docPath = aliasResolution.path
      const exists = await docExists(spaceId, docPath)
      if (!exists) throw new Error(`Document not found: ${docPath}`)
      const { snapshot, revision } = await docSourceAtRevision(
        spaceId,
        docPath,
        undefined,
        false
      )
      const result = snapshot.result
      const archived = await getDocArchiveInfo(spaceId, docPath)
      const lifetime = await getDocLifetimeView(spaceId, docPath)
      const { links, backlinks } = await getDocLinks(spaceId, docPath)
      const offset = args["offset"] as number | undefined
      const limit = args["limit"] as number | undefined
      const ranged = offset !== undefined || limit !== undefined
      // Line numbers here are the ones grep and edit report for the same revision.
      const markdownContent = (markdown: string) =>
        ranged
          ? sliceMarkdownLines(markdown, offset ?? 1, limit)
          : { content: markdown, totalLines: countMarkdownLines(markdown) }
      const common = {
        docPath,
        storedAs: result.storedAs,
        revision,
        archived,
        ...lifetime,
        links,
        backlinks,
      }

      if (result.storedAs === "json" && Array.isArray(result.data)) {
        const metadata = buildBlockDocMetadata(result.data)
        if (args["format"] === "blocknote") {
          if (ranged) {
            throw new Error(
              "offset and limit read Markdown lines; omit them to read BlockNote blocks."
            )
          }
          return {
            ...common,
            content: result.data,
            format: "blocknote",
            ...metadata,
          }
        }
        // The text action edit matches against.
        const markdown = await docMarkdownProjection(spaceId, docPath, snapshot)
        if (markdown === null) throw new Error("Failed to read document")
        return {
          ...common,
          ...markdownContent(markdown),
          format: "markdown",
          ...metadata,
        }
      }
      if (typeof result.data !== "string") {
        throw new Error("Unexpected document format")
      }
      return {
        ...common,
        ...markdownContent(result.data),
        format: "markdown",
        ...buildMarkdownDocMetadata(result.data),
      }
    }
    case "docs.grep": {
      const parsed = GrepDocsInput.parse(args)
      validateGrepPattern(parsed)
      const pathPrefix = normalizePathPrefix(parsed.pathPrefix)
      const includeArchived = parsed.includeArchived ?? false
      let spaceIds: string[]
      if (parsed.spaceId) {
        const { data: space, error } = await readSpace(parsed.spaceId)
        if (error || !space) throw new Error(error ?? "Space not found")
        if (!includeArchived && getSpaceArchiveInfo(space)) {
          throw new Error(
            `Space is archived: ${parsed.spaceId}. Re-run with includeArchived=true to search it.`
          )
        }
        spaceIds = [space.id]
      } else {
        spaceIds = (await listSpaces())
          .filter((space) => includeArchived || !getSpaceArchiveInfo(space))
          .map((space) => space.id)
          .sort()
      }
      const { matches, total, skipped } = await grepDocs({
        ...parsed,
        spaceIds,
        pathPrefix,
        includeArchived,
      })
      return {
        matches,
        total,
        truncated: total > matches.length,
        skipped,
        scope: {
          ...(parsed.spaceId ? { spaceId: parsed.spaceId } : {}),
          ...(pathPrefix ? { pathPrefix } : {}),
          includeArchived,
        },
      }
    }
    case "docs.write": {
      const spaceId = args["spaceId"] as string
      const docPath = args["docPath"] as string
      const content = args["content"] as unknown[] | string
      const force = (args["force"] as boolean) ?? false
      const lifetime = args["lifetime"] as DocumentLifetime | undefined
      const archiveOn = args["archiveOn"] as string | undefined
      const expectedRevision = args["expectedRevision"] as string | undefined

      const existed = await docExists(spaceId, docPath)
      if (!existed && !lifetime) {
        throw new Error(DOCUMENT_LIFETIME_REQUIRED_MESSAGE)
      }
      assertLifetimeInput(args)
      if (existed && lifetime && (await getDocArchiveInfo(spaceId, docPath))) {
        throw new Error(
          `Document is archived: ${docPath}. Restore it first; restored documents are durable.`
        )
      }
      if (!existed && expectedRevision) {
        throw new DocEditError(
          "revision_conflict",
          `${docPath} does not exist. Omit expectedRevision to create it.`,
          { currentRevision: null }
        )
      }

      const writeOptions = {
        force,
        updatedBy: actorId,
        source: "mcp",
        managedIdentity: true,
        mermaidValidation: "strict" as const,
      }
      let formattingDropped: FormattingDrop[] = []
      let result: DocWriteResult
      if (!existed) {
        // A create must not replace a Doc another writer created meanwhile.
        result = await writeDoc(spaceId, docPath, content, {
          ...writeOptions,
          createOnly: true,
        })
      } else {
        const current = await agentChangeBase(
          spaceId,
          docPath,
          expectedRevision,
          true
        )
        const base = current.base
        if (Array.isArray(base)) {
          let blocks: unknown[]
          let regions: Parameters<typeof commitAgentBlocks>[0]["regions"]
          if (typeof content === "string") {
            // Markdown over a rich Doc: blocks whose Markdown is unchanged
            // keep their ids and formatting.
            const splice = await spliceBlockReplacement(base, content)
            formattingDropped = splice.formattingDropped
            if (formattingDropped.length > 0 && !force) {
              const fields = [
                ...new Set(formattingDropped.flatMap((drop) => drop.fields)),
              ]
              throw new DocEditError(
                "formatting_dropped",
                `This write would drop formatting Markdown cannot show from ${formattingDropped.length} changed block(s) (${fields.join(", ")}). Use action edit to change only the text you mean to, or set force=true to accept the loss.`,
                { formattingDropped }
              )
            }
            blocks = splice.blocks
            regions = splice.regions
          } else {
            // Blocks replace the whole Doc. Ids let an open session take them.
            // Canonical form, so blocks equal to the current ones match them.
            blocks = withBlockIds(inheritBlockIds(content, base))
            try {
              blocks = await canonicalizeBlocksForWrite(blocks)
            } catch {
              // Written as given; writeDoc reports what it cannot store.
            }
            regions = [
              {
                replacedBlockIds: base.map((block) =>
                  String((block as { id?: unknown })?.id)
                ),
                blocks,
              },
            ]
          }
          result = await commitAgentBlocks({
            spaceId,
            docPath,
            base,
            baseIsSource: current.baseIsSource,
            blocks,
            regions,
            sourceRevision: current.sourceRevision,
            writeOptions,
          })
        } else {
          result = await writeDoc(spaceId, docPath, content, {
            ...writeOptions,
            sourceRevision: current.sourceRevision,
          })
        }
      }
      if (!result.ok) {
        throw await docWriteFailure(spaceId, docPath, result)
      }
      await syncDocAfterToolWrite(spaceId, docPath)
      const lifetimeResult: { lifetime?: DocumentLifetime; archiveOn?: string } = !existed
        ? await applyLifetimeOnCreate({ spaceId, path: docPath, lifetime, archiveOn })
        : lifetime
          ? await setDocumentLifetime({
              spaceId,
              path: docPath,
              change: { lifetime, ...(archiveOn ? { archiveOn } : {}) },
            })
          : {}
      return {
        ok: true,
        docPath,
        revision: committedDocRevision(result),
        storedAs: result.storedAs,
        ...(lifetimeResult.lifetime ? { lifetime: lifetimeResult.lifetime } : {}),
        ...(lifetimeResult.archiveOn ? { archiveOn: lifetimeResult.archiveOn } : {}),
        formattingDropped,
        repairs: result.repairs ?? [],
        warnings: await docWriteWarnings(spaceId, docPath),
      }
    }
    case "docs.edit": {
      const spaceId = args["spaceId"] as string
      const docPath = args["docPath"] as string
      const { edits, repairs } = repairEditTexts(parseTextEdits(args["edits"]))
      const expectedRevision = args["expectedRevision"] as string | undefined

      if (!(await docExists(spaceId, docPath))) {
        throw new Error(`Document not found: ${docPath}`)
      }
      const current = await agentChangeBase(
        spaceId,
        docPath,
        expectedRevision,
        false
      )
      const stored = current.base
      const writeOptions = {
        updatedBy: actorId,
        source: "mcp",
        reason: "Edited document",
        mermaidValidation: "strict" as const,
        repairEscapedMermaidFences: false,
        managedIdentity: true,
      }

      if (typeof stored === "string") {
        // Markdown file: exact replacement on the stored text; every byte
        // outside the edited spans is kept.
        const edit = applyTextEdits(stored, edits)
        if (edit.text === stored) {
          throw new DocEditError(
            "no_change",
            "The edits leave the document unchanged."
          )
        }
        const written = await writeDoc(spaceId, docPath, edit.text, {
          ...writeOptions,
          sourceRevision: current.sourceRevision,
        })
        if (!written.ok) throw await docWriteFailure(spaceId, docPath, written)
        await syncDocAfterToolWrite(spaceId, docPath)
        // Quotes are text as the page shows it, without the Markdown around it.
        // Each version is read once, however many comments it has.
        let before: ReturnType<typeof markdownReadingText> | undefined
        let after: ReturnType<typeof markdownReadingText> | undefined
        const passageEdited = (selector: PassageSelector): boolean => {
          before ??= markdownReadingText(stored)
          const passage = locateMarkdownPassage(stored, selector, before)
          return (
            passage !== null &&
            edit.originalRanges.some(
              (range) => range.start < passage.end && range.end > passage.start
            )
          )
        }
        return {
          ok: true,
          docPath,
          revision: committedDocRevision(written),
          storedAs: written.storedAs,
          snippet: editSnippet(edit.text, edit.editedRanges),
          formattingDropped: [],
          annotationsAffected: await annotationsAffectedByEdit(
            spaceId,
            docPath,
            ({ quote, prefix, suffix }) =>
              quote && passageEdited({ quote, prefix, suffix })
                ? locateMarkdownPassage(
                    edit.text,
                    { quote, prefix, suffix },
                    (after ??= markdownReadingText(edit.text))
                  )?.match === "exact"
                : null
          ),
          repairs: [...repairs, ...(written.repairs ?? [])],
          warnings: await docWriteWarnings(spaceId, docPath),
        }
      }

      if (!Array.isArray(stored)) throw new Error("Unexpected document format")
      const splice = await spliceBlockEdits(stored, edits)
      const written = await commitAgentBlocks({
        spaceId,
        docPath,
        base: stored,
        baseIsSource: current.baseIsSource,
        blocks: splice.blocks,
        regions: splice.regions,
        sourceRevision: current.sourceRevision,
        writeOptions,
      })
      if (!written.ok) throw await docWriteFailure(spaceId, docPath, written)
      await syncDocAfterToolWrite(spaceId, docPath)

      // Everything below describes what this write stored, even if another
      // writer has changed the Doc since.
      const finalBlocks = Array.isArray(written.content) ? written.content : splice.blocks
      const finalProjection = await projectBlocks(finalBlocks)
      const warnings: Array<DocConventionIssue | Record<string, string>> =
        await docWriteWarnings(spaceId, docPath)
      // The edited text as stored: the changed blocks as written, in the
      // document the edit was matched against (an open Doc may hold other
      // people's changes elsewhere).
      const writtenTopLevel = new Map(
        (finalBlocks as Array<{ id?: unknown }>).map((block) => [block?.id, block])
      )
      const changedTopLevel = new Set(
        splice.regions.flatMap((region) => region.blocks.map((block) => block.id))
      )
      const editedBlocks = splice.blocks.map((block) =>
        changedTopLevel.has(block.id)
          ? (writtenTopLevel.get(block.id) ?? block)
          : block
      )
      const storedEdit = await projectBlocks(editedBlocks)
      if (storedEdit.markdown !== splice.editedMarkdown) {
        warnings.push({
          severity: "hint",
          code: "markdown_normalized",
          message:
            "Worktable stored the edited text in its normal Markdown form, which differs from the text you sent.",
          hint: "Read the document again before copying oldText for the next edit.",
        })
      }
      // Annotations are judged by this edit alone: the document it matched
      // against, before and after, not other people's changes in an open Doc.
      const finalById = blocksById(editedBlocks)
      const changedIds = new Set([
        ...splice.changed.modified,
        ...splice.removedIds,
      ])
      const storedText = blocksPlainText(stored)
      const finalText = blocksPlainText(editedBlocks)
      return {
        ok: true,
        docPath,
        revision: committedDocRevision(written),
        storedAs: written.storedAs,
        changed: splice.changed,
        snippet: regionSnippet(finalProjection, splice.regions),
        formattingDropped: splice.formattingDropped,
        annotationsAffected: await annotationsAffectedByEdit(
          spaceId,
          docPath,
          ({ blockId, quote }) => {
            if (blockId && changedIds.has(blockId)) {
              const block = finalById.get(blockId)
              if (!quote) return block !== undefined
              return block
                ? blocksPlainText([block]).includes(quote)
                : finalText.includes(quote)
            }
            // Anchored by quote alone (or to a block that no longer exists):
            // affected when the edit removed the quoted text.
            if (quote && (!blockId || !finalById.has(blockId))) {
              return storedText.includes(quote) && !finalText.includes(quote)
                ? false
                : null
            }
            return null
          }
        ),
        repairs: [...repairs, ...(written.repairs ?? [])],
        warnings,
      }
    }
    case "docs.delete": {
      const spaceId = args["spaceId"] as string
      const docPath = args["docPath"] as string
      const deleteResult = await deleteDoc(spaceId, docPath)
      if (deleteResult.error) throw new Error(deleteResult.error)
      if (deleteResult.notFound) {
        throw new Error(`Document not found: ${docPath}`)
      }
      return { ok: true, docPath }
    }
    case "docs.rename": {
      const spaceId = args["spaceId"] as string
      const oldPath = args["oldPath"] as string
      const newPath = args["newPath"] as string
      const outcome = await renameDocAndSync(spaceId, oldPath, newPath, {
        scopes: identity.scopes,
      })
      if (outcome.error) throw new Error(outcome.error)
      const move = outcome.renamed[0]!
      return { ok: true, oldPath: move.from, newPath: move.to }
    }
    case "documents.move_folder": {
      const parsed = MoveDocumentFolderInput.parse(args)
      const result = await moveDocumentFolder(
        parsed.spaceId,
        parsed.oldPath,
        parsed.newPath
      )
      if (!result.ok) throw new Error(result.error)
      return {
        ok: true,
        oldPath: result.from,
        newPath: result.to,
        count: result.renamed.length,
        renamed: result.renamed,
      }
    }
    case "documents.archive_folder": {
      const parsed = ArchiveDocumentFolderInput.parse(args)
      const result = await setDocumentFolderArchived({
        spaceId: parsed.spaceId,
        path: parsed.path,
        archived: true,
        archivedBy: actorId,
        reason: parsed.reason,
      })
      if (!result.ok) throw new Error(result.error)
      return {
        ok: true,
        path: result.path,
        archived: true,
        count: result.paths.length,
        paths: result.paths,
      }
    }
    case "documents.restore_folder": {
      const parsed = RestoreDocumentFolderInput.parse(args)
      const result = await setDocumentFolderArchived({
        spaceId: parsed.spaceId,
        path: parsed.path,
        archived: false,
        archivedBy: actorId,
      })
      if (!result.ok) throw new Error(result.error)
      return {
        ok: true,
        path: result.path,
        archived: false,
        count: result.paths.length,
        paths: result.paths,
      }
    }
    case "documents.delete_folder": {
      const parsed = DeleteDocumentFolderInput.parse(args)
      const result = await deleteDocumentFolder(parsed.spaceId, parsed.path)
      if (!result.ok) throw new Error(result.error)
      return {
        ok: true,
        path: result.path,
        count: result.paths.length,
        paths: result.paths,
      }
    }
    case "docs.list": {
      const spaceId = args["spaceId"] as string
      const includeArchived =
        (args["includeArchived"] as boolean | undefined) ?? false
      const docs = await decorateDocsWithBacklinkCounts(
        spaceId,
        await listDocsDetailed(spaceId, { includeArchived })
      )
      return { docs }
    }
    case "workspace.pending": {
      // The request's whole identity: Teams access needs its team binding.
      return await readPending(
        currentRequestIdentity() ?? identity,
        PendingInput.parse(args)
      )
    }
    case "workspace.space_index": {
      const parsed = SpaceIndexInput.parse(args)
      const index = await buildSpaceIndex(parsed.spaceId)
      if (!index) throw new Error(`Space not found: ${parsed.spaceId}`)
      return { index }
    }
    case "mermaid.validate": {
      return await validateMermaid(args["source"] as string)
    }
    case "mermaid.preview": {
      const theme = (args["theme"] as "light" | "dark" | undefined) ?? "dark"
      return await previewMermaid(args["source"] as string, theme)
    }
    case "guidance.drawings":
      return {
        guide:
          context.surface === "preview"
            ? withPreviewToolNames(DRAWING_GUIDE)
            : DRAWING_GUIDE,
      }
    case "guidance.format_spec": {
      const spec = FORMAT_SPEC.trim()
      return {
        spec: context.surface === "preview" ? withPreviewToolNames(spec) : spec,
      }
    }
    default:
      throw new Error(`Unknown operation: ${operationId}`)
  }
}
