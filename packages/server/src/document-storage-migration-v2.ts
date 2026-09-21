import { createHash, randomBytes } from "node:crypto"
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { CanonicalIdSchema } from "@worktable/types"
import { ensureAppDir } from "./app-storage.ts"
import { atomicWriteText } from "./atomic-file.ts"
import {
  DocumentGenerationIdSchema,
  WidgetFileSchema,
  type DocumentProvenance,
  type WidgetFile,
} from "@worktable/types"
import {
  readBoundedRegularFile,
  readBoundedRegularFileBytes,
} from "./bounded-file.ts"
import {
  readCompatibleDocumentAnnotationsV2,
  readDocumentAnnotationsV2,
  writeDocumentAnnotationsV2,
  writeDocumentPortableStateV2,
} from "./document-data-v2.ts"
import {
  assertSourceDocumentInventoryLineage,
  calculateDocumentSourceCheckpoint,
  planDocumentIdMaterialization,
  materializeDocumentIdsAt,
  type DocumentIdMaterializationPlan,
} from "./document-id-materialization.ts"
import {
  BUILTIN_DOCUMENT_COMPANIONS,
  BUILTIN_DOCUMENT_FORMATS,
  createBuiltinDocumentFormatRegistry,
} from "./document-format-registry.ts"
import { updateDocumentInventoryAt } from "./document-inventory.ts"
import {
  buildHtmlDocumentPortableStateEntries,
  HTML_DOCUMENT_PORTABLE_STATE_VERSION,
} from "./html-document-storage-v2.ts"
import {
  DOCUMENT_GENERATION_MAX_ENTRY_BYTES,
  writeDocumentGenerationV2,
  type DocumentGenerationPayloadEntry,
} from "./document-version-store-v2.ts"
import { analyzeDocumentPath } from "./document-path.ts"
import {
  preflightDocumentWorkspace,
  type PreflightDocumentSource,
} from "./document-preflight.ts"
import {
  beginPreparedWorkspaceReplacement,
  createWorkspaceReplacementPaths,
  discardRolledBackWorkspaceReplacement,
  workspaceCommittedBackupPath,
} from "./workspace-replacement.ts"
import {
  DOCUMENT_STORAGE_MIGRATION_RECEIPT_TTL_MS,
  recoverInterruptedWorkspaceReplacements,
} from "./workspace-replacement-recovery.ts"
import {
  requireWorkspaceStorageVersionAt,
  workspaceStorageLayoutFromManifest,
  type WorkspaceManifestV2,
} from "./workspace-storage-v2.ts"
import {
  calculateLocalWorkspaceContentCheckpoints,
} from "./workspace-transfer-v2.ts"
import { getWorkspaceRoot, writeWorkspaceManifestBytesAt } from "./workspace.ts"
import { mintVersionId, stableVersionHash } from "./version-store.ts"
import { parseCanonicalYaml } from "./yaml.ts"

export interface DocumentStorageV2MigrationPlan {
  type: "worktable.document-storage-migration-plan"
  version: 1
  workspaceRoot: string
  workspaceId: string
  sourceStorageVersion: 1
  targetStorageVersion: 2
  workspaceContentCheckpoint: string
  sourceCheckpoint: string
  durableIdentityCheckpoint: string
  documentCount: number
  durableCount: number
  materializeCount: number
  conflictCount: number
  dependencyCount: number
  dependencyBytes: number
  clean: boolean
  diagnostics: Array<{ path: string; message: string }>
  identityPlan: DocumentIdMaterializationPlan
}

export interface DocumentStorageV2MigrationResult {
  type: "worktable.document-storage-migration-result"
  version: 1
  workspaceRoot: string
  workspaceId: string
  sourceStorageVersion: 1
  targetStorageVersion: 2
  beforeWorkspaceContentCheckpoint: string
  afterWorkspaceContentCheckpoint: string
  sourceCheckpoint: string
  afterSourceCheckpoint: string
  documentCount: number
  materializedCount: number
  htmlDocumentsMigrated: number
  annotationFilesMigrated: number
  annotationsMigrated: number
  backupPath: string
  backupWorkspaceContentCheckpoint: string
  copiedBytes: number
  elapsedMs: number
}

export interface DocumentStorageV2RehearsalResult extends DocumentStorageV2MigrationResult {
  sourceWorkspace: string
  copiedWorkspace: string
  sourceAfterWorkspaceContentCheckpoint: string
  rollbackProcedure: readonly string[]
}

interface MigrationRecoveryJob {
  id: string
  kind: "document-storage-v2"
  state: "replacing" | "complete" | "failed"
  updatedAt: string
  expiresAt: string
  prepared?: { stagingPath: string; backupPath: string }
  recovery?: { state: "complete"; backupPath: string }
}

async function createMigrationRecoveryJob(input: {
  stagingPath: string
  backupPath: string
}): Promise<{ directory: string; path: string; job: MigrationRecoveryJob }> {
  const id = `wsm_${randomBytes(16).toString("base64url")}`
  const directory = join(ensureAppDir(), "workspace-transfers", "jobs", id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, "job.json")
  const job: MigrationRecoveryJob = {
    id,
    kind: "document-storage-v2",
    state: "replacing",
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(
      Date.now() + DOCUMENT_STORAGE_MIGRATION_RECEIPT_TTL_MS
    ).toISOString(),
    prepared: input,
  }
  await atomicWriteText(path, `${JSON.stringify(job, null, 2)}\n`)
  return { directory, path, job }
}

async function settleMigrationRecoveryJob(
  record: Awaited<ReturnType<typeof createMigrationRecoveryJob>>,
  state: "complete" | "failed"
): Promise<void> {
  if (state === "complete") {
    const prepared = record.job.prepared!
    const job: MigrationRecoveryJob = {
      ...record.job,
      state,
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(
        Date.now() + DOCUMENT_STORAGE_MIGRATION_RECEIPT_TTL_MS
      ).toISOString(),
      recovery: {
        state: "complete",
        backupPath: workspaceCommittedBackupPath(prepared.backupPath),
      },
    }
    delete job.prepared
    await atomicWriteText(record.path, `${JSON.stringify(job, null, 2)}\n`)
    return
  }
  const job = { ...record.job, state, updatedAt: new Date().toISOString() }
  await atomicWriteText(record.path, `${JSON.stringify(job, null, 2)}\n`)
  await rm(record.directory, { recursive: true, force: true })
}

function durableIdentityCheckpoint(
  documents: readonly PreflightDocumentSource[]
): string {
  return createHash("sha256")
    .update(
      documents
        .filter((document) => document.identity === "durable")
        .map((document) =>
          JSON.stringify({
            spaceId: document.spaceId,
            path: document.path,
            documentId: document.documentId,
            format: document.format,
            source: document.source,
          })
        )
        .sort()
        .join("\n")
    )
    .digest("hex")
}

async function reservedV2NamespaceDiagnostics(
  workspaceRoot: string
): Promise<Array<{ path: string; message: string }>> {
  const diagnostics: Array<{ path: string; message: string }> = []
  for (const [parentName, reservedName] of [
    ["spaces", "document-data"],
    ["versions", "documents"],
  ] as const) {
    const parent = join(workspaceRoot, parentName)
    const entries = await readdir(parent, { withFileTypes: true }).catch(
      (error) => {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "ENOTDIR") return []
        throw error
      }
    )
    if (entries.length > 10_000) {
      diagnostics.push({
        path: parentName,
        message: "workspace namespace exceeds the migration census limit",
      })
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const reserved = join(parent, entry.name, reservedName)
      if (await pathExists(reserved)) {
        diagnostics.push({
          path: relative(workspaceRoot, reserved).split(sep).join("/"),
          message: "reserved document Storage V2 namespace is already occupied",
        })
      }
    }
  }
  return diagnostics
}

async function legacyAnnotationOwnershipDiagnostics(
  workspaceRoot: string,
  documents: readonly PreflightDocumentSource[]
): Promise<Array<{ path: string; message: string }>> {
  const diagnostics: Array<{ path: string; message: string }> = []
  const expected = new Set(
    documents.map(
      (document) =>
        `${document.spaceId}\0${legacyAnnotationKind(document)}\0${document.path}`
    )
  )
  const spacesRoot = join(workspaceRoot, "spaces")
  const spaces = await readdir(spacesRoot, { withFileTypes: true }).catch(
    (error) => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") return []
      throw error
    }
  )
  let entriesSeen = 0
  let limitExceeded = false

  for (const space of spaces) {
    if (limitExceeded) break
    if (!space.isDirectory()) continue
    for (const root of ["docs", "widgets"] as const) {
      if (limitExceeded) break
      const annotationRoot = join(spacesRoot, space.name, "annotations", root)
      const rootInfo = await lstat(annotationRoot).catch((error) => {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "ENOENT" || code === "ENOTDIR") return null
        throw error
      })
      if (!rootInfo) continue
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        diagnostics.push({
          path: relative(workspaceRoot, annotationRoot).split(sep).join("/"),
          message: "legacy annotation root must be a real directory",
        })
        continue
      }
      const walk = async (directory: string): Promise<void> => {
        if (limitExceeded) return
        const entries = await readdir(directory, { withFileTypes: true }).catch(
          (error) => {
            const code = (error as NodeJS.ErrnoException).code
            if (code === "ENOENT" || code === "ENOTDIR") return []
            throw error
          }
        )
        for (const entry of entries) {
          entriesSeen += 1
          if (entriesSeen > 10_000) {
            limitExceeded = true
            diagnostics.push({
              path: relative(workspaceRoot, annotationRoot)
                .split(sep)
                .join("/"),
              message: "legacy annotation census exceeds its entry limit",
            })
            return
          }
          const entryPath = join(directory, entry.name)
          if (entry.isDirectory()) {
            await walk(entryPath)
            continue
          }
          if (
            entry.isSymbolicLink() ||
            (!entry.isFile() && !entry.isDirectory())
          ) {
            diagnostics.push({
              path: relative(workspaceRoot, entryPath).split(sep).join("/"),
              message: "legacy annotation storage contains an unsafe entry",
            })
            continue
          }
          if (!entry.isFile() || !entry.name.endsWith(".annotations.json")) {
            continue
          }
          const key = relative(annotationRoot, entryPath)
            .split(sep)
            .join("/")
            .slice(0, -".annotations.json".length)
          if (!expected.has(`${space.name}\0${root}\0${key}`)) {
            diagnostics.push({
              path: relative(workspaceRoot, entryPath).split(sep).join("/"),
              message: "legacy annotation has no inventoried document owner",
            })
          }
        }
      }
      await walk(annotationRoot)
    }
  }
  return diagnostics
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !fromRoot.startsWith("../") &&
      !fromRoot.startsWith("..\\"))
  )
}

function migrationError(plan: DocumentStorageV2MigrationPlan): Error {
  const detail = plan.diagnostics
    .slice(0, 3)
    .map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`)
    .join("; ")
  return new Error(
    `document storage V2 migration preflight failed: ${detail || "workspace is not ready"}`
  )
}

function legacyAnnotationKind(
  document: PreflightDocumentSource
): "docs" | "widgets" {
  return document.source.relativePath.startsWith("widgets/")
    ? "widgets"
    : "docs"
}

function legacyAnnotationPath(
  workspaceRoot: string,
  document: PreflightDocumentSource
): string {
  const analysis = analyzeDocumentPath(document.path)
  if (!analysis.safe || !analysis.canonicalPath) {
    throw new Error("legacy annotation path is unsafe")
  }
  const root = resolve(
    workspaceRoot,
    "spaces",
    document.spaceId,
    "annotations",
    legacyAnnotationKind(document)
  )
  const file = resolve(root, `${document.path}.annotations.json`)
  const fromRoot = relative(root, file)
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error("legacy annotation path escapes its store")
  }
  return file
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return false
    throw error
  }
}

function recoverInterruptedStorageMigration(): void {
  const committed = recoverInterruptedWorkspaceReplacements({ details: true })
    .filter(
      (entry) =>
        entry.kind === "document-storage-v2" &&
        entry.state === "complete" &&
        entry.backupPath
    )
    .at(-1)
  if (!committed?.backupPath) return
  throw new Error(
    `a previous storage V2 migration committed after interruption; the retained V1 rollback backup is ${committed.backupPath}`
  )
}

async function migrateLegacyAnnotations(
  workspaceRoot: string,
  documents: readonly PreflightDocumentSource[]
): Promise<{ files: number; annotations: number }> {
  let files = 0
  let annotations = 0
  for (const document of documents) {
    if (document.identity !== "durable") {
      throw new Error("annotation migration requires durable document IDs")
    }
    const path = legacyAnnotationPath(workspaceRoot, document)
    if (!(await pathExists(path))) continue
    const legacyKind = legacyAnnotationKind(document)
    const projected = await readCompatibleDocumentAnnotationsV2({
      workspaceRoot,
      spaceId: document.spaceId,
      documentId: document.documentId,
      logicalPath: document.path,
      legacyKind,
    })
    if (projected.store !== "legacy-v1") {
      throw new Error("legacy annotation path conflicts with V2 document data")
    }
    const written = await writeDocumentAnnotationsV2({
      workspaceRoot,
      spaceId: document.spaceId,
      documentId: document.documentId,
      logicalPath: document.path,
      legacyKind,
      annotations: projected.file.annotations,
      expectedRevision: projected.file.revision,
      updatedAt: projected.file.updatedAt,
    })
    const verified = await readDocumentAnnotationsV2({
      workspaceRoot,
      spaceId: document.spaceId,
      documentId: document.documentId,
    })
    if (
      !verified ||
      verified.revision !== written.revision ||
      verified.annotations.length !== projected.file.annotations.length
    ) {
      throw new Error("migrated document annotations failed verification")
    }
    await unlink(path)
    files += 1
    annotations += verified.annotations.length
  }
  return { files, annotations }
}

const LEGACY_HTML_METADATA_MAX_BYTES = 1024 * 1024
const LEGACY_HTML_STATE_MAX_BYTES = 16 * 1024 * 1024
const LEGACY_HTML_COMPANION_MAX_ENTRIES = 10_000

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function versionableWidget(widget: WidgetFile) {
  return {
    name: widget.name,
    ...(widget.description !== undefined
      ? { description: widget.description }
      : {}),
    permissions: widget.permissions,
    metadata: widget.metadata,
    runtime: widget.runtime,
  }
}

async function legacyWidgetProvenance(
  workspaceRoot: string,
  spaceId: string,
  path: string
): Promise<DocumentProvenance | null> {
  const metadataPath = join(
    workspaceRoot,
    "spaces",
    spaceId,
    "widgets.meta.json"
  )
  if (!(await pathExists(metadataPath))) return null
  try {
    const parsed = JSON.parse(
      await readBoundedRegularFile(metadataPath, LEGACY_HTML_METADATA_MAX_BYTES)
    )
    const value =
      object(parsed) && object(parsed["widgets"])
        ? parsed["widgets"][path]
        : null
    const provenance = object(value) ? value["provenance"] : null
    if (
      !object(provenance) ||
      typeof provenance["updatedAt"] !== "string" ||
      typeof provenance["updatedBy"] !== "string" ||
      typeof provenance["source"] !== "string" ||
      typeof provenance["versionId"] !== "string" ||
      typeof provenance["contentHash"] !== "string"
    ) {
      return null
    }
    return provenance as unknown as DocumentProvenance
  } catch {
    return null
  }
}

async function readLegacyHtmlCompanions(
  bundleRoot: string
): Promise<DocumentGenerationPayloadEntry[]> {
  const companions: DocumentGenerationPayloadEntry[] = []
  let entries = 0
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1
      if (entries > LEGACY_HTML_COMPANION_MAX_ENTRIES) {
        throw new Error("legacy HTML companion census exceeds its entry limit")
      }
      const absolutePath = join(directory, entry.name)
      const relativePath = relative(bundleRoot, absolutePath)
        .split(sep)
        .join("/")
      if (entry.isSymbolicLink()) {
        throw new Error(
          `legacy HTML companion is a symbolic link: ${relativePath}`
        )
      }
      if (entry.isDirectory()) {
        await walk(absolutePath)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(
          `legacy HTML companion is not a regular file: ${relativePath}`
        )
      }
      if (
        relativePath === "index.html" ||
        relativePath === "widget.yaml" ||
        relativePath === "state.yaml"
      ) {
        continue
      }
      companions.push({
        path: relativePath,
        bytes: await readBoundedRegularFileBytes(
          absolutePath,
          DOCUMENT_GENERATION_MAX_ENTRY_BYTES
        ),
      })
    }
  }
  await walk(bundleRoot)
  return companions.sort((left, right) => left.path.localeCompare(right.path))
}

async function writeMigratedHtmlArchive(input: {
  workspaceRoot: string
  spaceId: string
  path: string
  archive: WidgetFile["archive"]
}): Promise<void> {
  if (!input.archive) return
  const metadataPath = join(
    input.workspaceRoot,
    "spaces",
    input.spaceId,
    "docs.meta.json"
  )
  let raw: Record<string, unknown> = { version: 1, docs: {} }
  if (await pathExists(metadataPath)) {
    const parsed = JSON.parse(
      await readBoundedRegularFile(metadataPath, LEGACY_HTML_METADATA_MAX_BYTES)
    )
    if (!object(parsed) || parsed["version"] !== 1 || !object(parsed["docs"])) {
      throw new Error("legacy Doc metadata is invalid")
    }
    raw = parsed
  }
  const docs = raw["docs"] as Record<string, unknown>
  const current = object(docs[input.path])
    ? (docs[input.path] as Record<string, unknown>)
    : {}
  docs[input.path] = { ...current, archived: input.archive }
  await atomicWriteText(metadataPath, `${JSON.stringify(raw, null, 2)}\n`)
}

async function writeMigratedHtmlGeneration(input: {
  workspaceRoot: string
  spaceId: string
  documentId: PreflightDocumentSource["documentId"]
  path: string
  widget: WidgetFile
  html: Uint8Array
  provenance: DocumentProvenance | null
}): Promise<void> {
  const contentHash = stableVersionHash({
    html: new TextDecoder("utf-8", { fatal: true }).decode(input.html),
    widget: versionableWidget(input.widget),
  })
  const reusesLegacySnapshot =
    input.provenance?.contentHash === contentHash &&
    DocumentGenerationIdSchema.safeParse(input.provenance.versionId).success
  const createdAt = reusesLegacySnapshot
    ? input.provenance!.updatedAt
    : input.provenance
      ? new Date().toISOString()
      : input.widget.updatedAt
  // Keep every legacy snapshot authoritative for its own ID and checkpoint.
  // The migrated source receives a distinct V2 generation.
  const generationId = mintVersionId(createdAt)
  const provenance: DocumentProvenance = {
    updatedAt: createdAt,
    updatedBy: reusesLegacySnapshot
      ? input.provenance!.updatedBy
      : input.provenance
        ? "external"
        : "system",
    source: reusesLegacySnapshot
      ? input.provenance!.source
      : "filesystem",
    versionId: generationId,
    contentHash,
  }
  await writeDocumentGenerationV2({
    workspaceRoot: input.workspaceRoot,
    spaceId: input.spaceId,
    documentId: input.documentId,
    generationId,
    logicalPath: input.path,
    format: { id: BUILTIN_DOCUMENT_FORMATS.html, sourceVersion: 1 },
    operation: "update",
    createdAt,
    createdBy: provenance.updatedBy,
    source: provenance.source,
    provenance,
    authoredSource: {
      kind: "file",
      entries: [{ path: "document.html", bytes: input.html }],
    },
    companions: [
      {
        key: BUILTIN_DOCUMENT_COMPANIONS.htmlPermissions,
        entries: [
          {
            path: "properties.json",
            bytes: new TextEncoder().encode(
              `${JSON.stringify(versionableWidget(input.widget), null, 2)}\n`
            ),
          },
        ],
      },
    ],
    registry: createBuiltinDocumentFormatRegistry(),
  })
}

async function migrateLegacyHtmlDocuments(
  workspaceRoot: string,
  documents: readonly PreflightDocumentSource[]
): Promise<number> {
  let migrated = 0
  for (const document of documents) {
    if (
      document.format.id !== BUILTIN_DOCUMENT_FORMATS.html ||
      document.format.sourceVersion !== 1 ||
      document.source.kind !== "bundle" ||
      !document.source.relativePath.startsWith("widgets/") ||
      document.source.relativePath.endsWith(".wtdoc")
    ) {
      continue
    }
    if (document.identity !== "durable") {
      throw new Error("HTML migration requires a durable document ID")
    }
    const spaceRoot = resolve(workspaceRoot, "spaces", document.spaceId)
    const bundleRoot = resolve(spaceRoot, document.source.relativePath)
    const widget = WidgetFileSchema.parse(
      parseCanonicalYaml(
        await readBoundedRegularFile(
          join(bundleRoot, "widget.yaml"),
          LEGACY_HTML_METADATA_MAX_BYTES
        )
      )
    )
    if (widget.id !== document.path) {
      throw new Error("legacy HTML metadata disagrees with its logical path")
    }
    const html = await readBoundedRegularFileBytes(
      join(bundleRoot, "index.html"),
      DOCUMENT_GENERATION_MAX_ENTRY_BYTES
    )
    let runtimeState: Record<string, unknown> | undefined
    const statePath = join(bundleRoot, "state.yaml")
    if (await pathExists(statePath)) {
      const parsed = parseCanonicalYaml(
        await readBoundedRegularFile(statePath, LEGACY_HTML_STATE_MAX_BYTES)
      )
      if (!object(parsed)) {
        throw new Error("legacy HTML runtime state is not an object")
      }
      runtimeState = parsed
    }
    const companions = await readLegacyHtmlCompanions(bundleRoot)
    const destination = resolve(spaceRoot, "docs", `${document.path}.html`)
    if (await pathExists(destination)) {
      throw new Error(
        `HTML migration destination already exists: ${document.path}`
      )
    }
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, html, { flag: "wx" })
    await writeDocumentPortableStateV2({
      workspaceRoot,
      spaceId: document.spaceId,
      documentId: document.documentId,
      logicalPath: document.path,
      format: { id: BUILTIN_DOCUMENT_FORMATS.html, sourceVersion: 1 },
      stateVersion: HTML_DOCUMENT_PORTABLE_STATE_VERSION,
      entries: buildHtmlDocumentPortableStateEntries({
        widget,
        sourceBytes: html,
        ...(runtimeState ? { runtimeState } : {}),
        legacyCompanions: companions,
      }),
      registry: createBuiltinDocumentFormatRegistry(),
      expectedRevision: null,
      updatedAt: widget.updatedAt,
    })
    await writeMigratedHtmlArchive({
      workspaceRoot,
      spaceId: document.spaceId,
      path: document.path,
      archive: widget.archive,
    })
    const provenance = await legacyWidgetProvenance(
      workspaceRoot,
      document.spaceId,
      document.path
    )
    await writeMigratedHtmlGeneration({
      workspaceRoot,
      spaceId: document.spaceId,
      documentId: document.documentId,
      path: document.path,
      widget,
      html,
      provenance,
    })
    await updateDocumentInventoryAt(spaceRoot, {
      upsert: [
        {
          documentId: document.documentId,
          path: document.path,
          format: { id: BUILTIN_DOCUMENT_FORMATS.html, sourceVersion: 1 },
          source: {
            kind: "file",
            relativePath: `docs/${document.path}.html`,
          },
        },
      ],
    })
    await rm(bundleRoot, { recursive: true, force: true })
    migrated += 1
  }
  for (const spaceId of new Set(
    documents.map((document) => document.spaceId)
  )) {
    await rm(join(workspaceRoot, "spaces", spaceId, "widgets.meta.json"), {
      force: true,
    })
  }
  return migrated
}

async function requireSeparateWorkspaceRoots(
  sourceWorkspaceInput: string,
  copiedWorkspaceInput: string
): Promise<{ sourceWorkspace: string; copiedWorkspace: string }> {
  const [sourceWorkspace, copiedWorkspace] = await Promise.all([
    realpath(resolve(sourceWorkspaceInput)),
    realpath(resolve(copiedWorkspaceInput)),
  ])
  const [sourceInfo, copyInfo] = await Promise.all([
    lstat(sourceWorkspace),
    lstat(copiedWorkspace),
  ])
  if (
    !sourceInfo.isDirectory() ||
    sourceInfo.isSymbolicLink() ||
    !copyInfo.isDirectory() ||
    copyInfo.isSymbolicLink() ||
    sourceWorkspace === copiedWorkspace ||
    (sourceInfo.dev === copyInfo.dev && sourceInfo.ino === copyInfo.ino) ||
    isInside(sourceWorkspace, copiedWorkspace) ||
    isInside(copiedWorkspace, sourceWorkspace)
  ) {
    throw new Error(
      "storage V2 rehearsal requires a separate real copied workspace"
    )
  }
  return { sourceWorkspace, copiedWorkspace }
}

export async function planDocumentStorageV2Migration(
  workspaceRootInput: string,
  options: { appDir?: string; runtimeCacheKey?: string } = {}
): Promise<DocumentStorageV2MigrationPlan> {
  const workspaceRoot = await realpath(resolve(workspaceRootInput))
  const layout = await requireWorkspaceStorageVersionAt(workspaceRoot, [1])
  const identityPlan = await planDocumentIdMaterialization(
    workspaceRoot,
    options
  )
  const reservedDiagnostics =
    await reservedV2NamespaceDiagnostics(workspaceRoot)
  const annotationDiagnostics = await legacyAnnotationOwnershipDiagnostics(
    workspaceRoot,
    identityPlan.preflight.documents
  )
  const spaceDiagnostics = identityPlan.preflight.spaceIds
    .filter((spaceId) => !CanonicalIdSchema.safeParse(spaceId).success)
    .map((spaceId) => ({
      path: `spaces/${spaceId}`,
      message: "legacy Space ID cannot be represented by Storage V2",
    }))
  const diagnostics = [
    ...identityPlan.preflight.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => ({
        path: diagnostic.path ?? ".",
        message: diagnostic.message,
      })),
    ...identityPlan.census.diagnostics.map((diagnostic) => ({
      path: diagnostic.path,
      message: diagnostic.message,
    })),
    ...identityPlan.diagnostics.map((diagnostic) => ({
      path: diagnostic.path,
      message: diagnostic.message,
    })),
    ...reservedDiagnostics,
    ...annotationDiagnostics,
    ...spaceDiagnostics,
  ]
  const targetLayout = workspaceStorageLayoutFromManifest({
    ...layout.manifest,
    version: 2,
  })
  if (targetLayout.kind !== "v2") {
    diagnostics.push({
      path: "worktable.workspace.json",
      message:
        targetLayout.kind === "invalid"
          ? targetLayout.reason
          : "workspace manifest cannot be admitted as storage V2",
    })
  }
  return {
    type: "worktable.document-storage-migration-plan",
    version: 1,
    workspaceRoot,
    workspaceId: layout.manifest["id"] as string,
    sourceStorageVersion: 1,
    targetStorageVersion: 2,
    workspaceContentCheckpoint: identityPlan.workspaceContentCheckpoint,
    sourceCheckpoint: identityPlan.sourceCheckpoint,
    durableIdentityCheckpoint: durableIdentityCheckpoint(
      identityPlan.preflight.documents
    ),
    documentCount: identityPlan.documentCount,
    durableCount: identityPlan.durableCount,
    materializeCount: identityPlan.materializeCount,
    conflictCount: identityPlan.preflight.conflictCount,
    dependencyCount: identityPlan.census.dependencies.length,
    dependencyBytes: identityPlan.census.dependencies.reduce(
      (total, dependency) => total + (dependency.bytes ?? 0),
      0
    ),
    clean: identityPlan.clean && diagnostics.length === 0,
    diagnostics,
    identityPlan,
  }
}

async function admitStorageV2Manifest(stagingPath: string): Promise<void> {
  const raw = JSON.parse(
    await readFile(join(stagingPath, "worktable.workspace.json"), "utf8")
  ) as Record<string, unknown>
  if (raw["type"] !== "worktable.workspace" || raw["version"] !== 1) {
    throw new Error("staged workspace is no longer a V1 workspace")
  }
  const manifest: WorkspaceManifestV2 = {
    ...raw,
    type: "worktable.workspace",
    version: 2,
  } as WorkspaceManifestV2
  writeWorkspaceManifestBytesAt(
    stagingPath,
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  await requireWorkspaceStorageVersionAt(stagingPath, [2])
}

async function verifyMigratedWorkspace(input: {
  workspaceRoot: string
  workspaceId: string
  expectedSourceCheckpoint: string
  documentCount: number
}): Promise<{ workspaceContentCheckpoint: string }> {
  const [layout, preflight, checkpoints] = await Promise.all([
    requireWorkspaceStorageVersionAt(input.workspaceRoot, [2]),
    preflightDocumentWorkspace(input.workspaceRoot),
    calculateLocalWorkspaceContentCheckpoints(input.workspaceRoot),
  ])
  if (
    layout.manifest.id !== input.workspaceId ||
    !preflight.clean ||
    preflight.documents.some((document) => document.identity !== "durable") ||
    preflight.documentCount !== input.documentCount ||
    calculateDocumentSourceCheckpoint(preflight.documents) !==
      input.expectedSourceCheckpoint
  ) {
    throw new Error("migrated workspace failed V2 verification")
  }
  return {
    workspaceContentCheckpoint: checkpoints.workspaceContentCheckpoint,
  }
}

/**
 * Build a complete sibling workspace, write the V2 manifest only after its
 * contents verify, and atomically replace the configured copied workspace.
 */
export async function migrateDocumentStorageV2(input: {
  workspaceRoot: string
  expectedWorkspaceId: string
  expectedWorkspaceContentCheckpoint: string
  appDir?: string
  runtimeCacheKey?: string
  validateBeforeCommit?: () => Promise<void>
}): Promise<DocumentStorageV2MigrationResult> {
  const startedAt = performance.now()
  if (resolve(input.workspaceRoot) !== resolve(getWorkspaceRoot())) {
    throw new Error(
      "storage V2 migration target must be the configured workspace"
    )
  }
  recoverInterruptedStorageMigration()
  const workspaceRoot = await realpath(resolve(input.workspaceRoot))
  const inspectionOptions = {
    ...(input.appDir ? { appDir: input.appDir } : {}),
    ...(input.runtimeCacheKey
      ? { runtimeCacheKey: input.runtimeCacheKey }
      : {}),
  }
  const plan = await planDocumentStorageV2Migration(
    workspaceRoot,
    inspectionOptions
  )
  if (!plan.clean) throw migrationError(plan)
  if (
    plan.workspaceId !== input.expectedWorkspaceId ||
    plan.workspaceContentCheckpoint !== input.expectedWorkspaceContentCheckpoint
  ) {
    throw new Error("workspace changed after storage V2 migration census")
  }

  const replacementPaths = createWorkspaceReplacementPaths()
  // The sibling path belongs to this attempt as soon as copying begins. Even
  // a partial copy can be large and contain private workspace data.
  let replacementPrepared = true
  try {
    await cp(workspaceRoot, replacementPaths.stagingPath, {
      recursive: true,
      preserveTimestamps: true,
      errorOnExist: true,
      force: false,
    })
    const [sourceAfterCopy, stagedBeforeMigration] = await Promise.all([
      calculateLocalWorkspaceContentCheckpoints(workspaceRoot),
      calculateLocalWorkspaceContentCheckpoints(replacementPaths.stagingPath),
    ])
    if (
      sourceAfterCopy.workspaceContentCheckpoint !==
        plan.workspaceContentCheckpoint ||
      stagedBeforeMigration.workspaceContentCheckpoint !==
        plan.workspaceContentCheckpoint
    ) {
      throw new Error("workspace changed while the migration copy was captured")
    }

    const stagedPlan = await planDocumentIdMaterialization(
      replacementPaths.stagingPath,
      inspectionOptions
    )
    if (
      !stagedPlan.clean ||
      stagedPlan.workspaceId !== plan.workspaceId ||
      stagedPlan.workspaceContentCheckpoint !==
        plan.workspaceContentCheckpoint ||
      stagedPlan.sourceCheckpoint !== plan.sourceCheckpoint
    ) {
      throw new Error("prepared migration copy failed source verification")
    }
    const materialized = await materializeDocumentIdsAt(
      replacementPaths.stagingPath,
      {
        workspaceId: plan.workspaceId,
        workspaceContentCheckpoint: stagedPlan.workspaceContentCheckpoint,
        ...inspectionOptions,
      }
    )
    const materializedPreflight = await preflightDocumentWorkspace(
      replacementPaths.stagingPath
    )
    if (
      !materializedPreflight.clean ||
      materializedPreflight.documents.some(
        (document) => document.identity !== "durable"
      )
    ) {
      throw new Error("materialized migration copy failed annotation census")
    }
    const migratedAnnotations = await migrateLegacyAnnotations(
      replacementPaths.stagingPath,
      materializedPreflight.documents
    )
    const htmlDocumentsMigrated = await migrateLegacyHtmlDocuments(
      replacementPaths.stagingPath,
      materializedPreflight.documents
    )
    const cutoverPreflight = await preflightDocumentWorkspace(
      replacementPaths.stagingPath
    )
    if (
      !cutoverPreflight.clean ||
      cutoverPreflight.documents.some(
        (document) => document.identity !== "durable"
      ) ||
      cutoverPreflight.documentCount !== plan.documentCount
    ) {
      throw new Error("HTML document storage cutover failed verification")
    }
    const afterSourceCheckpoint = calculateDocumentSourceCheckpoint(
      cutoverPreflight.documents
    )
    await admitStorageV2Manifest(replacementPaths.stagingPath)
    await verifyMigratedWorkspace({
      workspaceRoot: replacementPaths.stagingPath,
      workspaceId: plan.workspaceId,
      expectedSourceCheckpoint: afterSourceCheckpoint,
      documentCount: plan.documentCount,
    })
    const stagedCheckpoint = (
      await calculateLocalWorkspaceContentCheckpoints(
        replacementPaths.stagingPath
      )
    ).workspaceContentCheckpoint

    const backupCheckpoints =
      await calculateLocalWorkspaceContentCheckpoints(workspaceRoot)
    if (
      backupCheckpoints.workspaceContentCheckpoint !==
      plan.workspaceContentCheckpoint
    ) {
      throw new Error("migration backup source changed before the swap")
    }
    const recovery = await createMigrationRecoveryJob({
      stagingPath: replacementPaths.stagingPath,
      backupPath: replacementPaths.backupPath,
    })

    let transaction: Awaited<
      ReturnType<typeof beginPreparedWorkspaceReplacement>
    > | null = null
    try {
      transaction = await beginPreparedWorkspaceReplacement(
        replacementPaths.stagingPath,
        replacementPaths.backupPath,
        stagedCheckpoint,
        plan.workspaceContentCheckpoint,
        {
          manifest: "use-staged",
          checkpointPaths: "local",
          ...(input.validateBeforeCommit
            ? { validateBeforeSwap: input.validateBeforeCommit }
            : {}),
        }
      )
      const verified = await verifyMigratedWorkspace({
        workspaceRoot,
        workspaceId: plan.workspaceId,
        expectedSourceCheckpoint: afterSourceCheckpoint,
        documentCount: plan.documentCount,
      })
      await transaction.commit()
      // The backup rename above is the durable commit point. A failure to
      // remove the now-terminal recovery record must not turn a successful
      // migration into a reported failure; startup can safely finish that
      // cleanup while preserving the committed V1 rollback tree.
      await settleMigrationRecoveryJob(recovery, "complete").catch(
        () => undefined
      )
      const backupPath = workspaceCommittedBackupPath(
        replacementPaths.backupPath
      )
      replacementPrepared = false
      return {
        type: "worktable.document-storage-migration-result",
        version: 1,
        workspaceRoot,
        workspaceId: plan.workspaceId,
        sourceStorageVersion: 1,
        targetStorageVersion: 2,
        beforeWorkspaceContentCheckpoint: plan.workspaceContentCheckpoint,
        afterWorkspaceContentCheckpoint: verified.workspaceContentCheckpoint,
        sourceCheckpoint: plan.sourceCheckpoint,
        afterSourceCheckpoint,
        documentCount: plan.documentCount,
        materializedCount: materialized.materializedCount,
        htmlDocumentsMigrated,
        annotationFilesMigrated: migratedAnnotations.files,
        annotationsMigrated: migratedAnnotations.annotations,
        backupPath,
        backupWorkspaceContentCheckpoint:
          backupCheckpoints.workspaceContentCheckpoint,
        copiedBytes: stagedBeforeMigration.bytes,
        elapsedMs: Math.round(performance.now() - startedAt),
      }
    } catch (error) {
      if (transaction) {
        await transaction.rollback()
        await discardRolledBackWorkspaceReplacement(
          replacementPaths.stagingPath,
          replacementPaths.backupPath
        )
        await settleMigrationRecoveryJob(recovery, "failed")
      } else if (await pathExists(workspaceRoot)) {
        // A final validation or pre-swap check can fail after the recovery
        // record is durable but before the first rename. Retire that record
        // only while the configured workspace is still present; otherwise
        // startup recovery still owns the interrupted replacement.
        await settleMigrationRecoveryJob(recovery, "failed")
      }
      throw error
    }
  } finally {
    if (replacementPrepared) {
      await rm(replacementPaths.stagingPath, { recursive: true, force: true })
    }
  }
}

export async function rehearseDocumentStorageV2Migration(input: {
  sourceWorkspace: string
  copiedWorkspace: string
  expectedWorkspaceId: string
  expectedSourceWorkspaceContentCheckpoint: string
  expectedCopyWorkspaceContentCheckpoint: string
  appDir?: string
  runtimeCacheKey?: string
  offlineConfirmed: true
}): Promise<DocumentStorageV2RehearsalResult> {
  if (input.offlineConfirmed !== true) {
    throw new Error(
      "storage V2 rehearsal requires confirmation that the copied workspace is offline"
    )
  }
  if (resolve(input.copiedWorkspace) !== resolve(getWorkspaceRoot())) {
    throw new Error(
      "storage V2 migration target must be the configured workspace"
    )
  }
  recoverInterruptedStorageMigration()
  const { sourceWorkspace, copiedWorkspace } =
    await requireSeparateWorkspaceRoots(
      input.sourceWorkspace,
      input.copiedWorkspace
    )
  const inspectionOptions = {
    ...(input.appDir ? { appDir: input.appDir } : {}),
    ...(input.runtimeCacheKey
      ? { runtimeCacheKey: input.runtimeCacheKey }
      : {}),
  }
  const [sourceBefore, copyBefore] = await Promise.all([
    planDocumentStorageV2Migration(sourceWorkspace, inspectionOptions),
    planDocumentStorageV2Migration(copiedWorkspace, inspectionOptions),
  ])
  if (!sourceBefore.clean || !copyBefore.clean) {
    throw new Error("source or copied workspace is not ready for V2 migration")
  }
  if (
    sourceBefore.workspaceId !== input.expectedWorkspaceId ||
    copyBefore.workspaceId !== input.expectedWorkspaceId ||
    sourceBefore.workspaceContentCheckpoint !==
      input.expectedSourceWorkspaceContentCheckpoint ||
    copyBefore.workspaceContentCheckpoint !==
      input.expectedCopyWorkspaceContentCheckpoint
  ) {
    throw new Error("source or copied workspace changed after migration census")
  }
  if (
    sourceBefore.sourceCheckpoint !== copyBefore.sourceCheckpoint ||
    sourceBefore.identityPlan.materializationBaseCheckpoint !==
      copyBefore.identityPlan.materializationBaseCheckpoint ||
    sourceBefore.durableIdentityCheckpoint !==
      copyBefore.durableIdentityCheckpoint ||
    sourceBefore.documentCount !== copyBefore.documentCount
  ) {
    throw new Error("copied workspace does not match its migration source")
  }
  await assertSourceDocumentInventoryLineage(
    sourceWorkspace,
    copiedWorkspace,
    sourceBefore.identityPlan.preflight.spaceIds
  )

  let sourceImmediatelyBeforeCommit = sourceBefore.workspaceContentCheckpoint
  const migrated = await migrateDocumentStorageV2({
    workspaceRoot: copiedWorkspace,
    expectedWorkspaceId: copyBefore.workspaceId,
    expectedWorkspaceContentCheckpoint: copyBefore.workspaceContentCheckpoint,
    validateBeforeCommit: async () => {
      const current = await planDocumentStorageV2Migration(
        sourceWorkspace,
        inspectionOptions
      )
      if (
        !current.clean ||
        current.workspaceContentCheckpoint !==
          sourceBefore.workspaceContentCheckpoint ||
        current.sourceCheckpoint !== sourceBefore.sourceCheckpoint ||
        current.durableIdentityCheckpoint !==
          sourceBefore.durableIdentityCheckpoint
      ) {
        throw new Error("source workspace changed during migration rehearsal")
      }
      await assertSourceDocumentInventoryLineage(
        sourceWorkspace,
        copiedWorkspace,
        sourceBefore.identityPlan.preflight.spaceIds
      )
      sourceImmediatelyBeforeCommit = current.workspaceContentCheckpoint
    },
    ...inspectionOptions,
  })
  const failedWorkspace = `${copiedWorkspace}.storage-v2-rollback-${Date.now()}`
  return {
    ...migrated,
    sourceWorkspace,
    copiedWorkspace,
    sourceAfterWorkspaceContentCheckpoint: sourceImmediatelyBeforeCommit,
    rollbackProcedure: [
      "Stop Worktable before restoring the retained V1 backup.",
      `Move ${copiedWorkspace} to ${failedWorkspace}.`,
      `Move ${migrated.backupPath} to ${copiedWorkspace}.`,
      `Verify workspace checkpoint ${migrated.backupWorkspaceContentCheckpoint} before reopening.`,
    ],
  }
}
