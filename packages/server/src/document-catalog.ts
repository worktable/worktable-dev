import { createHash } from "node:crypto"
import { lstat } from "node:fs/promises"
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
  readDocAliasesAt,
  reservedByAliasIn,
  resolveDocAliasIn,
  type DocAliases,
} from "./doc-aliases.ts"
import {
  readDocumentBundleManifest,
  readDocumentInventoryAt,
  inspectDocumentSource,
  type DocumentInventoryDiagnostic,
} from "./document-inventory.ts"
import { analyzeDocumentPath } from "./document-path.ts"
import {
  createBuiltinDocumentFormatRegistry,
  type DocumentFormatRegistry,
} from "./document-format-registry.ts"
import {
  DOCUMENT_STORAGE_PROFILE_IDS,
  documentStorageProfiles,
  type DocumentStorageProfileId,
} from "./document-storage-profile.ts"

export interface DocumentHandle {
  documentId: DocumentId
  identity: "durable" | "provisional"
  source: DocumentSource
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
  inventoryDiagnostics: DocumentInventoryDiagnostic[]
  provenCoreBundleIdentities: ReadonlySet<string>
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
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
  return claim.source.relativePath.slice(
    "docs/".length,
    -registration.source.extension.length
  )
}

function filesystemIdentity(info: Awaited<ReturnType<typeof lstat>>): string {
  return `${info.dev}:${info.ino}`
}

async function inspectSourceOwnership(
  spaceRoot: string,
  source: DocumentSource,
  identities: ReadonlySet<string>
): Promise<{ ownedByCoreBundle: boolean; updatedAt?: string }> {
  let current: string | null = source.relativePath
  let updatedAt: string | undefined
  while (current) {
    try {
      const info = await lstat(resolve(spaceRoot, current))
      if (
        current === source.relativePath &&
        source.kind === "file" &&
        info.isFile() &&
        !info.isSymbolicLink() &&
        Number.isFinite(info.mtimeMs)
      ) {
        updatedAt = info.mtime.toISOString()
      }
      if (!info.isSymbolicLink() && identities.has(filesystemIdentity(info))) {
        return {
          ownedByCoreBundle: true,
          ...(updatedAt ? { updatedAt } : {}),
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
    }
    const separator = current.lastIndexOf("/")
    current = separator === -1 ? null : current.slice(0, separator)
  }
  return {
    ownedByCoreBundle: false,
    ...(updatedAt ? { updatedAt } : {}),
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
  bundleRoot: string
): Promise<boolean> {
  let ancestor = resolve(spaceRoot, "widgets")
  for (const segment of relativePath.split("/").slice(1, -1)) {
    ancestor = join(ancestor, segment)
    try {
      await lstat(join(ancestor, "widget.yaml"))
      return false
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error
    }
  }
  for (const name of ["widget.yaml", "index.html"]) {
    try {
      const info = await lstat(join(bundleRoot, name))
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
  aliases: DocAliases,
  registry: DocumentFormatRegistry
): Promise<{
  claims: Array<
    DocumentSourceClaim & {
      documentId: DocumentId
      identity: "durable" | "provisional"
    }
  >
  diagnostics: DocumentInventoryDiagnostic[]
  provenCoreBundleIdentities: ReadonlySet<string>
}> {
  const inventory = await readDocumentInventoryAt(
    resolve(spaceRoot, "documents.meta.json"),
    spaceRoot
  )
  const provenCoreBundleIds = new Set<DocumentId>()
  const provenCoreBundleIdentities = new Set<string>()
  const provenCoreBundleUpdatedAt = new Map<DocumentId, string>()
  for (const entry of inventory.entries.values()) {
    const snapshot = await provenCoreBundleSnapshot(spaceRoot, entry)
    if (snapshot) {
      provenCoreBundleIds.add(entry.documentId)
      provenCoreBundleIdentities.add(snapshot.identity)
      if (snapshot.updatedAt) {
        provenCoreBundleUpdatedAt.set(entry.documentId, snapshot.updatedAt)
      }
    }
  }
  const visibleLegacyClaims: DocumentSourceClaim[] = []
  for (const claim of legacyClaims) {
    const inspected = await inspectSourceOwnership(
      spaceRoot,
      claim.source,
      provenCoreBundleIdentities
    )
    if (!inspected.ownedByCoreBundle) {
      visibleLegacyClaims.push(
        claim.updatedAt || !inspected.updatedAt
          ? claim
          : { ...claim, updatedAt: inspected.updatedAt }
      )
    }
  }
  const bySource = new Map(
    [...inventory.entries.values()].map((entry) => [
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

  for (const entry of inventory.entries.values()) {
    if (consumed.has(entry.documentId)) continue
    const legacyPath = registeredFileLogicalPath(entry, registry)
    if (legacyPath && reservedByAliasIn(aliases, legacyPath)) continue
    const diagnostics: SourceClaimDiagnostic[] = []
    const sourceValidation = await inspectDocumentSource(
      spaceRoot,
      entry.source
    )
    const sourceExists = sourceValidation.safe
    let updatedAt = provenCoreBundleUpdatedAt.get(entry.documentId)
    if (sourceValidation.safe && entry.source.kind === "file") {
      const info = await lstat(sourceValidation.absolutePath).catch(() => null)
      if (
        info?.isFile() &&
        !info.isSymbolicLink() &&
        Number.isFinite(info.mtimeMs)
      ) {
        updatedAt = info.mtime.toISOString()
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
          sourceValidation.absolutePath
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
    claims.push({
      origin: "inventory",
      path: entry.path,
      comparisonKey: analyzed.comparisonKey,
      format: entry.format,
      source: entry.source,
      title: humanizePath(entry.path),
      ...(updatedAt ? { updatedAt } : {}),
      ...(usesLegacyDocArchiveMetadata(entry, registry)
        ? { archiveProvider: "legacy-doc-metadata" as const }
        : {}),
      diagnostics,
      documentId: entry.documentId,
      identity: "durable",
    })
  }
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

function aliasClaimsFor(
  entry: DocumentCatalogEntry,
  aliases: DocAliases
): CatalogAliasClaim[] {
  const paths =
    entry.kind === "document"
      ? [entry.descriptor.path]
      : entry.claims.flatMap((claim) =>
          claim.kind === "document" ? [claim.path] : []
        )
  return [...new Set(paths)].flatMap((path) => {
    if (!reservedByAliasIn(aliases, path)) return []
    const targetPath = resolveDocAliasIn(aliases, path)
    if (!targetPath) {
      throw new Error(`Document alias could not be resolved: ${path}`)
    }
    return [{ kind: "alias" as const, path, targetPath }]
  })
}

export async function buildDocumentCatalog(options: {
  workspaceRoot: string
  spaceId: string
  registry?: DocumentFormatRegistry
}): Promise<DocumentCatalog> {
  const spaceId = CanonicalIdSchema.parse(options.spaceId)
  const registry = options.registry ?? createBuiltinDocumentFormatRegistry()
  const spaceRoot = resolve(options.workspaceRoot, "spaces", spaceId)
  const aliasResult = await readDocAliasesAt(
    resolve(spaceRoot, "doc-aliases.json")
  )
  if (!aliasResult.aliases) {
    throw new Error(aliasResult.error ?? "Document aliases are unavailable")
  }
  const legacyClaims = await listLegacyDocumentClaims(
    spaceRoot,
    aliasResult.aliases,
    registry
  )
  const merged = await inventoryClaims(
    spaceRoot,
    spaceId,
    legacyClaims,
    aliasResult.aliases,
    registry
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
    const aliasClaims = aliasClaimsFor(entry, aliasResult.aliases)
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
  }
}
