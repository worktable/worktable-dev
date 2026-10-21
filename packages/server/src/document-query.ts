import { usesDocumentVersionStoreV2 } from "./document-version-compatibility-v2.ts"
import { lstat, opendir } from "node:fs/promises"
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
import { CanonicalIdSchema } from "@worktable/types"
import {
  buildDocumentCatalog,
  catalogBuildsStarted,
  catalogDocumentUnchanged,
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
import { resolveDocAliasIn, type DocAliases } from "./doc-aliases.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import {
  getDocMetaFactsMaps,
  getSpaceArchiveInfo,
  readSpace,
  sanitizeDocPath,
  type DocLifetimeFacts,
} from "./store.ts"
import { effectiveArchiveOn } from "./lifetime-rules.ts"
import { withWidgetReadLock } from "./widget-store.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { FINGERPRINT_TREE_MAX_ENTRIES } from "./file-fingerprint.ts"
import { readSpaceSnapshot } from "./workspace-read-model.ts"

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
  docLifetimes: ReadonlyMap<string, DocLifetimeFacts>
  spaceArchived: boolean
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
  /** The Space's aliases from the same catalog, mapping old paths to current ones. */
  aliases?: DocAliases
}

export type DocumentHandleResolution =
  | { kind: "document"; handle: ResolvedDocumentHandle }
  | { kind: "conflict"; conflict: DocumentConflictItem; resolvedFrom?: string }
  | { kind: "not-found" }
  | { kind: "alias-error" }

/** One current catalog entry of a Space, as seen by the search index. */
export interface SearchProjectionCandidate {
  /** Path comparison key; stable across case-only renames. */
  key: string
  /** Changes whenever the catalog's view of the entry changes. */
  revision: string
  /** Source modification time reported by the catalog, when known. */
  updatedAt?: string
  /** The projection, when this call projected the entry; null if it vanished. */
  read?: DocumentReadWithView | null
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
    const archived = isArchived(claim, context.docArchives)
    const lifetime =
      claim.archiveProvider === "legacy-doc-metadata"
        ? context.docLifetimes.get(claim.path)
        : undefined
    const archiveOn = archived
      ? undefined
      : effectiveArchiveOn(lifetime, claim.updatedAt)
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
        ...(lifetime?.createdAt ? { createdAt: lifetime.createdAt } : {}),
        ...(!archived && claim.archiveProvider === "legacy-doc-metadata"
          ? { lifetime: archiveOn ? ("temporary" as const) : ("durable" as const) }
          : {}),
        ...(archiveOn ? { archiveOn } : {}),
        ...(archived ? { archived: true } : {}),
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
  spaceId: string,
  signal?: AbortSignal
): Promise<DocumentQueryContext> {
  const { data: space, error } = await readSpace(spaceId)
  if (error || !space) throw new DocumentSpaceNotFoundError(spaceId)

  const registry = createBuiltinDocumentFormatRegistry()
  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
    registry,
    ...(signal ? { signal } : {}),
  })
  signal?.throwIfAborted()
  const allClaims = catalog.entries.flatMap(claimsFor)
  const metadataPaths = allClaims.flatMap((claim) =>
    claim.kind === "document" &&
    claim.archiveProvider === "legacy-doc-metadata"
      ? [claim.path]
      : []
  )
  const { archives: docArchives, lifetimes: docLifetimes } =
    await getDocMetaFactsMaps(spaceId, metadataPaths)
  return {
    catalog,
    registry,
    docArchives,
    docLifetimes,
    spaceArchived: Boolean(getSpaceArchiveInfo(space)),
  }
}

/**
 * The query context from the Space's read-model snapshot. Only for reads:
 * writers build fresh under the document path lock.
 */
function snapshotDocumentQueryContext(
  spaceId: string,
  options: { lockHeld?: boolean; refresh?: boolean; signal?: AbortSignal } = {}
): Promise<DocumentQueryContext> {
  if (!CanonicalIdSchema.safeParse(spaceId).success) {
    return Promise.reject(new DocumentSpaceNotFoundError(spaceId))
  }
  const workspaceRoot = getWorkspaceRoot()
  const spaceRoot = resolve(workspaceRoot, "spaces", spaceId)
  return readSpaceSnapshot({
    workspaceRoot,
    spaceId,
    sources: [
      "space.json",
      "documents.meta.json",
      "docs.meta.json",
      "doc-aliases.json",
    ].map((name) => resolve(spaceRoot, name)),
    trees: () => documentQueryInputTrees(spaceRoot),
    // An abandoned request stops its build and releases the Space.
    build: () => documentQueryContext(spaceId, options.signal),
    ...(options.lockHeld ? { lockHeld: true } : {}),
    ...(options.refresh ? { refresh: true } : {}),
  })
}

/**
 * Directories holding the rest of what the query context reads: sources
 * under docs and widgets, and the portable state that HTML Doc titles come
 * from. Annotations and version history beside that state are not read.
 */
async function documentQueryInputTrees(spaceRoot: string): Promise<string[]> {
  const dataRoot = resolve(spaceRoot, "document-data")
  const documentIds: string[] = []
  try {
    for await (const entry of await opendir(dataRoot)) {
      if (documentIds.length >= FINGERPRINT_TREE_MAX_ENTRIES) {
        throw new Error("document data exceeds the fingerprint entry limit")
      }
      documentIds.push(entry.name)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error
  }
  return [
    resolve(spaceRoot, "docs"),
    resolve(spaceRoot, "widgets"),
    ...documentIds.map((documentId) => resolve(dataRoot, documentId, "state")),
  ]
}

/** The Space's document catalog from its read-model snapshot, for reads. */
export async function readDocumentCatalogSnapshot(
  spaceId: string,
  options: { lockHeld?: boolean } = {}
): Promise<DocumentCatalog> {
  return (await snapshotDocumentQueryContext(spaceId, options)).catalog
}

/** A Space's durable documents by id, as one read-model snapshot sees them. */
export interface DocumentIdentities {
  /** Whether the Space itself is archived. */
  spaceArchived: boolean
  /**
   * Documents that open, with the path and title they have now. Archived
   * documents and those whose path another claim also holds are left out.
   */
  current: ReadonlyMap<string, { path: string; title: string }>
  /** Documents that are archived. */
  archived: ReadonlySet<string>
}

const identitiesByContext = new WeakMap<
  DocumentQueryContext,
  DocumentIdentities
>()

function documentIdentities(context: DocumentQueryContext): DocumentIdentities {
  const known = identitiesByContext.get(context)
  if (known) return known
  const current = new Map<string, { path: string; title: string }>()
  const archived = new Set<string>()
  for (const entry of context.catalog.entries) {
    if (entry.kind !== "document") continue
    for (const claim of claimsFor(entry)) {
      if (claim.kind !== "document" || claim.identity !== "durable") continue
      if (isArchived(claim, context.docArchives)) {
        archived.add(claim.documentId)
      } else {
        current.set(claim.documentId, { path: claim.path, title: claim.title })
      }
    }
  }
  const identities = {
    spaceArchived: context.spaceArchived,
    current,
    archived,
  }
  identitiesByContext.set(context, identities)
  return identities
}

/**
 * Where each durable document of a Space is now, from its read-model
 * snapshot: no lock and no file reads while the snapshot is current. Computed
 * once per snapshot.
 */
export async function readDocumentIdentities(
  spaceId: string,
  options: { lockHeld?: boolean } = {}
): Promise<{ catalog: DocumentCatalog; identities: DocumentIdentities }> {
  const context = await snapshotDocumentQueryContext(spaceId, options)
  return { catalog: context.catalog, identities: documentIdentities(context) }
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
  return (await listDocumentsWithAliases(options)).documents
}

/** listDocuments, with the document aliases of the same snapshot. */
export async function listDocumentsWithAliases(options: {
  spaceId: string
  includeArchived?: boolean
}): Promise<{ documents: DocumentListItem[]; aliases: DocAliases }> {
  // Legacy Doc writes can replace one storage extension with another. The
  // snapshot is built under the namespace lock, so catalog discovery and its
  // resulting view describe the same namespace state.
  const context = await snapshotDocumentQueryContext(options.spaceId)
  return {
    documents: context.catalog.entries.flatMap((entry) => {
      const classified = classifyEntry(
        entry,
        context,
        options.includeArchived ?? false
      )
      return classified ? [classified.item] : []
    }),
    aliases: context.catalog.aliases,
  }
}

export interface DocumentLifetimeTarget {
  path: string
  archived: boolean
  /** Whether this document's storage records a lifetime. */
  supported: boolean
  /** The lifetime fields document lists report for this document. */
  view: Pick<DocumentSummary, "createdAt" | "lifetime" | "archiveOn">
}

/**
 * Every document in a Space with whether it can carry a lifetime. Conflicting
 * paths are omitted: their identity must be resolved before changing them.
 */
export async function listDocumentLifetimeTargets(
  spaceId: string
): Promise<DocumentLifetimeTarget[]> {
  return withDocPathLock(spaceId, () =>
    listDocumentLifetimeTargetsLocked(spaceId)
  )
}

/**
 * As listDocumentLifetimeTargets, for callers already holding the doc-path
 * lock. Only a read may ask for the read-model snapshot.
 */
export async function listDocumentLifetimeTargetsLocked(
  spaceId: string,
  options: { snapshot?: boolean } = {}
): Promise<DocumentLifetimeTarget[]> {
  {
    const context = options.snapshot
      ? await snapshotDocumentQueryContext(spaceId, { lockHeld: true })
      : await documentQueryContext(spaceId)
    return context.catalog.entries.flatMap((entry) => {
      const classified = classifyEntry(entry, context, true)
      if (!classified || classified.kind !== "document") return []
      const { createdAt, lifetime, archiveOn } = classified.item
      return [
        {
          path: classified.claim.path,
          archived: classified.item.archived === true,
          supported:
            classified.claim.archiveProvider === "legacy-doc-metadata",
          view: {
            ...(createdAt ? { createdAt } : {}),
            ...(lifetime ? { lifetime } : {}),
            ...(archiveOn ? { archiveOn } : {}),
          },
        },
      ]
    })
  }
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
  const timeoutMs = DOCUMENT_READ_BUDGET.timeoutMs
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

async function searchCandidate(
  spaceId: string,
  item: ClassifiedEntry
): Promise<SearchProjectionCandidate> {
  if (item.kind === "conflict") {
    return { key: item.item.pathKey, revision: JSON.stringify(item.item) }
  }
  let revision = JSON.stringify([item.item, item.claim.source])
  let updatedAt = item.item.updatedAt
  // A legacy HTML bundle dates itself from widget.yaml, which an outside edit
  // of its index.html does not touch. Its revision includes the page itself.
  if (legacyHtmlWidgetId(item)) {
    const page = await lstat(
      resolve(
        getWorkspaceRoot(),
        "spaces",
        spaceId,
        item.claim.source.relativePath,
        "index.html"
      )
    ).catch(() => null)
    revision += page ? `\0${page.ino}:${page.size}:${page.mtimeMs}` : "\0missing"
    if (page && !(Date.parse(updatedAt ?? "") >= page.mtimeMs)) {
      updatedAt = page.mtime.toISOString()
    }
  }
  return {
    key: analyzeDocumentPath(item.item.path).comparisonKey ?? item.item.path,
    revision,
    ...(updatedAt ? { updatedAt } : {}),
  }
}

/**
 * Project one Space for the derived common search index. Callers must apply
 * documents:read policy before invoking this function. Every current catalog
 * entry comes back as a candidate with its revision, and only the candidates
 * `shouldProject` selects are projected. With `projectionMs`, projection stops
 * once that long has passed after catalog discovery, leaving `complete` false;
 * at least one selected candidate is always projected. Callers continue in
 * another call, so the Space lock is never held for a whole large Space.
 */
export async function projectDocumentsForSearch(options: {
  spaceId: string
  includeArchived?: boolean
  shouldProject?: (candidate: SearchProjectionCandidate) => boolean
  projectionMs?: number
}): Promise<{ candidates: SearchProjectionCandidate[]; complete: boolean }> {
  // A search candidate's catalog claim and projection must describe the same
  // committed Doc snapshot while a storage-format transition is in flight.
  return withDocPathLock(options.spaceId, async () => {
    const startedAt = performance.now()
    const context = await documentQueryContext(options.spaceId)
    const classified = context.catalog.entries.flatMap((entry) => {
      const item = classifyEntry(
        entry,
        context,
        options.includeArchived ?? false
      )
      return item ? [item] : []
    })
    // Project for at least as long as discovery took, so a sliced build is
    // not dominated by repeating discovery for every slice.
    const discoveredAt = performance.now()
    const deadline =
      options.projectionMs === undefined
        ? Number.POSITIVE_INFINITY
        : discoveredAt +
          Math.max(options.projectionMs, discoveredAt - startedAt)
    const candidates: SearchProjectionCandidate[] = []
    let projected = 0
    let complete = true
    for (const item of classified) {
      const candidate = await searchCandidate(options.spaceId, item)
      candidates.push(candidate)
      if (options.shouldProject && !options.shouldProject(candidate)) continue
      if (projected > 0 && performance.now() >= deadline) {
        complete = false
        continue
      }
      projected += 1
      candidate.read =
        item.kind === "conflict"
          ? { result: { kind: "conflict", conflict: item.item } }
          : await readPreparedDocumentTransactionally(
              {
                spaceId: options.spaceId,
                path: item.item.path,
                includeArchived: options.includeArchived,
              },
              { context, classified: item }
            )
    }
    return { candidates, complete }
  })
}

interface DocumentReadOptions {
  spaceId: string
  path: string
  includeArchived?: boolean
  signal?: AbortSignal
  /**
   * Resolve the path through the Space's read-model snapshot. Only for
   * reads: the document found is checked against its files, and anything
   * else is decided from a fresh build.
   */
  snapshot?: boolean
}

async function prepareDocumentReadResult(
  options: DocumentReadOptions
): Promise<PreparedDocumentReadResult> {
  if (!options.snapshot) {
    return prepareFromContext(
      await documentQueryContext(options.spaceId, options.signal),
      options
    )
  }
  // Callers hold the Space's document path lock.
  const buildsBefore = catalogBuildsStarted()
  const context = await snapshotDocumentQueryContext(options.spaceId, {
    lockHeld: true,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  const snapshot = prepareFromContext(context, options)
  options.signal?.throwIfAborted()
  // A catalog built since this read began already saw the files as they are.
  if (context.catalog.derivedFrom.build > buildsBefore) return snapshot
  if (
    snapshot.kind === "prepared" &&
    snapshot.prepared.classified.kind === "document" &&
    (await catalogDocumentUnchanged(snapshot.prepared.context.catalog, {
      workspaceRoot: getWorkspaceRoot(),
      spaceId: options.spaceId,
      documentId: snapshot.prepared.classified.claim.documentId,
      path: snapshot.prepared.classified.claim.path,
      source: snapshot.prepared.classified.claim.source,
    }))
  ) {
    return snapshot
  }
  // Not found, a conflict, an alias problem, or a document whose files
  // changed since the snapshot: decide from the files, and publish that.
  return prepareFromContext(
    await snapshotDocumentQueryContext(options.spaceId, {
      lockHeld: true,
      refresh: true,
      ...(options.signal ? { signal: options.signal } : {}),
    }),
    options
  )
}

function prepareFromContext(
  context: DocumentQueryContext,
  options: { path: string; includeArchived?: boolean }
): PreparedDocumentReadResult {
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

async function prepareDocumentRead(
  options: DocumentReadOptions
): Promise<PreparedDocumentRead> {
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
  spaceId: string
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
  return {
    result: await projectClassifiedDocument({
      spaceId,
      context,
      classified,
      resolvedFrom,
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

  return withWidgetReadLock(options.spaceId, widgetId, async () => {
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
  prepared: PreparedDocumentRead
): Promise<DocumentReadWithView | null> {
  return usePreparedDocumentTransactionally(options, prepared, (current) =>
    readPreparedDocument(current, options.spaceId)
  )
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
      aliases: context.catalog.aliases,
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
    /** Internal callers already serializing a namespace mutation must not relock it. */
    namespaceLockHeld?: boolean
    /**
     * A read that may resolve the path through the Space's read-model
     * snapshot. Ignored when an identity may be materialized.
     */
    snapshot?: boolean
    /**
     * Abandon the read once the caller gives up: stop waiting for the Space
     * lock, stop catalog discovery, and never invoke the callback.
     */
    signal?: AbortSignal
  },
  use: (handle: ResolvedDocumentHandle) => Promise<T> | T
): Promise<T | Exclude<DocumentHandleResolution, { kind: "document" }>> {
  try {
    const read = async () => {
      const result = await prepareDocumentReadResult({
        ...options,
        snapshot: Boolean(options.snapshot && !options.materializeIdentity),
      })
      if (result.kind !== "prepared") return result
      options.signal?.throwIfAborted()
      return (
        (await usePreparedDocumentTransactionally(
          options,
          result.prepared,
          async (current) => {
            // A legacy HTML read may have waited for its widget lock.
            options.signal?.throwIfAborted()
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
    }
    return await (options.namespaceLockHeld
      ? read()
      : withDocPathLock(options.spaceId, read, options.signal))
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
    const result = await prepareDocumentReadResult({
      ...options,
      snapshot: true,
    })
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
    const prepared = await prepareDocumentRead({ ...options, snapshot: true })
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
