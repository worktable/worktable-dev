import { createHash } from "node:crypto"
import type { BigIntStats, Stats } from "node:fs"
import { lstat, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type {
  DocumentDescriptor,
  DocumentFormatClaim,
  DocumentHealth,
  DocumentId,
  DocumentSource,
} from "@worktable/types"
import { CanonicalIdSchema } from "@worktable/types"
import {
  listLegacyDocumentClaims,
  type DocumentSourceClaim,
  type SourceClaimDiagnostic,
} from "./document-adapters.ts"
import {
  createDocAliasReservationLookup,
  createDocAliasResolver,
  readDocAliasesAt,
  type DocAliases,
} from "./doc-aliases.ts"
import {
  readDocumentBundleManifest,
  readDocumentInventoryAt,
  inspectDocumentSource,
  type DocumentInventoryDiagnostic,
  type DocumentInventoryEntry,
} from "./document-inventory.ts"
import { mapWithConcurrency } from "./bounded-concurrency.ts"
import {
  FingerprintCache,
  fingerprintOf,
  readTreeFingerprints,
  type FileFingerprint,
} from "./file-fingerprint.ts"
import { analyzeDocumentPath } from "./document-path.ts"
import {
  htmlDocumentTitleFromProperties,
  readHtmlDocumentPropertiesV2,
  type HtmlDocumentPropertiesRead,
} from "./html-document-properties-v2.ts"
import {
  BUILTIN_DOCUMENT_FORMATS,
  createBuiltinDocumentFormatRegistry,
  withoutSuffix,
  type DocumentFormatRegistry,
} from "./document-format-registry.ts"
import { storedDocTitle } from "./doc-title-text.ts"
import { filesPreviewEnabled } from "./files-preview.ts"
import {
  DOCUMENT_STORAGE_PROFILE_IDS,
  documentStorageProfiles,
  type DocumentStorageProfileId,
} from "./document-storage-profile.ts"
import { timing } from "./request-timing.ts"
import { documentPortableStateV2Directory } from "./workspace-storage-v2.ts"

/**
 * What a file source's bytes are, as its metadata says: the change time an
 * edit always moves, with the modification time, inode and size. A file
 * replaced with its modification time kept still gets a new stamp.
 */
export function sourceStampOf(info: {
  mtimeNs: bigint
  ctimeNs: bigint
  ino: bigint
  size: bigint
}): string {
  return [info.mtimeNs, info.ctimeNs, info.ino, info.size]
    .map((value) => value.toString(36))
    .join(".")
}

export interface DocumentHandle {
  documentId: DocumentId
  identity: "durable" | "provisional"
  source: DocumentSource
  /** For a file source, what its bytes are; changes whenever they do. */
  sourceStamp?: string
  storageProfile: DocumentStorageProfileId | null
  archived?: boolean
  archiveProvider?: "legacy-doc-metadata"
  diagnostics: SourceClaimDiagnostic[]
}

export interface CatalogDocumentEntry {
  kind: "document"
  descriptor: DocumentDescriptor
  handle: DocumentHandle
}

export interface CatalogDocumentClaim {
  kind: "document"
  documentId: DocumentId
  identity: "durable" | "provisional"
  path: string
  format: DocumentFormatClaim
  title: string
  health: DocumentHealth
  updatedAt?: string
  source: DocumentSource
  sourceStamp?: string
  storageProfile: DocumentStorageProfileId | null
  archived?: boolean
  archiveProvider?: "legacy-doc-metadata"
  diagnostics: SourceClaimDiagnostic[]
}

export interface CatalogAliasClaim {
  kind: "alias"
  path: string
  targetPath: string
}

export type CatalogConflictClaim = CatalogDocumentClaim | CatalogAliasClaim

export interface CatalogConflictEntry {
  kind: "conflict"
  pathKey: string
  claims: CatalogConflictClaim[]
}

export type DocumentCatalogEntry = CatalogDocumentEntry | CatalogConflictEntry

export interface DocumentCatalog {
  entries: DocumentCatalogEntry[]
  aliases: DocAliases
  inventoryDiagnostics: readonly DocumentInventoryDiagnostic[]
  provenCoreBundleIdentities: ReadonlySet<string>
  /**
   * Saved properties read for durable V2 HTML Doc titles, so a listing of
   * the same catalog does not read portable state again. Null when the state
   * could not be read.
   */
  htmlProperties: ReadonlyMap<DocumentId, HtmlDocumentPropertiesRead | null>
  /**
   * Fingerprints of the files each row came from, taken while building:
   * file sources by relative path, and HTML Doc properties by document.
   * Files changed within the racy window are left out.
   */
  derivedFrom: {
    /** The build's place in catalogBuildsStarted(). */
    build: number
    sources: ReadonlyMap<string, string>
    htmlProperties: ReadonlyMap<DocumentId, string>
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

// ============================================================
// Reading files once
// ============================================================
//
// A build asks the filesystem about each path at most once, and its
// independent per-document questions run concurrently. Files that are parsed
// (the inventory, the alias file, HTML Doc portable state) are kept parsed
// while their full fingerprint (lstat: type, device, inode, size, change and
// modification times) stays the same; a file changed within the racy window
// is always read again. Each build still inspects every file, so a cached
// parse is exactly what reading the file now would return. That makes the
// caches safe for writers too: unlike a read-model snapshot, nothing here is
// trusted because of a signal or an age.

const CATALOG_IO_CONCURRENCY = 32

type BuildLstat = (path: string) => Promise<BigIntStats>

/** An lstat that answers each path once for the rest of one build. */
function createBuildLstat(): BuildLstat {
  const answers = new Map<string, Promise<BigIntStats>>()
  return (path) => {
    let answer = answers.get(path)
    if (!answer) {
      answer = lstat(path, { bigint: true })
      // Each caller awaits its answer; a shared rejection is not unhandled.
      answer.catch(() => undefined)
      answers.set(path, answer)
    }
    return answer
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR"
}

/** The file's fingerprint, or null when it does not exist. */
async function buildFingerprint(
  lstatPath: BuildLstat,
  path: string,
  observedAt: number
): Promise<FileFingerprint | null> {
  try {
    return fingerprintOf(await lstatPath(path), observedAt)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

/** One entry per Space for its inventory and alias file. */
const SPACE_FILE_CACHE_LIMIT = 1_024
/** One entry per durable V2 HTML Doc. */
const HTML_PROPERTIES_CACHE_LIMIT = 10_000
const DOC_TITLE_CACHE_LIMIT = 50_000

/**
 * Reuse a parse of `path` while its fingerprint is unchanged. Values are
 * frozen by `parse` and shared by every build that reads the same file.
 */
async function readParsed<T>(
  cache: FingerprintCache<T>,
  lstatPath: BuildLstat,
  path: string,
  parse: () => Promise<T>
): Promise<T> {
  const fingerprint = await buildFingerprint(lstatPath, path, Date.now())
  const cached = fingerprint ? cache.get(path, fingerprint.key) : undefined
  if (cached !== undefined) return cached
  cache.delete(path)
  const value = await parse()
  if (fingerprint && !fingerprint.racy) {
    cache.set(path, fingerprint.key, value)
  }
  return value
}

type InventoryClaimEntry = Readonly<Omit<DocumentInventoryEntry, "raw">>

interface CatalogInventory {
  entries: readonly InventoryClaimEntry[]
  diagnostics: readonly DocumentInventoryDiagnostic[]
}

const parsedInventories = new FingerprintCache<CatalogInventory>(
  SPACE_FILE_CACHE_LIMIT
)
const parsedAliases = new FingerprintCache<
  Awaited<ReturnType<typeof readDocAliasesAt>>
>(SPACE_FILE_CACHE_LIMIT)

async function readCatalogInventory(
  spaceRoot: string,
  lstatPath: BuildLstat
): Promise<CatalogInventory> {
  const path = resolve(spaceRoot, "documents.meta.json")
  return readParsed(parsedInventories, lstatPath, path, async () => {
    const inventory = await readDocumentInventoryAt(path, spaceRoot)
    return Object.freeze({
      entries: Object.freeze(
        [...inventory.entries.values()].map(
          ({ documentId, path, format, source }) =>
            Object.freeze({
              documentId,
              path,
              format: Object.freeze({ ...format }),
              source: Object.freeze({ ...source }),
            })
        )
      ),
      diagnostics: Object.freeze(
        inventory.diagnostics.map((diagnostic) =>
          Object.freeze({ ...diagnostic })
        )
      ),
    })
  })
}

async function readCatalogAliases(
  spaceRoot: string,
  lstatPath: BuildLstat
): Promise<Awaited<ReturnType<typeof readDocAliasesAt>>> {
  const path = resolve(spaceRoot, "doc-aliases.json")
  return readParsed(parsedAliases, lstatPath, path, async () => {
    const result = await readDocAliasesAt(path)
    if (result.aliases) {
      Object.freeze(result.aliases.exact)
      Object.freeze(result.aliases.prefixes)
      Object.freeze(result.aliases)
    }
    return Object.freeze(result)
  })
}

interface HtmlPropertiesView {
  /** Null when the saved properties are unavailable. */
  read: HtmlDocumentPropertiesRead | null
  /** The title they give the Doc, if any. */
  title: string | undefined
  /**
   * The logical path and every portable state file's fingerprint, or null
   * when they changed too recently to identify the properties.
   */
  key: string | null
}

const parsedHtmlProperties = new FingerprintCache<HtmlPropertiesView>(
  HTML_PROPERTIES_CACHE_LIMIT
)

/** Identify a durable V2 HTML Doc's saved properties without reading them. */
export async function htmlPropertiesKey(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
  path: string
}): Promise<string | null> {
  const stateRoot = documentPortableStateV2Directory(
    input.workspaceRoot,
    input.spaceId,
    input.documentId
  )
  try {
    const state = await readTreeFingerprints({ files: [], trees: [stateRoot] })
    return state.racy
      ? null
      : JSON.stringify([input.path, [...state.keys].sort()])
  } catch {
    // Read them fresh; the reader reports what is wrong.
    return null
  }
}

/**
 * Saved properties of a durable V2 HTML Doc and the title they give it,
 * re-read only when its logical path or any file of its portable state
 * changed.
 */
async function readCatalogHtmlProperties(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
  path: string
}): Promise<HtmlPropertiesView> {
  const stateRoot = documentPortableStateV2Directory(
    input.workspaceRoot,
    input.spaceId,
    input.documentId
  )
  const key = await htmlPropertiesKey(input)
  const cached = key !== null ? parsedHtmlProperties.get(stateRoot, key) : undefined
  if (cached !== undefined) return cached
  parsedHtmlProperties.delete(stateRoot)
  let view: HtmlPropertiesView
  try {
    const read = deepFreeze(await readHtmlDocumentPropertiesV2(input))
    view = { read, title: htmlDocumentTitleFromProperties(read, input.path), key }
  } catch {
    // Unavailable optional display metadata must not hide the source.
    view = { read: null, title: undefined, key }
  }
  if (key !== null) parsedHtmlProperties.set(stateRoot, key, view)
  return view
}

const docTitles = new FingerprintCache<string>(DOC_TITLE_CACHE_LIMIT)

/**
 * The title a Doc file opens with, re-read only when its fingerprint
 * changed. A file changed too recently to identify is read every time.
 */
async function readCatalogDocTitle(
  file: string,
  key: string | undefined,
  markdown: boolean
): Promise<string> {
  const cached = key !== undefined ? docTitles.get(file, key) : undefined
  if (cached !== undefined) return cached
  let title = ""
  try {
    title = storedDocTitle(await readFile(file, "utf8"), markdown)
  } catch {
    // An unreadable file keeps the name its path gives; its reader reports why.
  }
  if (key !== undefined) docTitles.set(file, key, title)
  return title
}

/** Freeze a parsed value; binary views cannot be frozen and are left as is. */
function deepFreeze<T>(value: T): T {
  if (
    value &&
    typeof value === "object" &&
    !ArrayBuffer.isView(value) &&
    !Object.isFrozen(value)
  ) {
    Object.freeze(value)
    for (const nested of Object.values(value)) deepFreeze(nested)
  }
  return value
}

function provisionalDocumentId(
  spaceId: string,
  source: DocumentSource
): DocumentId {
  const encoded = createHash("sha256")
    .update(`${spaceId}\0${source.kind}\0${source.relativePath}`)
    .digest()
    .subarray(0, 16)
    .toString("base64url")
  return `doc_${encoded}` as DocumentId
}

function humanizePath(path: string): string {
  const leaf = path.split("/").pop() ?? path
  return (
    leaf
      .replace(/[-_]+/g, " ")
      .trim()
      .replace(/(^|\s)\p{L}/gu, (character) => character.toUpperCase()) || path
  )
}

function hasErrors(diagnostics: SourceClaimDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error")
}

function sourcePathKey(relativePath: string): string {
  return analyzeDocumentPath(relativePath).comparisonKey ?? relativePath
}

function usesLegacyDocArchiveMetadata(
  claim: {
    source: DocumentSource
    format: DocumentFormatClaim
  },
  registry: DocumentFormatRegistry
): boolean {
  return (
    documentStorageProfiles.resolve(claim.format, claim.source, registry) ===
    DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile
  )
}

function registeredFileLogicalPath(
  claim: { source: DocumentSource; format: DocumentFormatClaim },
  registry: DocumentFormatRegistry
): string | null {
  const registration = registry.fileSource(claim.format)
  if (
    !registration ||
    claim.source.kind !== "file" ||
    !claim.source.relativePath.startsWith("docs/") ||
    !claim.source.relativePath.endsWith(registration.source.extension)
  ) {
    return null
  }
  return withoutSuffix(
    claim.source.relativePath.slice("docs/".length),
    registration.source.extension
  )
}

function filesystemIdentity(info: Stats | BigIntStats): string {
  return `${info.dev}:${info.ino}`
}

async function inspectSourceOwnership(
  spaceRoot: string,
  source: DocumentSource,
  identities: ReadonlySet<string>,
  lstatPath: BuildLstat
): Promise<{ ownedByCoreBundle: boolean; updatedAt?: string; sourceStamp?: string }> {
  let current: string | null = source.relativePath
  let updatedAt: string | undefined
  let sourceStamp: string | undefined
  while (current) {
    try {
      const info = await lstatPath(resolve(spaceRoot, current))
      if (
        current === source.relativePath &&
        source.kind === "file" &&
        info.isFile() &&
        !info.isSymbolicLink()
      ) {
        updatedAt = info.mtime.toISOString()
        sourceStamp = sourceStampOf(info)
      }
      // Only a proven core bundle can own a source; without one, its
      // ancestors need no inspection.
      if (identities.size === 0) break
      if (!info.isSymbolicLink() && identities.has(filesystemIdentity(info))) {
        return {
          ownedByCoreBundle: true,
          ...(updatedAt ? { updatedAt } : {}),
          ...(sourceStamp ? { sourceStamp } : {}),
        }
      }
    } catch (error) {
      if (!isMissing(error)) throw error
      if (identities.size === 0) break
    }
    const separator = current.lastIndexOf("/")
    current = separator === -1 ? null : current.slice(0, separator)
  }
  return {
    ownedByCoreBundle: false,
    ...(updatedAt ? { updatedAt } : {}),
    ...(sourceStamp ? { sourceStamp } : {}),
  }
}

function markSourceOwnershipOverlaps(
  claims: Array<DocumentSourceClaim & { documentId: DocumentId }>
): void {
  const bundleRoots = new Map(
    claims
      .filter((claim) => claim.source.kind === "bundle")
      .map(
        (claim) => [sourcePathKey(claim.source.relativePath), claim] as const
      )
  )
  for (const claim of claims) {
    let owner: (typeof claims)[number] | undefined
    let separator = sourcePathKey(claim.source.relativePath).lastIndexOf("/")
    let ancestor = sourcePathKey(claim.source.relativePath)
    while (separator !== -1) {
      ancestor = ancestor.slice(0, separator)
      owner = bundleRoots.get(ancestor)
      if (owner) break
      separator = ancestor.lastIndexOf("/")
    }
    if (!owner) continue
    claim.diagnostics.push({
      severity: "error",
      code: "source-ownership-overlap",
      message: `source is nested within bundle ${owner.source.relativePath}`,
    })
  }
}

async function provenCoreBundleSnapshot(
  spaceRoot: string,
  entry: {
    documentId: DocumentId
    format: DocumentFormatClaim
    source: DocumentSource
  }
): Promise<{ identity: string; updatedAt?: string } | null> {
  if (
    entry.source.kind !== "bundle" ||
    !entry.source.relativePath.endsWith(".wtdoc")
  ) {
    return null
  }
  const before = await inspectDocumentSource(spaceRoot, entry.source)
  if (!before.safe) return null
  const beforeInfo = await lstat(before.absolutePath)
  const identity = filesystemIdentity(beforeInfo)
  const bundle = await readDocumentBundleManifest(before.absolutePath)
  const manifest = bundle.manifest
  if (
    !manifest ||
    manifest.documentId !== entry.documentId ||
    manifest.format.id !== entry.format.id ||
    manifest.format.sourceVersion !== entry.format.sourceVersion
  ) {
    return null
  }
  const [manifestInfo, contentInfo] = await Promise.all([
    lstat(join(before.absolutePath, "manifest.json")).catch(() => null),
    lstat(join(before.absolutePath, manifest.content)).catch(() => null),
  ])
  const after = await inspectDocumentSource(spaceRoot, entry.source)
  if (!after.safe) return null
  const afterInfo = await lstat(after.absolutePath)
  if (filesystemIdentity(afterInfo) !== identity) return null
  const mtimes = [
    manifestInfo?.isFile() && !manifestInfo.isSymbolicLink()
      ? manifestInfo.mtimeMs
      : Number.NaN,
    contentInfo?.isFile() && !contentInfo.isSymbolicLink()
      ? contentInfo.mtimeMs
      : Number.NaN,
  ].filter(Number.isFinite)
  const latestMtime = mtimes.length > 0 ? Math.max(...mtimes) : undefined
  return {
    identity,
    ...(latestMtime !== undefined
      ? { updatedAt: new Date(latestMtime).toISOString() }
      : {}),
  }
}

async function isLegacyHtmlBundle(
  spaceRoot: string,
  relativePath: string,
  bundleRoot: string,
  lstatPath: BuildLstat
): Promise<boolean> {
  let ancestor = resolve(spaceRoot, "widgets")
  for (const segment of relativePath.split("/").slice(1, -1)) {
    ancestor = join(ancestor, segment)
    try {
      await lstatPath(join(ancestor, "widget.yaml"))
      return false
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
    }
  }
  for (const name of ["widget.yaml", "index.html"]) {
    try {
      const info = await lstatPath(join(bundleRoot, name))
      if (!info.isFile() || info.isSymbolicLink()) return false
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
      return false
    }
  }
  return true
}

async function inventoryClaims(
  spaceRoot: string,
  spaceId: string,
  legacyClaims: DocumentSourceClaim[],
  reservedByAlias: (path: string) => unknown,
  registry: DocumentFormatRegistry,
  lstatPath: BuildLstat,
  signal?: AbortSignal
): Promise<{
  claims: Array<
    DocumentSourceClaim & {
      documentId: DocumentId
      identity: "durable" | "provisional"
    }
  >
  diagnostics: readonly DocumentInventoryDiagnostic[]
  provenCoreBundleIdentities: ReadonlySet<string>
}> {
  const inventory = await readCatalogInventory(spaceRoot, lstatPath)
  const provenCoreBundleIds = new Set<DocumentId>()
  const provenCoreBundleIdentities = new Set<string>()
  const provenCoreBundleUpdatedAt = new Map<DocumentId, string>()
  const snapshots = await mapWithConcurrency(
    inventory.entries,
    CATALOG_IO_CONCURRENCY,
    (entry) => {
      signal?.throwIfAborted()
      return provenCoreBundleSnapshot(spaceRoot, entry)
    }
  )
  inventory.entries.forEach((entry, index) => {
    const snapshot = snapshots[index]
    if (snapshot) {
      provenCoreBundleIds.add(entry.documentId)
      provenCoreBundleIdentities.add(snapshot.identity)
      if (snapshot.updatedAt) {
        provenCoreBundleUpdatedAt.set(entry.documentId, snapshot.updatedAt)
      }
    }
  })
  const ownership = await mapWithConcurrency(
    legacyClaims,
    CATALOG_IO_CONCURRENCY,
    (claim) => {
      signal?.throwIfAborted()
      return inspectSourceOwnership(
        spaceRoot,
        claim.source,
        provenCoreBundleIdentities,
        lstatPath
      )
    }
  )
  const visibleLegacyClaims: DocumentSourceClaim[] = []
  legacyClaims.forEach((claim, index) => {
    const inspected = ownership[index]!
    if (!inspected.ownedByCoreBundle) {
      visibleLegacyClaims.push({
        ...claim,
        ...(!claim.updatedAt && inspected.updatedAt
          ? { updatedAt: inspected.updatedAt }
          : {}),
        ...(inspected.sourceStamp ? { sourceStamp: inspected.sourceStamp } : {}),
      })
    }
  })
  const bySource = new Map(
    inventory.entries.map((entry) => [
      `${entry.source.kind}:${sourcePathKey(entry.source.relativePath)}`,
      entry,
    ])
  )
  const claims: Array<
    DocumentSourceClaim & {
      documentId: DocumentId
      identity: "durable" | "provisional"
    }
  > = []
  const consumed = new Set<DocumentId>()

  for (const claim of visibleLegacyClaims) {
    const inventoryEntry = bySource.get(
      `${claim.source.kind}:${sourcePathKey(claim.source.relativePath)}`
    )
    if (!inventoryEntry) {
      claims.push({
        ...claim,
        documentId: provisionalDocumentId(spaceId, claim.source),
        identity: "provisional",
      })
      continue
    }
    consumed.add(inventoryEntry.documentId)
    const diagnostics = [...claim.diagnostics]
    if (
      inventoryEntry.path !== claim.path ||
      inventoryEntry.format.id !== claim.format.id ||
      inventoryEntry.format.sourceVersion !== claim.format.sourceVersion
    ) {
      diagnostics.push({
        severity: "error",
        code: "inventory-source-mismatch",
        message: "inventory claim disagrees with the legacy source claim",
      })
    }
    claims.push({
      ...claim,
      documentId: inventoryEntry.documentId,
      identity: "durable",
      diagnostics,
    })
  }

  const unconsumed = inventory.entries.filter((entry) => {
    if (consumed.has(entry.documentId)) return false
    const legacyPath = registeredFileLogicalPath(entry, registry)
    return !(legacyPath && reservedByAlias(legacyPath))
  })
  const inventoryOnly = await mapWithConcurrency(
    unconsumed,
    CATALOG_IO_CONCURRENCY,
    async (entry) => {
      signal?.throwIfAborted()
      const diagnostics: SourceClaimDiagnostic[] = []
      const sourceValidation = await inspectDocumentSource(
        spaceRoot,
        entry.source,
        lstatPath
      )
      const sourceExists = sourceValidation.safe
      let updatedAt = provenCoreBundleUpdatedAt.get(entry.documentId)
      let sourceStamp: string | undefined
      if (sourceValidation.safe && entry.source.kind === "file") {
        const info = await lstatPath(sourceValidation.absolutePath).catch(
          () => null
        )
        if (info?.isFile() && !info.isSymbolicLink()) {
          updatedAt = info.mtime.toISOString()
          sourceStamp = sourceStampOf(info)
        }
      }
      if (!sourceValidation.safe) {
        diagnostics.push({
          severity: "error",
          code: sourceValidation.message.includes("symbolic link")
            ? "source-symlink"
            : "inventory-source-missing",
          message: sourceValidation.message,
        })
      }
      if (
        sourceExists &&
        entry.source.kind === "bundle" &&
        entry.source.relativePath.endsWith(".wtdoc") &&
        !provenCoreBundleIds.has(entry.documentId)
      ) {
        diagnostics.push({
          severity: "error",
          code: "bundle-manifest-mismatch",
          message: "bundle manifest is invalid or disagrees with inventory",
        })
      }
      if (
        sourceExists &&
        entry.source.kind === "bundle" &&
        !entry.source.relativePath.endsWith(".wtdoc") &&
        !(
          entry.source.relativePath.startsWith("widgets/") &&
          (await isLegacyHtmlBundle(
            spaceRoot,
            entry.source.relativePath,
            sourceValidation.absolutePath,
            lstatPath
          ))
        )
      ) {
        diagnostics.push({
          severity: "error",
          code: "bundle-manifest-mismatch",
          message:
            "inventory bundle must satisfy the core manifest or legacy HTML contract",
        })
      }
      const analyzed = analyzeDocumentPath(entry.path)
      if (!analyzed.safe) {
        diagnostics.push({
          severity: "error",
          code: "unsafe-logical-path",
          message: "inventory source has an unsafe logical path",
        })
      } else if (!analyzed.portable) {
        diagnostics.push({
          severity: "warning",
          code: "nonportable-logical-path",
          message: "inventory source has a nonportable logical path",
        })
      }
      return {
        origin: "inventory" as const,
        path: entry.path,
        comparisonKey: analyzed.comparisonKey,
        format: entry.format,
        source: entry.source,
        title: humanizePath(entry.path),
        ...(updatedAt ? { updatedAt } : {}),
        ...(sourceStamp ? { sourceStamp } : {}),
        ...(usesLegacyDocArchiveMetadata(entry, registry)
          ? { archiveProvider: "legacy-doc-metadata" as const }
          : {}),
        diagnostics,
        documentId: entry.documentId,
        identity: "durable" as const,
      }
    }
  )
  claims.push(...inventoryOnly)
  markSourceOwnershipOverlaps(claims)
  return {
    claims,
    diagnostics: inventory.diagnostics,
    provenCoreBundleIdentities,
  }
}

function claimHealth(
  format: DocumentFormatClaim,
  diagnostics: SourceClaimDiagnostic[],
  registry: DocumentFormatRegistry
): DocumentHealth {
  if (hasErrors(diagnostics)) return "invalid"
  return registry.health(format)
}

function catalogDocumentClaim(
  claim: DocumentSourceClaim & {
    documentId: DocumentId
    identity: "durable" | "provisional"
  },
  registry: DocumentFormatRegistry
): CatalogDocumentClaim {
  return {
    kind: "document",
    documentId: claim.documentId,
    identity: claim.identity,
    path: claim.path,
    format: claim.format,
    title: claim.title,
    health: claimHealth(claim.format, claim.diagnostics, registry),
    ...(claim.updatedAt ? { updatedAt: claim.updatedAt } : {}),
    source: claim.source,
    ...(claim.sourceStamp ? { sourceStamp: claim.sourceStamp } : {}),
    storageProfile: documentStorageProfiles.resolve(
      claim.format,
      claim.source,
      registry
    ),
    ...(claim.archived ? { archived: true } : {}),
    ...(claim.archiveProvider
      ? { archiveProvider: claim.archiveProvider }
      : {}),
    diagnostics: claim.diagnostics,
  }
}

interface AliasLookups {
  reserved: (path: string) => unknown
  resolve: (path: string) => string | null
}

function aliasClaimsFor(
  entry: DocumentCatalogEntry,
  aliases: AliasLookups
): CatalogAliasClaim[] {
  const paths =
    entry.kind === "document"
      ? [entry.descriptor.path]
      : entry.claims.flatMap((claim) =>
          claim.kind === "document" ? [claim.path] : []
        )
  return [...new Set(paths)].flatMap((path) => {
    if (!aliases.reserved(path)) return []
    const targetPath = aliases.resolve(path)
    if (!targetPath) {
      throw new Error(`Document alias could not be resolved: ${path}`)
    }
    return [{ kind: "alias" as const, path, targetPath }]
  })
}

type DocumentCatalogOptions = {
  workspaceRoot: string
  spaceId: string
  registry?: DocumentFormatRegistry
  /** Stops discovery between phases once the caller no longer needs it. */
  signal?: AbortSignal
}

/**
 * Whether one document's own files are as they were when the catalog was
 * built: its file source and, for an HTML Doc, the portable state its title
 * came from. False whenever that cannot be shown, including for bundles.
 */
export async function catalogDocumentUnchanged(
  catalog: DocumentCatalog,
  document: {
    workspaceRoot: string
    spaceId: string
    documentId: DocumentId
    path: string
    source: DocumentSource
  }
): Promise<boolean> {
  if (document.source.kind !== "file") return false
  const recorded = catalog.derivedFrom.sources.get(document.source.relativePath)
  if (recorded === undefined) return false
  let current: FileFingerprint
  try {
    current = fingerprintOf(
      await lstat(
        resolve(
          document.workspaceRoot,
          "spaces",
          document.spaceId,
          document.source.relativePath
        ),
        { bigint: true }
      )
    )
  } catch {
    return false
  }
  // The recorded fingerprint was not racy, so any later change shows.
  if (current.key !== recorded) return false
  if (!catalog.htmlProperties.has(document.documentId)) return true
  const properties = catalog.derivedFrom.htmlProperties.get(document.documentId)
  return (
    properties !== undefined &&
    properties === (await htmlPropertiesKey(document))
  )
}

let buildsStarted = 0

/**
 * How many catalog builds have started. A catalog whose `derivedFrom.build`
 * is above an earlier reading inspected its files after that reading.
 */
export function catalogBuildsStarted(): number {
  return buildsStarted
}

export function buildDocumentCatalog(
  options: DocumentCatalogOptions
): Promise<DocumentCatalog> {
  return timing.span("catalog", () => buildDocumentCatalogFromFiles(options))
}

async function buildDocumentCatalogFromFiles(
  options: DocumentCatalogOptions
): Promise<DocumentCatalog> {
  const spaceId = CanonicalIdSchema.parse(options.spaceId)
  const registry = options.registry ?? createBuiltinDocumentFormatRegistry()
  const spaceRoot = resolve(options.workspaceRoot, "spaces", spaceId)
  const build = ++buildsStarted
  const startedAt = Date.now()
  const lstatPath = createBuildLstat()
  const aliasResult = await readCatalogAliases(spaceRoot, lstatPath)
  if (!aliasResult.aliases) {
    throw new Error(aliasResult.error ?? "Document aliases are unavailable")
  }
  const aliases: AliasLookups = {
    reserved: createDocAliasReservationLookup(aliasResult.aliases),
    resolve: createDocAliasResolver(aliasResult.aliases),
  }
  options.signal?.throwIfAborted()
  const legacyClaims = await listLegacyDocumentClaims(
    spaceRoot,
    aliasResult.aliases,
    registry
  )
  options.signal?.throwIfAborted()
  const inventoried = await inventoryClaims(
    spaceRoot,
    spaceId,
    legacyClaims,
    aliases.reserved,
    registry,
    lstatPath,
    options.signal
  )
  // With files off, files that gained an identity while they were on take no
  // part in the Space: not listed, and in no conflict with a Doc's path.
  const merged = filesPreviewEnabled()
    ? inventoried
    : {
        ...inventoried,
        claims: inventoried.claims.filter(
          (claim) => claim.format.id !== BUILTIN_DOCUMENT_FORMATS.file
        ),
      }
  const htmlProperties = new Map<DocumentId, HtmlDocumentPropertiesRead | null>()
  const htmlClaims = merged.claims.filter(
    (claim) =>
      claim.identity === "durable" &&
      claim.format.id === "worktable.html" &&
      claim.format.sourceVersion === 1 &&
      claim.source.kind === "file" &&
      !claim.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  )
  const htmlReads = await mapWithConcurrency(
    htmlClaims,
    CATALOG_IO_CONCURRENCY,
    (claim) => {
      options.signal?.throwIfAborted()
      return readCatalogHtmlProperties({
        workspaceRoot: options.workspaceRoot,
        spaceId,
        documentId: claim.documentId,
        path: claim.path,
      })
    }
  )
  const htmlKeys = new Map<DocumentId, string>()
  htmlClaims.forEach((claim, index) => {
    const view = htmlReads[index]!
    htmlProperties.set(claim.documentId, view.read)
    if (view.key !== null) htmlKeys.set(claim.documentId, view.key)
    claim.title = view.title ?? claim.title
  })
  // What each document's row was derived from, for readers that act on one
  // document from a snapshot of this catalog.
  const sourceKeys = new Map<string, string>()
  await mapWithConcurrency(
    merged.claims,
    CATALOG_IO_CONCURRENCY,
    async (claim) => {
      if (claim.source.kind !== "file") return
      const fingerprint = await buildFingerprint(
        lstatPath,
        resolve(spaceRoot, claim.source.relativePath),
        startedAt
      ).catch(() => null)
      if (fingerprint && !fingerprint.racy) {
        sourceKeys.set(claim.source.relativePath, fingerprint.key)
      }
    }
  )
  // A Doc is named by the title it opens with, read again only when its
  // file changes.
  await mapWithConcurrency(
    merged.claims.filter(
      (claim) =>
        claim.source.kind === "file" &&
        (claim.format.id === BUILTIN_DOCUMENT_FORMATS.markdown ||
          claim.format.id === BUILTIN_DOCUMENT_FORMATS.richText) &&
        !claim.diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ),
    CATALOG_IO_CONCURRENCY,
    async (claim) => {
      options.signal?.throwIfAborted()
      const title = await readCatalogDocTitle(
        resolve(spaceRoot, claim.source.relativePath),
        sourceKeys.get(claim.source.relativePath),
        claim.format.id === BUILTIN_DOCUMENT_FORMATS.markdown
      )
      if (title) claim.title = title
    }
  )
  const grouped = new Map<string, typeof merged.claims>()
  for (const claim of merged.claims) {
    const key = claim.comparisonKey ?? `invalid:${claim.source.relativePath}`
    const group = grouped.get(key) ?? []
    group.push(claim)
    grouped.set(key, group)
  }

  const entries: DocumentCatalogEntry[] = []
  for (const [pathKey, group] of grouped) {
    group.sort((a, b) =>
      compareStrings(a.source.relativePath, b.source.relativePath)
    )
    if (group.length > 1) {
      entries.push({
        kind: "conflict",
        pathKey,
        claims: group.map((claim) => catalogDocumentClaim(claim, registry)),
      })
      continue
    }
    const claim = group[0]
    if (!claim) continue
    entries.push({
      kind: "document",
      descriptor: {
        documentId: claim.documentId,
        path: claim.path,
        format: claim.format,
        title: claim.title,
        health: claimHealth(claim.format, claim.diagnostics, registry),
        ...(claim.updatedAt ? { updatedAt: claim.updatedAt } : {}),
      },
      handle: {
        documentId: claim.documentId,
        identity: claim.identity,
        source: claim.source,
        ...(claim.sourceStamp ? { sourceStamp: claim.sourceStamp } : {}),
        storageProfile: documentStorageProfiles.resolve(
          claim.format,
          claim.source,
          registry
        ),
        ...(claim.archived ? { archived: true } : {}),
        ...(claim.archiveProvider
          ? { archiveProvider: claim.archiveProvider }
          : {}),
        diagnostics: claim.diagnostics,
      },
    })
  }
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!
    const aliasClaims = aliasClaimsFor(entry, aliases)
    if (aliasClaims.length === 0) continue
    entries[index] = {
      kind: "conflict",
      pathKey:
        entry.kind === "conflict"
          ? entry.pathKey
          : (analyzeDocumentPath(entry.descriptor.path).comparisonKey ??
            entry.descriptor.path),
      claims: [
        ...(entry.kind === "conflict"
          ? entry.claims
          : [
              {
                kind: "document" as const,
                documentId: entry.descriptor.documentId,
                identity: entry.handle.identity,
                path: entry.descriptor.path,
                format: entry.descriptor.format,
                title: entry.descriptor.title,
                health: entry.descriptor.health,
                source: entry.handle.source,
                storageProfile: entry.handle.storageProfile,
                ...(entry.handle.archived ? { archived: true } : {}),
                ...(entry.handle.archiveProvider
                  ? { archiveProvider: entry.handle.archiveProvider }
                  : {}),
                diagnostics: entry.handle.diagnostics,
              },
            ]),
        ...aliasClaims,
      ],
    }
  }
  entries.sort((a, b) => {
    const aKey = a.kind === "conflict" ? a.pathKey : a.descriptor.path
    const bKey = b.kind === "conflict" ? b.pathKey : b.descriptor.path
    return compareStrings(aKey, bKey)
  })
  return {
    entries,
    aliases: aliasResult.aliases,
    inventoryDiagnostics: merged.diagnostics,
    provenCoreBundleIdentities: merged.provenCoreBundleIdentities,
    htmlProperties,
    derivedFrom: { build, sources: sourceKeys, htmlProperties: htmlKeys },
  }
}
