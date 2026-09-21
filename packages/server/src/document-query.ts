import { usesDocumentVersionStoreV2 } from "./document-version-compatibility-v2.ts"
import { resolve } from "node:path"
import type {
  DocumentConflictItem,
  DocumentFormatClaim,
  DocumentHealth,
  DocumentId,
  DocumentListItem,
  DocumentNavigationTarget,
  DocumentReadResult,
  DocumentSource,
  DocumentSpecializedView,
  DocumentSummary,
  DocumentRenderDisposition,
} from "@worktable/types"
import {
  buildDocumentCatalog,
  type DocumentCatalog,
  type DocumentCatalogEntry,
} from "./document-catalog.ts"
import {
  readLegacyHtmlClaim,
  type DocumentSourceClaim,
} from "./document-adapters.ts"
import { analyzeDocumentPath } from "./document-path.ts"
import {
  BUILTIN_DOCUMENT_FORMATS,
  createBuiltinDocumentFormatRegistry,
  type DocumentFormatRegistry,
  type DocumentFormatCapabilityHints,
  type DocumentOperationBudget,
} from "./document-format-registry.ts"
import {
  documentStorageProfiles,
  type DocumentStorageProfileId,
} from "./document-storage-profile.ts"
import {
  mintDocumentId,
  updateDocumentInventory,
} from "./document-inventory.ts"
import { DocumentProjectionError } from "./document-projections.ts"
import {
  DocumentSourceReadError,
  readDocumentSource,
} from "./document-source-reader.ts"
import { resolveDocAliasIn } from "./doc-aliases.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import { getDocArchiveInfoMap, readSpace, sanitizeDocPath } from "./store.ts"
import { withWidgetWriteLock } from "./widget-store.ts"
import { getWorkspaceRoot } from "./workspace.ts"

const DOCUMENT_READ_BUDGET: DocumentOperationBudget = {
  maxInputBytes: 512 * 1024,
  maxOutputBytes: 64 * 1024,
  maxDepth: 64,
  maxElements: 20_000,
  timeoutMs: 1_000,
}

export class DocumentSpaceNotFoundError extends Error {
  constructor(spaceId: string) {
    super(`Space not found: ${spaceId}`)
    this.name = "DocumentSpaceNotFoundError"
  }
}

interface QueryDocumentClaim {
  kind: "document"
  documentId: DocumentId
  identity: "durable" | "provisional"
  source: DocumentSource
  path: string
  format: DocumentFormatClaim
  title: string
  health: DocumentHealth
  updatedAt?: string
  folderMoveSupported: boolean
  folderArchiveSupported: boolean
  folderDeleteSupported: boolean
  catalogArchived?: boolean
  archiveProvider?: "legacy-doc-metadata"
  storageProfile: DocumentStorageProfileId | null
}

interface QueryAliasClaim {
  kind: "alias"
  path: string
  targetPath: string
}

type QueryClaim = QueryDocumentClaim | QueryAliasClaim

interface DocumentQueryContext {
  catalog: DocumentCatalog
  registry: DocumentFormatRegistry
  docArchives: ReadonlyMap<string, unknown>
}

type ClassifiedEntry =
  | {
      kind: "document"
      item: DocumentSummary
      claim: QueryDocumentClaim
    }
  | { kind: "conflict"; item: DocumentConflictItem }

type ClassifiedDocument = Extract<ClassifiedEntry, { kind: "document" }>

export interface DocumentReadWithView {
  result: DocumentReadResult
  documentView?: DocumentSpecializedView
}

export interface ResolvedDocumentHandle {
  documentId: DocumentId
  identity: "durable" | "provisional"
  document: DocumentSummary
  source: DocumentSource
  storageProfile: DocumentStorageProfileId | null
  rendererKey: string | null
  renderDisposition: DocumentRenderDisposition | null
  formatCapabilities: DocumentFormatCapabilityHints | null
  resolvedFrom?: string
}

export type DocumentHandleResolution =
  | { kind: "document"; handle: ResolvedDocumentHandle }
  | { kind: "conflict"; conflict: DocumentConflictItem; resolvedFrom?: string }
  | { kind: "not-found" }
  | { kind: "alias-error" }

export interface DocumentProjectionBudget {
  maxDocuments: number
  maxOutputBytes: number
  timeoutMs: number
}

export interface DocumentProjectionBudgetState {
  limits: DocumentProjectionBudget
  deadlineMs: number
  projectedDocuments: number
  projectedBytes: number
}

export function createDocumentProjectionBudgetState(
  limits: DocumentProjectionBudget
): DocumentProjectionBudgetState {
  return {
    limits,
    deadlineMs: performance.now() + limits.timeoutMs,
    projectedDocuments: 0,
    projectedBytes: 0,
  }
}

function claimsFor(entry: DocumentCatalogEntry): QueryClaim[] {
  if (entry.kind === "document") {
    return [
      {
        kind: "document",
        documentId: entry.descriptor.documentId,
        identity: entry.handle.identity,
        source: entry.handle.source,
        path: entry.descriptor.path,
        format: entry.descriptor.format,
        title: entry.descriptor.title,
        health: entry.descriptor.health,
        folderMoveSupported: Boolean(
          entry.handle.storageProfile &&
            documentStorageProfiles.get(entry.handle.storageProfile)
              .managedPrefixRename &&
            !entry.handle.diagnostics.some(
              (diagnostic) => diagnostic.severity === "error"
            )
        ),
        folderArchiveSupported: Boolean(
          entry.handle.storageProfile &&
            documentStorageProfiles.get(entry.handle.storageProfile)
              .archiveAdapter &&
            !entry.handle.diagnostics.some(
              (diagnostic) => diagnostic.severity === "error"
            )
        ),
        folderDeleteSupported: Boolean(
          entry.handle.storageProfile &&
            documentStorageProfiles.get(entry.handle.storageProfile)
              .deleteAdapter &&
            !entry.handle.diagnostics.some(
              (diagnostic) => diagnostic.severity === "error"
            )
        ),
        ...(entry.descriptor.updatedAt
          ? { updatedAt: entry.descriptor.updatedAt }
          : {}),
        ...(entry.handle.archived ? { catalogArchived: true } : {}),
        ...(entry.handle.archiveProvider
          ? { archiveProvider: entry.handle.archiveProvider }
          : {}),
        storageProfile: entry.handle.storageProfile,
      },
    ]
  }
  return entry.claims.map((claim) =>
    claim.kind === "alias"
      ? claim
      : {
          kind: "document",
          documentId: claim.documentId,
          identity: claim.identity,
          source: claim.source,
          path: claim.path,
          format: claim.format,
          title: claim.title,
          health: claim.health,
          folderMoveSupported: Boolean(
            claim.storageProfile &&
              documentStorageProfiles.get(claim.storageProfile)
                .managedPrefixRename &&
              !claim.diagnostics.some(
                (diagnostic) => diagnostic.severity === "error"
              )
          ),
          folderArchiveSupported: Boolean(
            claim.storageProfile &&
              documentStorageProfiles.get(claim.storageProfile)
                .archiveAdapter &&
              !claim.diagnostics.some(
                (diagnostic) => diagnostic.severity === "error"
              )
          ),
          folderDeleteSupported: Boolean(
            claim.storageProfile &&
              documentStorageProfiles.get(claim.storageProfile)
                .deleteAdapter &&
              !claim.diagnostics.some(
                (diagnostic) => diagnostic.severity === "error"
              )
          ),
          ...(claim.updatedAt ? { updatedAt: claim.updatedAt } : {}),
          ...(claim.archived ? { catalogArchived: true } : {}),
          ...(claim.archiveProvider
            ? { archiveProvider: claim.archiveProvider }
            : {}),
          storageProfile: claim.storageProfile,
        }
  )
}

function isArchived(
  claim: QueryDocumentClaim,
  docArchives: ReadonlyMap<string, unknown>
): boolean {
  return claim.archiveProvider === "legacy-doc-metadata"
    ? docArchives.has(claim.path)
    : claim.catalogArchived === true
}

function classifyEntry(
  entry: DocumentCatalogEntry,
  context: DocumentQueryContext,
  includeArchived: boolean
): ClassifiedEntry | null {
  const claims = claimsFor(entry).filter(
    (claim) =>
      claim.kind === "alias" ||
      includeArchived ||
      !isArchived(claim, context.docArchives)
  )
  if (!claims.some((claim) => claim.kind === "document")) return null
  if (claims.length === 1 && claims[0]?.kind === "document") {
    const claim = claims[0]
    return {
      kind: "document",
      claim,
      item: {
        kind: "document",
        path: claim.path,
        format: claim.format,
        title: claim.title,
        health: claim.health,
        folderOperations: {
          move: claim.folderMoveSupported,
          archive: claim.folderArchiveSupported,
          delete: claim.folderDeleteSupported,
        },
        ...(claim.updatedAt ? { updatedAt: claim.updatedAt } : {}),
        ...(isArchived(claim, context.docArchives) ? { archived: true } : {}),
      },
    }
  }

  return {
    kind: "conflict",
    item: {
      kind: "conflict",
      pathKey: entry.kind === "conflict" ? entry.pathKey : claims[0]!.path,
      health: "ambiguous",
      claims: claims.map((claim) =>
        claim.kind === "alias"
          ? {
              kind: "alias",
              path: claim.path,
              targetPath: claim.targetPath,
            }
          : {
              kind: "document",
              path: claim.path,
              format: claim.format,
              ...(isArchived(claim, context.docArchives)
                ? { archived: true }
                : {}),
            }
      ),
    },
  }
}

async function documentQueryContext(
  spaceId: string
): Promise<DocumentQueryContext> {
  const { data: space, error } = await readSpace(spaceId)
  if (error || !space) throw new DocumentSpaceNotFoundError(spaceId)

  const registry = createBuiltinDocumentFormatRegistry()
  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
    registry,
  })
  const allClaims = catalog.entries.flatMap(claimsFor)
  const docArchives = await getDocArchiveInfoMap(
    spaceId,
    allClaims.flatMap((claim) =>
      claim.kind === "document" &&
      claim.archiveProvider === "legacy-doc-metadata"
        ? [claim.path]
        : []
    )
  )
  return { catalog, registry, docArchives }
}

function entryKey(entry: DocumentCatalogEntry): string {
  if (entry.kind === "conflict") return entry.pathKey
  return (
    analyzeDocumentPath(entry.descriptor.path).comparisonKey ??
    entry.descriptor.path
  )
}

function findEntry(
  catalog: DocumentCatalog,
  path: string
): DocumentCatalogEntry | null {
  const analysis = analyzeDocumentPath(path)
  if (!analysis.safe || !analysis.comparisonKey) {
    throw new Error("Document path is unsafe")
  }
  return (
    catalog.entries.find(
      (entry) => entryKey(entry) === analysis.comparisonKey
    ) ?? null
  )
}

export async function listDocuments(options: {
  spaceId: string
  includeArchived?: boolean
}): Promise<DocumentListItem[]> {
  // Legacy Doc writes can replace one storage extension with another. Keep
  // catalog discovery and its resulting view in the same namespace snapshot.
  return withDocPathLock(options.spaceId, async () => {
    const context = await documentQueryContext(options.spaceId)
    return context.catalog.entries.flatMap((entry) => {
      const classified = classifyEntry(
        entry,
        context,
        options.includeArchived ?? false
      )
      return classified ? [classified.item] : []
    })
  })
}

function metadataOnly(
  document: DocumentSummary,
  reason:
    | "unsupported-format"
    | "unsupported-version"
    | "invalid"
    | "projection-unavailable"
    | "too-large"
    | "temporarily-unavailable",
  resolvedFrom?: string
): DocumentReadResult {
  return {
    kind: "document",
    document:
      reason === "invalid" || reason === "temporarily-unavailable"
        ? { ...document, health: reason }
        : document,
    ...(resolvedFrom ? { resolvedFrom } : {}),
    projection: { kind: "metadata-only", reason },
  }
}

interface PreparedDocumentRead {
  context: DocumentQueryContext
  classified: ClassifiedEntry
  resolvedFrom?: string
}

type PreparedDocumentReadResult =
  | { kind: "prepared"; prepared: PreparedDocumentRead }
  | { kind: "not-found" }
  | { kind: "alias-error" }

export type DocumentNavigationResolution =
  | { kind: "target"; target: DocumentNavigationTarget }
  | { kind: "not-found" | "conflict" }

interface PreparedProjectionOptions {
  budget?: DocumentProjectionBudgetState
}

export function legacySpecializedDocumentView(input: {
  path: string
  format: DocumentFormatClaim
  source: DocumentSource
  health: DocumentHealth
  allowHtmlFile?: boolean
}): DocumentSpecializedView | undefined {
  if (input.health !== "supported") return undefined
  if (
    input.source.kind === "file" &&
    sanitizeDocPath(input.path) === input.path &&
    ((input.format.id === "worktable.markdown" &&
      input.source.relativePath === `docs/${input.path}.md`) ||
      (input.format.id === "worktable.rich-text" &&
        input.source.relativePath === `docs/${input.path}.json`))
  ) {
    return "doc"
  }
  if (
    input.format.id === "worktable.html" &&
    ((input.source.kind === "bundle" &&
      input.source.relativePath === `widgets/${input.path}`) ||
      (input.allowHtmlFile &&
        input.source.kind === "file" &&
        input.source.relativePath === `docs/${input.path}.html`))
  ) {
    return "html"
  }
  return undefined
}

async function specializedViewFor(
  classified: ClassifiedDocument
): Promise<DocumentSpecializedView | undefined> {
  return legacySpecializedDocumentView({
    path: classified.claim.path,
    format: classified.claim.format,
    source: classified.claim.source,
    health: classified.item.health,
    allowHtmlFile: await usesDocumentVersionStoreV2(),
  })
}

async function projectClassifiedDocument(options: {
  spaceId: string
  context: DocumentQueryContext
  classified: ClassifiedDocument
  resolvedFrom?: string
  timeoutMs?: number
}): Promise<DocumentReadResult> {
  const { claim, item } = options.classified
  if (item.health === "unsupported-format") {
    return metadataOnly(item, "unsupported-format", options.resolvedFrom)
  }
  if (item.health === "unsupported-version") {
    return metadataOnly(item, "unsupported-version", options.resolvedFrom)
  }
  if (item.health === "invalid") {
    return metadataOnly(item, "invalid", options.resolvedFrom)
  }
  if (item.health === "temporarily-unavailable") {
    return metadataOnly(item, "temporarily-unavailable", options.resolvedFrom)
  }

  const adapter = options.context.registry.get(item.format.id)
  if (!adapter?.projectText) {
    return metadataOnly(item, "projection-unavailable", options.resolvedFrom)
  }
  if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
    return metadataOnly(item, "projection-unavailable", options.resolvedFrom)
  }
  const timeoutMs = Math.max(
    1,
    Math.min(
      options.timeoutMs ?? DOCUMENT_READ_BUDGET.timeoutMs,
      DOCUMENT_READ_BUDGET.timeoutMs
    )
  )
  const signal = AbortSignal.timeout(timeoutMs)
  const maxInputBytes = Math.min(
    adapter.projectionMaxInputBytes ?? DOCUMENT_READ_BUDGET.maxInputBytes,
    8 * 1024 * 1024
  )
  try {
    const projection = await adapter.projectText({
      source: claim.source,
      read: (maxBytes) =>
        readDocumentSource({
          spaceRoot: resolve(getWorkspaceRoot(), "spaces", options.spaceId),
          documentId: claim.documentId,
          format: claim.format,
          source: claim.source,
          maxBytes: Math.min(maxBytes, maxInputBytes),
          signal,
        }),
      budget: { ...DOCUMENT_READ_BUDGET, maxInputBytes, timeoutMs },
      signal,
    })
    return {
      kind: "document",
      document: item,
      ...(options.resolvedFrom ? { resolvedFrom: options.resolvedFrom } : {}),
      projection,
    }
  } catch (error) {
    if (error instanceof DocumentSourceReadError) {
      return metadataOnly(
        item,
        error.reason === "too-large"
          ? "too-large"
          : error.reason === "invalid-source"
            ? "invalid"
            : "temporarily-unavailable",
        options.resolvedFrom
      )
    }
    if (error instanceof DocumentProjectionError) {
      return metadataOnly(item, error.reason, options.resolvedFrom)
    }
    return metadataOnly(item, "temporarily-unavailable", options.resolvedFrom)
  }
}

/**
 * Project one Space for the derived common search index. Callers must apply
 * documents:read policy before invoking this function. Catalog discovery is
 * shared once per Space. A projection budget state may be shared across
 * Spaces so one search rebuild has one aggregate resource boundary.
 */
export async function projectDocumentsForSearch(options: {
  spaceId: string
  includeArchived?: boolean
  projectionBudget?: DocumentProjectionBudgetState
}): Promise<DocumentReadWithView[]> {
  // A search candidate's catalog claim and projection must describe the same
  // committed Doc snapshot while a storage-format transition is in flight.
  return withDocPathLock(options.spaceId, async () => {
    const context = await documentQueryContext(options.spaceId)
    const classified = context.catalog.entries.flatMap((entry) => {
      const item = classifyEntry(
        entry,
        context,
        options.includeArchived ?? false
      )
      return item ? [item] : []
    })
    const results: DocumentReadWithView[] = []
    const budget = options.projectionBudget
    for (const item of classified) {
      if (item.kind === "conflict") {
        results.push({ result: { kind: "conflict", conflict: item.item } })
        continue
      }
      const projected = await readPreparedDocumentTransactionally(
        {
          spaceId: options.spaceId,
          path: item.item.path,
          includeArchived: options.includeArchived,
        },
        { context, classified: item },
        budget ? { budget } : undefined
      )
      if (!projected) continue
      const { result } = projected
      const resultBytes =
        result.kind === "document" && result.projection.kind === "text"
          ? Buffer.byteLength(result.projection.text) +
            result.projection.headings.reduce(
              (total, heading) => total + Buffer.byteLength(heading),
              0
            )
          : 0
      if (
        budget &&
        result.kind === "document" &&
        result.projection.kind === "text" &&
        budget.projectedBytes + resultBytes > budget.limits.maxOutputBytes
      ) {
        results.push({
          result: metadataOnly(result.document, "projection-unavailable"),
          ...(projected.documentView
            ? { documentView: projected.documentView }
            : {}),
        })
        budget.projectedBytes = budget.limits.maxOutputBytes
        continue
      }
      if (budget) budget.projectedBytes += resultBytes
      results.push(projected)
    }
    return results
  })
}

async function prepareDocumentReadResult(options: {
  spaceId: string
  path: string
  includeArchived?: boolean
}): Promise<PreparedDocumentReadResult> {
  const context = await documentQueryContext(options.spaceId)
  let entry = findEntry(context.catalog, options.path)
  let classified = entry
    ? classifyEntry(entry, context, options.includeArchived ?? false)
    : null
  let resolvedFrom: string | undefined

  if (!classified) {
    const resolved = resolveDocAliasIn(context.catalog.aliases, options.path)
    if (!resolved) return { kind: "alias-error" }
    if (resolved !== options.path) {
      entry = findEntry(context.catalog, resolved)
      classified = entry
        ? classifyEntry(entry, context, options.includeArchived ?? false)
        : null
      resolvedFrom = options.path
    }
  }
  if (!classified) return { kind: "not-found" }
  return {
    kind: "prepared",
    prepared: {
      context,
      classified,
      ...(resolvedFrom ? { resolvedFrom } : {}),
    },
  }
}

async function prepareDocumentRead(options: {
  spaceId: string
  path: string
  includeArchived?: boolean
}): Promise<PreparedDocumentRead> {
  const result = await prepareDocumentReadResult(options)
  if (result.kind === "alias-error") {
    throw new Error("Document alias resolution failed")
  }
  if (result.kind === "not-found") {
    throw new Error(`Document not found: ${options.path}`)
  }
  return result.prepared
}

function legacyHtmlWidgetId(classified: ClassifiedEntry): string | null {
  if (classified.kind !== "document") return null
  const { claim } = classified
  if (
    claim.format.id !== BUILTIN_DOCUMENT_FORMATS.html ||
    claim.source.kind !== "bundle" ||
    !claim.source.relativePath.startsWith("widgets/") ||
    claim.source.relativePath.endsWith(".wtdoc")
  ) {
    return null
  }
  return claim.source.relativePath.slice("widgets/".length) || null
}

function refreshLegacyHtmlPrepared(
  prepared: PreparedDocumentRead,
  currentClaim: DocumentSourceClaim,
  includeArchived: boolean
): PreparedDocumentRead | null {
  if (prepared.classified.kind !== "document") return null
  if (currentClaim.archived && !includeArchived) return null

  const { classified } = prepared
  const health =
    classified.item.health === "invalid" ||
    currentClaim.diagnostics.some(
      (diagnostic) => diagnostic.severity === "error"
    )
      ? "invalid"
      : prepared.context.registry.health(currentClaim.format)
  const {
    updatedAt: _previousClaimUpdatedAt,
    catalogArchived: _previousClaimArchived,
    ...previousClaim
  } = classified.claim
  const {
    updatedAt: _previousItemUpdatedAt,
    archived: _previousItemArchived,
    ...previousItem
  } = classified.item
  return {
    ...prepared,
    classified: {
      kind: "document",
      claim: {
        ...previousClaim,
        source: currentClaim.source,
        path: currentClaim.path,
        format: currentClaim.format,
        title: currentClaim.title,
        health,
        ...(currentClaim.updatedAt
          ? { updatedAt: currentClaim.updatedAt }
          : {}),
        ...(currentClaim.archived ? { catalogArchived: true } : {}),
      },
      item: {
        ...previousItem,
        path: currentClaim.path,
        format: currentClaim.format,
        title: currentClaim.title,
        health,
        ...(currentClaim.updatedAt
          ? { updatedAt: currentClaim.updatedAt }
          : {}),
        ...(currentClaim.archived ? { archived: true } : {}),
      },
    },
  }
}

async function readPreparedDocument(
  prepared: PreparedDocumentRead,
  spaceId: string,
  options: { projectionAllowed: boolean; timeoutMs?: number }
): Promise<DocumentReadWithView> {
  const { context, classified, resolvedFrom } = prepared
  if (classified.kind === "conflict") {
    return {
      result: {
        kind: "conflict",
        conflict: classified.item,
        ...(resolvedFrom ? { resolvedFrom } : {}),
      },
    }
  }
  const documentView = await specializedViewFor(classified)
  const adapter = context.registry.get(classified.item.format.id)
  if (
    !options.projectionAllowed &&
    classified.item.health === "supported" &&
    adapter?.projectText
  ) {
    return {
      result: metadataOnly(
        classified.item,
        "projection-unavailable",
        resolvedFrom
      ),
      ...(documentView ? { documentView } : {}),
    }
  }
  return {
    result: await projectClassifiedDocument({
      spaceId,
      context,
      classified,
      resolvedFrom,
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
    }),
    ...(documentView ? { documentView } : {}),
  }
}

async function usePreparedDocumentTransactionally<T>(
  options: {
    spaceId: string
    includeArchived?: boolean
  },
  prepared: PreparedDocumentRead,
  use: (current: PreparedDocumentRead) => Promise<T> | T
): Promise<T | null> {
  const widgetId = legacyHtmlWidgetId(prepared.classified)
  if (!widgetId) return use(prepared)

  return withWidgetWriteLock(options.spaceId, widgetId, async () => {
    const currentClaim = await readLegacyHtmlClaim(
      resolve(getWorkspaceRoot(), "spaces", options.spaceId),
      widgetId
    )
    if (!currentClaim) return null
    const current = refreshLegacyHtmlPrepared(
      prepared,
      currentClaim,
      options.includeArchived ?? false
    )
    return current ? use(current) : null
  })
}

async function readPreparedDocumentTransactionally(
  options: {
    spaceId: string
    path: string
    includeArchived?: boolean
  },
  prepared: PreparedDocumentRead,
  projection: PreparedProjectionOptions = {}
): Promise<DocumentReadWithView | null> {
  const project = (current: PreparedDocumentRead) => {
    const budget = projection.budget
    const timeoutMs =
      budget === undefined ? undefined : budget.deadlineMs - performance.now()
    let projectionAllowed = true
    if (budget && current.classified.kind === "document") {
      const { item } = current.classified
      const canProject =
        item.health === "supported" &&
        Boolean(current.context.registry.get(item.format.id)?.projectText)
      if (canProject) {
        projectionAllowed =
          budget.projectedDocuments < budget.limits.maxDocuments &&
          budget.projectedBytes < budget.limits.maxOutputBytes &&
          (timeoutMs ?? 0) > 0
        if (projectionAllowed) budget.projectedDocuments += 1
      }
    }
    return readPreparedDocument(current, options.spaceId, {
      projectionAllowed,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })
  }
  return usePreparedDocumentTransactionally(options, prepared, project)
}

function handleForPrepared(
  prepared: PreparedDocumentRead
): DocumentHandleResolution {
  const { classified, context, resolvedFrom } = prepared
  if (classified.kind === "conflict") {
    return {
      kind: "conflict",
      conflict: classified.item,
      ...(resolvedFrom ? { resolvedFrom } : {}),
    }
  }
  const registration = context.registry.get(classified.item.format.id)
  return {
    kind: "document",
    handle: {
      documentId: classified.claim.documentId,
      identity: classified.claim.identity,
      document: classified.item,
      source: classified.claim.source,
      storageProfile: classified.claim.storageProfile,
      rendererKey: registration?.rendererKey ?? null,
      renderDisposition: registration?.renderDisposition ?? null,
      formatCapabilities: registration?.capabilities ?? null,
      ...(resolvedFrom ? { resolvedFrom } : {}),
    },
  }
}

/** Resolve one exact logical document to its private source handle. */
export async function useResolvedDocumentHandle<T>(
  options: {
    spaceId: string
    path: string
    includeArchived?: boolean
    /**
     * Assign a stable private ID before invoking the callback. This is reserved
     * for a user mutation that needs durable document-owned state; ordinary
     * reads keep newly discovered filesystem documents provisional.
     */
    materializeIdentity?: boolean
  },
  use: (handle: ResolvedDocumentHandle) => Promise<T> | T
): Promise<T | Exclude<DocumentHandleResolution, { kind: "document" }>> {
  try {
    return await withDocPathLock(options.spaceId, async () => {
      const result = await prepareDocumentReadResult(options)
      if (result.kind !== "prepared") return result
      return (
        (await usePreparedDocumentTransactionally(
          options,
          result.prepared,
          async (current) => {
            const resolution = handleForPrepared(current)
            if (resolution.kind !== "document") return resolution
            if (
              !options.materializeIdentity ||
              resolution.handle.identity === "durable"
            ) {
              return use(resolution.handle)
            }
            const documentId = mintDocumentId()
            await updateDocumentInventory(options.spaceId, {
              upsert: [
                {
                  documentId,
                  path: resolution.handle.document.path,
                  format: resolution.handle.document.format,
                  source: resolution.handle.source,
                },
              ],
            })
            return use({
              ...resolution.handle,
              documentId,
              identity: "durable",
            })
          }
        )) ?? { kind: "not-found" }
      )
    })
  } catch (error) {
    if (error instanceof DocumentSpaceNotFoundError) {
      return { kind: "not-found" }
    }
    throw error
  }
}

/** Resolve a portable path to its canonical common document route. */
export async function resolveDocumentNavigation(options: {
  spaceId: string
  path: string
  includeArchived?: boolean
}): Promise<DocumentNavigationResolution> {
  return withDocPathLock(options.spaceId, async () => {
    const result = await prepareDocumentReadResult(options)
    if (result.kind === "not-found") return { kind: "not-found" }
    if (result.kind === "alias-error") return { kind: "conflict" }

    const { classified, resolvedFrom } = result.prepared
    if (classified.kind === "conflict") return { kind: "conflict" }
    const view = await specializedViewFor(classified)

    return {
      kind: "target",
      target: {
        path: classified.item.path,
        ...(view ? { view } : {}),
        ...(resolvedFrom ? { resolvedFrom } : {}),
      },
    }
  })
}

export async function readDocumentWithView(options: {
  spaceId: string
  path: string
  includeArchived?: boolean
}): Promise<DocumentReadWithView> {
  // Preparation observes the owning source path, so it belongs in the same
  // transaction as projection rather than outside the Doc namespace lock.
  return withDocPathLock(options.spaceId, async () => {
    const prepared = await prepareDocumentRead(options)
    const result = await readPreparedDocumentTransactionally(options, prepared)
    if (!result) throw new Error(`Document not found: ${options.path}`)
    return result
  })
}

export async function readDocument(options: {
  spaceId: string
  path: string
  includeArchived?: boolean
}): Promise<DocumentReadResult> {
  return (await readDocumentWithView(options)).result
}
