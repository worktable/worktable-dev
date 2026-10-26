import { teamsEnabled } from "./team-database.ts"
import { canAccessSpace, commentAccess } from "./team-policy.ts"
import { extname, resolve } from "node:path"
import type {
  Annotation,
  DocumentAnnotationV2,
  DocumentBacklink,
  DocumentReferrer,
  DocumentCollaboration,
  DocumentContributors,
  DocumentContent,
  DocumentPage,
  DocumentPageResult,
  DocumentProvenance,
  DocumentRenderDisposition,
  DocumentSharingSummary,
  DocumentVersionSummary,
} from "@worktable/types"
import { listAnnotations } from "./annotation-store.ts"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import {
  DOC_CONTENT_MAX_BYTES,
  docContentRevision,
  docSourceContentRevision,
  docStoredAs,
  htmlContentRevisionOf,
  sha256Hex,
} from "./document-content-revision.ts"
import { listDocumentAnnotationsForHandle } from "./document-annotation-service.ts"
import {
  legacySpecializedDocumentView,
  readDocumentCatalogSnapshot,
  type DocumentHandleResolution,
  type ResolvedDocumentHandle,
  useResolvedDocumentHandle,
} from "./document-query.ts"
import { pathMovesFor } from "./doc-aliases.ts"
import {
  BUILTIN_DOCUMENT_FORMATS,
  createBuiltinDocumentFormatRegistry,
} from "./document-format-registry.ts"
import {
  DOCUMENT_STORAGE_PROFILE_IDS,
  type DocumentStorageProfileId,
} from "./document-storage-profile.ts"
import {
  DocumentSourceReadError,
  readDocumentSource,
} from "./document-source-reader.ts"
import { peekDocActivity } from "./activity-log.ts"
import { peekDocBacklinks, peekDocOutbound } from "./link-graph.ts"
import { filesPreviewEnabled } from "./files-preview.ts"
import { peekDocReferrers } from "./doc-referrers.ts"
import {
  documentShareLinkSummary,
  ShareLinksStoreError,
} from "./share-links-store.ts"
import { creatorMayShare, currentSharingPolicy } from "./share-policy.ts"
import { getDocMetaView, listDocVersions, readSpace } from "./store.ts"
import type { VersionEntry } from "./version-store.ts"
import {
  listCompatibleDocumentVersionsV2,
  type CompatibleDocumentVersionSummary,
  type LegacyDocumentVersionLocator,
} from "./document-version-store-v2.ts"
import {
  getWidgetProvenance,
  listWidgetVersions,
} from "./widget-version-store.ts"
import { readWidgetDocument } from "./widget-store.ts"
import { getWorkspaceRoot } from "./workspace.ts"
import { readWorkspaceStorageLayoutAt } from "./workspace-storage-v2.ts"

const RAW_SOURCE_MAX_BYTES = 64 * 1024 * 1024
const RAW_SOURCE_TIMEOUT_MS = 30_000

type LegacyShareKind = "doc" | "html"

interface DocumentPageMetadata {
  provenance?: DocumentProvenance
  revision?: string
  collaboration?: DocumentCollaboration
  backlinks?: DocumentBacklink[]
  referrers?: DocumentReferrer[]
  contributors?: DocumentContributors
  embeds?: Record<string, string>
  version?: string
  networkRequested?: true
}

/**
 * The version of each file a Doc links to or embeds, from the cached link
 * graph and the catalog snapshot, so its files load from addresses a
 * browser keeps without asking again.
 */
async function embedVersions(
  spaceId: string,
  docPath: string
): Promise<Record<string, string> | undefined> {
  if (!filesPreviewEnabled()) return undefined
  const targets = peekDocOutbound(spaceId, docPath)
  if (!targets || targets.length === 0) return undefined
  // A page reads under the Space's lock, which this read must not take again.
  const catalog = await readDocumentCatalogSnapshot(spaceId, { lockHeld: true })
  const wanted = new Set(targets)
  const embeds: Record<string, string> = {}
  for (const entry of catalog.entries) {
    if (
      entry.kind === "document" &&
      entry.descriptor.format.id === BUILTIN_DOCUMENT_FORMATS.file &&
      entry.handle.sourceStamp &&
      wanted.has(entry.descriptor.path)
    ) {
      embeds[entry.descriptor.path] = entry.handle.sourceStamp
    }
  }
  return Object.keys(embeds).length > 0 ? embeds : undefined
}

interface DocumentPageIntegration {
  rendererKey: string
  renderDisposition: DocumentRenderDisposition
  storageProfiles: readonly DocumentStorageProfileId[]
  legacyShareKind: LegacyShareKind
  annotationTarget: (path: string) => { docPath: string } | { widgetId: string }
  readMetadata: (
    spaceId: string,
    handle: ResolvedDocumentHandle
  ) => Promise<DocumentPageMetadata | null>
  listVersions: (spaceId: string, path: string) => Promise<VersionEntry[]>
}

const PAGE_INTEGRATIONS: readonly DocumentPageIntegration[] = [
  {
    rendererKey: "doc",
    renderDisposition: "trusted-component",
    storageProfiles: [DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile],
    legacyShareKind: "doc",
    annotationTarget: (path) => ({ docPath: path }),
    async readMetadata(spaceId, handle) {
      const [meta, epoch, revision, embeds] = await Promise.all([
        getDocMetaView(spaceId, handle.document.path),
        getWorkspaceCollaborationEpoch(),
        docSourceContentRevision(spaceId, handle.source),
        embedVersions(spaceId, handle.document.path),
      ])
      // Backlinks and who has worked on the doc come from per-Space caches
      // that answer without reading files. A Space whose cache is not built
      // yet leaves them out until its background build lands. Both keep the
      // paths docs had when they were recorded; the Space's aliases say where
      // those docs are now.
      // The moves are indexed once per alias set, so a read looks up this
      // doc's entries instead of resolving every path in the Space.
      const path = handle.document.path
      const moves = pathMovesFor(handle.aliases)
      const backlinks = peekDocBacklinks(spaceId, path, moves)
      const referrers = peekDocReferrers(spaceId, path, moves.current)
      const activity = peekDocActivity(spaceId, path, moves)
      return {
        ...(meta.provenance ? { provenance: meta.provenance } : {}),
        ...(revision ? { revision } : {}),
        ...(backlinks ? { backlinks } : {}),
        ...(referrers ? { referrers } : {}),
        ...(embeds ? { embeds } : {}),
        ...(activity
          ? {
              contributors: {
                ...(activity.lastEditor
                  ? { lastEditor: activity.lastEditor }
                  : {}),
                recent: activity.contributors,
              },
            }
          : {}),
        collaboration: {
          epoch,
          cacheEpoch: meta.collaborationCacheEpoch,
          cacheEpochHistory: meta.collaborationCacheEpochHistory,
        },
      }
    },
    listVersions: (spaceId, path) => listDocVersions(spaceId, path),
  },
  {
    rendererKey: "html",
    renderDisposition: "opaque-sandbox",
    storageProfiles: [
      DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle,
      DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile,
    ],
    legacyShareKind: "html",
    annotationTarget: (path) => ({ widgetId: path }),
    async readMetadata(spaceId, handle) {
      const path = handle.document.path
      const { data: document } = await readWidgetDocument(spaceId, path)
      if (!document) return null
      const provenance = await getWidgetProvenance(spaceId, path)
      return {
        ...(provenance ? { provenance } : {}),
        revision: htmlContentRevisionOf(document),
        ...(document.widget.requests?.network ? { networkRequested: true as const } : {}),
      }
    },
    listVersions: (spaceId, path) => listWidgetVersions(spaceId, path),
  },
]

async function pageIntegration(
  handle: ResolvedDocumentHandle
): Promise<DocumentPageIntegration | null> {
  if (
    handle.document.health !== "supported" ||
    !handle.rendererKey ||
    !handle.renderDisposition ||
    !handle.storageProfile
  ) {
    return null
  }
  const legacyView = legacySpecializedDocumentView({
    path: handle.document.path,
    format: handle.document.format,
    source: handle.source,
    health: handle.document.health,
    allowHtmlFile: await usesDocumentStorageV2(),
  })
  if (legacyView !== handle.rendererKey) return null
  return (
    PAGE_INTEGRATIONS.find(
      (integration) =>
        integration.rendererKey === handle.rendererKey &&
        integration.renderDisposition === handle.renderDisposition &&
        integration.storageProfiles.includes(handle.storageProfile!)
    ) ?? null
  )
}

/**
 * How a document is shared by link: as a Doc or an HTML Doc, or null when it
 * has no safe public projection. The page's sharing capability uses the same
 * test.
 */
export async function publicShareKind(
  handle: ResolvedDocumentHandle
): Promise<LegacyShareKind | null> {
  if (handle.formatCapabilities?.publicProjection !== "safe") return null
  return (await pageIntegration(handle))?.legacyShareKind ?? null
}

function rendererForHandle(
  handle: ResolvedDocumentHandle,
  integration: DocumentPageIntegration | null,
  storageV2: boolean
): DocumentPage["renderer"] {
  if (
    handle.document.health !== "supported" ||
    !handle.rendererKey ||
    !handle.renderDisposition ||
    handle.renderDisposition === "attachment-only"
  ) {
    return null
  }
  // The existing Doc and HTML renderers still read through their legacy APIs,
  // so expose them only for the storage profiles those APIs understand. New
  // renderer keys consume the common document APIs and do not need a second
  // server registration merely to become routable.
  const hasLegacyIntegration = PAGE_INTEGRATIONS.some(
    (candidate) => candidate.rendererKey === handle.rendererKey
  )
  if (hasLegacyIntegration && !integration) return null
  // The common replace-authoring APIs require V2 storage. Keep copied sources
  // downloadable on older workspaces without opening an editor that cannot save.
  if (
    !hasLegacyIntegration &&
    !storageV2 &&
    handle.formatCapabilities?.authoring === "replace"
  )
    return null
  return {
    key: handle.rendererKey,
    disposition: handle.renderDisposition,
  }
}

function publicVersion(
  version: VersionEntry | CompatibleDocumentVersionSummary
): DocumentVersionSummary {
  return {
    ...("store" in version ? { store: version.store } : {}),
    id: version.id,
    createdAt: version.createdAt,
    createdBy: version.createdBy,
    source: version.source,
    operation: version.operation,
    ...(version.reason ? { reason: version.reason } : {}),
    ...(version.checkpoint
      ? {
          checkpoint: {
            meaningful: version.checkpoint.meaningful,
            kind: version.checkpoint.kind,
            ...(version.checkpoint.label
              ? { label: version.checkpoint.label }
              : {}),
          },
        }
      : {}),
  }
}

function legacyVersionLocator(
  handle: ResolvedDocumentHandle
): LegacyDocumentVersionLocator | undefined {
  const kind = createBuiltinDocumentFormatRegistry().get(
    handle.document.format.id
  )?.legacyVersionKind
  return kind ? { kind, key: handle.document.path } : undefined
}

async function usesDocumentStorageV2(): Promise<boolean> {
  return (await readWorkspaceStorageLayoutAt(getWorkspaceRoot())).kind === "v2"
}

/** A file's page names the Docs that use it, from the same cached graph. */
function fileMetadata(
  spaceId: string,
  handle: ResolvedDocumentHandle
): DocumentPageMetadata {
  const moves = pathMovesFor(handle.aliases)
  const backlinks = peekDocBacklinks(spaceId, handle.document.path, moves)
  // Records whose file fields name it use it too.
  const referrers = peekDocReferrers(spaceId, handle.document.path, moves.current)
  return {
    ...(backlinks ? { backlinks } : {}),
    ...(referrers ? { referrers } : {}),
    ...(handle.sourceStamp ? { version: handle.sourceStamp } : {}),
  }
}

async function pageForHandle(
  spaceId: string,
  handle: ResolvedDocumentHandle,
  rawSourceAuthorized: boolean,
  annotationsAuthorized: boolean,
  sharingAuthorized: boolean,
  recordsAuthorized = false,
  canCreateShareLinks = true,
  visitorComments?: (documentId: string) => Promise<DocumentSharingSummary["visitorComments"]>
): Promise<DocumentPage> {
  const integration = await pageIntegration(handle)
  const storageV2 = await usesDocumentStorageV2()
  const metadata = integration
    ? await integration.readMetadata(spaceId, handle)
    : handle.document.format.id === BUILTIN_DOCUMENT_FORMATS.file
      ? fileMetadata(spaceId, handle)
      : null
  const { data: space } = sharingAuthorized
    ? await readSpace(spaceId)
    : { data: null }
  const sharing = Boolean(
    sharingAuthorized &&
    integration &&
    handle.formatCapabilities?.publicProjection === "safe" &&
    space &&
    !space.settings["archive"] &&
    !handle.document.archived
  )
  const renderer = rendererForHandle(handle, integration, storageV2)
  const links = sharing
    ? sharingSummary(spaceId, handle, canCreateShareLinks)
    : undefined
  const visitorSummary = visitorComments && handle.identity === "durable" && !handle.document.archived
    ? await visitorComments(handle.documentId)
    : undefined
  return {
    kind: "document",
    document: handle.document,
    ...(handle.resolvedFrom ? { resolvedFrom: handle.resolvedFrom } : {}),
    renderer,
    capabilities: {
      ...(teamsEnabled()
        ? {
            edit: canAccessSpace(spaceId, "edit"),
            comment: canAccessSpace(spaceId, commentAccess()),
          }
        : {}),
      rawSource: rawSourceAuthorized && handle.document.health !== "invalid",
      versions:
        (storageV2 && handle.identity === "durable") || Boolean(integration),
      annotations:
        annotationsAuthorized &&
        ((storageV2 && handle.identity === "durable") || Boolean(integration)),
      sharing,
      ...(sharing && integration
        ? { legacyShareKind: integration.legacyShareKind }
        : {}),
    },
    ...(metadata?.provenance ? { provenance: metadata.provenance } : {}),
    // Without a renderer there is nothing to read by revision.
    ...(renderer && metadata?.revision ? { revision: metadata.revision } : {}),
    ...(renderer && metadata?.collaboration
      ? { collaboration: metadata.collaboration }
      : {}),
    ...(metadata?.backlinks ? { backlinks: metadata.backlinks } : {}),
    ...(metadata?.referrers
      ? {
          referrers: metadata.referrers.filter(
            (referrer) => recordsAuthorized || referrer.kind !== "record"
          ),
        }
      : {}),
    ...(metadata?.contributors ? { contributors: metadata.contributors } : {}),
    ...(metadata?.embeds ? { embeds: metadata.embeds } : {}),
    ...(metadata?.version ? { version: metadata.version } : {}),
    ...(metadata?.networkRequested ? { networkRequested: true as const } : {}),
    ...(links || visitorSummary ? { sharing: {...(links ?? {activeLinks: 0, canCreate: false}), ...(visitorSummary ? {visitorComments: visitorSummary} : {})} } : {}),
  }
}

/**
 * The page's sharing, so the page needs no request of
 * its own for it: a policy revision read and an indexed aggregate, and none for a document
 * that has never had a durable id, which every link needs. Only links the
 * owner policy lets open now count as active.
 */
function sharingSummary(
  spaceId: string,
  handle: ResolvedDocumentHandle,
  canCreate: boolean
): DocumentSharingSummary | undefined {
  try {
    if (handle.identity !== "durable") return { activeLinks: 0, canCreate }
    const policy = currentSharingPolicy()
    const allowed =
      !policy.paused &&
      (policy.levels.includes("view") || policy.levels.includes("comment")) &&
      (policy.spaces.mode === "all" || policy.spaces.spaceIds.includes(spaceId))
    const summary = allowed
      ? documentShareLinkSummary(
          spaceId,
          handle.documentId,
          Date.now(),
          policy.maxExpiryDays,
          (creator) => creatorMayShare(creator, spaceId, policy),
          policy.requirePassword,
          policy.liveLinks,
          policy.levels
        )
      : { activeLinks: 0, nextExpiry: null }
    return {
      activeLinks: summary.activeLinks,
      canCreate,
      ...(summary.nextExpiry !== null
        ? { nextExpiry: new Date(summary.nextExpiry).toISOString() }
        : {}),
    }
  } catch (error) {
    // A store this version can't open shares nothing; the page still opens.
    if (error instanceof ShareLinksStoreError) return undefined
    throw error
  }
}

export async function readDocumentPage(options: {
  spaceId: string
  path: string
  includeArchived?: boolean
  rawSourceAuthorized: boolean
  annotationsAuthorized: boolean
  /** Whether records that point at the doc may be named. */
  recordsAuthorized?: boolean
  sharingAuthorized: boolean
  /**
   * Whether the reader may make a share link now. Only a hint for the share
   * dialog; making a link checks again.
   */
  canCreateShareLinks?: boolean
  visitorComments?: (documentId: string) => Promise<DocumentSharingSummary["visitorComments"]>
}): Promise<DocumentPageResult | { kind: "alias-error" } | null> {
  const resolution = await useResolvedDocumentHandle(
    { ...options, snapshot: true },
    (handle) =>
      pageForHandle(
        options.spaceId,
        handle,
        options.rawSourceAuthorized,
        options.annotationsAuthorized,
        options.sharingAuthorized,
        options.recordsAuthorized ?? false,
        options.canCreateShareLinks ?? true,
        options.visitorComments
      )
  )
  if (resolution.kind === "not-found") return null
  if (resolution.kind === "alias-error") return resolution
  if (resolution.kind === "conflict") {
    return {
      kind: "conflict",
      conflict: resolution.conflict,
      ...(resolution.resolvedFrom
        ? { resolvedFrom: resolution.resolvedFrom }
        : {}),
    }
  }
  return resolution
}

export type DocumentVersionsResolution =
  | { kind: "versions"; versions: DocumentVersionSummary[] }
  | Exclude<DocumentHandleResolution, { kind: "document" }>
  | { kind: "unsupported" }

export async function readDocumentVersions(options: {
  spaceId: string
  path: string
  includeArchived?: boolean
  checkpointsOnly?: boolean
}): Promise<DocumentVersionsResolution> {
  return useResolvedDocumentHandle(
    { ...options, snapshot: true },
    async (handle) => {
      if ((await usesDocumentStorageV2()) && handle.identity === "durable") {
        const versions = await listCompatibleDocumentVersionsV2({
          workspaceRoot: getWorkspaceRoot(),
          spaceId: options.spaceId,
          documentId: handle.documentId,
          legacy: legacyVersionLocator(handle),
          checkpointsOnly: options.checkpointsOnly,
        })
        return {
          kind: "versions" as const,
          versions: versions.map(publicVersion),
        }
      }
      const integration = await pageIntegration(handle)
      if (!integration) return { kind: "unsupported" } as const
      const versions = await integration.listVersions(
        options.spaceId,
        handle.document.path
      )
      return {
        kind: "versions" as const,
        versions: versions
          .filter(
            (version) =>
              !options.checkpointsOnly ||
              version.checkpoint?.meaningful === true
          )
          .map(publicVersion),
      }
    }
  )
}

export type DocumentAnnotationsResolution =
  | {
      kind: "annotations"
      annotations: Array<Annotation | DocumentAnnotationV2>
      total: number
      nextOffset?: number
    }
  | Exclude<DocumentHandleResolution, { kind: "document" }>
  | { kind: "unsupported" }

export async function readDocumentAnnotations(options: {
  spaceId: string
  path: string
  includeArchived?: boolean
  includeResolved?: boolean
  limit?: number
  offset?: number
}): Promise<DocumentAnnotationsResolution> {
  return useResolvedDocumentHandle(
    { ...options, snapshot: true },
    async (handle) => {
      if ((await usesDocumentStorageV2()) && handle.identity === "durable") {
        const listed = await listDocumentAnnotationsForHandle({
          spaceId: options.spaceId,
          documentId: handle.documentId,
          path: handle.document.path,
          formatId: handle.document.format.id,
          includeResolved: options.includeResolved,
          limit: options.limit,
          offset: options.offset,
        })
        return { kind: "annotations" as const, ...listed }
      }
      const integration = await pageIntegration(handle)
      if (!integration) return { kind: "unsupported" } as const
      const listed = await listAnnotations(options.spaceId, {
        target: integration.annotationTarget(handle.document.path),
        includeResolved: options.includeResolved,
        limit: options.limit,
        offset: options.offset,
      })
      return {
        kind: "annotations" as const,
        annotations: listed.annotations,
        total: listed.total,
        ...(listed.nextOffset !== undefined
          ? { nextOffset: listed.nextOffset }
          : {}),
      }
    }
  )
}

export interface RawDocumentSource {
  bytes: Uint8Array
  fileName: string
  formatId: string
  /** What the source's bytes are, as the catalog saw them. */
  version?: string
}

export type RawDocumentSourceResolution =
  | { kind: "source"; source: RawDocumentSource }
  | { kind: "unavailable" }
  | Exclude<DocumentHandleResolution, { kind: "document" }>

function sourceFileName(handle: ResolvedDocumentHandle): string {
  const leaf = handle.document.path.split("/").at(-1) || "document"
  // A file's path already ends with its whole name.
  if (handle.document.format.id === BUILTIN_DOCUMENT_FORMATS.file) return leaf
  const sourceExtension =
    handle.source.kind === "file" ? extname(handle.source.relativePath) : ""
  const registry = createBuiltinDocumentFormatRegistry()
  const extension =
    sourceExtension || registry.get(handle.document.format.id)?.extensions[0]
  return `${leaf}${extension || ".bin"}`
}

export async function readRawDocumentSource(options: {
  spaceId: string
  path: string
  includeArchived?: boolean
}): Promise<RawDocumentSourceResolution> {
  return useResolvedDocumentHandle(
    { ...options, snapshot: true },
    async (handle) => {
      if (handle.document.health === "invalid") {
        return { kind: "unavailable" } as const
      }
      const bytes = await readDocumentSource({
        spaceRoot: resolve(getWorkspaceRoot(), "spaces", options.spaceId),
        documentId: handle.documentId,
        format: handle.document.format,
        source: handle.source,
        maxBytes: RAW_SOURCE_MAX_BYTES,
        signal: AbortSignal.timeout(RAW_SOURCE_TIMEOUT_MS),
      })
      return {
        kind: "source" as const,
        source: {
          bytes,
          fileName: sourceFileName(handle),
          formatId: handle.document.format.id,
          ...(handle.sourceStamp ? { version: handle.sourceStamp } : {}),
        },
      }
    }
  )
}

export type DocumentContentResolution =
  | { kind: "content"; content: DocumentContent }
  | Exclude<DocumentHandleResolution, { kind: "document" }>
  | { kind: "unsupported" }
  | { kind: "unavailable" }

/**
 * The content the Doc renderer shows, with its revision, read from the exact
 * source the page check resolves. Only documents that open in the Doc
 * renderer have content here; HTML Docs serve their frame.
 */
export async function readDocumentContent(options: {
  spaceId: string
  path: string
}): Promise<DocumentContentResolution> {
  return useResolvedDocumentHandle(
    { ...options, includeArchived: true, snapshot: true },
    async (handle): Promise<DocumentContentResolution> => {
      const integration = await pageIntegration(handle)
      const storedAs =
        handle.source.kind === "file"
          ? docStoredAs(handle.source.relativePath)
          : null
      if (integration?.rendererKey !== "doc" || !storedAs) {
        return { kind: "unsupported" }
      }
      let bytes: Uint8Array
      try {
        bytes = await readDocumentSource({
          spaceRoot: resolve(getWorkspaceRoot(), "spaces", options.spaceId),
          documentId: handle.documentId,
          format: handle.document.format,
          source: handle.source,
          maxBytes: DOC_CONTENT_MAX_BYTES,
          signal: AbortSignal.timeout(RAW_SOURCE_TIMEOUT_MS),
        })
      } catch (error) {
        if (error instanceof DocumentSourceReadError) {
          return { kind: "unavailable" }
        }
        throw error
      }
      const revision = docContentRevision({
        storedAs,
        sha256: sha256Hex(bytes),
      })
      // Decoded as GET …/docs/<path> always has.
      const text = Buffer.from(bytes).toString("utf8")
      if (storedAs === "md") {
        return {
          kind: "content",
          content: { revision, format: "markdown", content: text },
        }
      }
      let blocks: unknown
      try {
        blocks = JSON.parse(text)
      } catch {
        return { kind: "unavailable" }
      }
      if (!Array.isArray(blocks)) return { kind: "unavailable" }
      return {
        kind: "content",
        content: { revision, format: "blocknote", content: blocks },
      }
    }
  )
}

export { DocumentSourceReadError }
