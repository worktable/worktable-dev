import { assertSpaceAccess } from "./team-policy.ts";
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import { noteDocumentEdited, recordActivity } from "./activity-log.ts"
import {
  noteDocumentActivity,
  noteDocumentCreated,
} from "./document-activity.ts"
import { effectiveArchiveOn } from "./lifetime-rules.ts"
import { createHash } from "node:crypto"
import { lstat, rm } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import {
  DocumentGenerationIdSchema,
  QUICKDRAW_FORMAT,
  parseQuickdrawDocument,
  type DocumentFormatClaim,
  type DocumentId,
  type DocumentGenerationManifestV2,
  type DocumentSource,
} from "@worktable/types"
import {
  atomicCreateBytes,
  atomicWriteBytesAfterValidation,
} from "./atomic-file.ts"
import {
  buildDocumentCatalog,
  type DocumentCatalog,
} from "./document-catalog.ts"
import { readDocumentCatalogSnapshot } from "./document-query.ts"
import {
  advanceDocumentCreateRecoveryV2,
  finishDocumentCreateRecoveryV2,
  prepareDocumentCreateRecoveryV2,
  reconcileDocumentCreateRecoveryV2,
} from "./document-create-recovery-v2.ts"
import {
  DOCUMENT_GENERATION_MAX_ENTRY_BYTES,
  listDocumentGenerationsV2,
  readDocumentGenerationV2,
  commitDocumentAgentMutationV2,
  listCompatibleDocumentVersionsV2,
  readCompatibleDocumentVersionV2,
  retireReplacedGenerationV2,
  writeDocumentGenerationV2,
} from "./document-version-store-v2.ts"
import {
  BUILTIN_DOCUMENT_FORMATS,
  createBuiltinDocumentFormatRegistry,
  pathIsHidden,
  type DocumentFormatRegistry,
  type ServerDocumentFormatRegistration,
} from "./document-format-registry.ts"
import {
  mintDocumentId,
  updateDocumentInventory,
  updateDocumentInventoryAt,
  validateDocumentInventoryMutation,
} from "./document-inventory.ts"
import { analyzeDocumentPath } from "./document-path.ts"
import { readDocumentSource } from "./document-source-reader.ts"
import {
  deleteDurableDocExactlyLocked,
  moveDurableDocumentExactlyLocked,
  setDurableDocumentArchivedExactlyLocked,
} from "./document-lifecycle-journal.ts"
import {
  DOCUMENT_STORAGE_PROFILE_IDS,
  documentStorageProfiles,
} from "./document-storage-profile.ts"
import { resolveDocAliasIn, reservedByAliasIn } from "./doc-aliases.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import {
  catalogHasDocumentsBelow,
  formatsWritableWith,
  hasDocumentsBelow,
  moveDocumentFolder,
} from "./document-folder-move.ts"
import { rewriteLinksAfterMove } from "./link-rewrite.ts"
import { invalidateSearchIndex } from "./search-index.ts"
import {
  prepareSuppressedDocReplay,
  publishManagedDocGenerationProjection,
  getDocArchiveInfo,
  getDocLifetimeFactsMap,
  restoreDocVersion,
  setDocsArchiveOn,
  suppressPath,
  type DocSourceRevision,
  unsuppressPath,
} from "./store.ts"
import { mintVersionId } from "./version-store.ts"
import { pruneDocumentGenerationsForCountV2 } from "./version-retention.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import {
  documentGenerationV2Directory,
  ensureRealDocumentStorageDirectory,
  requireWorkspaceStorageVersionAt,
} from "./workspace-storage-v2.ts"
import { notifyWorkspaceChangeAndWait } from "./workspace-events.ts"
import { requireWorkspaceRecovery } from "./workspace-safety.ts"
import { validateDrawingImageMutation } from "./drawing-image-validation.ts"
import { logDocument, logError } from "./debug-log.ts"

const WRITE_ADAPTER_BUDGET = {
  maxInputBytes: DOCUMENT_GENERATION_MAX_ENTRY_BYTES,
  maxOutputBytes: DOCUMENT_GENERATION_MAX_ENTRY_BYTES,
  maxDepth: 128,
  maxElements: 100_000,
  timeoutMs: 5_000,
} as const

export type DocumentWriteFailure =
  | "not-found"
  | "conflict"
  | "invalid"
  | "unsupported"
  | "forbidden"

export class DocumentWriteError extends Error {
  readonly reason: DocumentWriteFailure

  constructor(reason: DocumentWriteFailure, message: string) {
    super(message)
    this.name = "DocumentWriteError"
    this.reason = reason
  }
}

function requireValidVersionId(
  versionId: string,
  store: "v2" | "legacy-v1"
): void {
  const valid =
    store === "v2"
      ? DocumentGenerationIdSchema.safeParse(versionId).success
      : versionId.length > 0 &&
        versionId.length <= 200 &&
        versionId !== "." &&
        versionId !== ".." &&
        !versionId.includes("/") &&
        !versionId.includes("\\") &&
        !versionId.includes("\0")
  if (!valid) {
    throw new DocumentWriteError("invalid", "Document version ID is invalid")
  }
}

export type DocumentAgentMutationInput = Omit<
  NonNullable<DocumentGenerationManifestV2["agentMutation"]>,
  "state" | "sourceRevision" | "beforeGenerationId"
>

export interface DocumentWriteResult {
  documentId: DocumentId
  path: string
  format: DocumentFormatClaim
  sourceRevision: string
  versionId: string
  mutation?: {
    receipt: NonNullable<DocumentGenerationManifestV2["agentMutation"]>
    bytes: Uint8Array
    replayed: boolean
  }
}

export interface DocumentMoveResult {
  documentId: DocumentId
  from: string
  to: string
  sourceRevision: string
}

interface ManagedFileDocument {
  documentId: DocumentId
  identity: "durable" | "provisional"
  path: string
  format: DocumentFormatClaim
  source: DocumentSource & { kind: "file" }
  registration: ServerDocumentFormatRegistration
}

type WritableDocument = ManagedFileDocument & {
  registration: ServerDocumentFormatRegistration & {
    fileSource: NonNullable<ServerDocumentFormatRegistration["fileSource"]>
    prepareWrite: NonNullable<ServerDocumentFormatRegistration["prepareWrite"]>
  }
}

export async function registeredDocumentSourceRevision(input: {
  documentId: DocumentId
  path: string
  format: DocumentFormatClaim
  source: DocumentSource
  bytes: Uint8Array
}): Promise<string> {
  const hash = createHash("sha256")
  hash.update(
    JSON.stringify({
      // Replacement invalidates clients and drafts even when imported bytes match.
      workspaceEpoch: await getWorkspaceCollaborationEpoch(),
      documentId: input.documentId,
      path: input.path,
      format: input.format,
      source: input.source,
    })
  )
  hash.update("\0")
  hash.update(input.bytes)
  return `rev_${hash.digest("base64url")}`
}

function entryComparisonKey(entry: DocumentCatalog["entries"][number]): string {
  return entry.kind === "conflict"
    ? entry.pathKey
    : (analyzeDocumentPath(entry.descriptor.path).comparisonKey ??
        entry.descriptor.path)
}

function entryAt(catalog: DocumentCatalog, path: string) {
  const key = analyzeDocumentPath(path).comparisonKey
  if (!key) {
    throw new DocumentWriteError("invalid", "Document path is invalid")
  }
  return catalog.entries.find((entry) => entryComparisonKey(entry) === key)
}

function writableRegistration(
  registry: DocumentFormatRegistry,
  format: DocumentFormatClaim
): ServerDocumentFormatRegistration {
  const registration = registry.get(format.id)
  if (
    !registration ||
    !registration.sourceVersions.includes(format.sourceVersion) ||
    registration.capabilities.authoring === "none" ||
    !registration.fileSource ||
    !registration.prepareWrite
  ) {
    throw new DocumentWriteError(
      "unsupported",
      "This document format does not support complete source replacement"
    )
  }
  return registration
}

function requirePortablePath(path: string): string {
  const analyzed = analyzeDocumentPath(path, { enforceNewPathGrammar: true })
  if (!analyzed.safe || !analyzed.portable || analyzed.canonicalPath !== path) {
    throw new DocumentWriteError(
      "invalid",
      "Document path must be canonical and portable"
    )
  }
  return path
}

async function requireV2Workspace(workspaceRoot: string): Promise<void> {
  await requireWorkspaceStorageVersionAt(workspaceRoot, [2])
}

async function preparedBytes(
  registration: ServerDocumentFormatRegistration,
  format: DocumentFormatClaim,
  bytes: Uint8Array
): Promise<Uint8Array> {
  if (bytes.byteLength > WRITE_ADAPTER_BUDGET.maxInputBytes) {
    throw new DocumentWriteError(
      "invalid",
      "Document source exceeds the authoring size limit"
    )
  }
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error("Document write adapter timed out")
        controller.abort(error)
        reject(error)
      }, WRITE_ADAPTER_BUDGET.timeoutMs)
    })
    const prepared = await Promise.race([
      registration.prepareWrite!({
        bytes: bytes.slice(),
        sourceVersion: format.sourceVersion,
        budget: WRITE_ADAPTER_BUDGET,
        signal: controller.signal,
      }),
      timedOut,
    ])
    if (!(prepared.bytes instanceof Uint8Array)) {
      throw new Error("Document write adapter returned invalid bytes")
    }
    if (prepared.bytes.byteLength > WRITE_ADAPTER_BUDGET.maxOutputBytes) {
      throw new Error("Document write adapter exceeded its output budget")
    }
    return prepared.bytes.slice()
  } catch (error) {
    throw new DocumentWriteError(
      "invalid",
      error instanceof Error ? error.message : "Document source is invalid"
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function validateDrawingImagesBeforeCommit(
  format: DocumentFormatClaim,
  bytes: Uint8Array,
  before?: Uint8Array
): Promise<void> {
  if (format.id !== QUICKDRAW_FORMAT) return
  try {
    await validateDrawingImageMutation(
      parseQuickdrawDocument(bytes),
      before ? parseQuickdrawDocument(before) : undefined
    )
  } catch (error) {
    throw new DocumentWriteError(
      "invalid",
      error instanceof Error ? error.message : "Invalid drawing image asset"
    )
  }
}

async function readSource(
  workspaceRoot: string,
  spaceId: string,
  document: ManagedFileDocument
): Promise<Uint8Array> {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new Error("Document source read timed out")),
    WRITE_ADAPTER_BUDGET.timeoutMs
  )
  try {
    return await readDocumentSource({
      spaceRoot: resolve(workspaceRoot, "spaces", spaceId),
      documentId: document.documentId,
      format: document.format,
      source: document.source,
      maxBytes: WRITE_ADAPTER_BUDGET.maxInputBytes,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function legacyDocRestoreFence(input: {
  workspaceRoot: string
  spaceId: string
  document: WritableDocument
  expectedRevision: string
}): Promise<DocSourceRevision> {
  const currentBytes = await readSource(
    input.workspaceRoot,
    input.spaceId,
    input.document
  )
  if (
    (await registeredDocumentSourceRevision({
      ...input.document,
      bytes: currentBytes,
    })) !== input.expectedRevision
  ) {
    throw new DocumentWriteError(
      "conflict",
      "Document source changed since it was read"
    )
  }
  return {
    relativePath: input.document.source.relativePath,
    size: currentBytes.byteLength,
    sha256: createHash("sha256").update(currentBytes).digest("hex"),
  }
}

function resolveManagedFileDocument(
  catalog: DocumentCatalog,
  requestedPath: string,
  registry: DocumentFormatRegistry,
  options: { allowAliases?: boolean } = {}
): ManagedFileDocument {
  const resolvedPath = resolveDocAliasIn(catalog.aliases, requestedPath)
  if (!resolvedPath) {
    throw new DocumentWriteError(
      "conflict",
      "Document alias could not be resolved"
    )
  }
  if (
    !options.allowAliases &&
    analyzeDocumentPath(resolvedPath).comparisonKey !==
      analyzeDocumentPath(requestedPath).comparisonKey
  ) {
    throw new DocumentWriteError(
      "conflict",
      "Document mutations require the current document path"
    )
  }
  const entry = entryAt(catalog, resolvedPath)
  if (!entry) {
    throw new DocumentWriteError("not-found", "Document not found")
  }
  if (entry.kind === "conflict") {
    throw new DocumentWriteError(
      "conflict",
      "This document path has conflicting sources"
    )
  }
  if (
    entry.descriptor.health !== "supported" ||
    entry.handle.diagnostics.some(
      (diagnostic) => diagnostic.severity === "error"
    )
  ) {
    throw new DocumentWriteError(
      "conflict",
      "This document must be repaired before it can be updated"
    )
  }
  const registration = registry.get(entry.descriptor.format.id)
  if (
    !registration ||
    !registration.sourceVersions.includes(entry.descriptor.format.sourceVersion)
  ) {
    throw new DocumentWriteError(
      "unsupported",
      "This document format is not registered"
    )
  }
  if (
    entry.handle.storageProfile !==
      DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile ||
    entry.handle.source.kind !== "file"
  ) {
    throw new DocumentWriteError(
      "unsupported",
      "This document source is not managed by the generic file writer"
    )
  }
  return {
    documentId: entry.handle.documentId,
    identity: entry.handle.identity,
    path: entry.descriptor.path,
    format: entry.descriptor.format,
    source: entry.handle.source,
    registration,
  }
}

async function materializeManagedFileDocument(
  spaceId: string,
  document: ManagedFileDocument
): Promise<ManagedFileDocument & { identity: "durable" }> {
  if (document.identity === "durable") {
    return document as ManagedFileDocument & { identity: "durable" }
  }
  const documentId = mintDocumentId()
  await updateDocumentInventory(spaceId, {
    upsert: [
      {
        documentId,
        path: document.path,
        format: document.format,
        source: document.source,
      },
    ],
  })
  return { ...document, documentId, identity: "durable" }
}

export async function materializeRegisteredDocumentIdentity(options: {
  spaceId: string
  path: string
  registry?: DocumentFormatRegistry
}): Promise<{
  documentId: DocumentId
  path: string
  format: DocumentFormatClaim
}> {
  assertSpaceAccess(options.spaceId);
  const workspaceRoot = getWorkspaceRoot()
  const registry = options.registry ?? createBuiltinDocumentFormatRegistry()
  return withDocPathLock(options.spaceId, async () => {
    await requireV2Workspace(workspaceRoot)
    const current = resolveManagedFileDocument(
      await buildDocumentCatalog({
        workspaceRoot,
        spaceId: options.spaceId,
        registry,
      }),
      options.path,
      registry
    )
    const durable = await materializeManagedFileDocument(
      options.spaceId,
      current
    )
    return {
      documentId: durable.documentId,
      path: durable.path,
      format: durable.format,
    }
  })
}

function resolveWritableDocument(
  catalog: DocumentCatalog,
  requestedPath: string,
  registry: DocumentFormatRegistry,
  options: { allowAliases?: boolean } = {}
): WritableDocument {
  const document = resolveManagedFileDocument(
    catalog,
    requestedPath,
    registry,
    options
  )
  const registration = writableRegistration(registry, document.format)
  return { ...document, registration } as WritableDocument
}

function generationEntryName(document: WritableDocument): string {
  return `document${document.registration.fileSource!.extension}`
}

async function removeGeneration(
  workspaceRoot: string,
  spaceId: string,
  documentId: DocumentId,
  generationId: string
): Promise<void> {
  await rm(
    documentGenerationV2Directory(
      workspaceRoot,
      spaceId,
      documentId,
      generationId
    ),
    { recursive: true, force: true }
  )
}

async function publishMutation(spaceId: string): Promise<void> {
  invalidateSearchIndex({ spaceId })
}

function suppressRegisteredSourceWrite(input: {
  absoluteSource: string
  spaceId: string
  path: string
  registration: ServerDocumentFormatRegistration
}): () => void {
  suppressPath(input.absoluteSource)
  return () => {
    if (input.registration.legacyVersionKind === "docs") {
      prepareSuppressedDocReplay(input.absoluteSource, {
        spaceId: input.spaceId,
        docPath: input.path,
      })
    }
    // Keep the path suppressed through fs.watch delivery and its debounce.
    // A genuinely later external edit is replayed against the latest source.
    setTimeout(() => unsuppressPath(input.absoluteSource), 150)
  }
}

async function publishLegacyDocProjection(input: {
  registration: ServerDocumentFormatRegistration
  spaceId: string
  path: string
  updatedAt: string
  updatedBy: string
  source: string
  versionId: string
  contentChanged: boolean
}): Promise<void> {
  if (input.registration.legacyVersionKind !== "docs") return
  try {
    await publishManagedDocGenerationProjection(input.spaceId, input.path, {
      updatedAt: input.updatedAt,
      updatedBy: input.updatedBy,
      source: input.source,
      versionId: input.versionId,
      contentChanged: input.contentChanged,
    })
  } catch (error) {
    // Source and V2 history are already canonical. This compatibility
    // projection is repairable by the normal filesystem reconciliation path,
    // so do not report a false failed write that a retry would duplicate.
    console.error(
      "[document-write] legacy Doc projection failed after commit:",
      logError(error)
    )
  }
}

async function pruneCommittedHistory(input: {
  spaceId: string
  documentId: DocumentId
}): Promise<void> {
  await pruneDocumentGenerationsForCountV2(
    input.spaceId,
    input.documentId
  ).catch((error) => {
    console.warn("[document-write] version retention cleanup failed:", logError(error))
  })
}

/** The newest version, and whether it already holds exactly these bytes. */
async function newestVersionHolding(input: {
  workspaceRoot: string
  spaceId: string
  document: WritableDocument
  documentId: DocumentId
  bytes: Uint8Array
}): Promise<{
  count: number
  newestId: string | undefined
  holds: boolean
}> {
  const legacyKind = input.document.registration.legacyVersionKind
  const existing = await listCompatibleDocumentVersionsV2({
    workspaceRoot: input.workspaceRoot,
    spaceId: input.spaceId,
    documentId: input.documentId,
    ...(legacyKind
      ? {
          legacy: {
            kind: legacyKind,
            key: input.document.path,
          },
        }
      : {}),
  })
  const latest = existing[0]
  if (latest?.store === "v2") {
    const generation = await readCompatibleDocumentVersionV2({
      workspaceRoot: input.workspaceRoot,
      spaceId: input.spaceId,
      documentId: input.documentId,
      versionId: latest.id,
      store: "v2",
    })
    const previousBytes =
      generation?.store === "v2" &&
      generation.generation.authoredSource.kind === "file" &&
      generation.generation.authoredSource.entries.length === 1
        ? generation.generation.authoredSource.entries[0]!.bytes
        : null
    if (
      previousBytes &&
      Buffer.from(previousBytes).equals(Buffer.from(input.bytes))
    ) {
      return { count: existing.length, newestId: latest.id, holds: true }
    }
  }
  return { count: existing.length, newestId: latest?.id, holds: false }
}

async function ensurePreEditBaseline(input: {
  workspaceRoot: string
  spaceId: string
  document: WritableDocument
  documentId: DocumentId
  bytes: Uint8Array
  beforeCreatedAt: string
  registry: DocumentFormatRegistry
}): Promise<{ generationId: string; created: boolean }> {
  const newest = await newestVersionHolding(input)
  if (newest.holds) return { generationId: newest.newestId!, created: false }
  const baselineLabel =
    newest.count === 0 ? "Pre-tracking baseline" : "Pre-edit recovery point"
  const createdAt = new Date(
    Math.max(0, Date.parse(input.beforeCreatedAt) - 1)
  ).toISOString()
  const generationId = mintVersionId(createdAt)
  await writeDocumentGenerationV2({
    workspaceRoot: input.workspaceRoot,
    spaceId: input.spaceId,
    documentId: input.documentId,
    generationId,
    logicalPath: input.document.path,
    format: input.document.format,
    operation: "create",
    createdAt,
    createdBy: "system",
    source: "filesystem",
    reason: baselineLabel,
    checkpoint: {
      meaningful: true,
      kind: "system",
      label: baselineLabel,
      sourceCategory: "external",
    },
    authoredSource: {
      kind: "file",
      entries: [
        { path: generationEntryName(input.document), bytes: input.bytes },
      ],
    },
    registry: input.registry,
  })
  return { generationId, created: true }
}

async function replayAgentMutationLocked(input: {
  workspaceRoot: string
  spaceId: string
  document: WritableDocument
  mutation: Pick<
    DocumentAgentMutationInput,
    "actor" | "requestId" | "requestHash"
  >
}): Promise<DocumentWriteResult | null> {
  if (input.document.identity !== "durable") return null
  const generations = await listDocumentGenerationsV2({
    workspaceRoot: input.workspaceRoot,
    spaceId: input.spaceId,
    documentId: input.document.documentId,
  })
  const prior = generations.find(
    (item) =>
      item.agentMutation?.actor === input.mutation.actor &&
      item.agentMutation.requestId === input.mutation.requestId
  )
  if (!prior?.agentMutation) return null
  if (prior.agentMutation.requestHash !== input.mutation.requestHash)
    throw new DocumentWriteError(
      "conflict",
      "requestId was already used with different drawing operations; use a new requestId"
    )
  const generation = await readDocumentGenerationV2({
    workspaceRoot: input.workspaceRoot,
    spaceId: input.spaceId,
    documentId: input.document.documentId,
    generationId: prior.id,
  })
  const bytes = generation?.authoredSource.entries[0]?.bytes
  if (!bytes || generation.authoredSource.entries.length !== 1)
    throw new DocumentWriteError("conflict", "Mutation history is unavailable")
  if (prior.agentMutation.state !== "committed") {
    const live = await readSource(
      input.workspaceRoot,
      input.spaceId,
      input.document
    )
    if (!Buffer.from(live).equals(Buffer.from(bytes)))
      throw new DocumentWriteError(
        "conflict",
        "A previous attempt has an unconfirmed drawing receipt. Inspect the current drawing before making a new request; this request will not be applied again."
      )
    await commitDocumentAgentMutationV2({
      workspaceRoot: input.workspaceRoot,
      spaceId: input.spaceId,
      documentId: input.document.documentId,
      generationId: prior.id,
    })
  }
  return {
    documentId: input.document.documentId,
    path: prior.logicalPath,
    format: prior.format,
    sourceRevision: prior.agentMutation.sourceRevision,
    versionId: prior.id,
    mutation: {
      receipt: { ...prior.agentMutation, state: "committed" },
      bytes,
      replayed: true,
    },
  }
}

/** Check durable request receipts before constructing another mutation. The writer checks again under its lock. */
export async function replayRegisteredDocumentMutation(options: {
  spaceId: string
  path: string
  actor: string
  requestId: string
  requestHash: string
}): Promise<DocumentWriteResult | null> {
  assertSpaceAccess(options.spaceId);
  const workspaceRoot = getWorkspaceRoot()
  const registry = createBuiltinDocumentFormatRegistry()
  return withDocPathLock(options.spaceId, async () => {
    await requireV2Workspace(workspaceRoot)
    const catalog = await buildDocumentCatalog({
      workspaceRoot,
      spaceId: options.spaceId,
      registry,
    })
    let document: WritableDocument
    try {
      document = resolveWritableDocument(catalog, options.path, registry, {
        allowAliases: true,
      })
    } catch (error) {
      if (error instanceof DocumentWriteError && error.reason === "not-found")
        return null
      throw error
    }
    return replayAgentMutationLocked({
      workspaceRoot,
      spaceId: options.spaceId,
      document,
      mutation: options,
    })
  })
}

async function finishAgentReceipt(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
  generationId: string
}): Promise<void> {
  // Source and history have committed. Do not roll back a successful edit if the receipt marker fails;
  // a retry verifies the exact source bytes before finishing this marker.
  await commitDocumentAgentMutationV2(input).catch((error) =>
    console.warn("[document-write] mutation receipt commit deferred:", logError(error))
  )
}

export async function createRegisteredDocument(options: {
  spaceId: string
  path: string
  format: DocumentFormatClaim
  bytes: Uint8Array
  createdBy: string
  source: string
  reason?: string
  agentMutation?: DocumentAgentMutationInput
  registry?: DocumentFormatRegistry
}): Promise<DocumentWriteResult> {
  assertSpaceAccess(options.spaceId, "edit");
  const workspaceRoot = getWorkspaceRoot()
  const registry = options.registry ?? createBuiltinDocumentFormatRegistry()
  const path = requirePortablePath(options.path)
  if (
    options.format.id === BUILTIN_DOCUMENT_FORMATS.file &&
    pathIsHidden(path)
  ) {
    throw new DocumentWriteError("invalid", "Files can't go in hidden folders")
  }
  const registration = writableRegistration(registry, options.format)
  const bytes = await preparedBytes(registration, options.format, options.bytes)

  const result = await withDocPathLock(options.spaceId, async () => {
    assertSpaceAccess(options.spaceId, "edit");
    const created = await (async () => {
      await requireV2Workspace(workspaceRoot)
      const catalog = await buildDocumentCatalog({
        workspaceRoot,
        spaceId: options.spaceId,
        registry,
      })
      if (
        catalog.inventoryDiagnostics.some(
          (diagnostic) => diagnostic.severity === "error"
        )
      ) {
        throw new DocumentWriteError(
          "conflict",
          "Document inventory must be repaired before creating documents"
        )
      }
      if (
        options.agentMutation &&
        (entryAt(catalog, path) || reservedByAliasIn(catalog.aliases, path))
      ) {
        const document = resolveWritableDocument(catalog, path, registry, {
          allowAliases: true,
        })
        const replay = await replayAgentMutationLocked({
          workspaceRoot,
          spaceId: options.spaceId,
          document,
          mutation: options.agentMutation,
        })
        if (replay) return replay
      }
      if (reservedByAliasIn(catalog.aliases, path) || entryAt(catalog, path)) {
        throw new DocumentWriteError(
          "conflict",
          "Another document already uses this path"
        )
      }
      await validateDrawingImagesBeforeCommit(options.format, bytes)
      const profile = documentStorageProfiles.get(
        DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile
      )
      const source = profile.sourceForLogicalPath?.(
        options.format,
        path,
        registry
      )
      if (!source || source.kind !== "file") {
        throw new DocumentWriteError(
          "unsupported",
          "This format has no managed file source"
        )
      }
      const documentId = mintDocumentId()
      const inventoryEntry = {
        documentId,
        path,
        format: options.format,
        source,
      }
      await validateDocumentInventoryMutation(options.spaceId, {
        upsert: [inventoryEntry],
      })
      const absoluteSource = resolve(
        workspaceRoot,
        "spaces",
        options.spaceId,
        source.relativePath
      )
      await ensureRealDocumentStorageDirectory(
        workspaceRoot,
        dirname(absoluteSource)
      )
      if (await lstat(absoluteSource).catch(() => null)) {
        throw new DocumentWriteError(
          "conflict",
          "Another document source already exists at this path"
        )
      }

      const releaseWatcherSuppression = suppressRegisteredSourceWrite({
        absoluteSource,
        spaceId: options.spaceId,
        path,
        registration,
      })
      try {
        const now = new Date().toISOString()
        const versionId = mintVersionId(now)
        const generationEntry = `document${registration.fileSource!.extension}`
        const agentMutation = options.agentMutation
          ? {
              ...options.agentMutation,
              state: "prepared" as const,
              sourceRevision: await registeredDocumentSourceRevision({
                documentId,
                path,
                format: options.format,
                source,
                bytes,
              }),
            }
          : undefined
        const committedResult = async (): Promise<DocumentWriteResult> => {
          if (agentMutation)
            await finishAgentReceipt({
              workspaceRoot,
              spaceId: options.spaceId,
              documentId,
              generationId: versionId,
            })
          await publishLegacyDocProjection({
            registration,
            spaceId: options.spaceId,
            path,
            updatedAt: now,
            updatedBy: options.createdBy,
            source: options.source,
            versionId,
            contentChanged: true,
          })
          return {
            documentId,
            path,
            format: options.format,
            sourceRevision: await registeredDocumentSourceRevision({
              documentId,
              path,
              format: options.format,
              source,
              bytes,
            }),
            versionId,
            ...(agentMutation
              ? {
                  mutation: {
                    receipt: { ...agentMutation, state: "committed" as const },
                    bytes,
                    replayed: false,
                  },
                }
              : {}),
          }
        }
        const recovery = await prepareDocumentCreateRecoveryV2({
          spaceId: options.spaceId,
          documentId,
          path,
          format: options.format,
          source,
          generationId: versionId,
          generationEntry,
          createdAt: now,
          createdBy: options.createdBy,
          operationSource: options.source,
          ...(options.reason ? { reason: options.reason } : {}),
          sourceBytes: bytes,
        })
        try {
          await writeDocumentGenerationV2({
            workspaceRoot,
            spaceId: options.spaceId,
            documentId,
            generationId: versionId,
            logicalPath: path,
            format: options.format,
            operation: "create",
            createdAt: now,
            createdBy: options.createdBy,
            source: options.source,
            ...(options.reason ? { reason: options.reason } : {}),
            ...(agentMutation ? { agentMutation } : {}),
            authoredSource: {
              kind: "file",
              entries: [
                {
                  path: generationEntry,
                  bytes,
                },
              ],
            },
            registry,
          })
          await advanceDocumentCreateRecoveryV2(recovery, "generation-written")
          try {
            await atomicCreateBytes(absoluteSource, bytes)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              throw new DocumentWriteError(
                "conflict",
                "Another document source was created at this path"
              )
            }
            throw error
          }
          await advanceDocumentCreateRecoveryV2(recovery, "source-written")
          await updateDocumentInventory(options.spaceId, {
            upsert: [inventoryEntry],
          })
          await advanceDocumentCreateRecoveryV2(recovery, "committed")
          await finishDocumentCreateRecoveryV2(recovery)
          return committedResult()
        } catch (error) {
          const recovered = await reconcileDocumentCreateRecoveryV2([
            recovery,
          ]).catch((recoveryError) => {
            requireWorkspaceRecovery("document creation is waiting for recovery")
            console.error(
              "[document-write] document create recovery failed:",
              logError(recoveryError)
            )
            return null
          })
          if (recovered?.[0] === "committed") {
            return committedResult()
          }
          throw error
        }
      } finally {
        releaseWatcherSuppression()
      }
    })()
    // Record creation under the same lock, so a concurrent move cannot leave
    // the fact on a path the document no longer has.
    await noteDocumentCreated(options.spaceId, path)
    return created
  })
  await pruneCommittedHistory({
    spaceId: options.spaceId,
    documentId: result.documentId,
  })
  await publishMutation(options.spaceId)
  await notifyWorkspaceChangeAndWait({
    type: "documentCorpus",
    spaceId: options.spaceId,
  })
  return result
}

export async function readRegisteredDocumentSource(options: {
  spaceId: string
  path: string
  registry?: DocumentFormatRegistry
}): Promise<{
  documentId: DocumentId
  path: string
  format: DocumentFormatClaim
  bytes: Uint8Array
  sourceRevision: string
  /** When the source last changed, as the document catalog records it. */
  updatedAt?: string
}> {
  assertSpaceAccess(options.spaceId);
  return withDocPathLock(options.spaceId, () =>
    readRegisteredDocumentSourceLocked(options)
  )
}

/** Caller holds the document namespace lock; capture without reacquiring it. */
export async function readRegisteredDocumentSourceLocked(options: {
  spaceId: string
  path: string
  registry?: DocumentFormatRegistry
}): Promise<{
  documentId: DocumentId
  path: string
  format: DocumentFormatClaim
  bytes: Uint8Array
  sourceRevision: string
  updatedAt?: string
}> {
  assertSpaceAccess(options.spaceId);
  const workspaceRoot = getWorkspaceRoot()
  const registry = options.registry ?? createBuiltinDocumentFormatRegistry()
  await requireV2Workspace(workspaceRoot)
  const catalog = await buildDocumentCatalog({
    workspaceRoot,
    spaceId: options.spaceId,
    registry,
  })
  const document = resolveManagedFileDocument(catalog, options.path, registry, {
    allowAliases: true,
  })
  const bytes = await readSource(workspaceRoot, options.spaceId, document)
  const entry = entryAt(catalog, document.path)
  const updatedAt =
    entry?.kind === "document" ? entry.descriptor.updatedAt : undefined
  return {
    documentId: document.documentId,
    path: document.path,
    format: document.format,
    bytes,
    sourceRevision: await registeredDocumentSourceRevision({
      ...document,
      bytes,
    }),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

/**
 * Keep the versions files have after something outside Worktable changed
 * them, such as an agent writing straight to disk. A file's history starts
 * once it has an identity: uploaded, moved or otherwise kept by Worktable.
 * Bytes the newest version already holds record nothing, and quick
 * successive changes merge into one version as people's saves do.
 *
 * One catalog serves every path in the batch. A path that names no file with
 * history, such as the temporary name of an atomic save, stands for its
 * folder: the files with history directly in it are checked instead.
 */
export async function recordExternalFileChanges(options: {
  spaceId: string
  paths: readonly string[]
}): Promise<{ recorded: string[] }> {
  const workspaceRoot = getWorkspaceRoot()
  const registry = createBuiltinDocumentFormatRegistry()
  return withDocPathLock(options.spaceId, async () => {
    await requireV2Workspace(workspaceRoot)
    const catalog = await buildDocumentCatalog({
      workspaceRoot,
      spaceId: options.spaceId,
      registry,
    })
    const keptFiles = new Map(
      catalog.entries.flatMap((entry) =>
        entry.kind === "document" &&
        entry.descriptor.format.id === BUILTIN_DOCUMENT_FORMATS.file &&
        entry.handle.identity === "durable"
          ? [[entry.descriptor.path, entry] as const]
          : []
      )
    )
    const folderOf = (path: string) =>
      path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
    const candidates = new Set<string>()
    const folders = new Set<string>()
    for (const path of options.paths) {
      if (keptFiles.has(path)) candidates.add(path)
      else folders.add(folderOf(path))
    }
    for (const path of keptFiles.keys()) {
      if (folders.has(folderOf(path))) candidates.add(path)
    }
    const recorded: string[] = []
    for (const path of candidates) {
      // One file that can't be kept leaves the rest of the batch kept.
      try {
        if (await recordFileVersionLocked(workspaceRoot, options.spaceId, catalog, path, registry)) {
          recorded.push(path)
        }
      } catch (error) {
        console.warn(
          "[files] a version for a change on disk was not kept:",
          logError(error)
        )
      }
    }
    return { recorded }
  })
}

/** Keep one file's bytes as a version unless its newest one holds them. */
async function recordFileVersionLocked(
  workspaceRoot: string,
  spaceId: string,
  catalog: DocumentCatalog,
  path: string,
  registry: DocumentFormatRegistry
): Promise<boolean> {
  const document = resolveWritableDocument(catalog, path, registry)
  let bytes: Uint8Array
  try {
    bytes = await readSource(workspaceRoot, spaceId, document)
  } catch {
    // Gone again, or past what one version can hold.
    return false
  }
  const newest = await newestVersionHolding({
    workspaceRoot,
    spaceId,
    document,
    documentId: document.documentId,
    bytes,
  })
  if (newest.holds) return false
  const now = new Date().toISOString()
  const written = await writeDocumentGenerationV2({
    workspaceRoot,
    spaceId,
    documentId: document.documentId,
    generationId: mintVersionId(now),
    ...(newest.newestId ? { coalesceWith: newest.newestId } : {}),
    logicalPath: document.path,
    format: document.format,
    operation: newest.count === 0 ? "create" : "update",
    createdAt: now,
    createdBy: "external",
    source: "filesystem",
    reason: "Changed on disk",
    authoredSource: {
      kind: "file",
      entries: [{ path: generationEntryName(document), bytes }],
    },
    registry,
  })
  if (newest.newestId) {
    // A change that continued the newest version replaces it, once this one
    // has committed; one that didn't keeps it.
    await retireReplacedGenerationV2({
      workspaceRoot,
      spaceId,
      documentId: document.documentId,
      replacement: written,
      replaced: newest.newestId,
    }).catch((error) => {
      console.warn(
        "[document-write] replaced version cleanup failed:",
        logError(error)
      )
    })
  }
  await pruneCommittedHistory({ spaceId, documentId: document.documentId })
  return true
}

export async function replaceRegisteredDocument(options: {
  spaceId: string
  path: string
  bytes: Uint8Array
  expectedRevision: string
  updatedBy: string
  source: string
  reason?: string
  agentMutation?: DocumentAgentMutationInput
  registry?: DocumentFormatRegistry
  /** Kernel-owned restore metadata; ordinary callers leave this unset. */
  checkpoint?: {
    meaningful: true
    kind: "restore"
    label?: string
  }
  /** Replace only a document of this format, checked under the lock. */
  expectedFormatId?: string
  /**
   * Keep this replacement as a version of its own. By default a quick
   * successive save by the same author continues the newest version, as
   * typing does; an upload is a deliberate version and never merges.
   */
  separateVersion?: boolean
}): Promise<DocumentWriteResult> {
  assertSpaceAccess(options.spaceId, "edit");
  const workspaceRoot = getWorkspaceRoot()
  const registry = options.registry ?? createBuiltinDocumentFormatRegistry()
  const result = await withDocPathLock(options.spaceId, async () => {
    assertSpaceAccess(options.spaceId, "edit");
    await requireV2Workspace(workspaceRoot)
    const catalog = await buildDocumentCatalog({
      workspaceRoot,
      spaceId: options.spaceId,
      registry,
    })
    const current = resolveWritableDocument(catalog, options.path, registry)
    if (
      options.expectedFormatId &&
      current.format.id !== options.expectedFormatId
    ) {
      throw new DocumentWriteError(
        "unsupported",
        "This document is not of the expected format"
      )
    }
    if (options.agentMutation) {
      const replay = await replayAgentMutationLocked({
        workspaceRoot,
        spaceId: options.spaceId,
        document: current,
        mutation: options.agentMutation,
      })
      if (replay) return replay
    }
    const before = await readSource(workspaceRoot, options.spaceId, current)
    const beforeRevision = await registeredDocumentSourceRevision({
      ...current,
      bytes: before,
    })
    if (beforeRevision !== options.expectedRevision) {
      throw new DocumentWriteError(
        "conflict",
        "Document source changed since it was read"
      )
    }
    const bytes = await preparedBytes(
      current.registration,
      current.format,
      options.bytes
    )
    await validateDrawingImagesBeforeCommit(current.format, bytes, before)
    const documentId =
      current.identity === "durable" ? current.documentId : mintDocumentId()
    const now = new Date().toISOString()
    const versionId = mintVersionId(now)
    const absoluteSource = resolve(
      workspaceRoot,
      "spaces",
      options.spaceId,
      current.source.relativePath
    )
    const releaseWatcherSuppression = suppressRegisteredSourceWrite({
      absoluteSource,
      spaceId: options.spaceId,
      path: current.path,
      registration: current.registration,
    })
    let sourcePublished = false
    let baseline: { generationId: string; created: boolean } | null = null
    let provisionalAdmitted = false
    try {
      if (current.identity === "provisional") {
        // Materialize the stable owner before publishing history or source so
        // an interruption cannot strand generations under an unreachable ID.
        await updateDocumentInventoryAt(
          resolve(workspaceRoot, "spaces", options.spaceId),
          {
            upsert: [
              {
                documentId,
                path: current.path,
                format: current.format,
                source: current.source,
              },
            ],
          }
        )
        provisionalAdmitted = true
      }
      baseline = await ensurePreEditBaseline({
        workspaceRoot,
        spaceId: options.spaceId,
        document: current,
        documentId,
        bytes: before,
        beforeCreatedAt: now,
        registry,
      })
      const agentMutation = options.agentMutation
        ? {
            ...options.agentMutation,
            state: "prepared" as const,
            beforeGenerationId: baseline.generationId,
            sourceRevision: await registeredDocumentSourceRevision({
              documentId,
              path: current.path,
              format: current.format,
              source: current.source,
              bytes,
            }),
          }
        : undefined
      // The newest version holds the content this save replaces; when it is
      // the same actor's open version, this save continues it.
      const coalesceWith =
        baseline.created || options.separateVersion
          ? undefined
          : baseline.generationId
      const written = await writeDocumentGenerationV2({
        workspaceRoot,
        spaceId: options.spaceId,
        documentId,
        generationId: versionId,
        ...(coalesceWith ? { coalesceWith } : {}),
        logicalPath: current.path,
        format: current.format,
        operation: options.checkpoint ? "checkpoint" : "update",
        createdAt: now,
        createdBy: options.updatedBy,
        source: options.source,
        ...(options.reason ? { reason: options.reason } : {}),
        ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
        ...(agentMutation ? { agentMutation } : {}),
        authoredSource: {
          kind: "file",
          entries: [{ path: generationEntryName(current), bytes }],
        },
        registry,
      })
      sourcePublished = await atomicWriteBytesAfterValidation(
        absoluteSource,
        bytes,
        async () => {
          const latest = await readSource(
            workspaceRoot,
            options.spaceId,
            current
          )
          return (
            (await registeredDocumentSourceRevision({
              ...current,
              bytes: latest,
            })) === beforeRevision
          )
        }
      )
      if (!sourcePublished) {
        throw new DocumentWriteError(
          "conflict",
          "Document source changed while the update was being prepared"
        )
      }
      await updateDocumentInventory(options.spaceId, {
        upsert: [
          {
            documentId,
            path: current.path,
            format: current.format,
            source: current.source,
          },
        ],
        ...(current.identity === "provisional"
          ? { remove: [current.documentId] }
          : {}),
      })
      if (coalesceWith) {
        // Only now that the save has committed: a failed save keeps the
        // version it would have replaced.
        await retireReplacedGenerationV2({
          workspaceRoot,
          spaceId: options.spaceId,
          documentId,
          replacement: written,
          replaced: coalesceWith,
        }).catch((error) => {
          console.warn(
            "[document-write] replaced version cleanup failed:",
            logError(error)
          )
        })
      }
      await publishLegacyDocProjection({
        registration: current.registration,
        spaceId: options.spaceId,
        path: current.path,
        updatedAt: now,
        updatedBy: options.updatedBy,
        source: options.source,
        versionId,
        contentChanged: true,
      })
      if (agentMutation)
        await finishAgentReceipt({
          workspaceRoot,
          spaceId: options.spaceId,
          documentId,
          generationId: versionId,
        })
      return {
        documentId,
        path: current.path,
        format: current.format,
        sourceRevision: await registeredDocumentSourceRevision({
          documentId,
          path: current.path,
          format: current.format,
          source: current.source,
          bytes,
        }),
        versionId,
        ...(agentMutation
          ? {
              mutation: {
                receipt: { ...agentMutation, state: "committed" as const },
                bytes,
                replayed: false,
              },
            }
          : {}),
      }
    } catch (error) {
      let canRollBackPublishedSource = sourcePublished
      if (sourcePublished) {
        canRollBackPublishedSource = await atomicWriteBytesAfterValidation(
          absoluteSource,
          before,
          async () => {
            const latest = await readSource(
              workspaceRoot,
              options.spaceId,
              current
            ).catch(() => null)
            return Boolean(
              latest && Buffer.from(latest).equals(Buffer.from(bytes))
            )
          }
        )
        if (!canRollBackPublishedSource) {
          console.warn(
            `[document-write] preserving a later filesystem edit after ${logDocument(options.spaceId, current.path)} replacement failed`
          )
        }
      }
      // Once another writer has changed or removed the published source, our
      // generation and durable owner are valid prior history. Preserve them so
      // watcher reconciliation can append the external state without losing
      // either committed edit.
      if (!sourcePublished || canRollBackPublishedSource) {
        await removeGeneration(
          workspaceRoot,
          options.spaceId,
          documentId,
          versionId
        )
        if (current.identity === "provisional" && baseline?.created) {
          await removeGeneration(
            workspaceRoot,
            options.spaceId,
            documentId,
            baseline.generationId
          )
        }
        if (provisionalAdmitted) {
          await updateDocumentInventoryAt(
            resolve(workspaceRoot, "spaces", options.spaceId),
            { remove: [documentId] }
          )
        }
      }
      throw error
    } finally {
      releaseWatcherSuppression()
    }
  })
  await pruneCommittedHistory({
    spaceId: options.spaceId,
    documentId: result.documentId,
  })
  await publishMutation(options.spaceId)
  await notifyWorkspaceChangeAndWait({
    type: "documentCorpus",
    spaceId: options.spaceId,
  })
  if (!result.mutation?.replayed) {
    noteDocumentEdited(
      options.spaceId,
      result.path,
      options.updatedBy,
      options.source
    )
  }
  return result
}

export async function checkpointRegisteredDocument(options: {
  spaceId: string
  path: string
  expectedRevision: string
  createdBy: string
  source: string
  label?: string
  reason?: string
  registry?: DocumentFormatRegistry
}): Promise<DocumentWriteResult> {
  assertSpaceAccess(options.spaceId, "edit");
  const workspaceRoot = getWorkspaceRoot()
  const registry = options.registry ?? createBuiltinDocumentFormatRegistry()
  const result = await withDocPathLock(options.spaceId, async () => {
    assertSpaceAccess(options.spaceId, "edit");
    await requireV2Workspace(workspaceRoot)
    const catalog = await buildDocumentCatalog({
      workspaceRoot,
      spaceId: options.spaceId,
      registry,
    })
    const current = resolveWritableDocument(catalog, options.path, registry)
    const bytes = await readSource(workspaceRoot, options.spaceId, current)
    const revision = await registeredDocumentSourceRevision({
      ...current,
      bytes,
    })
    if (revision !== options.expectedRevision) {
      throw new DocumentWriteError(
        "conflict",
        "Document source changed since it was read"
      )
    }
    const documentId =
      current.identity === "durable" ? current.documentId : mintDocumentId()
    if (current.identity === "provisional") {
      await updateDocumentInventory(options.spaceId, {
        upsert: [
          {
            documentId,
            path: current.path,
            format: current.format,
            source: current.source,
          },
        ],
        remove: [current.documentId],
      })
    }
    const now = new Date().toISOString()
    const versionId = mintVersionId(now)
    try {
      await writeDocumentGenerationV2({
        workspaceRoot,
        spaceId: options.spaceId,
        documentId,
        generationId: versionId,
        logicalPath: current.path,
        format: current.format,
        operation: "checkpoint",
        createdAt: now,
        createdBy: options.createdBy,
        source: options.source,
        ...(options.reason ? { reason: options.reason } : {}),
        checkpoint: {
          meaningful: true,
          kind: "manual",
          ...(options.label ? { label: options.label } : {}),
        },
        authoredSource: {
          kind: "file",
          entries: [{ path: generationEntryName(current), bytes }],
        },
        registry,
      })
    } catch (error) {
      if (current.identity === "provisional") {
        await updateDocumentInventory(options.spaceId, {
          upsert: [
            {
              documentId: current.documentId,
              path: current.path,
              format: current.format,
              source: current.source,
            },
          ],
          remove: [documentId],
        })
      }
      throw error
    }
    await publishLegacyDocProjection({
      registration: current.registration,
      spaceId: options.spaceId,
      path: current.path,
      updatedAt: now,
      updatedBy: options.createdBy,
      source: options.source,
      versionId,
      contentChanged: false,
    })
    return {
      documentId,
      path: current.path,
      format: current.format,
      sourceRevision: await registeredDocumentSourceRevision({
        documentId,
        path: current.path,
        format: current.format,
        source: current.source,
        bytes,
      }),
      versionId,
    }
  })
  await pruneCommittedHistory({
    spaceId: options.spaceId,
    documentId: result.documentId,
  })
  await notifyWorkspaceChangeAndWait({
    type: "documentCorpus",
    spaceId: options.spaceId,
  })
  return result
}

export async function restoreRegisteredDocumentVersion(options: {
  spaceId: string
  path: string
  versionId: string
  store?: "v2" | "legacy-v1"
  expectedRevision: string
  restoredBy: string
  source: string
  reason?: string
  registry?: DocumentFormatRegistry
}): Promise<DocumentWriteResult> {
  assertSpaceAccess(options.spaceId, "edit");
  const workspaceRoot = getWorkspaceRoot()
  const registry = options.registry ?? createBuiltinDocumentFormatRegistry()
  const store = options.store ?? "v2"
  requireValidVersionId(options.versionId, store)
  const plan = await withDocPathLock(options.spaceId, async () => {
    assertSpaceAccess(options.spaceId, "edit");
    await requireV2Workspace(workspaceRoot)
    const catalog = await buildDocumentCatalog({
      workspaceRoot,
      spaceId: options.spaceId,
      registry,
    })
    const current = resolveWritableDocument(catalog, options.path, registry)
    if (current.identity !== "durable") {
      throw new DocumentWriteError(
        "not-found",
        "This document has no durable version history"
      )
    }
    if (
      options.store === "legacy-v1" &&
      !current.registration.legacyVersionKind
    ) {
      throw new DocumentWriteError(
        "not-found",
        "This document has no compatible legacy version history"
      )
    }
    const generation = await readCompatibleDocumentVersionV2({
      workspaceRoot,
      spaceId: options.spaceId,
      documentId: current.documentId,
      versionId: options.versionId,
      store,
      ...(options.store === "legacy-v1"
        ? {
            legacy: {
              kind: current.registration.legacyVersionKind!,
              key: current.path,
            },
          }
        : {}),
    })
    if (!generation) {
      throw new DocumentWriteError("not-found", "Document version not found")
    }
    if (generation.store === "legacy-v1") {
      const after = generation.snapshot["after"]
      const content =
        after && typeof after === "object" && !Array.isArray(after)
          ? (after as Record<string, unknown>)["content"]
          : undefined
      if (content === undefined) {
        throw new DocumentWriteError(
          "conflict",
          "Document version is not compatible with the current source"
        )
      }
      if (current.registration.legacyVersionKind === "docs") {
        return {
          kind: "legacy-doc-restore" as const,
          expectedSourceRevision: await legacyDocRestoreFence({
            workspaceRoot,
            spaceId: options.spaceId,
            document: current,
            expectedRevision: options.expectedRevision,
          }),
        }
      }
      if (current.registration.legacyVersionKind === "widgets") {
        if (!content || typeof content !== "object" || Array.isArray(content)) {
          throw new DocumentWriteError(
            "conflict",
            "Document version is not compatible with the current source"
          )
        }
        const html = (content as Record<string, unknown>)["html"]
        if (typeof html !== "string") {
          throw new DocumentWriteError(
            "conflict",
            "Document version is not compatible with the current source"
          )
        }
        return {
          kind: "replace" as const,
          bytes: new TextEncoder().encode(html),
        }
      }
      return {
        kind: "replace" as const,
        bytes:
          typeof content === "string"
            ? new TextEncoder().encode(content)
            : new TextEncoder().encode(`${JSON.stringify(content, null, 2)}\n`),
      }
    }
    if (
      generation.generation.authoredSource.kind !== "file" ||
      generation.generation.authoredSource.entries.length !== 1
    ) {
      throw new DocumentWriteError(
        "conflict",
        "Document version is not compatible with the current source"
      )
    }
    const historicalFormat = generation.generation.manifest.format
    if (
      historicalFormat.id !== current.format.id ||
      historicalFormat.sourceVersion !== current.format.sourceVersion
    ) {
      const builtinDocFormats = new Set<string>([
        BUILTIN_DOCUMENT_FORMATS.markdown,
        BUILTIN_DOCUMENT_FORMATS.richText,
      ])
      if (
        current.registration.legacyVersionKind !== "docs" ||
        !builtinDocFormats.has(historicalFormat.id) ||
        !builtinDocFormats.has(current.format.id)
      ) {
        throw new DocumentWriteError(
          "conflict",
          "Document version is not compatible with the current source"
        )
      }
      return {
        kind: "legacy-doc-restore" as const,
        expectedSourceRevision: await legacyDocRestoreFence({
          workspaceRoot,
          spaceId: options.spaceId,
          document: current,
          expectedRevision: options.expectedRevision,
        }),
      }
    }
    return {
      kind: "replace" as const,
      bytes: generation.generation.authoredSource.entries[0]!.bytes,
    }
  })
  if (plan.kind === "legacy-doc-restore") {
    const label = `Restored ${basename(options.versionId)}`
    const restored = await restoreDocVersion(
      options.spaceId,
      options.path,
      options.versionId,
      {
        expectedSourceRevision: plan.expectedSourceRevision,
        updatedBy: options.restoredBy,
        source: "version-restore",
        reason: options.reason ?? label,
        checkpointLabel: label,
      }
    )
    if (!restored.ok) {
      throw new DocumentWriteError(
        restored.errorCode === "NOT_FOUND" ? "not-found" : "conflict",
        restored.error
      )
    }
    const current = await readRegisteredDocumentSource({
      spaceId: options.spaceId,
      path: options.path,
      registry,
    })
    await publishMutation(options.spaceId)
    await notifyWorkspaceChangeAndWait({
      type: "documentCorpus",
      spaceId: options.spaceId,
    })
    return {
      documentId: current.documentId,
      path: current.path,
      format: current.format,
      sourceRevision: current.sourceRevision,
      versionId: restored.provenance?.versionId ?? options.versionId,
    }
  }
  return replaceRegisteredDocument({
    spaceId: options.spaceId,
    path: options.path,
    bytes: plan.bytes,
    expectedRevision: options.expectedRevision,
    updatedBy: options.restoredBy,
    source: options.source,
    reason: options.reason ?? `Restored ${basename(options.versionId)}`,
    checkpoint: {
      meaningful: true,
      kind: "restore",
      label: `Restored ${basename(options.versionId)}`,
    },
    registry,
  })
}

export async function moveRegisteredDocument(options: {
  spaceId: string
  path: string
  to: string
  registry?: DocumentFormatRegistry
  /** A credential's scopes, which bound what moving the Doc's folder may move. */
  scopes?: readonly string[]
}): Promise<DocumentMoveResult> {
  assertSpaceAccess(options.spaceId, "edit");
  const registry = options.registry ?? createBuiltinDocumentFormatRegistry()
  const to = requirePortablePath(options.to)
  // A Doc's folder belongs to it: sub-Docs and files under it move with it,
  // as one folder move, which takes its own lock. A first child created while
  // this decides is seen under the lock, and the move starts again.
  let result: DocumentMoveResult | null = null
  let withFolder = false
  for (let pass = 0; pass < 2 && !result; pass += 1) {
    withFolder =
      options.path !== to &&
      (await hasDocumentsBelow(options.spaceId, options.path))
    if (withFolder) {
      // Refuse a Doc this move can't answer for, as moving it alone would,
      // before its folder moves.
      resolveManagedFileDocument(
        await readDocumentCatalogSnapshot(options.spaceId),
        options.path,
        registry
      )
      const formats = formatsWritableWith(options.scopes)
      const folder = await moveDocumentFolder(options.spaceId, options.path, to, {
        ...(formats ? { formats } : {}),
      })
      if (!folder.ok) {
        throw new DocumentWriteError(
          folder.kind === "conflict" ? "conflict" : folder.kind,
          folder.error
        )
      }
    }
    result = await moveRegisteredDocumentLocked(options, to, registry, withFolder)
  }
  if (!result) {
    throw new DocumentWriteError(
      "conflict",
      "The Doc's folder changed during the move. Try again."
    )
  }
  await noteDocumentActivity(options.spaceId, [to])
  await publishMutation(options.spaceId)
  await notifyWorkspaceChangeAndWait({
    type: "documentCorpus",
    spaceId: options.spaceId,
  })
  // A folder move rewrote its links already; an exact one does it here,
  // outside the lock, because rewriting writes the Docs that hold them.
  if (!withFolder) {
    await rewriteLinksAfterMove(options.spaceId, [{ from: result.from, to }])
  }
  return result
}

/** The move under the lock; null when the Doc gained a folder meanwhile. */
function moveRegisteredDocumentLocked(
  options: { spaceId: string; path: string },
  to: string,
  registry: DocumentFormatRegistry,
  withFolder: boolean
): Promise<DocumentMoveResult | null> {
  const workspaceRoot = getWorkspaceRoot()
  return withDocPathLock(options.spaceId, async () => {
    assertSpaceAccess(options.spaceId, "edit");
    await requireV2Workspace(workspaceRoot)
    const catalog = await buildDocumentCatalog({
      workspaceRoot,
      spaceId: options.spaceId,
      registry,
    })
    if (withFolder) {
      const moved = resolveManagedFileDocument(catalog, to, registry)
      const bytes = await readSource(workspaceRoot, options.spaceId, moved)
      return {
        documentId: moved.documentId,
        from: options.path,
        to,
        sourceRevision: await registeredDocumentSourceRevision({
          ...moved,
          bytes,
        }),
      }
    }
    const current = resolveManagedFileDocument(catalog, options.path, registry)
    if (current.path !== to && catalogHasDocumentsBelow(catalog, current.path)) {
      return null
    }
    // The lifecycle planner owns destination conflicts and can retire an alias
    // belonging to this same document when moving it back to a former path.
    // A blanket alias rejection here prevents that supported round trip.
    const moved = await moveDurableDocumentExactlyLocked(
      options.spaceId,
      current.path,
      to
    )
    if (moved.error) {
      throw new DocumentWriteError("conflict", moved.error)
    }
    if (!moved.handled || !moved.documentId) {
      throw new DocumentWriteError("not-found", "Document could not be moved")
    }
    const refreshed = resolveManagedFileDocument(
      await buildDocumentCatalog({
        workspaceRoot,
        spaceId: options.spaceId,
        registry,
      }),
      to,
      registry
    )
    const bytes = await readSource(workspaceRoot, options.spaceId, refreshed)
    return {
      documentId: moved.documentId,
      from: current.path,
      to,
      sourceRevision: await registeredDocumentSourceRevision({
        ...refreshed,
        bytes,
      }),
    }
  })
}

export async function setRegisteredDocumentArchived(options: {
  spaceId: string
  path: string
  archived: boolean
  archivedBy: string
  reason?: string
  /**
   * Archive only if the document's lifetime is due by this time, checked
   * under the same lock as the archive so concurrent activity wins.
   */
  onlyIfDueBy?: number
  registry?: DocumentFormatRegistry
}): Promise<{
  documentId: DocumentId
  path: string
  archived: boolean
  notDue?: true
}> {
  assertSpaceAccess(options.spaceId, "edit");
  const workspaceRoot = getWorkspaceRoot()
  const registry = options.registry ?? createBuiltinDocumentFormatRegistry()
  let stateChanged = false
  const result = await withDocPathLock(options.spaceId, async () => {
    assertSpaceAccess(options.spaceId, "edit");
    await requireV2Workspace(workspaceRoot)
    const catalog = await buildDocumentCatalog({
      workspaceRoot,
      spaceId: options.spaceId,
      registry,
    })
    const current = await materializeManagedFileDocument(
      options.spaceId,
      resolveManagedFileDocument(catalog, options.path, registry)
    )
    if (options.onlyIfDueBy !== undefined) {
      const entry = entryAt(catalog, current.path)
      const facts = (
        await getDocLifetimeFactsMap(options.spaceId, [current.path])
      ).get(current.path)
      const due = effectiveArchiveOn(
        facts,
        entry?.kind === "document" ? entry.descriptor.updatedAt : undefined
      )
      if (
        due === undefined ||
        Date.parse(due) > options.onlyIfDueBy ||
        (await getDocArchiveInfo(options.spaceId, current.path))
      ) {
        return {
          documentId: current.documentId,
          path: current.path,
          archived: false,
          notDue: true as const,
        }
      }
    }
    const wasArchived = Boolean(
      await getDocArchiveInfo(options.spaceId, current.path)
    )
    stateChanged = wasArchived !== options.archived
    if (!options.archived && wasArchived) {
      // Restored documents come back durable. Clear the date first: a failure
      // between the two steps leaves an archived durable document, never a
      // restored one that is already overdue.
      await setDocsArchiveOn(
        options.spaceId,
        [current.path],
        null,
        new Date().toISOString()
      )
    }
    const changed = await setDurableDocumentArchivedExactlyLocked(
      options.spaceId,
      current.path,
      options.archived,
      {
        path: current.path,
        storageProfileId: DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile,
      },
      {
        archivedBy: options.archivedBy,
        ...(options.reason ? { reason: options.reason } : {}),
      }
    )
    if (changed.error) {
      throw new DocumentWriteError("conflict", changed.error)
    }
    if (!changed.handled) {
      throw new DocumentWriteError(
        "not-found",
        "Document could not be archived"
      )
    }
    return {
      documentId: current.documentId,
      path: current.path,
      archived: options.archived,
    }
  })
  if (result.notDue) return result
  await publishMutation(options.spaceId)
  await notifyWorkspaceChangeAndWait({
    type: "documentCorpus",
    spaceId: options.spaceId,
  })
  // A retried archive or restore changes nothing worth reporting.
  if (stateChanged) {
    recordActivity({
      spaceId: options.spaceId,
      action: options.archived ? "doc.archived" : "doc.restored",
      target: { kind: "doc", path: result.path },
    })
  }
  return result
}

export async function deleteRegisteredDocument(options: {
  spaceId: string
  path: string
  registry?: DocumentFormatRegistry
}): Promise<{ documentId: DocumentId; path: string }> {
  assertSpaceAccess(options.spaceId, "edit");
  const workspaceRoot = getWorkspaceRoot()
  const registry = options.registry ?? createBuiltinDocumentFormatRegistry()
  const result = await withDocPathLock(options.spaceId, async () => {
    assertSpaceAccess(options.spaceId, "edit");
    await requireV2Workspace(workspaceRoot)
    const catalog = await buildDocumentCatalog({
      workspaceRoot,
      spaceId: options.spaceId,
      registry,
    })
    const current = await materializeManagedFileDocument(
      options.spaceId,
      resolveManagedFileDocument(catalog, options.path, registry)
    )
    const deleted = await deleteDurableDocExactlyLocked(
      options.spaceId,
      current.path
    )
    if (deleted.error) {
      throw new DocumentWriteError("conflict", deleted.error)
    }
    if (!deleted.handled || !deleted.documentId) {
      throw new DocumentWriteError("not-found", "Document could not be deleted")
    }
    return { documentId: deleted.documentId, path: current.path }
  })
  await publishMutation(options.spaceId)
  await notifyWorkspaceChangeAndWait({
    type: "documentCorpus",
    spaceId: options.spaceId,
  })
  return result
}
