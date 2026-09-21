import { createHash, randomBytes } from "node:crypto"
import {
  closeSync,
  constants,
  type Dirent,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path"
import {
  AnnotationFileSchema,
  CanonicalIdSchema,
  DOCUMENT_ARCHIVE_REASON_MAX_LENGTH,
  DocumentFormatClaimSchema,
  DocumentIdSchema,
  DocumentSourceSchema,
  SpaceFileSchema,
  WidgetFileSchema,
  WidgetIdSchema,
  type DocumentFormatClaim,
  type DocumentId,
  type DocumentSource,
} from "@worktable/types"
import { z } from "zod"
import { parseCanonicalYaml, rewriteYamlTopLevelString } from "./yaml.ts"
import { ensureAppDir, getAppDir } from "./app-storage.ts"
import { withAnnotationStoreLock } from "./annotation-store.ts"
import { notifyDocContentChanged } from "./content-events.ts"
import { buildDocumentCatalog } from "./document-catalog.ts"
import {
  withDocumentDataV2ExactDelete,
  withDocumentDataV2ExactMove,
  withDocumentDataV2PrefixDelete,
  withDocumentDataV2PrefixMove,
} from "./document-data-lifecycle-v2.ts"
import {
  activeArchiveFieldState,
  archiveFieldStatesEqual,
  archiveMetadataRelativePath,
  DOCUMENT_ARCHIVE_ADAPTER_IDS,
  DocumentArchiveAdapterIdSchema,
  isArchivedFieldState,
  parseArchiveFieldState,
  readArchiveFieldStates,
  rewriteArchiveFieldStates,
  serializeArchiveFieldState,
  type ArchiveFieldState,
} from "./document-archive-adapter.ts"
import {
  DOCUMENT_DELETE_ADAPTER_IDS,
  DocumentDeleteAdapterIdSchema,
  type DocumentDeleteAdapterId,
} from "./document-delete-adapter.ts"
import {
  mintDocumentId,
  prepareDocumentInventoryMutationAt,
  readDocumentInventory,
  updateDocumentInventory,
} from "./document-inventory.ts"
import {
  analyzeDocumentPath,
  documentPathKeyIsAtOrBelow,
  documentPathKeyIsBelow,
  remapDocumentPathPrefix,
} from "./document-path.ts"
import {
  BUILTIN_DOCUMENT_FORMATS,
  createBuiltinDocumentFormatRegistry,
} from "./document-format-registry.ts"
import {
  DOCUMENT_STORAGE_PROFILE_IDS,
  documentStorageProfiles,
  type DocumentStorageProfileId,
} from "./document-storage-profile.ts"
import {
  DOC_ALIASES_MAX_BYTES,
  prepareDocAliasBatch,
  prepareDocAliasMove,
  prepareDocAliasPrefixRetirement,
  prepareDocAliasRetirement,
  parseDocAliasesSnapshot,
  readDocAliases,
  reservedByAliasIn,
  withDocAliasLock,
} from "./doc-aliases.ts"
import {
  getSpacesBaseDir,
  prepareSuppressedDocReplay,
  prepareSuppressedPathReplay,
  recordExternalDocChange,
  recordRecoveredDocFormatTransition,
  suppressPath,
  unsuppressPath,
  withStoreWriteLock,
  withStoreWriteLocks,
} from "./store.ts"
import { withHostedDocumentShareLifecycle } from "./share-lifecycle.ts"
import type { ShareArtifact } from "./share-store.ts"
import {
  retiredVersionGenerationDir,
  stableVersionHash,
  withVersionKeyLocks,
  versionKeyDir,
} from "./version-store.ts"
import {
  getWorkspaceManifestPath,
  getWorkspaceRoot,
  getVersionsDir,
  isWorkspaceManifest,
  workspaceCacheKey,
} from "./workspace.ts"
import { notifyWorkspaceChangeAndWait } from "./workspace-events.ts"
import { requireWorkspaceRecovery } from "./workspace-safety.ts"
import { yjsManager } from "./yjs-manager.ts"

const JOURNAL_SCHEMA_VERSION = 1 as const
const LEGACY_JOURNAL_PLAN_VERSION = 1 as const
const JOURNAL_PLAN_VERSION = 2 as const
const JOURNAL_MAX_BYTES = 256 * 1024
const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024
const ARTIFACT_TOTAL_MAX_BYTES = 64 * 1024 * 1024
const SOURCE_MAX_BYTES = 2 * 1024 * 1024 * 1024
const SOURCE_BUNDLE_MAX_ENTRIES = 100_000
const HISTORY_MAX_FILES = 100_000
const RECOVERY_CATALOG_MAX_ENTRIES = 100_000
const PREFIX_RENAME_MAX_DOCUMENTS = 128
const OPERATION_ID_PATTERN = /^dlc_[A-Za-z0-9_-]{22}$/
const RECONCILIATION_PREFIX = ".reconcile-"
const lifecycleFormatRegistry = createBuiltinDocumentFormatRegistry()

function legacyVersionKindFor(
  format: DocumentFormatClaim,
  fallback: "docs" | "widgets"
): "docs" | "widgets" {
  return lifecycleFormatRegistry.get(format.id)?.legacyVersionKind ?? fallback
}

const SIMPLE_ARTIFACT_ROLES = [
  "doc-meta",
  "space-order",
  "inventory",
  "aliases",
  "doc-annotation",
  "widget-meta",
  "widget-annotation",
] as const
type SimpleArtifactRole = (typeof SIMPLE_ARTIFACT_ROLES)[number]
const SIMPLE_ARTIFACT_ORDER: readonly SimpleArtifactRole[] = [
  "doc-meta",
  "space-order",
  "inventory",
  "aliases",
  "doc-annotation",
  "widget-meta",
  "widget-annotation",
]
type ArtifactSide = "before" | "after"

const DURABLE_STEPS = [
  "target",
  "share-revoked",
  "history",
  "source",
  "archive-state",
  "doc-meta",
  "space-order",
  "inventory",
  "annotation",
  "aliases",
  "doc-annotation",
  "widget-meta",
  "widget-annotation",
  "committed",
] as const
type DurableStep = (typeof DURABLE_STEPS)[number]
type LifecycleFaultStep =
  | DurableStep
  | "before-journal-publication"
  | "archive-before-metadata-publication"
  | "journal-published"
  | "target-published"
  | "history-file-moved"
  | "source-moved"
  | "archive-mutation-written"
  | "annotation-moved"
  | "reconciliation-target-captured"
  | "delete-source-cleaned"
  | "cleanup-renamed"

const BlobRefSchema = z
  .object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().min(0).max(ARTIFACT_MAX_BYTES),
  })
  .strict()

const DirectHistoryFileSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (name) =>
          name !== "." &&
          name !== ".." &&
          !name.includes("/") &&
          !name.includes("\\") &&
          !name.includes("\0")
      ),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().min(0).max(SOURCE_MAX_BYTES),
  })
  .strict()

const DirectHistoryManifestSchema = z
  .array(DirectHistoryFileSchema)
  .max(HISTORY_MAX_FILES)

const ArtifactEditSchema = z
  .object({
    role: z.enum(SIMPLE_ARTIFACT_ROLES),
    before: BlobRefSchema.nullable(),
    after: BlobRefSchema.nullable(),
  })
  .strict()

const AnnotationEditSchema = z
  .object({
    before: BlobRefSchema,
    after: BlobRefSchema,
  })
  .strict()

const SourceIdentityEditSchema = z
  .object({
    relativePath: z.literal("widget.yaml"),
    before: BlobRefSchema,
    after: BlobRefSchema,
  })
  .strict()

const DocumentStorageProfileIdSchema = z.enum([
  DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile,
  DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle,
  DOCUMENT_STORAGE_PROFILE_IDS.coreBundle,
])

const JournalBaseSchema = z.object({
  schemaVersion: z.literal(JOURNAL_SCHEMA_VERSION),
  planVersion: z.union([
    z.literal(LEGACY_JOURNAL_PLAN_VERSION),
    z.literal(JOURNAL_PLAN_VERSION),
  ]),
  operationId: z.string().regex(OPERATION_ID_PATTERN),
  createdAt: z.iso.datetime(),
  phase: z.enum(["applying", "committed"]),
  workspace: z
    .object({
      canonicalRoot: z.string().min(1),
      manifestId: z.string().min(1),
    })
    .strict(),
})

const EndpointSchema = z
  .object({
    spaceId: CanonicalIdSchema,
    logicalPath: z.string().min(1),
    source: DocumentSourceSchema,
  })
  .strict()

const ExactRenameJournalSchema = JournalBaseSchema.extend({
  operationType: z.literal("exact-rename"),
  document: z
    .object({
      id: DocumentIdSchema,
      format: DocumentFormatClaimSchema,
      sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
      sourceSize: z.number().int().min(0),
      sourceEntries: z
        .number()
        .int()
        .min(0)
        .max(SOURCE_BUNDLE_MAX_ENTRIES)
        .optional(),
      sourceIdentity: SourceIdentityEditSchema.optional(),
      history: z.enum(["present", "absent"]),
      historyManifest: BlobRefSchema.optional(),
    })
    .strict(),
  from: EndpointSchema,
  to: EndpointSchema,
  edits: z.array(ArtifactEditSchema).max(SIMPLE_ARTIFACT_ROLES.length),
  annotation: AnnotationEditSchema.nullable(),
  completed: z.array(z.enum(DURABLE_STEPS)).max(DURABLE_STEPS.length),
}).strict()

const PrefixRenameDocumentSchema = z
  .object({
    document: z
      .object({
        id: DocumentIdSchema,
        format: DocumentFormatClaimSchema,
        sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
        sourceSize: z.number().int().min(0),
        sourceEntries: z
          .number()
          .int()
          .min(0)
          .max(SOURCE_BUNDLE_MAX_ENTRIES)
          .optional(),
        sourceIdentity: SourceIdentityEditSchema.optional(),
        history: z.enum(["present", "absent"]),
        historyManifest: BlobRefSchema,
      })
      .strict(),
    from: EndpointSchema,
    to: EndpointSchema,
    annotation: AnnotationEditSchema.nullable(),
  })
  .strict()

const PrefixEndpointSchema = z
  .object({
    spaceId: CanonicalIdSchema,
    logicalPath: z.string().min(1),
  })
  .strict()

const PrefixRenameJournalSchema = JournalBaseSchema.extend({
  operationType: z.literal("prefix-rename"),
  from: PrefixEndpointSchema,
  to: PrefixEndpointSchema,
  documents: z
    .array(PrefixRenameDocumentSchema)
    .min(1)
    .max(PREFIX_RENAME_MAX_DOCUMENTS),
  completedDocuments: z.number().int().min(0).max(PREFIX_RENAME_MAX_DOCUMENTS),
  edits: z.array(ArtifactEditSchema).max(SIMPLE_ARTIFACT_ROLES.length),
  completed: z.array(z.enum(DURABLE_STEPS)).max(DURABLE_STEPS.length),
}).strict()

const PrefixArchiveDocumentSchema = z
  .object({
    document: z
      .object({
        id: DocumentIdSchema,
        format: DocumentFormatClaimSchema,
      })
      .strict(),
    at: EndpointSchema,
    storageProfileId: DocumentStorageProfileIdSchema,
    archiveAdapter: DocumentArchiveAdapterIdSchema,
    archive: z
      .object({
        before: BlobRefSchema,
        after: BlobRefSchema,
      })
      .strict(),
  })
  .strict()

const PrefixArchiveMutationSchema = z
  .object({
    storageProfileId: DocumentStorageProfileIdSchema,
    archiveAdapter: DocumentArchiveAdapterIdSchema,
    documentIndexes: z
      .array(
        z
          .number()
          .int()
          .min(0)
          .max(PREFIX_RENAME_MAX_DOCUMENTS - 1)
      )
      .min(1)
      .max(PREFIX_RENAME_MAX_DOCUMENTS),
  })
  .strict()

const PrefixArchiveJournalSchema = JournalBaseSchema.extend({
  operationType: z.literal("prefix-archive"),
  /** Omitted by historical folder journals. */
  scope: z.enum(["folder", "exact"]).optional(),
  from: PrefixEndpointSchema,
  to: PrefixEndpointSchema,
  archived: z.boolean(),
  documents: z
    .array(PrefixArchiveDocumentSchema)
    .min(1)
    .max(PREFIX_RENAME_MAX_DOCUMENTS),
  mutations: z
    .array(PrefixArchiveMutationSchema)
    .max(PREFIX_RENAME_MAX_DOCUMENTS),
  completedMutations: z.number().int().min(0).max(PREFIX_RENAME_MAX_DOCUMENTS),
  edits: z.tuple([]),
  annotation: z.null(),
  completed: z.array(z.enum(DURABLE_STEPS)).max(DURABLE_STEPS.length),
}).strict()

const FormatTransitionJournalSchema = JournalBaseSchema.extend({
  operationType: z.literal("format-transition"),
  document: z
    .object({
      id: DocumentIdSchema,
      format: DocumentFormatClaimSchema,
      afterFormat: DocumentFormatClaimSchema,
      sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
      sourceSize: z.number().int().min(0),
      targetSha256: z.string().regex(/^[0-9a-f]{64}$/),
      targetSize: z.number().int().min(0).max(SOURCE_MAX_BYTES),
      history: z.literal("absent"),
    })
    .strict(),
  from: EndpointSchema,
  to: EndpointSchema,
  context: z
    .object({
      updatedBy: z.string().min(1).max(512),
      source: z.string().min(1).max(512),
      reason: z.string().max(2048).optional(),
    })
    .strict(),
  edits: z.array(ArtifactEditSchema).max(2),
  annotation: z.null(),
  completed: z.array(z.enum(DURABLE_STEPS)).max(DURABLE_STEPS.length),
}).strict()

const ExactDeletePresentDocumentSchema = z
  .object({
    id: DocumentIdSchema,
    format: DocumentFormatClaimSchema,
    sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
    sourceSize: z.number().int().min(0).max(SOURCE_MAX_BYTES),
    // Directory-backed sources include their descendant count. File journals
    // written before bundle deletion support omit this field.
    sourceEntries: z
      .number()
      .int()
      .min(0)
      .max(SOURCE_BUNDLE_MAX_ENTRIES)
      .optional(),
    // Journals written before source-absent deletion support omit this field.
    sourceState: z.literal("present").optional(),
    history: z.enum(["present", "absent"]),
    historyManifest: BlobRefSchema.optional(),
  })
  .strict()

const ExactDeleteAbsentDocumentSchema = z
  .object({
    id: DocumentIdSchema,
    format: DocumentFormatClaimSchema,
    sourceState: z.literal("absent"),
    history: z.enum(["present", "absent"]),
    historyManifest: BlobRefSchema.optional(),
  })
  .strict()

const ExactDeleteJournalSchema = JournalBaseSchema.extend({
  operationType: z.literal("exact-delete"),
  document: z.union([
    ExactDeletePresentDocumentSchema,
    ExactDeleteAbsentDocumentSchema,
  ]),
  from: EndpointSchema,
  to: EndpointSchema,
  edits: z.array(ArtifactEditSchema).max(SIMPLE_ARTIFACT_ROLES.length),
  annotation: z.null(),
  completed: z.array(z.enum(DURABLE_STEPS)).max(DURABLE_STEPS.length),
}).strict()

const PrefixDeleteDocumentSchema = z
  .object({
    document: ExactDeletePresentDocumentSchema.extend({
      identity: z.literal("durable"),
    }),
    at: EndpointSchema,
    storageProfileId: DocumentStorageProfileIdSchema,
    deleteAdapter: DocumentDeleteAdapterIdSchema,
    annotation: BlobRefSchema.nullable(),
  })
  .strict()

const PrefixDeleteJournalSchema = JournalBaseSchema.extend({
  operationType: z.literal("prefix-delete"),
  from: PrefixEndpointSchema,
  to: PrefixEndpointSchema,
  documents: z
    .array(PrefixDeleteDocumentSchema)
    .min(1)
    .max(PREFIX_RENAME_MAX_DOCUMENTS),
  completedDocuments: z.number().int().min(0).max(PREFIX_RENAME_MAX_DOCUMENTS),
  edits: z.array(ArtifactEditSchema).max(SIMPLE_ARTIFACT_ROLES.length),
  completed: z.array(z.enum(DURABLE_STEPS)).max(DURABLE_STEPS.length),
}).strict()

const JournalSchema = z.discriminatedUnion("operationType", [
  ExactRenameJournalSchema,
  PrefixRenameJournalSchema,
  PrefixArchiveJournalSchema,
  FormatTransitionJournalSchema,
  ExactDeleteJournalSchema,
  PrefixDeleteJournalSchema,
])

type BlobRef = z.infer<typeof BlobRefSchema>
type DirectHistoryFile = z.infer<typeof DirectHistoryFileSchema>
type ArtifactEdit = z.infer<typeof ArtifactEditSchema>
type DocumentLifecycleJournal = z.infer<typeof JournalSchema>
type ExactRenameJournal = z.infer<typeof ExactRenameJournalSchema>
type PrefixRenameJournal = z.infer<typeof PrefixRenameJournalSchema>
type PrefixRenameDocument = z.infer<typeof PrefixRenameDocumentSchema>
type PrefixArchiveJournal = z.infer<typeof PrefixArchiveJournalSchema>
type PrefixArchiveDocument = z.infer<typeof PrefixArchiveDocumentSchema>
type PrefixArchiveMutation = z.infer<typeof PrefixArchiveMutationSchema>
type PrefixLifecycleJournal =
  | PrefixRenameJournal
  | PrefixArchiveJournal
  | PrefixDeleteJournal
type LifecycleEndpoint = z.infer<typeof EndpointSchema>
type FormatTransitionJournal = z.infer<typeof FormatTransitionJournalSchema>
type ExactDeleteJournal = z.infer<typeof ExactDeleteJournalSchema>
type PrefixDeleteJournal = z.infer<typeof PrefixDeleteJournalSchema>
type PrefixDeleteDocument = z.infer<typeof PrefixDeleteDocumentSchema>

interface PreparedJournal {
  journal: DocumentLifecycleJournal
  blobs: Map<string, Buffer>
  directHistoryFiles?: DirectHistoryFile[]
  prefixHistoryFiles?: DirectHistoryFile[][]
  prefixDeleteHistoryFiles?: Array<DirectHistoryFile[] | undefined>
  targetBytes?: Buffer
}

export interface DurableExactRenameOutcome {
  handled: boolean
  documentId?: DocumentId
  error?: string
}

export interface DurablePrefixRenameOutcome {
  handled: boolean
  renamed?: Array<{ from: string; to: string; documentId: DocumentId }>
  error?: string
}

export interface DurablePrefixRenameMove {
  from: string
  to: string
  storageProfileId: DocumentStorageProfileId
}

export interface DurablePrefixArchiveDocument {
  path: string
  storageProfileId: DocumentStorageProfileId
}

export interface DurablePrefixArchiveContext {
  archivedBy: string
  reason?: string
}

export interface DurablePrefixArchiveOutcome {
  handled: boolean
  changed?: Array<{
    path: string
    documentId: DocumentId
    storageProfileId: DocumentStorageProfileId
  }>
  error?: string
}

export interface DurableFormatTransitionOutcome {
  handled: boolean
  documentId?: DocumentId
  error?: string
}

export interface DurableExactDeleteOutcome {
  handled: boolean
  documentId?: DocumentId
  error?: string
}

export interface DurablePrefixDeleteDocument {
  path: string
  storageProfileId: DocumentStorageProfileId
  deleteAdapter: DocumentDeleteAdapterId
}

export interface DurablePrefixDeleteOutcome {
  handled: boolean
  deleted?: Array<{
    path: string
    documentId: DocumentId
    storageProfileId: DocumentStorageProfileId
  }>
  error?: string
}

export interface DurableFormatTransitionOptions {
  spaceId: string
  docPath: string
  format: DocumentFormatClaim
  bytes: Uint8Array
  sourceRevision?: { relativePath: string; size: number; sha256: string }
  rotateCollaborationCache?: boolean
  context?: { updatedBy?: string; source?: string; reason?: string }
  validateBeforeCommit?: () => Promise<boolean>
  onCommitted?: () => Promise<void>
}

export interface RecoveredDocumentLifecycle {
  operationId: string
  spaceId: string
  docPath: string
}

export class SimulatedDocumentLifecycleCrash extends Error {}

class DocumentLifecyclePreconditionError extends Error {}

class CompensatedDocumentLifecycleError extends Error {
  constructor(cause: unknown) {
    super(
      cause instanceof Error
        ? cause.message
        : "Document lifecycle operation was compensated",
      { cause }
    )
    this.name = "CompensatedDocumentLifecycleError"
  }
}

/** True only when recovery proved that the active document generation survived. */
export function didDocumentLifecyclePreserveGeneration(
  error: unknown
): boolean {
  return error instanceof CompensatedDocumentLifecycleError
}

let stepHookForTests:
  | ((step: LifecycleFaultStep) => void | Promise<void>)
  | null = null

export function setDocumentLifecycleStepHookForTests(
  hook: ((step: LifecycleFaultStep) => void | Promise<void>) | null
): void {
  stepHookForTests = hook
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function optionalBytesEqual(
  left: Buffer | null,
  right: Buffer | null
): boolean {
  return left === null ? right === null : right !== null && left.equals(right)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR"
}

function hasFilesystemEntry(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return (
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  )
}

function requireRealDirectory(path: string, label: string): void {
  const info = lstatSync(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`)
  }
}

function assertSafeContainedPath(root: string, path: string): void {
  const resolvedRoot = resolve(root)
  const candidate = resolve(path)
  if (!inside(resolvedRoot, candidate)) {
    throw new Error("document lifecycle path escaped its trusted root")
  }
  const rel = relative(resolvedRoot, candidate)
  let current = resolvedRoot
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment)
    try {
      const info = lstatSync(current)
      if (info.isSymbolicLink()) {
        throw new Error("document lifecycle path traverses a symbolic link")
      }
      if (current !== candidate && !info.isDirectory()) {
        throw new Error("document lifecycle path traverses a non-directory")
      }
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
  }
}

function assertSafeWorkspacePath(path: string): void {
  const root = resolve(getWorkspaceRoot())
  requireRealDirectory(root, "Workspace root")
  assertSafeContainedPath(root, path)
}

function assertSafeAppPath(path: string): void {
  const root = resolve(getAppDir())
  requireRealDirectory(root, "Application data root")
  assertSafeContainedPath(root, path)
}

function readOptionalRegularFile(
  path: string,
  maxBytes: number
): Buffer | null {
  const flags =
    constants.O_RDONLY |
    (constants.O_NOFOLLOW ?? 0) |
    (constants.O_NONBLOCK ?? 0)
  let fd: number
  try {
    fd = openSync(path, flags)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  try {
    const opened = fstatSync(fd)
    const reachable = lstatSync(path)
    if (
      !opened.isFile() ||
      !reachable.isFile() ||
      reachable.isSymbolicLink() ||
      opened.dev !== reachable.dev ||
      opened.ino !== reachable.ino
    ) {
      throw new Error(
        `document lifecycle input must be a regular file: ${path}`
      )
    }
    if (opened.size > maxBytes) {
      throw new Error(
        `document lifecycle input exceeds its size limit: ${path}`
      )
    }
    const bytes = Buffer.allocUnsafe(opened.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      const count = readSync(fd, bytes, offset, bytes.byteLength - offset, null)
      if (count === 0) break
      offset += count
    }
    const growthProbe = Buffer.allocUnsafe(1)
    const grew = readSync(fd, growthProbe, 0, growthProbe.byteLength, null) > 0
    const after = fstatSync(fd)
    const reachableAfter = lstatSync(path)
    if (
      offset !== opened.size ||
      grew ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      reachableAfter.dev !== opened.dev ||
      reachableAfter.ino !== opened.ino ||
      !reachableAfter.isFile() ||
      reachableAfter.isSymbolicLink()
    ) {
      throw new Error(
        `document lifecycle input changed while it was read: ${path}`
      )
    }
    return bytes
  } finally {
    closeSync(fd)
  }
}

function fingerprintOptionalRegularFile(
  path: string,
  options?: { rejectNotDirectory?: boolean }
): { size: number; sha256: string } | null {
  const flags =
    constants.O_RDONLY |
    (constants.O_NOFOLLOW ?? 0) |
    (constants.O_NONBLOCK ?? 0)
  let fd: number
  try {
    fd = openSync(path, flags)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (
      code === "ENOENT" ||
      (code === "ENOTDIR" && !options?.rejectNotDirectory)
    ) {
      return null
    }
    throw error
  }
  try {
    const opened = fstatSync(fd)
    const reachable = lstatSync(path)
    if (
      !opened.isFile() ||
      !reachable.isFile() ||
      reachable.isSymbolicLink() ||
      opened.dev !== reachable.dev ||
      opened.ino !== reachable.ino
    ) {
      throw new Error(
        `document lifecycle input changed or is not a regular file: ${path}`
      )
    }
    if (opened.size > SOURCE_MAX_BYTES) {
      throw new Error(
        `document lifecycle source exceeds its supported size limit: ${path}`
      )
    }
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let captured = 0
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.byteLength, null)
      if (bytesRead === 0) break
      captured += bytesRead
      if (captured > SOURCE_MAX_BYTES) {
        throw new Error(
          `document lifecycle source exceeds its supported size limit: ${path}`
        )
      }
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = fstatSync(fd)
    const reachableAfter = lstatSync(path)
    if (
      captured !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.dev !== reachableAfter.dev ||
      opened.ino !== reachableAfter.ino ||
      !reachableAfter.isFile() ||
      reachableAfter.isSymbolicLink()
    ) {
      throw new Error(
        `document lifecycle input changed while it was inspected: ${path}`
      )
    }
    return { size: captured, sha256: hash.digest("hex") }
  } finally {
    closeSync(fd)
  }
}

function captureDirectHistoryFiles(path: string): DirectHistoryFile[] {
  let directory: ReturnType<typeof lstatSync>
  try {
    directory = lstatSync(path)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new DocumentLifecyclePreconditionError(
      "Document history must be a real directory"
    )
  }

  const files: DirectHistoryFile[] = []
  let totalBytes = 0
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) continue
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new DocumentLifecyclePreconditionError(
        "Document history contains an unsupported entry"
      )
    }
    if (files.length >= HISTORY_MAX_FILES) {
      throw new DocumentLifecyclePreconditionError(
        "Document history contains too many snapshots to change safely"
      )
    }
    const fingerprint = fingerprintOptionalRegularFile(join(path, entry.name), {
      rejectNotDirectory: true,
    })
    if (!fingerprint) {
      throw new DocumentLifecyclePreconditionError(
        "Document history changed while it was inspected"
      )
    }
    totalBytes += fingerprint.size
    if (totalBytes > SOURCE_MAX_BYTES) {
      throw new DocumentLifecyclePreconditionError(
        "Document history exceeds its supported size limit"
      )
    }
    const parsed = DirectHistoryFileSchema.safeParse({
      name: entry.name,
      ...fingerprint,
    })
    if (!parsed.success) {
      throw new DocumentLifecyclePreconditionError(
        "Document history contains an unsupported snapshot name"
      )
    }
    files.push(parsed.data)
  }
  return files
}

function fingerprintOptionalDeleteFile(
  path: string
): { size: number; sha256: string } | null {
  return fingerprintOptionalRegularFile(path, { rejectNotDirectory: true })
}

interface BundleFingerprint {
  size: number
  sha256: string
  entries: number
}

function unsafeBundleDeletion(): DocumentLifecyclePreconditionError {
  return new DocumentLifecyclePreconditionError(
    "This HTML doc contains files that cannot be deleted safely"
  )
}

/**
 * Capture one directory generation without following links. The digest owns
 * the complete tree, including empty directories and unknown regular files,
 * while the limits keep startup recovery work bounded.
 */
function fingerprintOptionalBundle(path: string): BundleFingerprint | null {
  let root
  try {
    root = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw unsafeBundleDeletion()
  }

  const hash = createHash("sha256")
  let size = 0
  let entries = 0
  const account = (): void => {
    entries += 1
    if (entries > SOURCE_BUNDLE_MAX_ENTRIES) {
      throw unsafeBundleDeletion()
    }
  }
  const record = (value: unknown): void => {
    hash.update(JSON.stringify(value))
    hash.update("\n")
  }
  const walk = (directory: string, relativePath: string): void => {
    const before = lstatSync(directory)
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw unsafeBundleDeletion()
    }
    if (relativePath) record(["directory", relativePath])
    const children = readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    )
    for (const child of children) {
      account()
      const childPath = join(directory, child.name)
      const childRelativePath = relativePath
        ? `${relativePath}/${child.name}`
        : child.name
      const info = lstatSync(childPath)
      if (info.isSymbolicLink()) {
        throw unsafeBundleDeletion()
      }
      if (info.isDirectory()) {
        walk(childPath, childRelativePath)
        continue
      }
      if (!info.isFile()) {
        throw unsafeBundleDeletion()
      }
      const file = fingerprintOptionalRegularFile(childPath, {
        rejectNotDirectory: true,
      })
      if (!file) {
        throw unsafeBundleDeletion()
      }
      size += file.size
      if (size > SOURCE_MAX_BYTES) {
        throw unsafeBundleDeletion()
      }
      record(["file", childRelativePath, file.size, file.sha256])
    }
    const after = lstatSync(directory)
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw unsafeBundleDeletion()
    }
  }

  walk(path, "")
  return { size, sha256: hash.digest("hex"), entries }
}

function existingBundlePaths(path: string): string[] {
  let root
  try {
    root = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new Error(
      `document lifecycle input changed or is not a real directory: ${path}`
    )
  }
  const paths = [path]
  let entries = 0
  const walk = (directory: string): void => {
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      entries += 1
      if (entries > SOURCE_BUNDLE_MAX_ENTRIES) {
        throw new Error(
          `document lifecycle source exceeds its entry limit: ${path}`
        )
      }
      const childPath = join(directory, child.name)
      const info = lstatSync(childPath)
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
        throw new Error(
          `document lifecycle bundle contains an unsafe entry: ${childPath}`
        )
      }
      paths.push(childPath)
      if (info.isDirectory()) walk(childPath)
    }
  }
  walk(path)
  return paths
}

type DeleteSourceFingerprint =
  | { kind: "file"; size: number; sha256: string }
  | { kind: "bundle"; size: number; sha256: string; entries: number }

interface ExactDeleteBehavior {
  historyKind: "docs" | "widgets"
  shareKind: "doc" | "html"
  reconciliationKind: "doc" | "widget"
  usesDocCollaboration: boolean
}

interface ExactRenameBehavior {
  historyKind: "docs" | "widgets"
  shareKind: "doc" | "html"
  reconciliationKind: "doc" | "widget"
  annotationKind: "doc" | "widget"
  usesDocCollaboration: boolean
  parksBundleSource: boolean
}

/** Logical companions belong to a storage profile, never to file-vs-bundle. */
function exactRenameBehavior(
  journal: Pick<ExactRenameJournal, "document" | "from">
): ExactRenameBehavior {
  const profile = documentStorageProfiles.resolve(
    journal.document.format,
    journal.from.source
  )
  const historyKind = legacyVersionKindFor(
    journal.document.format,
    profile === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
      ? "widgets"
      : "docs"
  )
  if (historyKind === "docs") {
    return {
      historyKind: "docs",
      shareKind: "doc",
      reconciliationKind: "doc",
      annotationKind: "doc",
      usesDocCollaboration: true,
      parksBundleSource: false,
    }
  }
  if (
    historyKind === "widgets" &&
    (profile === DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile ||
      profile === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle)
  ) {
    return {
      historyKind: "widgets",
      shareKind: "html",
      reconciliationKind: "widget",
      annotationKind: "widget",
      usesDocCollaboration: false,
      parksBundleSource:
        profile === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle,
    }
  }
  throw new Error("document move source adapter is unsupported")
}

function prefixRenameBehavior(
  entry: Pick<PrefixRenameDocument, "document" | "from">
): ExactRenameBehavior {
  return exactRenameBehavior(entry)
}

interface PrefixArchiveBehavior {
  shareKind: "doc" | "html"
  reconciliationKind: "doc" | "widget"
}

function prefixArchiveBehavior(
  entry: Pick<PrefixArchiveDocument, "archiveAdapter" | "document">
): PrefixArchiveBehavior {
  const legacyKind = lifecycleFormatRegistry.get(
    entry.document.format.id
  )?.legacyVersionKind
  if (legacyKind === "docs") {
    return { shareKind: "doc", reconciliationKind: "doc" }
  }
  if (legacyKind === "widgets") {
    return { shareKind: "html", reconciliationKind: "widget" }
  }
  if (entry.archiveAdapter === DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyDocMetadata) {
    return { shareKind: "doc", reconciliationKind: "doc" }
  }
  if (
    entry.archiveAdapter === DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyWidgetManifest
  ) {
    return { shareKind: "html", reconciliationKind: "widget" }
  }
  const unsupportedAdapter: never = entry.archiveAdapter
  throw new Error(
    `Unsupported document archive adapter: ${String(unsupportedAdapter)}`
  )
}

function prefixDocMoves(
  journal: PrefixRenameJournal
): Array<{ from: string; to: string }> {
  return journal.documents
    .filter((entry) => prefixRenameBehavior(entry).usesDocCollaboration)
    .map((entry) => ({
      from: entry.from.logicalPath,
      to: entry.to.logicalPath,
    }))
}

/**
 * Keep logical companions keyed by the admitted storage profile, not by its
 * physical file-or-directory shape. Future bundle formats need not inherit
 * HTML history, share, event, or collaboration behavior.
 */
function deleteBehavior(adapter: DocumentDeleteAdapterId): ExactDeleteBehavior {
  if (adapter === DOCUMENT_DELETE_ADAPTER_IDS.legacyDoc) {
    return {
      historyKind: "docs",
      shareKind: "doc",
      reconciliationKind: "doc",
      usesDocCollaboration: true,
    }
  }
  if (adapter === DOCUMENT_DELETE_ADAPTER_IDS.legacyHtml) {
    return {
      historyKind: "widgets",
      shareKind: "html",
      reconciliationKind: "widget",
      usesDocCollaboration: false,
    }
  }
  const unsupportedAdapter: never = adapter
  throw new Error(
    `Unsupported document deletion adapter: ${String(unsupportedAdapter)}`
  )
}

function exactDeleteBehavior(journal: ExactDeleteJournal): ExactDeleteBehavior {
  const legacyKind = lifecycleFormatRegistry.get(
    journal.document.format.id
  )?.legacyVersionKind
  if (legacyKind === "docs") {
    return deleteBehavior(DOCUMENT_DELETE_ADAPTER_IDS.legacyDoc)
  }
  if (legacyKind === "widgets") {
    return deleteBehavior(DOCUMENT_DELETE_ADAPTER_IDS.legacyHtml)
  }
  const profileId = documentStorageProfiles.resolve(
    journal.document.format,
    journal.from.source
  )
  const adapter = profileId
    ? documentStorageProfiles.get(profileId).deleteAdapter
    : null
  if (!adapter)
    throw new Error("document deletion source adapter is unsupported")
  return deleteBehavior(adapter)
}

function prefixDeleteBehavior(
  entry: Pick<
    PrefixDeleteDocument,
    "deleteAdapter" | "document" | "storageProfileId"
  >
): ExactDeleteBehavior {
  const legacyKind = lifecycleFormatRegistry.get(
    entry.document.format.id
  )?.legacyVersionKind
  if (legacyKind === "docs") {
    return deleteBehavior(DOCUMENT_DELETE_ADAPTER_IDS.legacyDoc)
  }
  if (legacyKind === "widgets") {
    return deleteBehavior(DOCUMENT_DELETE_ADAPTER_IDS.legacyHtml)
  }
  return deleteBehavior(entry.deleteAdapter)
}

function fingerprintOptionalDeleteSource(
  source: ExactDeleteJournal["from"]["source"],
  path: string
): DeleteSourceFingerprint | null {
  if (source.kind === "file") {
    const fingerprint = fingerprintOptionalDeleteFile(path)
    return fingerprint ? { kind: "file", ...fingerprint } : null
  }
  const fingerprint = fingerprintOptionalBundle(path)
  return fingerprint ? { kind: "bundle", ...fingerprint } : null
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null
  try {
    fd = openSync(path, "r")
    fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const unsupported = ["EINVAL", "ENOTSUP", "ENOSYS"].includes(code ?? "")
    const unsupportedOnWindows =
      process.platform === "win32" &&
      ["EACCES", "EISDIR", "EPERM"].includes(code ?? "")
    if (!unsupported && !unsupportedOnWindows) throw error
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function fsyncRegularFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    const reachable = lstatSync(path)
    if (
      !opened.isFile() ||
      !reachable.isFile() ||
      reachable.isSymbolicLink() ||
      opened.dev !== reachable.dev ||
      opened.ino !== reachable.ino
    ) {
      throw new Error("document lifecycle output is not a stable regular file")
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function fsyncRenameParents(source: string, target: string): void {
  const sourceParent = dirname(source)
  const targetParent = dirname(target)
  // Persist the new name first. A crash between these checkpoints can then
  // leave both names for recovery, never neither name.
  fsyncDirectory(targetParent)
  if (sourceParent !== targetParent) fsyncDirectory(sourceParent)
}

function ensureDurableDirectory(path: string, trustedRoot: string): void {
  const root = resolve(trustedRoot)
  const target = resolve(path)
  requireRealDirectory(root, "Trusted directory root")
  assertSafeContainedPath(root, target)
  const segments = relative(root, target).split(sep).filter(Boolean)
  let current = root
  for (const segment of segments) {
    const next = join(current, segment)
    try {
      requireRealDirectory(next, "Document lifecycle directory")
    } catch (error) {
      if (!isMissing(error)) throw error
      mkdirSync(next, { mode: 0o700 })
      fsyncDirectory(next)
      fsyncDirectory(current)
    }
    current = next
  }
}

function durableFileTemporaryPath(path: string): string {
  return `${path}.worktable-lifecycle.tmp`
}

function writeDurableFile(
  path: string,
  bytes: Uint8Array,
  mode = 0o666,
  validateBeforePublish?: () => void,
  temporaryOverride?: string
): void {
  const parent = dirname(path)
  mkdirSync(parent, { recursive: true })
  assertSafeContainedPath(parent, path)
  const temporary = temporaryOverride ?? durableFileTemporaryPath(path)
  if (dirname(temporary) !== parent) {
    throw new Error(
      "document lifecycle temporary file must share its target directory"
    )
  }
  assertSafeContainedPath(parent, temporary)
  // This path is private to the serialized lifecycle writer. A prior process
  // may have stopped while filling it, so make the next write self-cleaning.
  rmSync(temporary, { force: true })
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0)
  const fd = openSync(temporary, flags, mode)
  try {
    writeFileSync(fd, bytes)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    validateBeforePublish?.()
    renameSync(temporary, path)
    fsyncDirectory(parent)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function removeDurably(path: string): void {
  rmSync(path, { force: true })
  fsyncDirectory(dirname(path))
}

function lifecycleWorkspaceDirectory(): string {
  return join(ensureAppDir(), "document-lifecycle", workspaceCacheKey())
}

function activeDirectory(): string {
  return join(lifecycleWorkspaceDirectory(), "active")
}

function withWorkspaceLifecycleLock<T>(
  operation: () => Promise<T>
): Promise<T> {
  return withStoreWriteLock(`${activeDirectory()}#operation`, operation)
}

function journalPath(): string {
  return join(activeDirectory(), "journal.json")
}

function artifactPath(
  role: string,
  side: ArtifactSide,
  directory = activeDirectory()
): string {
  if (!/^[a-z][a-z0-9-]*$/.test(role)) {
    throw new Error("invalid document lifecycle artifact role")
  }
  return join(directory, "artifacts", `${role}.${side}.bin`)
}

function blobRef(bytes: Buffer): BlobRef {
  return { sha256: sha256(bytes), size: bytes.byteLength }
}

function addBlob(
  blobs: Map<string, Buffer>,
  role: string,
  side: ArtifactSide,
  bytes: Buffer | null
): BlobRef | null {
  if (!bytes) return null
  if (bytes.byteLength > ARTIFACT_MAX_BYTES) {
    throw new DocumentLifecyclePreconditionError(
      `Document ${role} state is too large to move safely`
    )
  }
  blobs.set(`${role}:${side}`, bytes)
  return blobRef(bytes)
}

function addDirectHistoryManifest(
  blobs: Map<string, Buffer>,
  files: DirectHistoryFile[],
  role = "history-manifest"
): BlobRef {
  const bytes = Buffer.from(JSON.stringify(files), "utf8")
  const ref = addBlob(blobs, role, "before", bytes)
  if (!ref) throw new Error("document history manifest is empty")
  return ref
}

function createEdit(
  blobs: Map<string, Buffer>,
  role: SimpleArtifactRole,
  before: Buffer | null,
  after: Buffer | null
): ArtifactEdit | null {
  if (
    (before === null && after === null) ||
    (before !== null && after !== null && before.equals(after))
  ) {
    return null
  }
  return {
    role,
    before: addBlob(blobs, role, "before", before),
    after: addBlob(blobs, role, "after", after),
  }
}

function parseJson(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new DocumentLifecyclePreconditionError(`${label} is not valid JSON`)
  }
  if (!isObject(value)) {
    throw new DocumentLifecyclePreconditionError(
      `${label} must contain an object`
    )
  }
  return value
}

function serializeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function prepareDocMetaEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  from: string,
  to: string
): ArtifactEdit | null {
  const path = join(spaceRoot, "docs.meta.json")
  const before = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
  if (!before) return null
  const raw = parseJson(before, "docs.meta.json")
  if (raw["version"] !== 1 || !isObject(raw["docs"])) {
    throw new DocumentLifecyclePreconditionError(
      "docs.meta.json has an unsupported or corrupt shape"
    )
  }
  const docs = { ...(raw["docs"] as Record<string, unknown>) }
  if (Object.hasOwn(docs, to)) {
    throw new DocumentLifecyclePreconditionError(
      `Target document metadata already exists: ${to}`
    )
  }
  if (!Object.hasOwn(docs, from)) return null
  docs[to] = docs[from]
  delete docs[from]
  const afterRaw = { ...raw, docs }
  const after = Object.keys(docs).length === 0 ? null : serializeJson(afterRaw)
  return createEdit(blobs, "doc-meta", before, after)
}

function prepareWidgetMetaEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  from: string,
  to: string
): ArtifactEdit | null {
  const path = join(spaceRoot, "widgets.meta.json")
  const before = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
  if (!before) return null
  const raw = parseJson(before, "widgets.meta.json")
  if (raw["version"] !== 1 || !isObject(raw["widgets"])) {
    throw new DocumentLifecyclePreconditionError(
      "widgets.meta.json has an unsupported or corrupt shape"
    )
  }
  const widgets = { ...(raw["widgets"] as Record<string, unknown>) }
  if (Object.hasOwn(widgets, to)) {
    throw new DocumentLifecyclePreconditionError(
      `Target HTML document metadata already exists: ${to}`
    )
  }
  if (!Object.hasOwn(widgets, from)) return null
  widgets[to] = widgets[from]
  delete widgets[from]
  return createEdit(
    blobs,
    "widget-meta",
    before,
    serializeJson({ ...raw, widgets })
  )
}

function prepareWidgetSourceIdentity(
  blobs: Map<string, Buffer>,
  sourcePath: string,
  from: string,
  to: string,
  artifactRole = "source-identity"
): z.infer<typeof SourceIdentityEditSchema> {
  const path = join(sourcePath, "widget.yaml")
  const before = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
  if (!before) {
    throw new DocumentLifecyclePreconditionError(
      "HTML document metadata is missing"
    )
  }
  let parsed: unknown
  try {
    parsed = parseCanonicalYaml(before.toString("utf8"))
  } catch {
    throw new DocumentLifecyclePreconditionError(
      "HTML document metadata must be repaired before moving this document"
    )
  }
  const widget = WidgetFileSchema.safeParse(parsed)
  if (!widget.success || widget.data.id !== from) {
    throw new DocumentLifecyclePreconditionError(
      "HTML document metadata disagrees with its path"
    )
  }
  const after = Buffer.from(
    rewriteYamlTopLevelString(before.toString("utf8"), "id", to),
    "utf8"
  )
  return {
    relativePath: "widget.yaml",
    before: addBlob(blobs, artifactRole, "before", before)!,
    after: addBlob(blobs, artifactRole, "after", after)!,
  }
}

function prepareDocMetaDeleteEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  path: string
): ArtifactEdit | null {
  const metaPath = join(spaceRoot, "docs.meta.json")
  const before = readOptionalRegularFile(metaPath, ARTIFACT_MAX_BYTES)
  if (!before) return null
  const raw = parseJson(before, "docs.meta.json")
  if (raw["version"] !== 1 || !isObject(raw["docs"])) {
    throw new DocumentLifecyclePreconditionError(
      "docs.meta.json has an unsupported or corrupt shape"
    )
  }
  const docs = { ...(raw["docs"] as Record<string, unknown>) }
  if (!Object.hasOwn(docs, path)) return null
  delete docs[path]
  const after = serializeJson({ ...raw, docs })
  return createEdit(blobs, "doc-meta", before, after)
}

function prepareSpaceOrderEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  spaceId: string,
  from: string,
  to: string
): ArtifactEdit | null {
  const path = join(spaceRoot, "space.json")
  const before = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
  if (!before) {
    throw new DocumentLifecyclePreconditionError(`Space not found: ${spaceId}`)
  }
  const raw = parseJson(before, "space.json")
  const parsed = SpaceFileSchema.safeParse(raw)
  if (!parsed.success || parsed.data.id !== spaceId) {
    throw new DocumentLifecyclePreconditionError(
      "space.json is invalid or disagrees with its directory"
    )
  }
  const settings = isObject(raw["settings"]) ? { ...raw["settings"] } : {}
  const order = settings["docOrder"]
  if (!Array.isArray(order) || !order.some((entry) => entry === from)) {
    return null
  }
  settings["docOrder"] = order.map((entry) => (entry === from ? to : entry))
  const after = serializeJson({
    ...raw,
    settings,
    updatedAt: new Date().toISOString(),
  })
  return createEdit(blobs, "space-order", before, after)
}

function prepareSpaceOrderDeleteEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  spaceId: string,
  path: string,
  preserveOrder: boolean
): ArtifactEdit | null {
  if (preserveOrder) return null
  const filePath = join(spaceRoot, "space.json")
  const before = readOptionalRegularFile(filePath, ARTIFACT_MAX_BYTES)
  if (!before) {
    throw new DocumentLifecyclePreconditionError(`Space not found: ${spaceId}`)
  }
  const raw = parseJson(before, "space.json")
  const parsed = SpaceFileSchema.safeParse(raw)
  if (!parsed.success || parsed.data.id !== spaceId) {
    throw new DocumentLifecyclePreconditionError(
      "space.json is invalid or disagrees with its directory"
    )
  }
  const settings = isObject(raw["settings"]) ? { ...raw["settings"] } : {}
  const order = settings["docOrder"]
  if (!Array.isArray(order) || !order.some((entry) => entry === path)) {
    return null
  }
  settings["docOrder"] = order.filter((entry) => entry !== path)
  return createEdit(
    blobs,
    "space-order",
    before,
    serializeJson({
      ...raw,
      settings,
      updatedAt: new Date().toISOString(),
    })
  )
}

async function prepareInventoryEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  spaceId: string,
  documentId: DocumentId,
  identity: "durable" | "provisional",
  fromPath: string,
  path: string,
  format: DocumentFormatClaim,
  fromSource: DocumentSource,
  source: DocumentSource
): Promise<ArtifactEdit> {
  const inventoryPath = join(spaceRoot, "documents.meta.json")
  const before = readOptionalRegularFile(inventoryPath, ARTIFACT_MAX_BYTES)
  if (identity === "durable" && !before) {
    throw new DocumentLifecyclePreconditionError(
      "Durable document inventory is missing"
    )
  }
  const inventory = await readDocumentInventory(spaceId)
  if (
    inventory.exists &&
    inventory.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document inventory must be repaired before renaming documents"
    )
  }
  const current = inventory.entries.get(documentId)
  if (
    (identity === "durable" &&
      (!current ||
        current.path !== fromPath ||
        current.source.kind !== fromSource.kind ||
        current.source.relativePath !== fromSource.relativePath ||
        (current.source.kind === "bundle" &&
          fromSource.kind === "bundle" &&
          current.source.manifestPath !== fromSource.manifestPath))) ||
    (identity === "provisional" && current)
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Durable document identity changed before the rename"
    )
  }
  const afterText = await prepareDocumentInventoryMutationAt(spaceRoot, {
    upsert: [
      {
        ...(current ?? { documentId }),
        path,
        format,
        source,
      },
    ],
  })
  const edit = createEdit(
    blobs,
    "inventory",
    before,
    Buffer.from(afterText, "utf8")
  )
  if (!edit) {
    throw new DocumentLifecyclePreconditionError(
      "Durable document identity could not be moved"
    )
  }
  return edit
}

async function prepareInventoryDeleteEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  spaceId: string,
  documentId: DocumentId,
  path: string,
  source:
    | { kind: "file"; relativePath: string }
    | { kind: "bundle"; relativePath: string; manifestPath?: string }
): Promise<ArtifactEdit> {
  const inventoryPath = join(spaceRoot, "documents.meta.json")
  const before = readOptionalRegularFile(inventoryPath, ARTIFACT_MAX_BYTES)
  if (!before) {
    throw new DocumentLifecyclePreconditionError(
      "Durable document inventory is missing"
    )
  }
  const inventory = await readDocumentInventory(spaceId)
  if (
    inventory.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document inventory must be repaired before deleting documents"
    )
  }
  const current = inventory.entries.get(documentId)
  if (
    !current ||
    current.path !== path ||
    current.source.kind !== source.kind ||
    current.source.relativePath !== source.relativePath ||
    (current.source.kind === "bundle" &&
      source.kind === "bundle" &&
      current.source.manifestPath !== source.manifestPath)
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Durable document identity changed before deletion"
    )
  }
  const afterText = await prepareDocumentInventoryMutationAt(spaceRoot, {
    remove: [documentId],
  })
  const edit = createEdit(
    blobs,
    "inventory",
    before,
    Buffer.from(afterText, "utf8")
  )
  if (!edit) {
    throw new DocumentLifecyclePreconditionError(
      "Durable document identity could not be retired"
    )
  }
  return edit
}

async function prepareFormatInventoryEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  spaceId: string,
  documentId: DocumentId,
  path: string,
  format: DocumentFormatClaim,
  source: { kind: "file"; relativePath: string }
): Promise<ArtifactEdit> {
  const inventoryPath = join(spaceRoot, "documents.meta.json")
  const before = readOptionalRegularFile(inventoryPath, ARTIFACT_MAX_BYTES)
  if (!before) {
    throw new DocumentLifecyclePreconditionError(
      "Durable document inventory is missing"
    )
  }
  const inventory = await readDocumentInventory(spaceId)
  if (
    inventory.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document inventory must be repaired before changing document format"
    )
  }
  const current = inventory.entries.get(documentId)
  if (!current || current.path !== path || current.source.kind !== "file") {
    throw new DocumentLifecyclePreconditionError(
      "Durable document identity changed before the format transition"
    )
  }
  const afterText = await prepareDocumentInventoryMutationAt(spaceRoot, {
    upsert: [{ ...current, path, format, source }],
  })
  const edit = createEdit(
    blobs,
    "inventory",
    before,
    Buffer.from(afterText, "utf8")
  )
  if (!edit) {
    throw new DocumentLifecyclePreconditionError(
      "Durable document source did not change"
    )
  }
  return edit
}

function prepareFormatDocMetaEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  path: string
): ArtifactEdit {
  const metaPath = join(spaceRoot, "docs.meta.json")
  const before = readOptionalRegularFile(metaPath, ARTIFACT_MAX_BYTES)
  const raw = before
    ? parseJson(before, "docs.meta.json")
    : { version: 1, docs: {} }
  if (raw["version"] !== 1 || !isObject(raw["docs"])) {
    throw new DocumentLifecyclePreconditionError(
      "docs.meta.json has an unsupported or corrupt shape"
    )
  }
  const docs = { ...(raw["docs"] as Record<string, unknown>) }
  const prior = isObject(docs[path]) ? docs[path] : {}
  const previousEpoch =
    typeof prior["collaborationCacheEpoch"] === "string" &&
    prior["collaborationCacheEpoch"].length > 0
      ? prior["collaborationCacheEpoch"]
      : "legacy"
  const priorHistory = Array.isArray(prior["collaborationCacheEpochHistory"])
    ? prior["collaborationCacheEpochHistory"].filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0
      )
    : []
  docs[path] = {
    ...prior,
    collaborationCacheEpoch: `epoch_${randomBytes(16).toString("base64url")}`,
    collaborationCacheEpochHistory: [...priorHistory, previousEpoch].filter(
      (value, index, values) => values.indexOf(value) === index
    ),
  }
  const edit = createEdit(
    blobs,
    "doc-meta",
    before,
    serializeJson({ ...raw, version: 1, docs })
  )
  if (!edit) {
    throw new DocumentLifecyclePreconditionError(
      "Document collaboration identity could not be rotated"
    )
  }
  return edit
}

function prepareAliasesEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  from: string,
  to: string
): ArtifactEdit {
  const path = join(spaceRoot, "doc-aliases.json")
  const before = readOptionalRegularFile(path, DOC_ALIASES_MAX_BYTES)
  const result = parseDocAliasesSnapshot(before?.toString("utf8") ?? null, path)
  if (!result.aliases) {
    throw new DocumentLifecyclePreconditionError(
      result.error ?? "Document aliases are unavailable"
    )
  }
  let afterText: string
  try {
    afterText = prepareDocAliasMove(result.aliases, from, to)
  } catch (error) {
    throw new DocumentLifecyclePreconditionError(
      error instanceof Error
        ? error.message
        : "Document alias could not be reserved for this move"
    )
  }
  const after = Buffer.from(afterText, "utf8")
  const edit = createEdit(blobs, "aliases", before, after)
  if (!edit) {
    throw new DocumentLifecyclePreconditionError(
      "Document alias could not be reserved for this move"
    )
  }
  return edit
}

function prepareAliasesDeleteEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  target: string
): ArtifactEdit | null {
  const path = join(spaceRoot, "doc-aliases.json")
  const before = readOptionalRegularFile(path, DOC_ALIASES_MAX_BYTES)
  const result = parseDocAliasesSnapshot(before?.toString("utf8") ?? null, path)
  if (!result.aliases) {
    throw new DocumentLifecyclePreconditionError(
      result.error ?? "Document aliases are unavailable"
    )
  }
  let afterText: string | null
  try {
    afterText = prepareDocAliasRetirement(result.aliases, target)
  } catch (error) {
    throw new DocumentLifecyclePreconditionError(
      error instanceof Error
        ? error.message
        : "Document aliases cannot be retired safely"
    )
  }
  return afterText
    ? createEdit(blobs, "aliases", before, Buffer.from(afterText, "utf8"))
    : null
}

function prepareDocAnnotationDeleteEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  path: string
): ArtifactEdit | null {
  const annotationPath = join(
    spaceRoot,
    "annotations",
    "docs",
    `${path}.annotations.json`
  )
  const before = readOptionalRegularFile(annotationPath, ARTIFACT_MAX_BYTES)
  return before ? createEdit(blobs, "doc-annotation", before, null) : null
}

function prepareWidgetMetaDeleteEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  path: string
): ArtifactEdit | null {
  const metaPath = join(spaceRoot, "widgets.meta.json")
  const before = readOptionalRegularFile(metaPath, ARTIFACT_MAX_BYTES)
  if (!before) return null
  const raw = parseJson(before, "widgets.meta.json")
  if (raw["version"] !== 1 || !isObject(raw["widgets"])) {
    throw new DocumentLifecyclePreconditionError(
      "widgets.meta.json has an unsupported or corrupt shape"
    )
  }
  const widgets = { ...(raw["widgets"] as Record<string, unknown>) }
  if (!Object.hasOwn(widgets, path)) return null
  delete widgets[path]
  return createEdit(
    blobs,
    "widget-meta",
    before,
    serializeJson({ ...raw, widgets })
  )
}

function prepareWidgetAnnotationDeleteEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  path: string
): ArtifactEdit | null {
  const annotationPath = join(
    spaceRoot,
    "annotations",
    "widgets",
    `${path}.annotations.json`
  )
  const before = readOptionalRegularFile(annotationPath, ARTIFACT_MAX_BYTES)
  return before ? createEdit(blobs, "widget-annotation", before, null) : null
}

function prepareAnnotationEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  spaceId: string,
  from: string,
  to: string,
  identity: "durable" | "provisional",
  role = "annotation",
  occupiedTargetsAllowed?: ReadonlySet<string>,
  annotationKind: "doc" | "widget" = "doc"
): z.infer<typeof AnnotationEditSchema> | null {
  const oldPath = join(
    spaceRoot,
    "annotations",
    annotationKind === "doc" ? "docs" : "widgets",
    `${from}.annotations.json`
  )
  const newPath = join(
    spaceRoot,
    "annotations",
    annotationKind === "doc" ? "docs" : "widgets",
    `${to}.annotations.json`
  )
  const before = readOptionalRegularFile(oldPath, ARTIFACT_MAX_BYTES)
  const target = readOptionalRegularFile(newPath, ARTIFACT_MAX_BYTES)
  if (target && !occupiedTargetsAllowed?.has(to)) {
    throw new DocumentLifecyclePreconditionError(
      `Target annotation state already exists: ${to}`
    )
  }
  if (!before) return null
  const raw = parseJson(before, "document annotations")
  const parsed = AnnotationFileSchema.safeParse(raw)
  if (!parsed.success || parsed.data.spaceId !== spaceId) {
    if (identity === "provisional") {
      throw new Error(`Invalid annotation file: ${oldPath}`)
    }
    throw new DocumentLifecyclePreconditionError(
      "Document annotation state must be repaired before moving this document"
    )
  }
  const updatedAt = new Date().toISOString()
  const annotations = Array.isArray(raw["annotations"])
    ? raw["annotations"].map((value) => {
        if (!isObject(value) || !isObject(value["target"])) return value
        const targetValue = value["target"]
        const targetField = annotationKind === "doc" ? "docPath" : "widgetId"
        if (typeof targetValue[targetField] !== "string") return value
        return {
          ...value,
          target: { ...targetValue, [targetField]: to },
          updatedAt,
        }
      })
    : []
  const revisionBase = {
    type: "worktable.annotations",
    version: 1,
    spaceId,
    updatedAt,
    annotations,
  }
  const after = serializeJson({
    ...raw,
    ...revisionBase,
    revision: createHash("sha256")
      .update(JSON.stringify(revisionBase))
      .digest("hex"),
  })
  return {
    before: addBlob(blobs, role, "before", before)!,
    after: addBlob(blobs, role, "after", after)!,
  }
}

interface PrefixMovePreparation {
  id: DocumentId
  identity: "durable" | "provisional"
  format: DocumentFormatClaim
  storageProfileId: DocumentStorageProfileId
  from: string
  to: string
  fromSource: DocumentSource
  toSource: DocumentSource
}

function prepareDocMetaBatchEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  moves: readonly PrefixMovePreparation[]
): ArtifactEdit | null {
  const path = join(spaceRoot, "docs.meta.json")
  const before = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
  if (!before) return null
  const raw = parseJson(before, "docs.meta.json")
  if (raw["version"] !== 1 || !isObject(raw["docs"])) {
    throw new DocumentLifecyclePreconditionError(
      "docs.meta.json has an unsupported or corrupt shape"
    )
  }
  const docs = { ...(raw["docs"] as Record<string, unknown>) }
  const sources = new Set(moves.map((move) => move.from))
  for (const { to } of moves) {
    if (Object.hasOwn(docs, to) && !sources.has(to)) {
      throw new DocumentLifecyclePreconditionError(
        `Target document metadata already exists: ${to}`
      )
    }
  }
  const moved = moves.flatMap(({ from, to }) =>
    Object.hasOwn(docs, from) ? [{ to, value: docs[from] }] : []
  )
  for (const { from } of moves) delete docs[from]
  for (const { to, value } of moved) docs[to] = value
  const after =
    Object.keys(docs).length === 0 ? null : serializeJson({ ...raw, docs })
  return createEdit(blobs, "doc-meta", before, after)
}

function prepareWidgetMetaBatchEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  moves: readonly PrefixMovePreparation[]
): ArtifactEdit | null {
  const path = join(spaceRoot, "widgets.meta.json")
  const before = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
  if (!before) return null
  const raw = parseJson(before, "widgets.meta.json")
  if (raw["version"] !== 1 || !isObject(raw["widgets"])) {
    throw new DocumentLifecyclePreconditionError(
      "widgets.meta.json has an unsupported or corrupt shape"
    )
  }
  const widgets = { ...(raw["widgets"] as Record<string, unknown>) }
  const sources = new Set(moves.map((move) => move.from))
  for (const { to } of moves) {
    if (Object.hasOwn(widgets, to) && !sources.has(to)) {
      throw new DocumentLifecyclePreconditionError(
        `Target HTML document metadata already exists: ${to}`
      )
    }
  }
  const moved = moves.flatMap(({ from, to }) =>
    Object.hasOwn(widgets, from) ? [{ to, value: widgets[from] }] : []
  )
  for (const { from } of moves) delete widgets[from]
  for (const { to, value } of moved) widgets[to] = value
  return createEdit(
    blobs,
    "widget-meta",
    before,
    serializeJson({ ...raw, widgets })
  )
}

function prepareSpaceOrderBatchEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  spaceId: string,
  fromPrefix: string,
  toPrefix: string,
  moves: readonly PrefixMovePreparation[]
): ArtifactEdit | null {
  const path = join(spaceRoot, "space.json")
  const before = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
  if (!before) {
    throw new DocumentLifecyclePreconditionError(`Space not found: ${spaceId}`)
  }
  const raw = parseJson(before, "space.json")
  const parsed = SpaceFileSchema.safeParse(raw)
  if (!parsed.success || parsed.data.id !== spaceId) {
    throw new DocumentLifecyclePreconditionError(
      "space.json is invalid or disagrees with its directory"
    )
  }
  const settings = isObject(raw["settings"]) ? { ...raw["settings"] } : {}
  const order = settings["docOrder"]
  if (!Array.isArray(order)) return null
  const targets = new Map(
    moves.flatMap(({ from, to }) => {
      const key = analyzeDocumentPath(from).comparisonKey
      return key ? [[key, to] as const] : []
    })
  )
  const moveOrderEntry = (entry: unknown): unknown => {
    if (typeof entry !== "string") return entry
    const key = analyzeDocumentPath(entry).comparisonKey
    if (!key) return entry
    const exact = targets.get(key)
    if (exact) return exact
    return remapDocumentPathPrefix(entry, fromPrefix, toPrefix) ?? entry
  }
  const movedOrder = order.map(moveOrderEntry)
  if (movedOrder.every((entry, index) => entry === order[index])) return null
  settings["docOrder"] = movedOrder
  return createEdit(
    blobs,
    "space-order",
    before,
    serializeJson({ ...raw, settings, updatedAt: new Date().toISOString() })
  )
}

async function prepareInventoryBatchEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  spaceId: string,
  moves: readonly PrefixMovePreparation[]
): Promise<ArtifactEdit> {
  const path = join(spaceRoot, "documents.meta.json")
  const before = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
  const inventory = await readDocumentInventory(spaceId)
  if (
    inventory.exists &&
    inventory.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document inventory must be repaired before renaming folders"
    )
  }
  if (moves.some((move) => move.identity === "durable") && !before) {
    throw new DocumentLifecyclePreconditionError(
      "Durable document inventory is missing"
    )
  }
  for (const move of moves) {
    const current = inventory.entries.get(move.id)
    if (
      (move.identity === "durable" &&
        (!current ||
          current.path !== move.from ||
          !sameDocumentSource(current.source, move.fromSource))) ||
      (move.identity === "provisional" && current)
    ) {
      throw new DocumentLifecyclePreconditionError(
        "Durable document identity changed before the folder rename"
      )
    }
  }
  const afterText = await prepareDocumentInventoryMutationAt(spaceRoot, {
    upsert: moves.map((move) => {
      const current = inventory.entries.get(move.id)
      return {
        ...(current ?? { documentId: move.id }),
        path: move.to,
        format: move.format,
        source: move.toSource,
      }
    }),
  })
  const edit = createEdit(
    blobs,
    "inventory",
    before,
    Buffer.from(afterText, "utf8")
  )
  if (!edit) {
    throw new DocumentLifecyclePreconditionError(
      "Durable document identities could not be moved"
    )
  }
  return edit
}

function preparePrefixAliasesEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  fromPrefix: string,
  toPrefix: string,
  moves: readonly PrefixMovePreparation[]
): ArtifactEdit {
  const path = join(spaceRoot, "doc-aliases.json")
  const before = readOptionalRegularFile(path, DOC_ALIASES_MAX_BYTES)
  const result = parseDocAliasesSnapshot(before?.toString("utf8") ?? null, path)
  if (!result.aliases) {
    throw new DocumentLifecyclePreconditionError(
      result.error ?? "Document aliases are unavailable"
    )
  }
  const fromKey = analyzeDocumentPath(fromPrefix).comparisonKey
  const toKey = analyzeDocumentPath(toPrefix).comparisonKey
  if (!fromKey || !toKey) {
    throw new DocumentLifecyclePreconditionError(
      "Document folder alias paths are invalid"
    )
  }
  const overlapsSource = documentPathKeyIsAtOrBelow(fromKey, toKey)
  const entries = overlapsSource
    ? moves.map(({ from, to }) => ({ from, to, kind: "exact" as const }))
    : [{ from: fromPrefix, to: toPrefix, kind: "prefix" as const }]
  let after: Buffer
  try {
    after = Buffer.from(prepareDocAliasBatch(result.aliases, entries), "utf8")
  } catch (error) {
    throw new DocumentLifecyclePreconditionError(
      error instanceof Error
        ? error.message
        : "Document aliases cannot reserve this folder move"
    )
  }
  const edit = createEdit(blobs, "aliases", before, after)
  if (!edit) {
    throw new DocumentLifecyclePreconditionError(
      "Document aliases could not reserve this folder move"
    )
  }
  return edit
}

interface PrefixDeletePreparation {
  id: DocumentId
  identity: "durable"
  format: DocumentFormatClaim
  storageProfileId: DocumentStorageProfileId
  deleteAdapter: DocumentDeleteAdapterId
  path: string
  source: DocumentSource
}

function prepareDocMetaBatchDeleteEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  deletions: readonly PrefixDeletePreparation[]
): ArtifactEdit | null {
  const path = join(spaceRoot, "docs.meta.json")
  const before = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
  if (!before) return null
  const raw = parseJson(before, "docs.meta.json")
  if (raw["version"] !== 1 || !isObject(raw["docs"])) {
    throw new DocumentLifecyclePreconditionError(
      "docs.meta.json has an unsupported or corrupt shape"
    )
  }
  const docs = { ...(raw["docs"] as Record<string, unknown>) }
  for (const deletion of deletions) delete docs[deletion.path]
  const after =
    Object.keys(docs).length === 0 ? null : serializeJson({ ...raw, docs })
  return createEdit(blobs, "doc-meta", before, after)
}

function prepareWidgetMetaBatchDeleteEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  deletions: readonly PrefixDeletePreparation[]
): ArtifactEdit | null {
  const path = join(spaceRoot, "widgets.meta.json")
  const before = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
  if (!before) return null
  const raw = parseJson(before, "widgets.meta.json")
  if (raw["version"] !== 1 || !isObject(raw["widgets"])) {
    throw new DocumentLifecyclePreconditionError(
      "widgets.meta.json has an unsupported or corrupt shape"
    )
  }
  const widgets = { ...(raw["widgets"] as Record<string, unknown>) }
  for (const deletion of deletions) delete widgets[deletion.path]
  return createEdit(
    blobs,
    "widget-meta",
    before,
    serializeJson({ ...raw, widgets })
  )
}

function prepareSpaceOrderBatchDeleteEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  spaceId: string,
  prefix: string
): ArtifactEdit | null {
  const path = join(spaceRoot, "space.json")
  const before = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
  if (!before) {
    throw new DocumentLifecyclePreconditionError(`Space not found: ${spaceId}`)
  }
  const raw = parseJson(before, "space.json")
  const parsed = SpaceFileSchema.safeParse(raw)
  if (!parsed.success || parsed.data.id !== spaceId) {
    throw new DocumentLifecyclePreconditionError(
      "space.json is invalid or disagrees with its directory"
    )
  }
  const prefixKey = analyzeDocumentPath(prefix).comparisonKey
  if (!prefixKey) {
    throw new DocumentLifecyclePreconditionError(
      "Document folder path is not canonical"
    )
  }
  const settings = isObject(raw["settings"]) ? { ...raw["settings"] } : {}
  const order = settings["docOrder"]
  if (!Array.isArray(order)) return null
  const afterOrder = order.filter((entry) => {
    const key =
      typeof entry === "string"
        ? analyzeDocumentPath(entry).comparisonKey
        : null
    return !key || !documentPathKeyIsAtOrBelow(key, prefixKey)
  })
  if (afterOrder.length === order.length) return null
  settings["docOrder"] = afterOrder
  return createEdit(
    blobs,
    "space-order",
    before,
    serializeJson({ ...raw, settings, updatedAt: new Date().toISOString() })
  )
}

async function prepareInventoryBatchDeleteEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  spaceId: string,
  deletions: readonly PrefixDeletePreparation[]
): Promise<ArtifactEdit | null> {
  const path = join(spaceRoot, "documents.meta.json")
  const before = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
  if (!before) {
    throw new DocumentLifecyclePreconditionError(
      "Durable document inventory is missing"
    )
  }
  const inventory = await readDocumentInventory(spaceId)
  if (
    inventory.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document inventory must be repaired before deleting folders"
    )
  }
  for (const deletion of deletions) {
    const current = inventory.entries.get(deletion.id)
    if (
      !current ||
      current.path !== deletion.path ||
      !sameDocumentSource(current.source, deletion.source)
    ) {
      throw new DocumentLifecyclePreconditionError(
        "Durable document identity changed before the folder deletion"
      )
    }
  }
  const afterText = await prepareDocumentInventoryMutationAt(spaceRoot, {
    remove: deletions.map((deletion) => deletion.id),
  })
  const edit = createEdit(
    blobs,
    "inventory",
    before,
    Buffer.from(afterText, "utf8")
  )
  if (!edit) {
    throw new DocumentLifecyclePreconditionError(
      "Durable document identities could not be retired"
    )
  }
  return edit
}

function preparePrefixDeleteAliasesEdit(
  blobs: Map<string, Buffer>,
  spaceRoot: string,
  prefix: string
): ArtifactEdit | null {
  const path = join(spaceRoot, "doc-aliases.json")
  const before = readOptionalRegularFile(path, DOC_ALIASES_MAX_BYTES)
  const result = parseDocAliasesSnapshot(before?.toString("utf8") ?? null, path)
  if (!result.aliases) {
    throw new DocumentLifecyclePreconditionError(
      result.error ?? "Document aliases are unavailable"
    )
  }
  let afterText: string | null
  try {
    afterText = prepareDocAliasPrefixRetirement(result.aliases, prefix)
  } catch (error) {
    throw new DocumentLifecyclePreconditionError(
      error instanceof Error
        ? error.message
        : "Document folder aliases cannot be retired safely"
    )
  }
  return afterText
    ? createEdit(blobs, "aliases", before, Buffer.from(afterText, "utf8"))
    : null
}

function workspaceBinding(): {
  canonicalRoot: string
  manifestId: string
} {
  const root = resolve(getWorkspaceRoot())
  requireRealDirectory(root, "Workspace root")
  const canonicalRoot = realpathSync(root)
  const manifestBytes = readOptionalRegularFile(
    getWorkspaceManifestPath(),
    ARTIFACT_MAX_BYTES
  )
  if (!manifestBytes) throw new Error("workspace manifest is missing")
  let manifest: unknown
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"))
  } catch {
    throw new Error("workspace manifest is invalid")
  }
  if (!isWorkspaceManifest(manifest)) {
    throw new Error("workspace manifest is invalid")
  }
  return { canonicalRoot, manifestId: manifest.id }
}

function sameDocumentSource(
  left: DocumentSource,
  right: DocumentSource
): boolean {
  return (
    left.kind === right.kind &&
    left.relativePath === right.relativePath &&
    (left.kind !== "bundle" ||
      right.kind !== "bundle" ||
      left.manifestPath === right.manifestPath)
  )
}

function validateHtmlAncestorTarget(
  sourcePath: string,
  targetPath: string
): void {
  let child = sourcePath
  for (let parent = dirname(sourcePath); ; parent = dirname(parent)) {
    const entries = readdirSync(parent, { withFileTypes: true })
    if (
      entries.length !== 1 ||
      join(parent, entries[0]!.name) !== child ||
      !entries[0]!.isDirectory() ||
      entries[0]!.isSymbolicLink()
    ) {
      throw new DocumentLifecyclePreconditionError(
        "Target HTML document path is an occupied folder"
      )
    }
    if (parent === targetPath) return
    child = parent
  }
}

function rejectHtmlTargetInsideBundle(
  spaceRoot: string,
  targetPath: string,
  allowedAncestor?: string
): void {
  const widgetsRoot = resolve(spaceRoot, "widgets")
  assertSafeContainedPath(spaceRoot, widgetsRoot)
  assertSafeContainedPath(widgetsRoot, targetPath)
  for (
    let ancestor = dirname(targetPath);
    ancestor !== widgetsRoot;
    ancestor = dirname(ancestor)
  ) {
    assertSafeContainedPath(widgetsRoot, ancestor)
    if (ancestor === allowedAncestor) continue
    if (hasFilesystemEntry(join(ancestor, "widget.yaml"))) {
      throw new DocumentLifecyclePreconditionError(
        "Target HTML document path is inside an existing HTML document"
      )
    }
  }
}

async function prepareExactRename(
  spaceId: string,
  from: string,
  to: string,
  expectedStorageProfileId: DocumentStorageProfileId = DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile
): Promise<PreparedJournal | null> {
  const inventory = await readDocumentInventory(spaceId)
  const registry = createBuiltinDocumentFormatRegistry()
  const durableClaim = [...inventory.entries.values()].find(
    (entry) => entry.path === from
  )
  let requestedSource: string | null = null
  const filesystemSourceKey = (path: string) =>
    process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path
  if (!durableClaim) {
    const sourceKey = analyzeDocumentPath(
      posix.normalize(from.replaceAll("\\", "/"))
    ).comparisonKey
    const lexicalEquivalent = sourceKey
      ? [...inventory.entries.values()].find(
          (entry) => analyzeDocumentPath(entry.path).comparisonKey === sourceKey
        )
      : undefined
    const spaceRoot = resolve(getSpacesBaseDir(), spaceId)
    const requestedProfile = documentStorageProfiles.get(
      expectedStorageProfileId
    )
    const requestedFormats: DocumentFormatClaim[] =
      expectedStorageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
        ? [{ id: BUILTIN_DOCUMENT_FORMATS.html, sourceVersion: 1 }]
        : registry.fileSourceFormats()
    const requestedRealPath = requestedFormats.flatMap((format) => {
      try {
        const source = requestedProfile.sourceForLogicalPath?.(format, from)
        if (!source) return []
        const candidate = resolve(spaceRoot, source.relativePath)
        return existsSync(candidate) ? [realpathSync(candidate)] : []
      } catch {
        return []
      }
    })[0]
    requestedSource = requestedRealPath
      ? relative(spaceRoot, requestedRealPath).split(sep).join("/")
      : null
    const physicalEquivalent =
      requestedSource &&
      requestedSource !== ".." &&
      !requestedSource.startsWith("../")
        ? [...inventory.entries.values()].find(
            (entry) =>
              documentStorageProfiles.resolve(entry.format, entry.source) ===
                expectedStorageProfileId &&
              filesystemSourceKey(entry.source.relativePath) ===
                filesystemSourceKey(requestedSource!)
          )
        : undefined
    const equivalentClaim = lexicalEquivalent ?? physicalEquivalent
    if (equivalentClaim) {
      throw new DocumentLifecyclePreconditionError(
        `Use the document’s exact current path before moving it: ${equivalentClaim.path}`
      )
    }
  }
  const aliasState = await readDocAliases(spaceId)
  if (!aliasState.aliases) {
    throw new DocumentLifecyclePreconditionError(
      aliasState.error ?? "Document aliases are unavailable"
    )
  }
  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
    registry,
  })
  const source = catalog.entries.find(
    (entry) => entry.kind === "document" && entry.descriptor.path === from
  )
  if (!source && !durableClaim) {
    const sourceKey = analyzeDocumentPath(from).comparisonKey
    const lexicalSource = catalog.entries.find((entry) =>
      entry.kind === "conflict"
        ? entry.pathKey === sourceKey
        : analyzeDocumentPath(entry.descriptor.path).comparisonKey === sourceKey
    )
    const physicalSource =
      requestedSource &&
      requestedSource !== ".." &&
      !requestedSource.startsWith("../")
        ? catalog.entries.find((entry) =>
            entry.kind === "document"
              ? entry.handle.storageProfile === expectedStorageProfileId &&
                filesystemSourceKey(entry.handle.source.relativePath) ===
                  filesystemSourceKey(requestedSource!)
              : entry.claims.some(
                  (claim) =>
                    claim.kind === "document" &&
                    claim.storageProfile === expectedStorageProfileId &&
                    filesystemSourceKey(claim.source.relativePath) ===
                      filesystemSourceKey(requestedSource!)
                )
          )
        : undefined
    const occupiedSource = lexicalSource ?? physicalSource
    if (occupiedSource?.kind === "conflict") {
      throw new DocumentLifecyclePreconditionError(
        `Document sources are ambiguous at their source path: ${from}`
      )
    }
    if (occupiedSource?.kind === "document") {
      throw new DocumentLifecyclePreconditionError(
        `Use the document’s exact current path before moving it: ${occupiedSource.descriptor.path}`
      )
    }
    return null
  }
  if (
    !source ||
    source.kind !== "document" ||
    (durableClaim
      ? source.handle.identity !== "durable" ||
        source.descriptor.documentId !== durableClaim.documentId
      : source.handle.identity !== "provisional")
  ) {
    throw new DocumentLifecyclePreconditionError(
      `Stable document identity cannot be resolved safely at its source path: ${from}`
    )
  }
  let documentId = durableClaim?.documentId
  if (!documentId) {
    do documentId = mintDocumentId()
    while (inventory.entries.has(documentId))
  }
  if (
    source.handle.storageProfile !== expectedStorageProfileId ||
    source.handle.diagnostics.some(
      (diagnostic) => diagnostic.severity === "error"
    )
  ) {
    throw new DocumentLifecyclePreconditionError(
      "This document type can't be moved yet"
    )
  }
  const storageProfile = documentStorageProfiles.get(
    source.handle.storageProfile
  )
  const expectedSource = storageProfile.sourceForLogicalPath?.(
    source.descriptor.format,
    from
  )
  if (
    !storageProfile.managedExactRename ||
    !expectedSource ||
    !sameDocumentSource(source.handle.source, expectedSource)
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Durable document source does not match its logical path"
    )
  }
  const targetAnalysis = analyzeDocumentPath(to, {
    enforceNewPathGrammar: true,
  })
  if (
    !targetAnalysis.safe ||
    !targetAnalysis.portable ||
    targetAnalysis.canonicalPath !== to ||
    !targetAnalysis.comparisonKey
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Target document path is not portable"
    )
  }
  if (
    expectedStorageProfileId ===
      DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle &&
    !WidgetIdSchema.safeParse(to).success
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Target HTML document path is not portable"
    )
  }
  const destinationClaim = catalog.entries.find((entry) => {
    const candidate =
      entry.kind === "conflict"
        ? entry.pathKey
        : analyzeDocumentPath(entry.descriptor.path).comparisonKey
    return candidate === targetAnalysis.comparisonKey
  })
  if (destinationClaim) {
    throw new DocumentLifecyclePreconditionError(
      `Target path already exists: ${to}`
    )
  }
  const binding = workspaceBinding()
  const spaceRoot = resolve(getSpacesBaseDir(), spaceId)
  requireRealDirectory(spaceRoot, `Space ${spaceId}`)
  assertSafeContainedPath(resolve(getWorkspaceRoot()), spaceRoot)
  const sourcePath = resolve(spaceRoot, source.handle.source.relativePath)
  const targetSource = storageProfile.sourceForLogicalPath?.(
    source.descriptor.format,
    to
  )
  if (!targetSource || targetSource.kind !== source.handle.source.kind) {
    throw new DocumentLifecyclePreconditionError(
      "This document type can't be moved yet"
    )
  }
  const targetRelativePath = targetSource.relativePath
  const targetPath = resolve(spaceRoot, targetRelativePath)
  assertSafeContainedPath(spaceRoot, sourcePath)
  assertSafeContainedPath(spaceRoot, targetPath)
  const sourceContainsTarget = targetPath.startsWith(`${sourcePath}${sep}`)
  const targetContainsSource = sourcePath.startsWith(`${targetPath}${sep}`)
  if (
    expectedStorageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
  ) {
    rejectHtmlTargetInsideBundle(
      spaceRoot,
      targetPath,
      sourceContainsTarget ? sourcePath : undefined
    )
  }
  const sourceFingerprint = fingerprintOptionalDeleteSource(
    source.handle.source,
    sourcePath
  )
  if (!sourceFingerprint) {
    throw new DocumentLifecyclePreconditionError(`Doc not found: ${from}`)
  }
  if (
    expectedStorageProfileId ===
      DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle &&
    targetContainsSource
  ) {
    validateHtmlAncestorTarget(sourcePath, targetPath)
  } else if (!sourceContainsTarget && hasFilesystemEntry(targetPath)) {
    throw new DocumentLifecyclePreconditionError(
      `Target path already exists: ${to}`
    )
  }

  const historyKind = legacyVersionKindFor(
    source.descriptor.format,
    expectedStorageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
      ? "widgets"
      : "docs"
  )
  const oldHistory = versionKeyDir(spaceId, historyKind, from)
  const newHistory = versionKeyDir(spaceId, historyKind, to)
  assertSafeWorkspacePath(resolve(getVersionsDir()))
  assertSafeWorkspacePath(oldHistory)
  assertSafeWorkspacePath(newHistory)
  const historyFiles = captureDirectHistoryFiles(oldHistory)
  if (
    captureDirectHistoryFiles(newHistory).length > 0 ||
    historyFiles.some((file) => hasFilesystemEntry(join(newHistory, file.name)))
  ) {
    throw new DocumentLifecyclePreconditionError(
      `Target version history already exists: ${to}`
    )
  }

  const blobs = new Map<string, Buffer>()
  const historyManifest = addDirectHistoryManifest(blobs, historyFiles)
  const sourceIdentity =
    expectedStorageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
      ? prepareWidgetSourceIdentity(blobs, sourcePath, from, to)
      : undefined
  const edits = [
    expectedStorageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
      ? prepareWidgetMetaEdit(blobs, spaceRoot, from, to)
      : prepareDocMetaEdit(blobs, spaceRoot, from, to),
    prepareSpaceOrderEdit(blobs, spaceRoot, spaceId, from, to),
    await prepareInventoryEdit(
      blobs,
      spaceRoot,
      spaceId,
      documentId,
      source.handle.identity,
      from,
      to,
      source.descriptor.format,
      source.handle.source,
      targetSource
    ),
    prepareAliasesEdit(blobs, spaceRoot, from, to),
  ].filter((edit): edit is ArtifactEdit => Boolean(edit))
  const annotation = prepareAnnotationEdit(
    blobs,
    spaceRoot,
    spaceId,
    from,
    to,
    source.handle.identity,
    "annotation",
    undefined,
    expectedStorageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
      ? "widget"
      : "doc"
  )
  const totalBytes = [...blobs.values()].reduce(
    (total, bytes) => total + bytes.byteLength,
    0
  )
  if (totalBytes > ARTIFACT_TOTAL_MAX_BYTES) {
    throw new DocumentLifecyclePreconditionError(
      "Document metadata is too large to move safely"
    )
  }
  const journal: DocumentLifecycleJournal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    planVersion: JOURNAL_PLAN_VERSION,
    operationType: "exact-rename",
    operationId: `dlc_${randomBytes(16).toString("base64url")}`,
    createdAt: new Date().toISOString(),
    phase: "applying",
    workspace: binding,
    document: {
      id: documentId,
      format: source.descriptor.format,
      sourceSha256: sourceFingerprint.sha256,
      sourceSize: sourceFingerprint.size,
      ...(sourceFingerprint.kind === "bundle"
        ? { sourceEntries: sourceFingerprint.entries }
        : {}),
      ...(sourceIdentity ? { sourceIdentity } : {}),
      history: historyFiles.length > 0 ? "present" : "absent",
      historyManifest,
    },
    from: {
      spaceId,
      logicalPath: from,
      source: source.handle.source,
    },
    to: {
      spaceId,
      logicalPath: to,
      source: targetSource,
    },
    edits,
    annotation,
    completed: [],
  }
  JournalSchema.parse(journal)
  assertPreparedJournalFits(journal)
  return { journal, blobs, directHistoryFiles: historyFiles }
}

async function preparePrefixRename(
  spaceId: string,
  fromPrefix: string,
  toPrefix: string,
  expectedMoves: readonly DurablePrefixRenameMove[]
): Promise<PreparedJournal | null> {
  const fromAnalysis = analyzeDocumentPath(fromPrefix)
  const toAnalysis = analyzeDocumentPath(toPrefix, {
    enforceNewPathGrammar: true,
  })
  if (
    !fromAnalysis.safe ||
    fromAnalysis.canonicalPath !== fromPrefix ||
    !fromAnalysis.comparisonKey
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document folder path is not canonical"
    )
  }
  if (
    !toAnalysis.safe ||
    !toAnalysis.portable ||
    toAnalysis.canonicalPath !== toPrefix ||
    !toAnalysis.comparisonKey
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Target document folder path is not portable"
    )
  }
  const sourcePrefixKey = fromAnalysis.comparisonKey
  if (documentPathKeyIsBelow(toAnalysis.comparisonKey, sourcePrefixKey)) {
    throw new DocumentLifecyclePreconditionError(
      "Cannot move a document folder into itself"
    )
  }

  const inventory = await readDocumentInventory(spaceId)
  if (
    inventory.exists &&
    inventory.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document inventory must be repaired before renaming folders"
    )
  }
  const aliasState = await readDocAliases(spaceId)
  if (!aliasState.aliases) {
    throw new DocumentLifecyclePreconditionError(
      aliasState.error ?? "Document aliases are unavailable"
    )
  }
  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
    registry: createBuiltinDocumentFormatRegistry(),
  })
  const isWithinSource = (path: string): boolean => {
    const key = analyzeDocumentPath(path).comparisonKey
    return Boolean(key && documentPathKeyIsAtOrBelow(key, sourcePrefixKey))
  }
  const relevant = catalog.entries.filter((entry) =>
    entry.kind === "conflict"
      ? entry.claims.some((claim) => isWithinSource(claim.path))
      : isWithinSource(entry.descriptor.path)
  )
  if (relevant.length === 0) return null
  if (relevant.some((entry) => entry.kind !== "document")) {
    throw new DocumentLifecyclePreconditionError(
      "Document sources are ambiguous inside this folder"
    )
  }
  const sources = relevant
    .filter((entry) => entry.kind === "document")
    .sort((a, b) => {
      const depth =
        a.descriptor.path.split("/").length -
        b.descriptor.path.split("/").length
      return depth || a.descriptor.path.localeCompare(b.descriptor.path)
    })
  if (sources.length > PREFIX_RENAME_MAX_DOCUMENTS) {
    throw new DocumentLifecyclePreconditionError(
      `Move a folder with ${PREFIX_RENAME_MAX_DOCUMENTS} or fewer documents`
    )
  }
  if (
    sources.some((entry) =>
      entry.handle.diagnostics.some(
        (diagnostic) => diagnostic.severity === "error"
      )
    )
  ) {
    throw new DocumentLifecyclePreconditionError(
      "This folder contains a document type that can't be moved yet"
    )
  }

  const spaceRoot = resolve(getSpacesBaseDir(), spaceId)
  requireRealDirectory(spaceRoot, `Space ${spaceId}`)
  assertSafeContainedPath(resolve(getWorkspaceRoot()), spaceRoot)
  const sourceLogicalPaths = new Set(
    sources.map((entry) => entry.descriptor.path)
  )
  const sourceComparisonKeys = new Set(
    sources.flatMap((entry) => {
      const key = analyzeDocumentPath(entry.descriptor.path).comparisonKey
      return key ? [key] : []
    })
  )
  const filesystemSourceKey = (path: string): string =>
    process.platform === "win32" ? path.toLocaleLowerCase("en-US") : path
  const sourceRelativePaths = new Set(
    sources.map((entry) =>
      filesystemSourceKey(entry.handle.source.relativePath)
    )
  )
  const claimedIds = new Set(inventory.entries.keys())
  const moves: PrefixMovePreparation[] = []
  for (const source of sources) {
    const from = source.descriptor.path
    const to = remapDocumentPathPrefix(from, fromPrefix, toPrefix)
    if (!to) {
      throw new DocumentLifecyclePreconditionError(
        "Document folder contents changed before the move"
      )
    }
    const target = analyzeDocumentPath(to, { enforceNewPathGrammar: true })
    if (
      !target.safe ||
      !target.portable ||
      target.canonicalPath !== to ||
      !target.comparisonKey
    ) {
      throw new DocumentLifecyclePreconditionError(
        `Target document path is not portable: ${to}`
      )
    }
    const storageProfileId = source.handle.storageProfile
    if (!storageProfileId) {
      throw new DocumentLifecyclePreconditionError(
        "This folder contains a document type that can't be moved yet"
      )
    }
    const storageProfile = documentStorageProfiles.get(storageProfileId)
    if (!storageProfile.managedPrefixRename) {
      throw new DocumentLifecyclePreconditionError(
        "This folder contains a document type that can't be moved yet"
      )
    }
    if (
      storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle &&
      !WidgetIdSchema.safeParse(to).success
    ) {
      throw new DocumentLifecyclePreconditionError(
        `Target HTML document path is not portable: ${to}`
      )
    }
    const targetSource = storageProfile.sourceForLogicalPath?.(
      source.descriptor.format,
      to
    )
    if (!targetSource || targetSource.kind !== source.handle.source.kind) {
      throw new DocumentLifecyclePreconditionError(
        "This folder contains a document type that can't be moved yet"
      )
    }
    const sourcePath = resolve(spaceRoot, source.handle.source.relativePath)
    const targetPath = resolve(spaceRoot, targetSource.relativePath)
    assertSafeContainedPath(spaceRoot, sourcePath)
    assertSafeContainedPath(spaceRoot, targetPath)
    if (storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle) {
      rejectHtmlTargetInsideBundle(spaceRoot, targetPath)
    }
    const expectedSource = storageProfile.sourceForLogicalPath?.(
      source.descriptor.format,
      from
    )
    if (
      !expectedSource ||
      !sameDocumentSource(expectedSource, source.handle.source)
    ) {
      throw new DocumentLifecyclePreconditionError(
        `Durable document source does not match its logical path: ${from}`
      )
    }
    const targetRelativeKey = filesystemSourceKey(targetSource.relativePath)
    const targetContainsSource = sourcePath.startsWith(`${targetPath}${sep}`)
    if (
      storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle &&
      targetContainsSource
    ) {
      validateHtmlAncestorTarget(sourcePath, targetPath)
    } else if (
      !sourceRelativePaths.has(targetRelativeKey) &&
      hasFilesystemEntry(targetPath)
    ) {
      throw new DocumentLifecyclePreconditionError(
        `Target path already exists: ${to}`
      )
    }
    const sourceFingerprint = fingerprintOptionalDeleteSource(
      source.handle.source,
      sourcePath
    )
    if (!sourceFingerprint) {
      throw new DocumentLifecyclePreconditionError(`Doc not found: ${from}`)
    }
    let id =
      source.handle.identity === "durable"
        ? source.descriptor.documentId
        : mintDocumentId()
    while (source.handle.identity === "provisional" && claimedIds.has(id)) {
      id = mintDocumentId()
    }
    claimedIds.add(id)
    moves.push({
      id,
      identity: source.handle.identity,
      format: source.descriptor.format,
      storageProfileId,
      from,
      to,
      fromSource: source.handle.source,
      toSource: targetSource,
    })
  }
  const targetKeys = moves.map((move) => {
    const key = analyzeDocumentPath(move.to).comparisonKey
    if (!key) {
      throw new DocumentLifecyclePreconditionError(
        `Target document path is not portable: ${move.to}`
      )
    }
    return key
  })
  if (
    new Set(targetKeys).size !== targetKeys.length ||
    new Set(moves.map((move) => move.id)).size !== moves.length
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document folder targets are ambiguous"
    )
  }
  if (targetKeys.some((targetKey) => sourceComparisonKeys.has(targetKey))) {
    throw new DocumentLifecyclePreconditionError(
      "This folder can't be moved to that location because its document paths would overlap"
    )
  }
  if (
    expectedMoves.length !== moves.length ||
    expectedMoves.some(
      (expected, index) =>
        expected.from !== moves[index]?.from ||
        expected.to !== moves[index]?.to ||
        expected.storageProfileId !== moves[index]?.storageProfileId
    )
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document folder contents changed before the move"
    )
  }
  for (const move of moves) {
    const targetKey = analyzeDocumentPath(move.to).comparisonKey
    if (!targetKey) {
      throw new DocumentLifecyclePreconditionError(
        `Target document path is not portable: ${move.to}`
      )
    }
    const occupied = catalog.entries.find((entry) => {
      const candidate =
        entry.kind === "conflict"
          ? entry.pathKey
          : analyzeDocumentPath(entry.descriptor.path).comparisonKey
      return candidate === targetKey
    })
    if (occupied && !sourceComparisonKeys.has(targetKey)) {
      throw new DocumentLifecyclePreconditionError(
        `Target path already exists: ${move.to}`
      )
    }
    if (
      reservedByAliasIn(catalog.aliases, move.to) &&
      !sourceComparisonKeys.has(targetKey)
    ) {
      throw new DocumentLifecyclePreconditionError(
        `Target path is reserved by a document alias: ${move.to}`
      )
    }
  }

  const blobs = new Map<string, Buffer>()
  const historyFiles: DirectHistoryFile[][] = []
  const documents: PrefixRenameDocument[] = []
  for (const [index, move] of moves.entries()) {
    const sourcePath = resolve(spaceRoot, move.fromSource.relativePath)
    const sourceFingerprint = fingerprintOptionalDeleteSource(
      move.fromSource,
      sourcePath
    )
    if (!sourceFingerprint) {
      throw new DocumentLifecyclePreconditionError(
        `Doc not found: ${move.from}`
      )
    }
    const historyKind = legacyVersionKindFor(
      move.format,
      move.storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
        ? "widgets"
        : "docs"
    )
    const oldHistory = versionKeyDir(spaceId, historyKind, move.from)
    const newHistory = versionKeyDir(spaceId, historyKind, move.to)
    assertSafeWorkspacePath(oldHistory)
    assertSafeWorkspacePath(newHistory)
    const files = captureDirectHistoryFiles(oldHistory)
    const targetKey = analyzeDocumentPath(move.to).comparisonKey
    if (!targetKey) {
      throw new DocumentLifecyclePreconditionError(
        `Target document path is not portable: ${move.to}`
      )
    }
    if (
      !sourceComparisonKeys.has(targetKey) &&
      (captureDirectHistoryFiles(newHistory).length > 0 ||
        files.some((file) => hasFilesystemEntry(join(newHistory, file.name))))
    ) {
      throw new DocumentLifecyclePreconditionError(
        `Target version history already exists: ${move.to}`
      )
    }
    const manifestRole = `history-manifest-${index}`
    const annotationRole = `annotation-${index}`
    const sourceIdentity =
      move.storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
        ? prepareWidgetSourceIdentity(
            blobs,
            sourcePath,
            move.from,
            move.to,
            `source-identity-${index}`
          )
        : undefined
    historyFiles.push(files)
    documents.push({
      document: {
        id: move.id,
        format: move.format,
        sourceSha256: sourceFingerprint.sha256,
        sourceSize: sourceFingerprint.size,
        ...(sourceFingerprint.kind === "bundle"
          ? { sourceEntries: sourceFingerprint.entries }
          : {}),
        ...(sourceIdentity ? { sourceIdentity } : {}),
        history: files.length > 0 ? "present" : "absent",
        historyManifest: addDirectHistoryManifest(blobs, files, manifestRole),
      },
      from: {
        spaceId,
        logicalPath: move.from,
        source: move.fromSource,
      },
      to: {
        spaceId,
        logicalPath: move.to,
        source: move.toSource,
      },
      annotation: prepareAnnotationEdit(
        blobs,
        spaceRoot,
        spaceId,
        move.from,
        move.to,
        move.identity,
        annotationRole,
        sourceLogicalPaths,
        move.storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
          ? "widget"
          : "doc"
      ),
    })
  }
  const docMoves = moves.filter(
    (move) =>
      move.storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile
  )
  const htmlMoves = moves.filter(
    (move) =>
      move.storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
  )
  const edits = [
    docMoves.length > 0
      ? prepareDocMetaBatchEdit(blobs, spaceRoot, docMoves)
      : null,
    htmlMoves.length > 0
      ? prepareWidgetMetaBatchEdit(blobs, spaceRoot, htmlMoves)
      : null,
    prepareSpaceOrderBatchEdit(
      blobs,
      spaceRoot,
      spaceId,
      fromPrefix,
      toPrefix,
      moves
    ),
    await prepareInventoryBatchEdit(blobs, spaceRoot, spaceId, moves),
    preparePrefixAliasesEdit(blobs, spaceRoot, fromPrefix, toPrefix, moves),
  ].filter((edit): edit is ArtifactEdit => Boolean(edit))
  const totalBytes = [...blobs.values()].reduce(
    (total, bytes) => total + bytes.byteLength,
    0
  )
  if (totalBytes > ARTIFACT_TOTAL_MAX_BYTES) {
    throw new DocumentLifecyclePreconditionError(
      "Document folder metadata is too large to move safely"
    )
  }
  const journal: PrefixRenameJournal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    planVersion: JOURNAL_PLAN_VERSION,
    operationType: "prefix-rename",
    operationId: `dlc_${randomBytes(16).toString("base64url")}`,
    createdAt: new Date().toISOString(),
    phase: "applying",
    workspace: workspaceBinding(),
    from: { spaceId, logicalPath: fromPrefix },
    to: { spaceId, logicalPath: toPrefix },
    documents,
    completedDocuments: 0,
    edits,
    completed: [],
  }
  JournalSchema.parse(journal)
  assertPreparedJournalFits(journal)
  return { journal, blobs, prefixHistoryFiles: historyFiles }
}

function archiveStateArtifact(
  blobs: Map<string, Buffer>,
  index: number,
  side: ArtifactSide,
  state: ArchiveFieldState
): BlobRef {
  const ref = addBlob(
    blobs,
    `archive-field-${index}`,
    side,
    serializeArchiveFieldState(state)
  )
  if (!ref) throw new Error("document archive field recovery state is empty")
  return ref
}

function prefixArchiveMutationGroups(
  documents: readonly PrefixArchiveDocument[],
  changedIndexes: ReadonlySet<number>
): PrefixArchiveMutation[] {
  const groups = new Map<
    string,
    PrefixArchiveMutation & { relativePath: string }
  >()
  for (const index of [...changedIndexes].sort((a, b) => a - b)) {
    const entry = documents[index]
    if (!entry) throw new Error("document archive mutation index is invalid")
    const relativePath = archiveMetadataRelativePath(entry.archiveAdapter, [
      entry.at.logicalPath,
    ])
    const key = `${entry.storageProfileId}\0${entry.archiveAdapter}\0${relativePath}`
    const group = groups.get(key) ?? {
      storageProfileId: entry.storageProfileId,
      archiveAdapter: entry.archiveAdapter,
      documentIndexes: [],
      relativePath,
    }
    group.documentIndexes.push(index)
    groups.set(key, group)
  }
  return [...groups.values()]
    .sort(
      (left, right) =>
        left.relativePath.localeCompare(right.relativePath) ||
        left.storageProfileId.localeCompare(right.storageProfileId) ||
        left.archiveAdapter.localeCompare(right.archiveAdapter)
    )
    .map((group) => ({
      storageProfileId: group.storageProfileId,
      archiveAdapter: group.archiveAdapter,
      documentIndexes: group.documentIndexes,
    }))
}

async function preparePrefixArchive(
  spaceId: string,
  prefix: string,
  archived: boolean,
  expectedDocuments: readonly DurablePrefixArchiveDocument[],
  context?: DurablePrefixArchiveContext,
  allowExact = false
): Promise<PreparedJournal | null> {
  const prefixAnalysis = analyzeDocumentPath(prefix)
  if (
    !prefixAnalysis.safe ||
    prefixAnalysis.canonicalPath !== prefix ||
    !prefixAnalysis.comparisonKey
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document folder path is not canonical"
    )
  }
  if (archived && (!context?.archivedBy || context.archivedBy.length > 512)) {
    throw new DocumentLifecyclePreconditionError(
      "Document archive actor is invalid"
    )
  }
  if (
    context?.reason &&
    context.reason.length > DOCUMENT_ARCHIVE_REASON_MAX_LENGTH
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document archive reason is too long"
    )
  }

  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
    registry: createBuiltinDocumentFormatRegistry(),
  })
  if (
    catalog.inventoryDiagnostics.some(
      (diagnostic) => diagnostic.severity === "error"
    )
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document inventory must be repaired before archiving folders"
    )
  }
  const withinPrefix = (path: string): boolean => {
    const key = analyzeDocumentPath(path).comparisonKey
    return Boolean(
      key && documentPathKeyIsAtOrBelow(key, prefixAnalysis.comparisonKey!)
    )
  }
  const belowPrefix = (path: string): boolean => {
    const key = analyzeDocumentPath(path).comparisonKey
    return Boolean(
      key && documentPathKeyIsBelow(key, prefixAnalysis.comparisonKey!)
    )
  }
  const relevantPath = allowExact
    ? (path: string): boolean =>
        analyzeDocumentPath(path).comparisonKey === prefixAnalysis.comparisonKey
    : withinPrefix
  const relevant = catalog.entries.filter((entry) =>
    entry.kind === "conflict"
      ? entry.claims.some((claim) => relevantPath(claim.path))
      : relevantPath(entry.descriptor.path)
  )
  if (relevant.length === 0) return null
  if (relevant.some((entry) => entry.kind !== "document")) {
    throw new DocumentLifecyclePreconditionError(
      "Document sources are ambiguous inside this folder"
    )
  }
  const sources = relevant
    .filter((entry) => entry.kind === "document")
    .sort((left, right) => {
      const depth =
        left.descriptor.path.split("/").length -
        right.descriptor.path.split("/").length
      return depth || left.descriptor.path.localeCompare(right.descriptor.path)
    })
  if (
    !allowExact &&
    !sources.some((entry) => belowPrefix(entry.descriptor.path))
  ) {
    return null
  }
  if (sources.length > PREFIX_RENAME_MAX_DOCUMENTS) {
    throw new DocumentLifecyclePreconditionError(
      `Archive a folder with ${PREFIX_RENAME_MAX_DOCUMENTS} or fewer documents`
    )
  }
  if (
    sources.some((entry) =>
      entry.handle.diagnostics.some(
        (diagnostic) => diagnostic.severity === "error"
      )
    )
  ) {
    throw new DocumentLifecyclePreconditionError(
      "This folder contains a document type that can't be archived yet"
    )
  }
  if (
    expectedDocuments.length !== sources.length ||
    expectedDocuments.some(
      (expected, index) =>
        expected.path !== sources[index]?.descriptor.path ||
        expected.storageProfileId !== sources[index]?.handle.storageProfile
    )
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document folder contents changed before the archive operation"
    )
  }

  const spaceRoot = resolve(getSpacesBaseDir(), spaceId)
  requireRealDirectory(spaceRoot, `Space ${spaceId}`)
  assertSafeContainedPath(resolve(getWorkspaceRoot()), spaceRoot)
  const blobs = new Map<string, Buffer>()
  const metadata = new Map<string, Buffer | null>()
  const documents: PrefixArchiveDocument[] = []
  const changedIndexes = new Set<number>()
  const archivedAt = new Date().toISOString()

  for (const [index, source] of sources.entries()) {
    const storageProfileId = source.handle.storageProfile
    if (!storageProfileId) {
      throw new DocumentLifecyclePreconditionError(
        "This folder contains a document type that can't be archived yet"
      )
    }
    const profile = documentStorageProfiles.get(storageProfileId)
    const archiveAdapter = profile.archiveAdapter
    const expectedSource = profile.sourceForLogicalPath?.(
      source.descriptor.format,
      source.descriptor.path
    )
    if (
      !archiveAdapter ||
      !expectedSource ||
      !sameDocumentSource(expectedSource, source.handle.source)
    ) {
      throw new DocumentLifecyclePreconditionError(
        "This folder contains a document type that can't be archived yet"
      )
    }
    if (
      archiveAdapter === DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyWidgetManifest &&
      !WidgetIdSchema.safeParse(source.descriptor.path).success
    ) {
      throw new DocumentLifecyclePreconditionError(
        `HTML document path is not portable: ${source.descriptor.path}`
      )
    }
    const relativePath = archiveMetadataRelativePath(archiveAdapter, [
      source.descriptor.path,
    ])
    const metadataPath = resolve(spaceRoot, relativePath)
    assertSafeContainedPath(spaceRoot, metadataPath)
    let raw = metadata.get(relativePath)
    if (raw === undefined && !metadata.has(relativePath)) {
      raw = readOptionalRegularFile(metadataPath, ARTIFACT_MAX_BYTES)
      metadata.set(relativePath, raw)
    }
    let before: ArchiveFieldState
    try {
      before = readArchiveFieldStates(archiveAdapter, raw ?? null, [
        source.descriptor.path,
      ])[0]!
    } catch (error) {
      throw new DocumentLifecyclePreconditionError(
        error instanceof Error
          ? error.message
          : "Document archive metadata is invalid"
      )
    }
    const after: ArchiveFieldState = archived
      ? isArchivedFieldState(before)
        ? before
        : {
            kind: "archive",
            value: {
              archivedAt,
              archivedBy: context!.archivedBy,
              ...(context?.reason ? { reason: context.reason } : {}),
            },
          }
      : isArchivedFieldState(before)
        ? activeArchiveFieldState(archiveAdapter)
        : before
    if (!archiveFieldStatesEqual(before, after)) changedIndexes.add(index)
    documents.push({
      document: {
        id: source.descriptor.documentId,
        format: source.descriptor.format,
      },
      at: {
        spaceId,
        logicalPath: source.descriptor.path,
        source: source.handle.source,
      },
      storageProfileId,
      archiveAdapter,
      archive: {
        before: archiveStateArtifact(blobs, index, "before", before),
        after: archiveStateArtifact(blobs, index, "after", after),
      },
    })
  }
  const mutations = prefixArchiveMutationGroups(documents, changedIndexes)
  const totalBytes = [...blobs.values()].reduce(
    (total, bytes) => total + bytes.byteLength,
    0
  )
  if (totalBytes > ARTIFACT_TOTAL_MAX_BYTES) {
    throw new DocumentLifecyclePreconditionError(
      "Document folder archive metadata is too large"
    )
  }
  const journal: PrefixArchiveJournal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    planVersion: JOURNAL_PLAN_VERSION,
    operationType: "prefix-archive",
    ...(allowExact ? { scope: "exact" as const } : {}),
    operationId: `dlc_${randomBytes(16).toString("base64url")}`,
    createdAt: new Date().toISOString(),
    phase: "applying",
    workspace: workspaceBinding(),
    from: { spaceId, logicalPath: prefix },
    to: { spaceId, logicalPath: prefix },
    archived,
    documents,
    mutations,
    completedMutations: 0,
    edits: [],
    annotation: null,
    completed: [],
  }
  JournalSchema.parse(journal)
  assertPreparedJournalFits(journal)
  return { journal, blobs }
}

async function preparePrefixDelete(
  spaceId: string,
  prefix: string,
  expectedDocuments: readonly DurablePrefixDeleteDocument[]
): Promise<PreparedJournal | null> {
  const prefixAnalysis = analyzeDocumentPath(prefix)
  if (
    !prefixAnalysis.safe ||
    prefixAnalysis.canonicalPath !== prefix ||
    !prefixAnalysis.comparisonKey
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document folder path is not canonical"
    )
  }

  const inventory = await readDocumentInventory(spaceId)
  if (
    inventory.exists &&
    inventory.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document inventory must be repaired before deleting folders"
    )
  }
  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
    registry: createBuiltinDocumentFormatRegistry(),
  })
  const withinPrefix = (path: string): boolean => {
    const key = analyzeDocumentPath(path).comparisonKey
    return Boolean(
      key && documentPathKeyIsAtOrBelow(key, prefixAnalysis.comparisonKey!)
    )
  }
  const belowPrefix = (path: string): boolean => {
    const key = analyzeDocumentPath(path).comparisonKey
    return Boolean(
      key && documentPathKeyIsBelow(key, prefixAnalysis.comparisonKey!)
    )
  }
  const relevant = catalog.entries.filter((entry) =>
    entry.kind === "conflict"
      ? entry.claims.some((claim) => withinPrefix(claim.path))
      : withinPrefix(entry.descriptor.path)
  )
  if (relevant.length === 0) return null
  if (relevant.some((entry) => entry.kind !== "document")) {
    throw new DocumentLifecyclePreconditionError(
      "Document sources are ambiguous inside this folder"
    )
  }
  const sources = relevant
    .filter((entry) => entry.kind === "document")
    .sort((left, right) => {
      const depth =
        left.descriptor.path.split("/").length -
        right.descriptor.path.split("/").length
      return depth || left.descriptor.path.localeCompare(right.descriptor.path)
    })
  if (!sources.some((entry) => belowPrefix(entry.descriptor.path))) return null
  if (sources.length > PREFIX_RENAME_MAX_DOCUMENTS) {
    throw new DocumentLifecyclePreconditionError(
      `Delete a folder with ${PREFIX_RENAME_MAX_DOCUMENTS} or fewer documents`
    )
  }
  if (
    sources.some((entry) =>
      entry.handle.diagnostics.some(
        (diagnostic) => diagnostic.severity === "error"
      )
    )
  ) {
    throw new DocumentLifecyclePreconditionError(
      "This folder contains a document type that can't be deleted yet"
    )
  }

  const deletions: PrefixDeletePreparation[] = []
  for (const source of sources) {
    if (source.handle.identity !== "durable") {
      throw new DocumentLifecyclePreconditionError(
        "Document identities changed before folder deletion"
      )
    }
    const storageProfileId = source.handle.storageProfile
    const profile = storageProfileId
      ? documentStorageProfiles.get(storageProfileId)
      : null
    const deleteAdapter = profile?.deleteAdapter ?? null
    const expectedSource = profile?.sourceForLogicalPath?.(
      source.descriptor.format,
      source.descriptor.path
    )
    if (
      !storageProfileId ||
      !deleteAdapter ||
      !expectedSource ||
      !sameDocumentSource(expectedSource, source.handle.source)
    ) {
      throw new DocumentLifecyclePreconditionError(
        "This folder contains a document type that can't be deleted yet"
      )
    }
    if (
      deleteAdapter === DOCUMENT_DELETE_ADAPTER_IDS.legacyHtml &&
      !WidgetIdSchema.safeParse(source.descriptor.path).success
    ) {
      throw new DocumentLifecyclePreconditionError(
        `HTML document path is not portable: ${source.descriptor.path}`
      )
    }
    deletions.push({
      id: source.descriptor.documentId,
      identity: "durable",
      format: source.descriptor.format,
      storageProfileId,
      deleteAdapter,
      path: source.descriptor.path,
      source: source.handle.source,
    })
  }
  if (
    expectedDocuments.length !== deletions.length ||
    expectedDocuments.some(
      (expected, index) =>
        expected.path !== deletions[index]?.path ||
        expected.storageProfileId !== deletions[index]?.storageProfileId ||
        expected.deleteAdapter !== deletions[index]?.deleteAdapter
    )
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document folder contents changed before deletion"
    )
  }

  const spaceRoot = resolve(getSpacesBaseDir(), spaceId)
  requireRealDirectory(spaceRoot, `Space ${spaceId}`)
  assertSafeContainedPath(resolve(getWorkspaceRoot()), spaceRoot)
  const blobs = new Map<string, Buffer>()
  const historyFiles: Array<DirectHistoryFile[] | undefined> = []
  const documents: PrefixDeleteDocument[] = []
  for (const [index, deletion] of deletions.entries()) {
    const sourcePath = resolve(spaceRoot, deletion.source.relativePath)
    assertSafeContainedPath(spaceRoot, sourcePath)
    const sourceFingerprint = fingerprintOptionalDeleteSource(
      deletion.source,
      sourcePath
    )
    if (!sourceFingerprint) {
      throw new DocumentLifecyclePreconditionError(
        `Document not found: ${deletion.path}`
      )
    }
    const behavior = deleteBehavior(
      legacyVersionKindFor(
        deletion.format,
        deletion.deleteAdapter === DOCUMENT_DELETE_ADAPTER_IDS.legacyHtml
          ? "widgets"
          : "docs"
      ) === "widgets"
        ? DOCUMENT_DELETE_ADAPTER_IDS.legacyHtml
        : DOCUMENT_DELETE_ADAPTER_IDS.legacyDoc
    )
    if (
      deletion.storageProfileId ===
        DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile &&
      behavior.historyKind === "widgets"
    ) {
      behavior.reconciliationKind = "doc"
    }
    const historyPath = versionKeyDir(
      spaceId,
      behavior.historyKind,
      deletion.path
    )
    assertSafeWorkspacePath(historyPath)
    const files = behavior.usesDocCollaboration
      ? captureDirectHistoryFiles(historyPath)
      : undefined
    const historyExists = files ? files.length > 0 : existsSync(historyPath)
    if (files === undefined && historyExists) {
      requireRealDirectory(historyPath, "Document history")
    }
    historyFiles.push(files)
    const annotationPath = resolve(
      spaceRoot,
      "annotations",
      behavior.reconciliationKind === "widget" ? "widgets" : "docs",
      `${deletion.path}.annotations.json`
    )
    assertSafeContainedPath(spaceRoot, annotationPath)
    const annotation = readOptionalRegularFile(
      annotationPath,
      ARTIFACT_MAX_BYTES
    )
    documents.push({
      document: {
        id: deletion.id,
        identity: deletion.identity,
        format: deletion.format,
        sourceSha256: sourceFingerprint.sha256,
        sourceSize: sourceFingerprint.size,
        ...(sourceFingerprint.kind === "bundle"
          ? { sourceEntries: sourceFingerprint.entries }
          : {}),
        history: historyExists ? "present" : "absent",
        ...(files
          ? {
              historyManifest: addDirectHistoryManifest(
                blobs,
                files,
                `history-manifest-${index}`
              ),
            }
          : {}),
      },
      at: {
        spaceId,
        logicalPath: deletion.path,
        source: deletion.source,
      },
      storageProfileId: deletion.storageProfileId,
      deleteAdapter: deletion.deleteAdapter,
      annotation: annotation
        ? addBlob(blobs, `delete-annotation-${index}`, "before", annotation)
        : null,
    })
  }

  const docs = deletions.filter(
    (deletion) =>
      deletion.deleteAdapter === DOCUMENT_DELETE_ADAPTER_IDS.legacyDoc
  )
  const html = deletions.filter(
    (deletion) =>
      deletion.deleteAdapter === DOCUMENT_DELETE_ADAPTER_IDS.legacyHtml
  )
  const edits = [
    docs.length > 0
      ? prepareDocMetaBatchDeleteEdit(blobs, spaceRoot, docs)
      : null,
    html.length > 0
      ? prepareWidgetMetaBatchDeleteEdit(blobs, spaceRoot, html)
      : null,
    prepareSpaceOrderBatchDeleteEdit(blobs, spaceRoot, spaceId, prefix),
    await prepareInventoryBatchDeleteEdit(blobs, spaceRoot, spaceId, deletions),
    preparePrefixDeleteAliasesEdit(blobs, spaceRoot, prefix),
  ].filter((edit): edit is ArtifactEdit => Boolean(edit))
  const totalBytes = [...blobs.values()].reduce(
    (total, bytes) => total + bytes.byteLength,
    0
  )
  if (totalBytes > ARTIFACT_TOTAL_MAX_BYTES) {
    throw new DocumentLifecyclePreconditionError(
      "Document folder metadata is too large to delete safely"
    )
  }

  const journal: PrefixDeleteJournal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    planVersion: JOURNAL_PLAN_VERSION,
    operationType: "prefix-delete",
    operationId: `dlc_${randomBytes(16).toString("base64url")}`,
    createdAt: new Date().toISOString(),
    phase: "applying",
    workspace: workspaceBinding(),
    from: { spaceId, logicalPath: prefix },
    to: { spaceId, logicalPath: prefix },
    documents,
    completedDocuments: 0,
    edits,
    completed: [],
  }
  JournalSchema.parse(journal)
  assertPreparedJournalFits(journal)
  return { journal, blobs, prefixDeleteHistoryFiles: historyFiles }
}

async function prepareExactDelete(
  spaceId: string,
  logicalPath: string,
  expectedStorageProfileId:
    | typeof DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile
    | typeof DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
): Promise<PreparedJournal | null> {
  const pathAnalysis = analyzeDocumentPath(logicalPath)
  if (
    !pathAnalysis.safe ||
    pathAnalysis.canonicalPath !== logicalPath ||
    !pathAnalysis.comparisonKey
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document path is not canonical"
    )
  }

  const inventory = await readDocumentInventory(spaceId)
  if (
    inventory.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document inventory must be repaired before deleting documents"
    )
  }
  const durableClaims = [...inventory.entries.values()].filter(
    (entry) =>
      entry.path === logicalPath &&
      documentStorageProfiles.resolve(entry.format, entry.source) ===
        expectedStorageProfileId
  )
  if (durableClaims.length === 0) {
    const equivalent = [...inventory.entries.values()].find(
      (entry) =>
        documentStorageProfiles.resolve(entry.format, entry.source) ===
          expectedStorageProfileId &&
        analyzeDocumentPath(entry.path).comparisonKey ===
          pathAnalysis.comparisonKey
    )
    if (equivalent) {
      throw new DocumentLifecyclePreconditionError(
        `Use the document's exact current path before deleting it: ${equivalent.path}`
      )
    }
    return null
  }
  if (durableClaims.length !== 1) {
    throw new DocumentLifecyclePreconditionError(
      `Stable document identity is ambiguous at its source path: ${logicalPath}`
    )
  }
  const durableClaim = durableClaims[0]!
  const storageProfile = documentStorageProfiles.get(expectedStorageProfileId)
  const expectedSource = storageProfile.sourceForLogicalPath?.(
    durableClaim.format,
    logicalPath
  )
  if (
    !storageProfile.deleteAdapter ||
    !expectedSource ||
    durableClaim.source.kind !== expectedSource.kind ||
    durableClaim.source.relativePath !== expectedSource.relativePath
  ) {
    throw new DocumentLifecyclePreconditionError(
      "This document storage layout does not support managed deletion"
    )
  }
  const binding = workspaceBinding()
  const spaceRoot = resolve(getSpacesBaseDir(), spaceId)
  requireRealDirectory(spaceRoot, `Space ${spaceId}`)
  assertSafeContainedPath(resolve(getWorkspaceRoot()), spaceRoot)
  const claimedSourcePath = resolve(spaceRoot, durableClaim.source.relativePath)
  assertSafeContainedPath(spaceRoot, claimedSourcePath)
  // A genuinely missing source is the one malformed durable state deletion
  // may clean. ENOTDIR and non-regular nodes remain conflicts rather than
  // being collapsed into absence.
  const sourceFingerprint = fingerprintOptionalDeleteSource(
    durableClaim.source,
    claimedSourcePath
  )

  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
  })
  const aliasedShadow = catalog.entries.some(
    (entry) =>
      entry.kind === "conflict" &&
      entry.claims.some(
        (claim) => claim.kind === "alias" && claim.targetPath === logicalPath
      ) &&
      entry.claims.some((claim) => claim.kind === "document")
  )
  if (aliasedShadow) {
    throw new DocumentLifecyclePreconditionError(
      "Document cannot be deleted while an aliased path contains another document"
    )
  }
  const matchingClaims: Array<{
    documentId: DocumentId
    identity: "durable" | "provisional"
    path: string
    format: DocumentFormatClaim
    source:
      | { kind: "file"; relativePath: string }
      | { kind: "bundle"; relativePath: string; manifestPath?: string }
    storageProfile:
      | (typeof DOCUMENT_STORAGE_PROFILE_IDS)[keyof typeof DOCUMENT_STORAGE_PROFILE_IDS]
      | null
    diagnostics: Array<{
      severity: "error" | "warning"
      code: string
      message: string
    }>
  }> = []
  for (const entry of catalog.entries) {
    if (entry.kind === "document") {
      if (entry.descriptor.documentId === durableClaim.documentId) {
        matchingClaims.push({
          documentId: entry.descriptor.documentId,
          identity: entry.handle.identity,
          path: entry.descriptor.path,
          format: entry.descriptor.format,
          source: entry.handle.source,
          storageProfile: entry.handle.storageProfile,
          diagnostics: entry.handle.diagnostics,
        })
      }
      continue
    }
    for (const claim of entry.claims) {
      if (
        claim.kind === "document" &&
        claim.documentId === durableClaim.documentId
      ) {
        matchingClaims.push(claim)
      }
    }
  }
  if (matchingClaims.length !== 1) {
    throw new DocumentLifecyclePreconditionError(
      `Stable document identity cannot be resolved safely at its source path: ${logicalPath}`
    )
  }
  const source = matchingClaims[0]!
  const errorDiagnostics = source.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error"
  )
  const sourceDiagnosticsMatch = sourceFingerprint
    ? errorDiagnostics.length === 0 ||
      (expectedStorageProfileId ===
        DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle &&
        errorDiagnostics.length === 1 &&
        errorDiagnostics[0]?.code === "widget-content-missing")
    : errorDiagnostics.length === 1 &&
      errorDiagnostics[0]?.code === "inventory-source-missing"
  if (
    source.identity !== "durable" ||
    source.documentId !== durableClaim.documentId ||
    source.path !== logicalPath ||
    source.format.id !== durableClaim.format.id ||
    source.format.sourceVersion !== durableClaim.format.sourceVersion ||
    source.storageProfile !== expectedStorageProfileId ||
    source.source.kind !== durableClaim.source.kind ||
    source.source.relativePath !== durableClaim.source.relativePath ||
    !sourceDiagnosticsMatch
  ) {
    throw new DocumentLifecyclePreconditionError(
      `Stable document identity cannot be resolved safely at its source path: ${logicalPath}`
    )
  }
  if (expectedStorageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile) {
    const aliasReservation = reservedByAliasIn(catalog.aliases, logicalPath)
    if (aliasReservation) {
      throw new DocumentLifecyclePreconditionError(
        `Path is reserved by a document ${aliasReservation.kind} alias: ${aliasReservation.path}`
      )
    }
  }

  const sourcePath = resolve(spaceRoot, source.source.relativePath)
  assertSafeContainedPath(spaceRoot, sourcePath)
  if (sourcePath !== claimedSourcePath) {
    throw new DocumentLifecyclePreconditionError(
      "Durable document source does not match its inventory claim"
    )
  }

  const historyKind = legacyVersionKindFor(
    source.format,
    expectedStorageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
      ? "widgets"
      : "docs"
  )
  const historyPath = versionKeyDir(spaceId, historyKind, logicalPath)
  assertSafeWorkspacePath(resolve(getVersionsDir()))
  assertSafeWorkspacePath(historyPath)
  const historyFiles =
    expectedStorageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile
      ? captureDirectHistoryFiles(historyPath)
      : undefined
  const historyExists = historyFiles
    ? historyFiles.length > 0
    : existsSync(historyPath)
  if (historyFiles === undefined && historyExists) {
    requireRealDirectory(historyPath, "Document history")
  }

  const preserveOrder = catalog.entries.some((entry) =>
    entry.kind === "document"
      ? entry.descriptor.path === logicalPath &&
        entry.descriptor.documentId !== source.documentId
      : entry.claims.some(
          (claim) =>
            claim.kind === "document" &&
            claim.path === logicalPath &&
            claim.documentId !== source.documentId
        )
  )
  const blobs = new Map<string, Buffer>()
  const historyManifest = historyFiles
    ? addDirectHistoryManifest(blobs, historyFiles)
    : undefined
  const commonEdits = [
    prepareSpaceOrderDeleteEdit(
      blobs,
      spaceRoot,
      spaceId,
      logicalPath,
      preserveOrder
    ),
    await prepareInventoryDeleteEdit(
      blobs,
      spaceRoot,
      spaceId,
      source.documentId,
      logicalPath,
      source.source
    ),
  ]
  const profileEdits =
    expectedStorageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
      ? [
          prepareWidgetMetaDeleteEdit(blobs, spaceRoot, logicalPath),
          prepareAliasesDeleteEdit(blobs, spaceRoot, logicalPath),
          prepareWidgetAnnotationDeleteEdit(blobs, spaceRoot, logicalPath),
        ]
      : [
          prepareDocMetaDeleteEdit(blobs, spaceRoot, logicalPath),
          prepareAliasesDeleteEdit(blobs, spaceRoot, logicalPath),
          prepareDocAnnotationDeleteEdit(blobs, spaceRoot, logicalPath),
        ]
  const edits = [...commonEdits, ...profileEdits].filter(
    (edit): edit is ArtifactEdit => Boolean(edit)
  )
  const totalBytes = [...blobs.values()].reduce(
    (total, bytes) => total + bytes.byteLength,
    0
  )
  if (totalBytes > ARTIFACT_TOTAL_MAX_BYTES) {
    throw new DocumentLifecyclePreconditionError(
      "Document metadata is too large to delete safely"
    )
  }

  const operationId = `dlc_${randomBytes(16).toString("base64url")}`
  const journal: ExactDeleteJournal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    planVersion: JOURNAL_PLAN_VERSION,
    operationType: "exact-delete",
    operationId,
    createdAt: new Date().toISOString(),
    phase: "applying",
    workspace: binding,
    document: sourceFingerprint
      ? {
          id: source.documentId,
          format: source.format,
          sourceSha256: sourceFingerprint.sha256,
          sourceSize: sourceFingerprint.size,
          ...(sourceFingerprint.kind === "bundle"
            ? { sourceEntries: sourceFingerprint.entries }
            : {}),
          history: historyExists ? "present" : "absent",
          ...(historyManifest ? { historyManifest } : {}),
        }
      : {
          id: source.documentId,
          format: source.format,
          sourceState: "absent",
          history: historyExists ? "present" : "absent",
          ...(historyManifest ? { historyManifest } : {}),
        },
    from: {
      spaceId,
      logicalPath,
      source: source.source,
    },
    to: {
      spaceId,
      logicalPath,
      source: source.source,
    },
    edits,
    annotation: null,
    completed: [],
  }
  JournalSchema.parse(journal)
  assertPreparedJournalFits(journal)
  return { journal, blobs, directHistoryFiles: historyFiles }
}

async function prepareFormatTransition(
  options: DurableFormatTransitionOptions
): Promise<PreparedJournal | null> {
  const pathAnalysis = analyzeDocumentPath(options.docPath)
  if (!pathAnalysis.safe || pathAnalysis.canonicalPath !== options.docPath) {
    throw new DocumentLifecyclePreconditionError(
      "Document path is not canonical"
    )
  }
  if (options.bytes.byteLength > SOURCE_MAX_BYTES) {
    throw new DocumentLifecyclePreconditionError(
      "Converted document exceeds its supported size limit"
    )
  }
  if (options.validateBeforeCommit && !(await options.validateBeforeCommit())) {
    throw new DocumentLifecyclePreconditionError(
      "Doc metadata cannot be preserved in the requested format"
    )
  }

  const inventory = await readDocumentInventory(options.spaceId)
  const durableClaim = [...inventory.entries.values()].find(
    (entry) => entry.path === options.docPath
  )
  if (!durableClaim) return null

  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId: options.spaceId,
  })
  const source = catalog.entries.find(
    (entry) =>
      entry.kind === "document" &&
      entry.descriptor.path === options.docPath &&
      entry.descriptor.documentId === durableClaim.documentId
  )
  if (
    !source ||
    source.kind !== "document" ||
    source.handle.identity !== "durable" ||
    source.handle.storageProfile !==
      DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile ||
    source.handle.source.kind !== "file" ||
    source.handle.diagnostics.some(
      (diagnostic) => diagnostic.severity === "error"
    )
  ) {
    throw new DocumentLifecyclePreconditionError(
      `Stable document identity cannot be resolved safely at its source path: ${options.docPath}`
    )
  }
  if (source.descriptor.format.id === options.format.id) {
    throw new DocumentLifecyclePreconditionError(
      "Document is already stored in the requested format"
    )
  }

  const storageProfile = documentStorageProfiles.get(
    DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile
  )
  const expectedFrom = storageProfile.sourceForLogicalPath?.(
    source.descriptor.format,
    options.docPath
  )
  const expectedTo = storageProfile.sourceForLogicalPath?.(
    options.format,
    options.docPath
  )
  if (
    !expectedFrom ||
    expectedFrom.kind !== "file" ||
    !expectedTo ||
    expectedTo.kind !== "file" ||
    source.handle.source.relativePath !== expectedFrom.relativePath
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document format does not support managed transitions"
    )
  }

  const operationId = `dlc_${randomBytes(16).toString("base64url")}`
  const parent = posix.dirname(expectedFrom.relativePath)
  const auxiliaryName = `.worktable-${operationId}`
  const parkedRelativePath = posix.join(parent, `${auxiliaryName}.source`)
  const stagedRelativePath = posix.join(parent, `${auxiliaryName}.target`)
  const spaceRoot = resolve(getSpacesBaseDir(), options.spaceId)
  requireRealDirectory(spaceRoot, `Space ${options.spaceId}`)
  assertSafeContainedPath(resolve(getWorkspaceRoot()), spaceRoot)
  const sourcePath = resolve(spaceRoot, expectedFrom.relativePath)
  const targetPath = resolve(spaceRoot, expectedTo.relativePath)
  const parkedPath = resolve(spaceRoot, parkedRelativePath)
  const stagedPath = resolve(spaceRoot, stagedRelativePath)
  for (const candidate of [sourcePath, targetPath, parkedPath, stagedPath]) {
    assertSafeContainedPath(spaceRoot, candidate)
  }
  const sourceFingerprint = fingerprintOptionalRegularFile(sourcePath)
  if (!sourceFingerprint) {
    throw new DocumentLifecyclePreconditionError(
      `Doc not found: ${options.docPath}`
    )
  }
  if (
    options.sourceRevision &&
    (options.sourceRevision.relativePath !== expectedFrom.relativePath ||
      options.sourceRevision.size !== sourceFingerprint.size ||
      options.sourceRevision.sha256 !== sourceFingerprint.sha256)
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document changed while it was being converted. Try again."
    )
  }
  if (
    fingerprintOptionalRegularFile(targetPath) ||
    fingerprintOptionalRegularFile(parkedPath) ||
    fingerprintOptionalRegularFile(stagedPath)
  ) {
    throw new DocumentLifecyclePreconditionError(
      "Document format transition paths are already occupied"
    )
  }

  const blobs = new Map<string, Buffer>()
  const edits: ArtifactEdit[] = []
  if (options.rotateCollaborationCache) {
    edits.push(prepareFormatDocMetaEdit(blobs, spaceRoot, options.docPath))
  }
  edits.push(
    await prepareFormatInventoryEdit(
      blobs,
      spaceRoot,
      options.spaceId,
      source.descriptor.documentId,
      options.docPath,
      options.format,
      expectedTo
    )
  )
  const totalBytes = [...blobs.values()].reduce(
    (total, bytes) => total + bytes.byteLength,
    0
  )
  if (totalBytes > ARTIFACT_TOTAL_MAX_BYTES) {
    throw new DocumentLifecyclePreconditionError(
      "Document metadata is too large to change format safely"
    )
  }

  const targetBytes = Buffer.from(options.bytes)
  const journal: FormatTransitionJournal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    planVersion: JOURNAL_PLAN_VERSION,
    operationType: "format-transition",
    operationId,
    createdAt: new Date().toISOString(),
    phase: "applying",
    workspace: workspaceBinding(),
    document: {
      id: source.descriptor.documentId,
      format: source.descriptor.format,
      afterFormat: options.format,
      sourceSha256: sourceFingerprint.sha256,
      sourceSize: sourceFingerprint.size,
      targetSha256: sha256(targetBytes),
      targetSize: targetBytes.byteLength,
      history: "absent",
    },
    from: {
      spaceId: options.spaceId,
      logicalPath: options.docPath,
      source: expectedFrom,
    },
    to: {
      spaceId: options.spaceId,
      logicalPath: options.docPath,
      source: expectedTo,
    },
    context: {
      updatedBy: options.context?.updatedBy ?? "unknown",
      source: options.context?.source ?? "unknown",
      ...(options.context?.reason ? { reason: options.context.reason } : {}),
    },
    edits,
    annotation: null,
    completed: [],
  }
  JournalSchema.parse(journal)
  return { journal, blobs, targetBytes }
}

function writeJournal(journal: DocumentLifecycleJournal): void {
  const parsed = JournalSchema.parse(journal)
  const bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8")
  if (bytes.byteLength > JOURNAL_MAX_BYTES) {
    throw new Error("document lifecycle journal exceeds its size limit")
  }
  writeDurableFile(journalPath(), bytes, 0o600)
}

function assertPreparedJournalFits(journal: DocumentLifecycleJournal): void {
  const bytes = Buffer.byteLength(`${JSON.stringify(journal, null, 2)}\n`)
  if (bytes > JOURNAL_MAX_BYTES) {
    throw new DocumentLifecyclePreconditionError(
      "Document lifecycle recovery state exceeds its supported size limit"
    )
  }
}

function createJournal(prepared: PreparedJournal): void {
  const parent = lifecycleWorkspaceDirectory()
  ensureDurableDirectory(parent, getAppDir())
  removeLifecycleCleanupTombstones()
  if (readReconciliationMarkers().length > 0) {
    throw new Error(
      "document content reconciliation must finish before another move"
    )
  }
  if (existsSync(activeDirectory())) {
    throw new Error(
      "an interrupted document lifecycle operation requires recovery"
    )
  }
  const temporary = join(
    parent,
    `.preparing-${prepared.journal.operationId}-${randomBytes(5).toString("hex")}`
  )
  try {
    mkdirSync(join(temporary, "artifacts"), {
      recursive: true,
      mode: 0o700,
    })
    for (const [key, bytes] of prepared.blobs) {
      const [role, side] = key.split(":") as [string, ArtifactSide]
      const path = join(temporary, "artifacts", `${role}.${side}.bin`)
      writeDurableFile(path, bytes, 0o600)
    }
    const journalBytes = Buffer.from(
      `${JSON.stringify(prepared.journal, null, 2)}\n`,
      "utf8"
    )
    if (journalBytes.byteLength > JOURNAL_MAX_BYTES) {
      throw new DocumentLifecyclePreconditionError(
        "Document lifecycle recovery state exceeds its supported size limit"
      )
    }
    writeDurableFile(join(temporary, "journal.json"), journalBytes, 0o600)
    fsyncDirectory(join(temporary, "artifacts"))
    fsyncDirectory(temporary)
    const admissionHookResult = stepHookForTests?.("before-journal-publication")
    if (admissionHookResult instanceof Promise) {
      throw new Error(
        "before-journal-publication test hook must be synchronous"
      )
    }
    // Planning reads several independently writable files. Revalidate the
    // complete captured checkpoint only after the recovery payload is durable
    // and immediately before making that payload active. If an external writer
    // changed any endpoint or metadata in the meantime, there is still no
    // published journal and no lifecycle mutation to recover.
    verifyCapturedBefore(prepared)
    renameSync(temporary, activeDirectory())
    const hookResult = stepHookForTests?.("journal-published")
    if (hookResult instanceof Promise) {
      throw new Error("journal-published test hook must be synchronous")
    }
    fsyncDirectory(parent)
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

function parseJournal(path: string): DocumentLifecycleJournal {
  const bytes = readOptionalRegularFile(path, JOURNAL_MAX_BYTES)
  if (!bytes) throw new Error("document lifecycle recovery state is incomplete")
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error("document lifecycle journal is invalid")
  }
  const result = JournalSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error("document lifecycle journal has an unsupported shape")
  }
  validateJournalBinding(result.data)
  validateJournalPaths(result.data)
  return result.data
}

function readJournal(): DocumentLifecycleJournal | null {
  if (!existsSync(activeDirectory())) return null
  const journal = parseJournal(journalPath())
  validateArtifacts(journal)
  return journal
}

function validateJournalBinding(journal: DocumentLifecycleJournal): void {
  const current = workspaceBinding()
  if (
    current.canonicalRoot !== journal.workspace.canonicalRoot ||
    current.manifestId !== journal.workspace.manifestId
  ) {
    throw new Error("document lifecycle journal belongs to another workspace")
  }
}

function validatePrefixRenameJournalPaths(journal: PrefixRenameJournal): void {
  if (journal.from.spaceId !== journal.to.spaceId) {
    throw new Error("document folder lifecycle journal crosses Spaces")
  }
  const fromRoot = analyzeDocumentPath(journal.from.logicalPath)
  const toRoot = analyzeDocumentPath(journal.to.logicalPath, {
    enforceNewPathGrammar: true,
  })
  if (
    !fromRoot.safe ||
    fromRoot.canonicalPath !== journal.from.logicalPath ||
    !fromRoot.comparisonKey ||
    !toRoot.safe ||
    !toRoot.portable ||
    toRoot.canonicalPath !== journal.to.logicalPath ||
    !toRoot.comparisonKey ||
    documentPathKeyIsBelow(toRoot.comparisonKey, fromRoot.comparisonKey)
  ) {
    throw new Error("document folder lifecycle roots are unsafe")
  }
  const ids = new Set<string>()
  const sources = new Set<string>()
  const targets = new Set<string>()
  let previousDepth = -1
  let previousPath = ""
  for (const entry of journal.documents) {
    if (
      entry.from.spaceId !== journal.from.spaceId ||
      entry.to.spaceId !== journal.to.spaceId
    ) {
      throw new Error("document folder lifecycle entry crosses Spaces")
    }
    const expectedTo = remapDocumentPathPrefix(
      entry.from.logicalPath,
      journal.from.logicalPath,
      journal.to.logicalPath
    )
    const from = analyzeDocumentPath(entry.from.logicalPath)
    const to = analyzeDocumentPath(entry.to.logicalPath, {
      enforceNewPathGrammar: true,
    })
    if (
      !from.safe ||
      from.canonicalPath !== entry.from.logicalPath ||
      !from.comparisonKey ||
      !documentPathKeyIsAtOrBelow(from.comparisonKey, fromRoot.comparisonKey) ||
      !to.safe ||
      !to.portable ||
      to.canonicalPath !== entry.to.logicalPath ||
      entry.to.logicalPath !== expectedTo ||
      !to.comparisonKey
    ) {
      throw new Error("document folder lifecycle entry path is unsafe")
    }
    const depth = entry.from.logicalPath.split("/").length
    if (
      depth < previousDepth ||
      (depth === previousDepth &&
        entry.from.logicalPath.localeCompare(previousPath) <= 0)
    ) {
      throw new Error("document folder lifecycle order is invalid")
    }
    previousDepth = depth
    previousPath = entry.from.logicalPath
    if (
      ids.has(entry.document.id) ||
      sources.has(from.comparisonKey) ||
      targets.has(to.comparisonKey)
    ) {
      throw new Error("document folder lifecycle entries are ambiguous")
    }
    ids.add(entry.document.id)
    sources.add(from.comparisonKey)
    targets.add(to.comparisonKey)
    const storageProfileId = documentStorageProfiles.resolve(
      entry.document.format,
      entry.from.source
    )
    if (!storageProfileId) {
      throw new Error("document folder lifecycle source adapter is unsupported")
    }
    const profile = documentStorageProfiles.get(storageProfileId)
    const expectedFrom = profile.sourceForLogicalPath?.(
      entry.document.format,
      entry.from.logicalPath
    )
    const expectedTarget = profile.sourceForLogicalPath?.(
      entry.document.format,
      entry.to.logicalPath
    )
    if (
      !profile.managedPrefixRename ||
      !expectedFrom ||
      !expectedTarget ||
      !sameDocumentSource(entry.from.source, expectedFrom) ||
      !sameDocumentSource(entry.to.source, expectedTarget)
    ) {
      throw new Error(
        "document folder lifecycle source locator is inconsistent"
      )
    }
    const bundleSource = entry.from.source.kind === "bundle"
    const bundleCheckpoint = entry.document.sourceEntries !== undefined
    const htmlProfile =
      storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
    if (
      bundleSource !== bundleCheckpoint ||
      htmlProfile !== Boolean(entry.document.sourceIdentity) ||
      (entry.document.sourceIdentity &&
        entry.document.sourceIdentity.relativePath !== "widget.yaml") ||
      (htmlProfile && !WidgetIdSchema.safeParse(entry.to.logicalPath).success)
    ) {
      throw new Error(
        "document folder lifecycle source checkpoint is inconsistent"
      )
    }
  }
  const roles = journal.edits.map((edit) => edit.role)
  const allowedRoles: readonly SimpleArtifactRole[] = [
    "doc-meta",
    "space-order",
    "inventory",
    "aliases",
    "widget-meta",
  ]
  if (
    new Set(roles).size !== roles.length ||
    !roles.includes("inventory") ||
    !roles.includes("aliases") ||
    roles.some((role) => !allowedRoles.includes(role))
  ) {
    throw new Error("document folder lifecycle step plan is incomplete")
  }
  const planned: DurableStep[] = ["share-revoked", "source"]
  planned.push(...orderedEdits(journal, "forward").map((edit) => edit.role))
  const expected =
    journal.phase === "committed" ? [...planned, "committed" as const] : planned
  const completedIsOrderedPrefix =
    new Set(journal.completed).size === journal.completed.length &&
    journal.completed.every((step, index) => expected[index] === step)
  if (
    journal.completedDocuments > journal.documents.length ||
    (journal.completed.includes("source") &&
      journal.completedDocuments !== journal.documents.length) ||
    (journal.phase === "committed" &&
      journal.completedDocuments !== journal.documents.length) ||
    !completedIsOrderedPrefix ||
    (journal.phase === "committed" &&
      journal.completed.length !== expected.length) ||
    (journal.phase === "applying" && journal.completed.includes("committed"))
  ) {
    throw new Error("document folder lifecycle progress checkpoint is invalid")
  }
}

function archiveMutationRelativePath(
  journal: PrefixArchiveJournal,
  mutation: PrefixArchiveMutation
): string {
  const entries = mutation.documentIndexes.map((index) => {
    const entry = journal.documents[index]
    if (!entry) {
      throw new Error("document archive mutation index is invalid")
    }
    if (
      entry.storageProfileId !== mutation.storageProfileId ||
      entry.archiveAdapter !== mutation.archiveAdapter
    ) {
      throw new Error("document archive mutation adapter is inconsistent")
    }
    return entry
  })
  return archiveMetadataRelativePath(
    mutation.archiveAdapter,
    entries.map((entry) => entry.at.logicalPath)
  )
}

function validatePrefixArchiveJournalPaths(
  journal: PrefixArchiveJournal
): void {
  if (
    journal.from.spaceId !== journal.to.spaceId ||
    journal.from.logicalPath !== journal.to.logicalPath
  ) {
    throw new Error("document archive lifecycle endpoint changed")
  }
  const root = analyzeDocumentPath(journal.from.logicalPath)
  if (
    !root.safe ||
    root.canonicalPath !== journal.from.logicalPath ||
    !root.comparisonKey
  ) {
    throw new Error("document archive lifecycle root is unsafe")
  }
  const ids = new Set<string>()
  const paths = new Set<string>()
  let hasDescendant = false
  let previousDepth = -1
  let previousPath = ""
  for (const entry of journal.documents) {
    if (entry.at.spaceId !== journal.from.spaceId) {
      throw new Error("document archive lifecycle entry crosses Spaces")
    }
    const path = analyzeDocumentPath(entry.at.logicalPath)
    if (
      !path.safe ||
      path.canonicalPath !== entry.at.logicalPath ||
      !path.comparisonKey ||
      !documentPathKeyIsAtOrBelow(path.comparisonKey, root.comparisonKey)
    ) {
      throw new Error("document archive lifecycle entry path is unsafe")
    }
    if (documentPathKeyIsBelow(path.comparisonKey, root.comparisonKey)) {
      hasDescendant = true
    }
    const depth = entry.at.logicalPath.split("/").length
    if (
      depth < previousDepth ||
      (depth === previousDepth &&
        entry.at.logicalPath.localeCompare(previousPath) <= 0)
    ) {
      throw new Error("document archive lifecycle order is invalid")
    }
    previousDepth = depth
    previousPath = entry.at.logicalPath
    if (ids.has(entry.document.id) || paths.has(path.comparisonKey)) {
      throw new Error("document archive lifecycle entries are ambiguous")
    }
    ids.add(entry.document.id)
    paths.add(path.comparisonKey)
    const resolvedProfile = documentStorageProfiles.resolve(
      entry.document.format,
      entry.at.source
    )
    const profile = resolvedProfile
      ? documentStorageProfiles.get(resolvedProfile)
      : null
    const expectedSource = profile?.sourceForLogicalPath?.(
      entry.document.format,
      entry.at.logicalPath
    )
    if (
      resolvedProfile !== entry.storageProfileId ||
      profile?.archiveAdapter !== entry.archiveAdapter ||
      !expectedSource ||
      !sameDocumentSource(expectedSource, entry.at.source)
    ) {
      throw new Error("document archive lifecycle adapter is inconsistent")
    }
  }
  const exactScope = journal.scope === "exact"
  if (
    exactScope &&
    (journal.documents.length !== 1 ||
      journal.documents[0]?.at.logicalPath !== journal.from.logicalPath)
  ) {
    throw new Error("document archive exact scope is invalid")
  }
  if (!exactScope && !hasDescendant) {
    throw new Error("document archive lifecycle root is not a folder")
  }

  const seenIndexes = new Set<number>()
  const seenGroups = new Set<string>()
  let previousMutationPath = ""
  for (const mutation of journal.mutations) {
    if (
      new Set(mutation.documentIndexes).size !==
        mutation.documentIndexes.length ||
      mutation.documentIndexes.some((index, position, values) =>
        position > 0 ? index <= values[position - 1]! : false
      )
    ) {
      throw new Error("document archive mutation order is invalid")
    }
    for (const index of mutation.documentIndexes) {
      if (seenIndexes.has(index)) {
        throw new Error("document archive mutation members overlap")
      }
      seenIndexes.add(index)
    }
    const relativePath = archiveMutationRelativePath(journal, mutation)
    const group = `${mutation.storageProfileId}\0${mutation.archiveAdapter}\0${relativePath}`
    if (
      seenGroups.has(group) ||
      (previousMutationPath &&
        relativePath.localeCompare(previousMutationPath) <= 0)
    ) {
      throw new Error("document archive mutation grouping is invalid")
    }
    seenGroups.add(group)
    previousMutationPath = relativePath
  }

  const planned: DurableStep[] = [
    ...(journal.archived ? (["share-revoked"] as const) : []),
    "archive-state",
  ]
  const expected =
    journal.phase === "committed" ? [...planned, "committed" as const] : planned
  const completedIsOrderedPrefix =
    new Set(journal.completed).size === journal.completed.length &&
    journal.completed.every((step, index) => expected[index] === step)
  if (
    journal.completedMutations > journal.mutations.length ||
    (journal.completed.includes("archive-state") &&
      journal.completedMutations !== journal.mutations.length) ||
    (journal.phase === "committed" &&
      journal.completedMutations !== journal.mutations.length) ||
    !completedIsOrderedPrefix ||
    (journal.phase === "committed" &&
      journal.completed.length !== expected.length) ||
    (journal.phase === "applying" && journal.completed.includes("committed"))
  ) {
    throw new Error("document archive lifecycle progress is invalid")
  }
}

function validatePrefixDeleteJournalPaths(journal: PrefixDeleteJournal): void {
  if (
    journal.from.spaceId !== journal.to.spaceId ||
    journal.from.logicalPath !== journal.to.logicalPath
  ) {
    throw new Error("document deletion lifecycle endpoint changed")
  }
  const root = analyzeDocumentPath(journal.from.logicalPath)
  if (
    !root.safe ||
    root.canonicalPath !== journal.from.logicalPath ||
    !root.comparisonKey
  ) {
    throw new Error("document deletion lifecycle root is unsafe")
  }
  const ids = new Set<string>()
  const paths = new Set<string>()
  let hasDescendant = false
  let previousDepth = -1
  let previousPath = ""
  for (const entry of journal.documents) {
    if (entry.at.spaceId !== journal.from.spaceId) {
      throw new Error("document deletion lifecycle entry crosses Spaces")
    }
    const path = analyzeDocumentPath(entry.at.logicalPath)
    if (
      !path.safe ||
      path.canonicalPath !== entry.at.logicalPath ||
      !path.comparisonKey ||
      !documentPathKeyIsAtOrBelow(path.comparisonKey, root.comparisonKey)
    ) {
      throw new Error("document deletion lifecycle entry path is unsafe")
    }
    if (documentPathKeyIsBelow(path.comparisonKey, root.comparisonKey)) {
      hasDescendant = true
    }
    const depth = entry.at.logicalPath.split("/").length
    if (
      depth < previousDepth ||
      (depth === previousDepth &&
        entry.at.logicalPath.localeCompare(previousPath) <= 0)
    ) {
      throw new Error("document deletion lifecycle order is invalid")
    }
    previousDepth = depth
    previousPath = entry.at.logicalPath
    if (ids.has(entry.document.id) || paths.has(path.comparisonKey)) {
      throw new Error("document deletion lifecycle entries are ambiguous")
    }
    ids.add(entry.document.id)
    paths.add(path.comparisonKey)
    const resolvedProfile = documentStorageProfiles.resolve(
      entry.document.format,
      entry.at.source
    )
    const profile = resolvedProfile
      ? documentStorageProfiles.get(resolvedProfile)
      : null
    const expectedSource = profile?.sourceForLogicalPath?.(
      entry.document.format,
      entry.at.logicalPath
    )
    if (
      resolvedProfile !== entry.storageProfileId ||
      profile?.deleteAdapter !== entry.deleteAdapter ||
      !expectedSource ||
      !sameDocumentSource(expectedSource, entry.at.source)
    ) {
      throw new Error("document deletion lifecycle adapter is inconsistent")
    }
    const bundleSource = entry.at.source.kind === "bundle"
    if (
      bundleSource !== (entry.document.sourceEntries !== undefined) ||
      (entry.deleteAdapter === DOCUMENT_DELETE_ADAPTER_IDS.legacyDoc &&
        !entry.document.historyManifest) ||
      (entry.deleteAdapter === DOCUMENT_DELETE_ADAPTER_IDS.legacyHtml &&
        entry.document.historyManifest !== undefined)
    ) {
      throw new Error(
        "document deletion lifecycle source checkpoint is inconsistent"
      )
    }
  }
  if (!hasDescendant) {
    throw new Error("document deletion lifecycle root is not a folder")
  }
  const roles = journal.edits.map((edit) => edit.role)
  const allowedRoles: readonly SimpleArtifactRole[] = [
    "doc-meta",
    "space-order",
    "inventory",
    "aliases",
    "widget-meta",
  ]
  if (
    new Set(roles).size !== roles.length ||
    roles.some((role) => !allowedRoles.includes(role)) ||
    !roles.includes("inventory")
  ) {
    throw new Error("document deletion lifecycle step plan is incomplete")
  }
  const planned: DurableStep[] = ["share-revoked", "source"]
  planned.push(...orderedEdits(journal, "forward").map((edit) => edit.role))
  const expected =
    journal.phase === "committed" ? [...planned, "committed" as const] : planned
  const completedIsOrderedPrefix =
    new Set(journal.completed).size === journal.completed.length &&
    journal.completed.every((step, index) => expected[index] === step)
  if (
    journal.completedDocuments > journal.documents.length ||
    (journal.completed.includes("source") &&
      journal.completedDocuments !== journal.documents.length) ||
    (journal.phase === "committed" &&
      journal.completedDocuments !== journal.documents.length) ||
    !completedIsOrderedPrefix ||
    (journal.phase === "committed" &&
      journal.completed.length !== expected.length) ||
    (journal.phase === "applying" && journal.completed.includes("committed"))
  ) {
    throw new Error("document deletion lifecycle progress is invalid")
  }
}

function validateJournalPaths(journal: DocumentLifecycleJournal): void {
  if (journal.operationType === "prefix-rename") {
    validatePrefixRenameJournalPaths(journal)
    return
  }
  if (journal.operationType === "prefix-archive") {
    validatePrefixArchiveJournalPaths(journal)
    return
  }
  if (journal.operationType === "prefix-delete") {
    validatePrefixDeleteJournalPaths(journal)
    return
  }
  if (journal.from.spaceId !== journal.to.spaceId) {
    throw new Error("document lifecycle journal crosses Spaces")
  }
  const from = analyzeDocumentPath(journal.from.logicalPath)
  const to = analyzeDocumentPath(journal.to.logicalPath, {
    enforceNewPathGrammar: journal.operationType === "exact-rename",
  })
  if (!from.safe || from.canonicalPath !== journal.from.logicalPath) {
    throw new Error("document lifecycle source path is unsafe")
  }
  if (
    !to.safe ||
    (journal.operationType === "exact-rename" && !to.portable) ||
    to.canonicalPath !== journal.to.logicalPath
  ) {
    throw new Error("document lifecycle target path is unsafe")
  }
  const storageProfileId = documentStorageProfiles.resolve(
    journal.document.format,
    journal.from.source
  )
  const supportedProfile =
    storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile ||
    ((journal.operationType === "exact-delete" ||
      journal.operationType === "exact-rename") &&
      storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle)
  if (!supportedProfile || storageProfileId === null) {
    throw new Error("document lifecycle source adapter is unsupported")
  }
  const storageProfile = documentStorageProfiles.get(storageProfileId)
  if (
    (journal.operationType === "exact-delete" &&
      !storageProfile.deleteAdapter) ||
    (journal.operationType === "exact-rename" &&
      !storageProfile.managedExactRename)
  ) {
    throw new Error("document lifecycle source adapter is unsupported")
  }
  const expectedFrom = storageProfile.sourceForLogicalPath?.(
    journal.document.format,
    journal.from.logicalPath
  )
  const targetFormat =
    journal.operationType === "format-transition"
      ? journal.document.afterFormat
      : journal.document.format
  const expectedTo = storageProfile.sourceForLogicalPath?.(
    targetFormat,
    journal.to.logicalPath
  )
  if (
    !expectedFrom ||
    !expectedTo ||
    !sameDocumentSource(journal.from.source, expectedFrom) ||
    !sameDocumentSource(journal.to.source, expectedTo)
  ) {
    throw new Error("document lifecycle source locator is inconsistent")
  }
  if (journal.operationType === "format-transition") {
    if (journal.from.logicalPath !== journal.to.logicalPath) {
      throw new Error("document format transition changed its logical path")
    }
    if (
      journal.from.source.kind !== "file" ||
      journal.to.source.kind !== "file"
    ) {
      throw new Error("document format transition requires file sources")
    }
  }
  if (journal.operationType === "exact-delete") {
    const bundleSource = journal.from.source.kind === "bundle"
    const bundleCheckpoint =
      journal.document.sourceState !== "absent" &&
      journal.document.sourceEntries !== undefined
    if (
      bundleSource !== bundleCheckpoint &&
      journal.document.sourceState !== "absent"
    ) {
      throw new Error("document deletion source checkpoint is inconsistent")
    }
  }
  if (journal.operationType === "exact-rename") {
    const bundleSource = journal.from.source.kind === "bundle"
    const bundleCheckpoint = journal.document.sourceEntries !== undefined
    const htmlProfile =
      storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
    if (
      bundleSource !== bundleCheckpoint ||
      htmlProfile !== Boolean(journal.document.sourceIdentity) ||
      (journal.document.sourceIdentity &&
        journal.document.sourceIdentity.relativePath !== "widget.yaml")
    ) {
      throw new Error("document move source checkpoint is inconsistent")
    }
  }
  if (journal.operationType !== "format-transition") {
    if (
      journal.document.historyManifest !== undefined &&
      storageProfileId !== DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile &&
      !(
        journal.operationType === "exact-rename" &&
        storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
      )
    ) {
      throw new Error("document lifecycle history checkpoint is inconsistent")
    }
  }
  const roles = journal.edits.map((edit) => edit.role)
  const allowedRoles: readonly SimpleArtifactRole[] =
    journal.operationType === "format-transition"
      ? ["doc-meta", "inventory"]
      : journal.operationType === "exact-delete" &&
          storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
        ? [
            "space-order",
            "inventory",
            "aliases",
            "widget-meta",
            "widget-annotation",
          ]
        : journal.operationType === "exact-rename" &&
            storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
          ? ["space-order", "inventory", "aliases", "widget-meta"]
          : journal.operationType === "exact-delete"
            ? [
                "doc-meta",
                "space-order",
                "inventory",
                "aliases",
                "doc-annotation",
              ]
            : ["doc-meta", "space-order", "inventory", "aliases"]
  if (new Set(roles).size !== roles.length || !roles.includes("inventory")) {
    throw new Error("document lifecycle step plan is incomplete")
  }
  if (roles.some((role) => !allowedRoles.includes(role))) {
    throw new Error("document lifecycle step plan has an invalid artifact role")
  }
  if (
    journal.operationType === "exact-rename" &&
    storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle &&
    !roles.includes("aliases")
  ) {
    throw new Error("document lifecycle step plan is incomplete")
  }
  const planned: DurableStep[] =
    journal.operationType === "format-transition"
      ? ["target", "source"]
      : journal.operationType === "exact-delete" &&
          journal.document.sourceState === "absent"
        ? ["share-revoked", "history"]
        : ["share-revoked", "history", "source"]
  for (const role of orderedEdits(journal, "forward").map(
    (edit) => edit.role
  )) {
    if (journal.operationType === "exact-rename" && role === "aliases") {
      planned.push("annotation")
    }
    planned.push(role)
  }
  const expected =
    journal.phase === "committed" ? [...planned, "committed" as const] : planned
  const completedIsOrderedPrefix =
    new Set(journal.completed).size === journal.completed.length &&
    journal.completed.every((step, index) => expected[index] === step)
  if (
    !completedIsOrderedPrefix ||
    (journal.phase === "committed" &&
      journal.completed.length !== expected.length) ||
    (journal.phase === "applying" && journal.completed.includes("committed"))
  ) {
    throw new Error("document lifecycle progress checkpoint is invalid")
  }
}

function artifactBytes(
  role: string,
  side: ArtifactSide,
  ref: BlobRef,
  directory?: string
): Buffer {
  const bytes = readOptionalRegularFile(
    artifactPath(role, side, directory),
    ARTIFACT_MAX_BYTES
  )
  if (!bytes || bytes.byteLength !== ref.size || sha256(bytes) !== ref.sha256) {
    throw new Error(`document lifecycle ${role} ${side} artifact is invalid`)
  }
  return bytes
}

function readDirectHistoryManifest(
  journal: ExactRenameJournal | ExactDeleteJournal
): DirectHistoryFile[] | null {
  const ref = journal.document.historyManifest
  if (!ref) return null
  const bytes = artifactBytes("history-manifest", "before", ref)
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error("document lifecycle history manifest is invalid")
  }
  const parsed = DirectHistoryManifestSchema.safeParse(raw)
  const totalBytes = parsed.success
    ? parsed.data.reduce((total, file) => total + file.size, 0)
    : 0
  if (
    !parsed.success ||
    new Set(parsed.data.map((file) => file.name)).size !== parsed.data.length ||
    totalBytes > SOURCE_MAX_BYTES ||
    journal.document.history !== (parsed.data.length > 0 ? "present" : "absent")
  ) {
    throw new Error("document lifecycle history checkpoint is inconsistent")
  }
  return parsed.data
}

function readPrefixHistoryManifest(
  journal: PrefixRenameJournal,
  index: number
): DirectHistoryFile[] {
  const entry = journal.documents[index]
  if (!entry) {
    throw new Error("document folder history checkpoint is missing")
  }
  const bytes = artifactBytes(
    `history-manifest-${index}`,
    "before",
    entry.document.historyManifest
  )
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error("document folder history manifest is invalid")
  }
  const parsed = DirectHistoryManifestSchema.safeParse(raw)
  const totalBytes = parsed.success
    ? parsed.data.reduce((total, file) => total + file.size, 0)
    : 0
  if (
    !parsed.success ||
    new Set(parsed.data.map((file) => file.name)).size !== parsed.data.length ||
    totalBytes > SOURCE_MAX_BYTES ||
    entry.document.history !== (parsed.data.length > 0 ? "present" : "absent")
  ) {
    throw new Error("document folder history checkpoint is inconsistent")
  }
  return parsed.data
}

function readPrefixDeleteHistoryManifest(
  journal: PrefixDeleteJournal,
  index: number,
  artifactDirectory?: string
): DirectHistoryFile[] | null {
  const entry = journal.documents[index]
  if (!entry) {
    throw new Error("document deletion history checkpoint is missing")
  }
  const ref = entry.document.historyManifest
  if (!ref) return null
  const bytes = artifactBytes(
    `history-manifest-${index}`,
    "before",
    ref,
    artifactDirectory
  )
  let raw: unknown
  try {
    raw = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error("document deletion history manifest is invalid")
  }
  const parsed = DirectHistoryManifestSchema.safeParse(raw)
  const totalBytes = parsed.success
    ? parsed.data.reduce((total, file) => total + file.size, 0)
    : 0
  if (
    !parsed.success ||
    new Set(parsed.data.map((file) => file.name)).size !== parsed.data.length ||
    totalBytes > SOURCE_MAX_BYTES ||
    entry.document.history !== (parsed.data.length > 0 ? "present" : "absent")
  ) {
    throw new Error("document deletion history checkpoint is inconsistent")
  }
  return parsed.data
}

function validateArtifacts(journal: DocumentLifecycleJournal): void {
  let total = 0
  for (const edit of journal.edits) {
    if (edit.before)
      total += artifactBytes(edit.role, "before", edit.before).byteLength
    if (edit.after)
      total += artifactBytes(edit.role, "after", edit.after).byteLength
  }
  if (journal.operationType === "prefix-archive") {
    const changedIndexes = new Set<number>()
    let sharedArchiveState: ArchiveFieldState | null = null
    for (const [index, entry] of journal.documents.entries()) {
      const beforeBytes = artifactBytes(
        `archive-field-${index}`,
        "before",
        entry.archive.before
      )
      const afterBytes = artifactBytes(
        `archive-field-${index}`,
        "after",
        entry.archive.after
      )
      total += beforeBytes.byteLength + afterBytes.byteLength
      const before = parseArchiveFieldState(entry.archiveAdapter, beforeBytes)
      const after = parseArchiveFieldState(entry.archiveAdapter, afterBytes)
      const changed = !archiveFieldStatesEqual(before, after)
      if (changed) changedIndexes.add(index)
      if (journal.archived) {
        if (
          (isArchivedFieldState(before) &&
            !archiveFieldStatesEqual(before, after)) ||
          (!isArchivedFieldState(before) && !isArchivedFieldState(after))
        ) {
          throw new Error("document archive provenance plan is invalid")
        }
        if (!isArchivedFieldState(before)) {
          if (
            sharedArchiveState &&
            !archiveFieldStatesEqual(sharedArchiveState, after)
          ) {
            throw new Error("document archive provenance is inconsistent")
          }
          sharedArchiveState = after
        }
      } else {
        const expectedAfter = isArchivedFieldState(before)
          ? activeArchiveFieldState(entry.archiveAdapter)
          : before
        if (!archiveFieldStatesEqual(expectedAfter, after)) {
          throw new Error("document restore plan is invalid")
        }
      }
    }
    const expectedMutations = prefixArchiveMutationGroups(
      journal.documents,
      changedIndexes
    )
    if (
      JSON.stringify(expectedMutations) !== JSON.stringify(journal.mutations)
    ) {
      throw new Error("document archive mutation plan is incomplete")
    }
  } else if (journal.operationType === "prefix-rename") {
    for (const [index, entry] of journal.documents.entries()) {
      if (entry.annotation) {
        total += artifactBytes(
          `annotation-${index}`,
          "before",
          entry.annotation.before
        ).byteLength
        total += artifactBytes(
          `annotation-${index}`,
          "after",
          entry.annotation.after
        ).byteLength
      }
      readPrefixHistoryManifest(journal, index)
      total += entry.document.historyManifest.size
      if (entry.document.sourceIdentity) {
        total += artifactBytes(
          `source-identity-${index}`,
          "before",
          entry.document.sourceIdentity.before
        ).byteLength
        total += artifactBytes(
          `source-identity-${index}`,
          "after",
          entry.document.sourceIdentity.after
        ).byteLength
      }
    }
  } else if (journal.operationType === "prefix-delete") {
    for (const [index, entry] of journal.documents.entries()) {
      if (entry.annotation) {
        total += artifactBytes(
          `delete-annotation-${index}`,
          "before",
          entry.annotation
        ).byteLength
      }
      const history = readPrefixDeleteHistoryManifest(journal, index)
      if (history) total += entry.document.historyManifest?.size ?? 0
    }
  } else if (journal.annotation) {
    total += artifactBytes(
      "annotation",
      "before",
      journal.annotation.before
    ).byteLength
    total += artifactBytes(
      "annotation",
      "after",
      journal.annotation.after
    ).byteLength
  }
  if (
    journal.operationType === "exact-rename" &&
    journal.document.sourceIdentity
  ) {
    total += artifactBytes(
      "source-identity",
      "before",
      journal.document.sourceIdentity.before
    ).byteLength
    total += artifactBytes(
      "source-identity",
      "after",
      journal.document.sourceIdentity.after
    ).byteLength
  }
  if (
    journal.operationType !== "format-transition" &&
    journal.operationType !== "prefix-rename" &&
    journal.operationType !== "prefix-archive" &&
    journal.operationType !== "prefix-delete" &&
    readDirectHistoryManifest(journal)
  ) {
    total += journal.document.historyManifest?.size ?? 0
  }
  if (total > ARTIFACT_TOTAL_MAX_BYTES) {
    throw new Error("document lifecycle recovery artifacts exceed their limit")
  }
}

function simpleEditPath(
  journal: DocumentLifecycleJournal,
  role: SimpleArtifactRole
): string {
  const spaceRoot = resolve(getSpacesBaseDir(), journal.from.spaceId)
  assertSafeWorkspacePath(spaceRoot)
  requireRealDirectory(spaceRoot, `Space ${journal.from.spaceId}`)
  const name: Record<SimpleArtifactRole, string> = {
    "doc-meta": "docs.meta.json",
    "space-order": "space.json",
    inventory: "documents.meta.json",
    aliases: "doc-aliases.json",
    "doc-annotation": join(
      "annotations",
      "docs",
      `${journal.from.logicalPath}.annotations.json`
    ),
    "widget-meta": "widgets.meta.json",
    "widget-annotation": join(
      "annotations",
      "widgets",
      `${journal.from.logicalPath}.annotations.json`
    ),
  }
  const path = resolve(spaceRoot, name[role])
  assertSafeContainedPath(spaceRoot, path)
  return path
}

function classifyFile(
  path: string,
  before: BlobRef | null,
  after: BlobRef | null
): "before" | "after" | "conflict" {
  const bytes = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
  if (!bytes) {
    if (before === null) return "before"
    if (after === null) return "after"
    return "conflict"
  }
  const hash = sha256(bytes)
  if (before && before.size === bytes.byteLength && before.sha256 === hash) {
    return "before"
  }
  if (after && after.size === bytes.byteLength && after.sha256 === hash) {
    return "after"
  }
  return "conflict"
}

function applySimpleEdit(
  journal: DocumentLifecycleJournal,
  edit: ArtifactEdit,
  direction: "forward" | "compensate"
): void {
  const path = simpleEditPath(journal, edit.role)
  const state = classifyFile(path, edit.before, edit.after)
  const desired = direction === "forward" ? "after" : "before"
  if (state === desired) return
  const expected = direction === "forward" ? "before" : "after"
  if (state !== expected) {
    throw new Error(`document lifecycle ${edit.role} state is ambiguous`)
  }
  const ref = direction === "forward" ? edit.after : edit.before
  if (!ref) removeDurably(path)
  else {
    const side = direction === "forward" ? "after" : "before"
    writeDurableFile(path, artifactBytes(edit.role, side, ref))
  }
}

function sourcePaths(
  journal: Exclude<DocumentLifecycleJournal, PrefixLifecycleJournal>
): {
  root: string
  from: string
  to: string
} {
  const root = resolve(getSpacesBaseDir(), journal.from.spaceId)
  assertSafeWorkspacePath(root)
  requireRealDirectory(root, `Space ${journal.from.spaceId}`)
  const from = resolve(root, journal.from.source.relativePath)
  const to = resolve(root, journal.to.source.relativePath)
  assertSafeContainedPath(root, from)
  assertSafeContainedPath(root, to)
  return { root, from, to }
}

function prefixEntryAsExactDelete(
  journal: PrefixDeleteJournal,
  entry: PrefixDeleteDocument,
  index: number
): ExactDeleteJournal {
  const document: ExactDeleteJournal["document"] = {
    id: entry.document.id,
    format: entry.document.format,
    sourceSha256: entry.document.sourceSha256,
    sourceSize: entry.document.sourceSize,
    ...(entry.document.sourceEntries === undefined
      ? {}
      : { sourceEntries: entry.document.sourceEntries }),
    ...(entry.document.sourceState
      ? { sourceState: entry.document.sourceState }
      : {}),
    history: entry.document.history,
    ...(entry.document.historyManifest
      ? { historyManifest: entry.document.historyManifest }
      : {}),
  }
  return {
    schemaVersion: journal.schemaVersion,
    planVersion: journal.planVersion,
    operationType: "exact-delete",
    operationId: journal.operationId,
    createdAt: journal.createdAt,
    phase: journal.phase,
    workspace: journal.workspace,
    document,
    from: entry.at,
    to: entry.at,
    edits: [],
    annotation: null,
    completed:
      journal.phase === "committed" || index < journal.completedDocuments
        ? ["source"]
        : [],
  }
}

function prefixDeleteQuarantineLeaf(index: number): string {
  return join("sources", index.toString().padStart(3, "0"))
}

function deleteSourcePaths(
  journal: ExactDeleteJournal,
  quarantineLeaf = "source"
): {
  root: string
  source: string
  quarantine: string
} {
  const root = resolve(getSpacesBaseDir(), journal.from.spaceId)
  assertSafeWorkspacePath(root)
  requireRealDirectory(root, `Space ${journal.from.spaceId}`)
  const source = resolve(root, journal.from.source.relativePath)
  const quarantine = resolve(
    root,
    ".worktable-lifecycle-trash",
    journal.operationId,
    quarantineLeaf
  )
  assertSafeContainedPath(root, source)
  assertSafeContainedPath(root, quarantine)
  return { root, source, quarantine }
}

function matchesDeleteSourceFingerprint(
  journal: ExactDeleteJournal,
  path: string
): boolean {
  const actual = fingerprintOptionalDeleteSource(journal.from.source, path)
  if (journal.document.sourceState === "absent") return !actual
  return Boolean(
    actual &&
    actual.kind === journal.from.source.kind &&
    actual.size === journal.document.sourceSize &&
    actual.sha256 === journal.document.sourceSha256 &&
    (actual.kind === "file" ||
      actual.entries === journal.document.sourceEntries)
  )
}

function prefixDeleteSourceChangedForReconciliation(
  journal: PrefixDeleteJournal,
  entry: PrefixDeleteDocument,
  index: number
): boolean {
  const exact = prefixEntryAsExactDelete(journal, entry, index)
  const paths = deleteSourcePaths(exact, prefixDeleteQuarantineLeaf(index))
  if (journal.phase === "committed") {
    return Boolean(
      fingerprintOptionalDeleteSource(entry.at.source, paths.source)
    )
  }
  return (
    Boolean(
      fingerprintOptionalDeleteSource(entry.at.source, paths.quarantine)
    ) || !matchesDeleteSourceFingerprint(exact, paths.source)
  )
}

function classifyDeleteSource(
  journal: ExactDeleteJournal,
  quarantineLeaf?: string
): "before" | "after" | "conflict" {
  const paths = deleteSourcePaths(journal, quarantineLeaf)
  const sourcePresent = Boolean(
    fingerprintOptionalDeleteSource(journal.from.source, paths.source)
  )
  const quarantinePresent = Boolean(
    fingerprintOptionalDeleteSource(journal.from.source, paths.quarantine)
  )
  if (journal.document.sourceState === "absent") return "conflict"
  if (journal.phase === "committed" && journal.completed.includes("source")) {
    // Once committed, a canonical source at the same path belongs to a later
    // generation and must not be mistaken for the retired source.
    return "after"
  }
  if (sourcePresent && !quarantinePresent) return "before"
  if (!sourcePresent && quarantinePresent) return "after"
  return "conflict"
}

function deleteSourceMatchesCheckpoint(
  journal: ExactDeleteJournal,
  expected: "before" | "after",
  options?: { allowRecreatedSource?: boolean; quarantineLeaf?: string }
): boolean {
  if (journal.document.sourceState !== "absent") {
    const state = classifyDeleteSource(journal, options?.quarantineLeaf)
    if (state === expected) return true
    if (expected !== "before" || !options?.allowRecreatedSource) return false
    const paths = deleteSourcePaths(journal, options?.quarantineLeaf)
    const source = fingerprintOptionalDeleteSource(
      journal.from.source,
      paths.source
    )
    const quarantine = fingerprintOptionalDeleteSource(
      journal.from.source,
      paths.quarantine
    )
    // Compensation can observe either an external unlink before our move, or
    // our owned quarantine beside a newly recreated canonical generation. In
    // both cases the retired source no longer occupies the canonical path.
    return (
      (!source && !quarantine) ||
      Boolean(
        quarantine && matchesDeleteSourceFingerprint(journal, paths.quarantine)
      )
    )
  }
  const paths = deleteSourcePaths(journal, options?.quarantineLeaf)
  if (fingerprintOptionalDeleteSource(journal.from.source, paths.quarantine)) {
    return false
  }
  const sourcePresent = Boolean(
    fingerprintOptionalDeleteSource(journal.from.source, paths.source)
  )
  if (expected === "before") {
    return !sourcePresent || Boolean(options?.allowRecreatedSource)
  }
  return !sourcePresent || journal.phase === "committed"
}

function applyDeleteSource(
  journal: ExactDeleteJournal,
  direction: "forward" | "compensate",
  quarantineLeaf?: string
): void {
  if (journal.document.sourceState === "absent") {
    const paths = deleteSourcePaths(journal, quarantineLeaf)
    if (
      fingerprintOptionalDeleteSource(journal.from.source, paths.quarantine)
    ) {
      throw new Error("document deletion source ownership is ambiguous")
    }
    if (
      direction === "forward" &&
      journal.phase !== "committed" &&
      fingerprintOptionalDeleteSource(journal.from.source, paths.source)
    ) {
      throw new Error("document deletion source was recreated during recovery")
    }
    // Compensation preserves an external recreation as an edit to the
    // generation whose deletion never committed. Committed recovery preserves
    // it as the source of a later generation.
    return
  }
  const state = classifyDeleteSource(journal, quarantineLeaf)
  const desired = direction === "forward" ? "after" : "before"
  if (state === desired) return
  const expected = direction === "forward" ? "before" : "after"
  if (state !== expected) {
    if (direction === "compensate" && journal.phase === "applying") {
      const paths = deleteSourcePaths(journal, quarantineLeaf)
      if (
        !fingerprintOptionalDeleteSource(journal.from.source, paths.source) &&
        !fingerprintOptionalDeleteSource(journal.from.source, paths.quarantine)
      ) {
        // The captured source was removed externally after journal
        // publication. Preserve that edit and let reconciliation report it;
        // compensation still restores every path-keyed companion.
        return
      }
      if (
        fingerprintOptionalDeleteSource(journal.from.source, paths.source) &&
        matchesDeleteSourceFingerprint(journal, paths.quarantine)
      ) {
        // The transaction-owned original is still quarantined, while an
        // external writer recreated the canonical source. Keep the external
        // edit in place; reconciliation removes only the owned quarantine.
        return
      }
    }
    throw new Error("document deletion source ownership is ambiguous")
  }
  const paths = deleteSourcePaths(journal, quarantineLeaf)
  if (direction === "forward") {
    if (!matchesDeleteSourceFingerprint(journal, paths.source)) {
      throw new Error("document deletion source changed before it was retired")
    }
    ensureDurableDirectory(dirname(paths.quarantine), paths.root)
    renameSync(paths.source, paths.quarantine)
    fsyncRenameParents(paths.source, paths.quarantine)
    return
  }
  if (fingerprintOptionalDeleteSource(journal.from.source, paths.source)) {
    throw new Error("document deletion source was recreated during recovery")
  }
  if (!matchesDeleteSourceFingerprint(journal, paths.quarantine)) {
    throw new Error("retired document source changed during recovery")
  }
  ensureDurableDirectory(dirname(paths.source), paths.root)
  renameSync(paths.quarantine, paths.source)
  fsyncRenameParents(paths.quarantine, paths.source)
  removeEmptyDeleteQuarantineDirectories(paths.quarantine)
}

function removeEmptyDeleteQuarantineDirectories(quarantine: string): void {
  for (const directory of [dirname(quarantine), dirname(dirname(quarantine))]) {
    try {
      rmdirSync(directory)
      fsyncDirectory(dirname(directory))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
        console.warn(
          `[document-lifecycle] deferred empty delete quarantine cleanup ${directory}`,
          error
        )
        return
      }
    }
  }
}

function finishDeleteSourceCleanup(
  journal: ExactDeleteJournal,
  quarantineLeaf?: string
): void {
  const paths = deleteSourcePaths(journal, quarantineLeaf)
  if (!fingerprintOptionalDeleteSource(journal.from.source, paths.quarantine)) {
    return
  }
  if (!matchesDeleteSourceFingerprint(journal, paths.quarantine)) {
    console.warn(
      `[document-lifecycle] retained changed deleted source for recovery: ${paths.quarantine}`
    )
    return
  }
  if (journal.from.source.kind === "bundle") {
    rmSync(paths.quarantine, { recursive: true, force: true })
    fsyncDirectory(dirname(paths.quarantine))
  } else {
    removeDurably(paths.quarantine)
  }
  removeEmptyDeleteQuarantineDirectories(paths.quarantine)
}

function formatTransitionPaths(journal: FormatTransitionJournal): {
  root: string
  from: string
  to: string
  parked: string
  staged: string
} {
  const source = sourcePaths(journal)
  const parent = dirname(source.from)
  const auxiliaryName = `.worktable-${journal.operationId}`
  const parked = resolve(parent, `${auxiliaryName}.source`)
  const staged = resolve(parent, `${auxiliaryName}.target`)
  assertSafeContainedPath(source.root, parked)
  assertSafeContainedPath(source.root, staged)
  return { ...source, parked, staged }
}

function verifiedFormatTransitionPaths(journal: FormatTransitionJournal): {
  root: string
  from: string
  to: string
  parked: string
  staged: string
} {
  const paths = formatTransitionPaths(journal)
  for (const path of [
    paths.from,
    paths.to,
    paths.parked,
    paths.staged,
    durableFileTemporaryPath(paths.staged),
  ]) {
    assertSafeWorkspacePath(path)
  }
  return paths
}

function matchesFingerprint(
  path: string,
  fingerprint: { size: number; sha256: string }
): boolean {
  const actual = fingerprintOptionalRegularFile(path)
  return Boolean(
    actual &&
    actual.size === fingerprint.size &&
    actual.sha256 === fingerprint.sha256
  )
}

function renameSourceParkingPaths(journal: ExactRenameJournal): {
  root: string
  from: string
  to: string
  parked: string
} {
  const paths = sourcePaths(journal)
  const parked = resolve(
    paths.root,
    ".worktable-lifecycle-moves",
    journal.operationId,
    "source"
  )
  assertSafeContainedPath(paths.root, parked)
  return { ...paths, parked }
}

function fingerprintOptionalRenameSource(
  journal: ExactRenameJournal,
  path: string
): DeleteSourceFingerprint | null {
  return fingerprintOptionalDeleteSource(journal.from.source, path)
}

function widgetIdentityAt(path: string): {
  present: boolean
  id: string | null
} {
  const bytes = readOptionalRegularFile(
    join(path, "widget.yaml"),
    ARTIFACT_MAX_BYTES
  )
  if (!bytes) return { present: false, id: null }
  try {
    const parsed = WidgetFileSchema.safeParse(
      parseCanonicalYaml(bytes.toString("utf8"))
    )
    return { present: true, id: parsed.success ? parsed.data.id : null }
  } catch {
    return { present: true, id: null }
  }
}

type ExactRenameSourceState =
  | "before"
  | "parked"
  | "intermediate"
  | "after"
  | "conflict"

function classifySource(journal: ExactRenameJournal): ExactRenameSourceState {
  const behavior = exactRenameBehavior(journal)
  if (behavior.parksBundleSource) {
    const paths = renameSourceParkingPaths(journal)
    const from = fingerprintOptionalRenameSource(journal, paths.from)
    const parked = fingerprintOptionalRenameSource(journal, paths.parked)
    const toIdentity = widgetIdentityAt(paths.to)
    const sourceContainsTarget = paths.to.startsWith(`${paths.from}${sep}`)
    const targetContainsSource = paths.from.startsWith(`${paths.to}${sep}`)
    const fromIdentity = widgetIdentityAt(paths.from)
    if (sourceContainsTarget && !parked && toIdentity.present) {
      if (fromIdentity.present) return "conflict"
      if (toIdentity.id === journal.from.logicalPath) return "intermediate"
      if (toIdentity.id === journal.to.logicalPath) return "after"
      return "conflict"
    }
    if (from && !parked) {
      const independentTarget =
        !sourceContainsTarget && !targetContainsSource && toIdentity.present
      return fromIdentity.id === journal.from.logicalPath && !independentTarget
        ? "before"
        : "conflict"
    }
    if (!from && parked) {
      const targetIsExpectedAncestor =
        targetContainsSource && !toIdentity.present
      const targetVacant = !hasFilesystemEntry(paths.to)
      if (!targetVacant && !targetIsExpectedAncestor) return "conflict"
      return widgetIdentityAt(paths.parked).id === journal.from.logicalPath
        ? "parked"
        : "conflict"
    }
    if (!from && !parked && toIdentity.present) {
      if (toIdentity.id === journal.from.logicalPath) return "intermediate"
      if (toIdentity.id === journal.to.logicalPath) return "after"
    }
    return "conflict"
  }

  const paths = sourcePaths(journal)
  const from = fingerprintOptionalRegularFile(paths.from)
  const to = fingerprintOptionalRegularFile(paths.to)
  // The unique endpoint owns the document. Content may legitimately change
  // through an external editor while this local-first transaction is in
  // flight; the journal hash is diagnostic, not authority to discard that
  // edit or strand recovery.
  if (from && !to) return "before"
  if (
    !from &&
    to &&
    (journal.completed.includes("source") ||
      (to.size === journal.document.sourceSize &&
        to.sha256 === journal.document.sourceSha256))
  ) {
    return "after"
  }
  return "conflict"
}

function publishFormatTarget(
  journal: FormatTransitionJournal,
  bytes: Buffer
): void {
  if (
    bytes.byteLength !== journal.document.targetSize ||
    sha256(bytes) !== journal.document.targetSha256
  ) {
    throw new Error("document format target bytes changed after preparation")
  }
  let paths = verifiedFormatTransitionPaths(journal)
  if (
    fingerprintOptionalRegularFile(paths.to) ||
    fingerprintOptionalRegularFile(paths.staged)
  ) {
    throw new Error("document format target is already occupied")
  }
  writeDurableFile(paths.staged, bytes, 0o666, () => {
    paths = verifiedFormatTransitionPaths(journal)
  })
  paths = verifiedFormatTransitionPaths(journal)
  // A hard link is the only portable primitive available here that publishes
  // the complete staged bytes without replacing an existing endpoint. If the
  // filesystem cannot provide it, compensation preserves the original doc.
  linkSync(paths.staged, paths.to)
  paths = verifiedFormatTransitionPaths(journal)
  fsyncRegularFile(paths.to)
  fsyncDirectory(dirname(paths.to))
  if (
    !matchesFingerprint(paths.to, {
      size: journal.document.targetSize,
      sha256: journal.document.targetSha256,
    })
  ) {
    throw new Error("document format target did not reach its checkpoint")
  }
  paths = verifiedFormatTransitionPaths(journal)
  removeDurably(paths.staged)
}

function parkFormatSource(journal: FormatTransitionJournal): void {
  let paths = verifiedFormatTransitionPaths(journal)
  if (
    !matchesFingerprint(paths.from, {
      size: journal.document.sourceSize,
      sha256: journal.document.sourceSha256,
    }) ||
    fingerprintOptionalRegularFile(paths.parked)
  ) {
    throw new Error("document format source changed before it was parked")
  }
  paths = verifiedFormatTransitionPaths(journal)
  renameSync(paths.from, paths.parked)
  fsyncRenameParents(paths.from, paths.parked)
  if (
    !matchesFingerprint(paths.parked, {
      size: journal.document.sourceSize,
      sha256: journal.document.sourceSha256,
    })
  ) {
    throw new Error("document format source changed while it was parked")
  }
}

function compensateFormatSource(journal: FormatTransitionJournal): void {
  let paths = verifiedFormatTransitionPaths(journal)
  const stagedTemporary = durableFileTemporaryPath(paths.staged)
  if (existsSync(stagedTemporary)) removeDurably(stagedTemporary)
  const targetFingerprint = {
    size: journal.document.targetSize,
    sha256: journal.document.targetSha256,
  }
  const target = fingerprintOptionalRegularFile(paths.to)
  const staged = fingerprintOptionalRegularFile(paths.staged)
  if (target && !matchesFingerprint(paths.to, targetFingerprint)) {
    throw new Error(
      "document format target changed before compensation completed"
    )
  }
  if (staged && !matchesFingerprint(paths.staged, targetFingerprint)) {
    throw new Error(
      "document format target changed before compensation completed"
    )
  }
  const from = fingerprintOptionalRegularFile(paths.from)
  const parked = fingerprintOptionalRegularFile(paths.parked)
  if (
    (from &&
      !matchesFingerprint(paths.from, {
        size: journal.document.sourceSize,
        sha256: journal.document.sourceSha256,
      })) ||
    (parked &&
      !matchesFingerprint(paths.parked, {
        size: journal.document.sourceSize,
        sha256: journal.document.sourceSha256,
      })) ||
    (from && parked)
  ) {
    throw new Error("document format source ownership is ambiguous")
  }
  if (!from && parked) {
    paths = verifiedFormatTransitionPaths(journal)
    renameSync(paths.parked, paths.from)
    fsyncRenameParents(paths.parked, paths.from)
  } else if (!from && !parked) {
    throw new Error("document format source is missing during compensation")
  }
  paths = verifiedFormatTransitionPaths(journal)
  if (target && fingerprintOptionalRegularFile(paths.to)) {
    if (!matchesFingerprint(paths.to, targetFingerprint)) {
      throw new Error(
        "document format target changed before compensation completed"
      )
    }
    removeDurably(paths.to)
  }
  if (fingerprintOptionalRegularFile(paths.staged)) {
    if (!matchesFingerprint(paths.staged, targetFingerprint)) {
      throw new Error(
        "document format target changed before compensation completed"
      )
    }
    removeDurably(paths.staged)
  }
}

function finishFormatSourceForward(journal: FormatTransitionJournal): void {
  let paths = verifiedFormatTransitionPaths(journal)
  const stagedTemporary = durableFileTemporaryPath(paths.staged)
  if (existsSync(stagedTemporary)) removeDurably(stagedTemporary)
  if (!fingerprintOptionalRegularFile(paths.to)) {
    throw new Error("committed document format target is missing")
  }
  if (fingerprintOptionalRegularFile(paths.staged)) {
    if (
      !matchesFingerprint(paths.staged, {
        size: journal.document.targetSize,
        sha256: journal.document.targetSha256,
      })
    ) {
      throw new Error("document format staging state is ambiguous")
    }
    paths = verifiedFormatTransitionPaths(journal)
    removeDurably(paths.staged)
  }
  const from = fingerprintOptionalRegularFile(paths.from)
  const parked = fingerprintOptionalRegularFile(paths.parked)
  if (from) {
    throw new Error("document format source ownership is ambiguous")
  }
  if (
    !parked ||
    !matchesFingerprint(paths.parked, {
      size: journal.document.sourceSize,
      sha256: journal.document.sourceSha256,
    })
  ) {
    throw new Error("parked document format source changed")
  }
}

function rewriteWidgetSourceIdentity(
  journal: ExactRenameJournal,
  path: string,
  desiredId: string
): void {
  if (!journal.document.sourceIdentity) {
    throw new Error("HTML document identity plan is missing")
  }
  const metadataPath = join(path, journal.document.sourceIdentity.relativePath)
  const temporaryPath = `${metadataPath}.worktable-${journal.operationId}.tmp`
  const bytes = readOptionalRegularFile(metadataPath, ARTIFACT_MAX_BYTES)
  if (!bytes) throw new Error("HTML document metadata is missing during move")
  let parsed: unknown
  try {
    parsed = parseCanonicalYaml(bytes.toString("utf8"))
  } catch {
    throw new Error("HTML document metadata changed during move")
  }
  const widget = WidgetFileSchema.safeParse(parsed)
  if (
    !widget.success ||
    ![journal.from.logicalPath, journal.to.logicalPath].includes(widget.data.id)
  ) {
    throw new Error("HTML document identity changed during move")
  }
  if (widget.data.id === desiredId) {
    if (existsSync(temporaryPath)) removeDurably(temporaryPath)
    return
  }
  writeDurableFile(
    metadataPath,
    Buffer.from(
      rewriteYamlTopLevelString(bytes.toString("utf8"), "id", desiredId),
      "utf8"
    ),
    0o666,
    undefined,
    temporaryPath
  )
}

function removeEmptyDirectoriesThrough(start: string, stop: string): void {
  for (let current = start; ; current = dirname(current)) {
    rmdirSync(current)
    fsyncDirectory(dirname(current))
    if (current === stop) return
  }
}

function cleanupRenameParkingDirectories(parked: string): void {
  for (const directory of [dirname(parked), dirname(dirname(parked))]) {
    try {
      rmdirSync(directory)
      fsyncDirectory(dirname(directory))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
        throw error
      }
    }
  }
}

function applyParkedBundleSource(
  journal: ExactRenameJournal,
  direction: "forward" | "compensate"
): void {
  let state = classifySource(journal)
  const paths = renameSourceParkingPaths(journal)
  const sourceContainsTarget = paths.to.startsWith(`${paths.from}${sep}`)
  const targetContainsSource = paths.from.startsWith(`${paths.to}${sep}`)
  if (direction === "forward") {
    if (state === "after") {
      cleanupRenameParkingDirectories(paths.parked)
      return
    }
    if (state === "before") {
      ensureDurableDirectory(dirname(paths.parked), paths.root)
      renameSync(paths.from, paths.parked)
      fsyncRenameParents(paths.from, paths.parked)
      state = classifySource(journal)
    }
    if (state === "parked") {
      if (targetContainsSource) {
        removeEmptyDirectoriesThrough(dirname(paths.from), paths.to)
      }
      ensureDurableDirectory(dirname(paths.to), paths.root)
      renameSync(paths.parked, paths.to)
      fsyncRenameParents(paths.parked, paths.to)
      state = classifySource(journal)
    }
    if (state === "intermediate") {
      rewriteWidgetSourceIdentity(journal, paths.to, journal.to.logicalPath)
      state = classifySource(journal)
    }
    if (state !== "after") {
      throw new Error("document lifecycle source ownership is ambiguous")
    }
    cleanupRenameParkingDirectories(paths.parked)
    return
  }

  if (state === "before") {
    cleanupRenameParkingDirectories(paths.parked)
    return
  }
  if (state === "after" || state === "intermediate") {
    rewriteWidgetSourceIdentity(journal, paths.to, journal.from.logicalPath)
    ensureDurableDirectory(dirname(paths.parked), paths.root)
    renameSync(paths.to, paths.parked)
    fsyncRenameParents(paths.to, paths.parked)
    if (sourceContainsTarget) {
      removeEmptyDirectoriesThrough(dirname(paths.to), paths.from)
    }
    state = classifySource(journal)
  }
  if (state === "parked") {
    ensureDurableDirectory(dirname(paths.from), paths.root)
    renameSync(paths.parked, paths.from)
    fsyncRenameParents(paths.parked, paths.from)
    state = classifySource(journal)
  }
  if (state !== "before") {
    throw new Error("document lifecycle source ownership is ambiguous")
  }
  cleanupRenameParkingDirectories(paths.parked)
}

function applySource(
  journal: ExactRenameJournal,
  direction: "forward" | "compensate"
): void {
  if (exactRenameBehavior(journal).parksBundleSource) {
    applyParkedBundleSource(journal, direction)
    return
  }
  const state = classifySource(journal)
  const desired = direction === "forward" ? "after" : "before"
  if (state === desired) return
  const expected = direction === "forward" ? "before" : "after"
  if (state !== expected) {
    throw new Error("document lifecycle source ownership is ambiguous")
  }
  const paths = sourcePaths(journal)
  const source = direction === "forward" ? paths.from : paths.to
  const target = direction === "forward" ? paths.to : paths.from
  ensureDurableDirectory(dirname(target), paths.root)
  assertSafeContainedPath(paths.root, target)
  renameSync(source, target)
  fsyncRenameParents(source, target)
}

function historyPaths(
  journal: Exclude<DocumentLifecycleJournal, PrefixLifecycleJournal>
): {
  from: string
  to: string
} {
  const kind =
    journal.operationType === "exact-rename"
      ? exactRenameBehavior(journal).historyKind
      : "docs"
  const paths = {
    from: versionKeyDir(journal.from.spaceId, kind, journal.from.logicalPath),
    to: versionKeyDir(journal.to.spaceId, kind, journal.to.logicalPath),
  }
  assertSafeWorkspacePath(resolve(getVersionsDir()))
  assertSafeWorkspacePath(paths.from)
  assertSafeWorkspacePath(paths.to)
  return paths
}

function deleteHistoryPaths(journal: ExactDeleteJournal): {
  active: string
  retired: string
} {
  const kind = exactDeleteBehavior(journal).historyKind
  const active = versionKeyDir(
    journal.from.spaceId,
    kind,
    journal.from.logicalPath
  )
  const retired = retiredVersionGenerationDir(
    journal.from.spaceId,
    kind,
    journal.from.logicalPath,
    journal.operationId
  )
  assertSafeWorkspacePath(resolve(getVersionsDir()))
  assertSafeWorkspacePath(active)
  assertSafeWorkspacePath(retired)
  return { active, retired }
}

function directHistoryPlan(
  journal: ExactRenameJournal | ExactDeleteJournal,
  preparedFiles?: DirectHistoryFile[]
): DirectHistoryFile[] | null {
  return preparedFiles ?? readDirectHistoryManifest(journal)
}

function directHistoryEndpoints(
  journal: ExactRenameJournal | ExactDeleteJournal
): { before: string; after: string } {
  if (journal.operationType === "exact-delete") {
    const paths = deleteHistoryPaths(journal)
    return { before: paths.active, after: paths.retired }
  }
  const paths = historyPaths(journal)
  return { before: paths.from, after: paths.to }
}

function directHistoryState(
  before: { size: number; sha256: string } | null,
  after: { size: number; sha256: string } | null,
  expected: DirectHistoryFile
): "before" | "linked" | "after" | "conflict" {
  if (matchesDirectHistoryFingerprint(before, expected) && !after) {
    return "before"
  }
  if (
    matchesDirectHistoryFingerprint(before, expected) &&
    matchesDirectHistoryFingerprint(after, expected)
  ) {
    return "linked"
  }
  if (!before && matchesDirectHistoryFingerprint(after, expected)) {
    return "after"
  }
  return "conflict"
}

function matchesDirectHistoryFingerprint(
  actual: { size: number; sha256: string } | null,
  expected: DirectHistoryFile
): boolean {
  return actual?.size === expected.size && actual.sha256 === expected.sha256
}

function inspectDirectHistoryFiles(
  path: string
): Map<string, { size: number; sha256: string }> {
  return new Map(
    captureDirectHistoryFiles(path).map(({ name, size, sha256 }) => [
      name,
      { size, sha256 },
    ])
  )
}

function inspectDirectHistoryState(
  journal: ExactRenameJournal | ExactDeleteJournal,
  files: DirectHistoryFile[],
  options?: { allowUnexpectedBefore?: boolean }
): {
  before: Map<string, { size: number; sha256: string }>
  after: Map<string, { size: number; sha256: string }>
} {
  const endpoints = directHistoryEndpoints(journal)
  const before = inspectDirectHistoryFiles(endpoints.before)
  const after = inspectDirectHistoryFiles(endpoints.after)
  const planned = new Set(files.map((file) => file.name))
  if (
    (!options?.allowUnexpectedBefore &&
      ([...before.keys()].some((name) => !planned.has(name)) ||
        files.some(
          (file) =>
            !before.has(file.name) &&
            hasFilesystemEntry(join(endpoints.before, file.name))
        ))) ||
    [...after.keys()].some((name) => !planned.has(name)) ||
    files.some(
      (file) =>
        !after.has(file.name) &&
        hasFilesystemEntry(join(endpoints.after, file.name))
    )
  ) {
    throw new Error(
      "document lifecycle history contains an unexpected snapshot"
    )
  }
  return { before, after }
}

function classifyDirectHistory(
  journal: ExactRenameJournal | ExactDeleteJournal,
  files: DirectHistoryFile[]
): "before" | "after" | "conflict" {
  const committedDelete =
    journal.operationType === "exact-delete" && journal.phase === "committed"
  const state = inspectDirectHistoryState(journal, files, {
    allowUnexpectedBefore: committedDelete,
  })
  if (files.length === 0) return "before"
  if (
    committedDelete &&
    files.every((file) =>
      matchesDirectHistoryFingerprint(state.after.get(file.name) ?? null, file)
    )
  ) {
    return "after"
  }
  const states = files.map((file) =>
    directHistoryState(
      state.before.get(file.name) ?? null,
      state.after.get(file.name) ?? null,
      file
    )
  )
  if (states.every((value) => value === "before")) return "before"
  if (states.every((value) => value === "after")) return "after"
  return "conflict"
}

function pruneEmptyHistoryDirectory(path: string): void {
  try {
    rmdirSync(path)
    fsyncDirectory(dirname(path))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      throw error
    }
  }
}

function applyDirectHistory(
  journal: ExactRenameJournal | ExactDeleteJournal,
  files: DirectHistoryFile[],
  direction: "forward" | "compensate"
): void {
  const endpoints = directHistoryEndpoints(journal)
  const committedDelete =
    direction === "forward" &&
    journal.operationType === "exact-delete" &&
    journal.phase === "committed"
  const state = inspectDirectHistoryState(journal, files, {
    allowUnexpectedBefore: committedDelete,
  })
  for (const file of files) {
    if (
      committedDelete &&
      matchesDirectHistoryFingerprint(state.after.get(file.name) ?? null, file)
    ) {
      continue
    }
    const current = directHistoryState(
      state.before.get(file.name) ?? null,
      state.after.get(file.name) ?? null,
      file
    )
    const desired = direction === "forward" ? "after" : "before"
    if (current === desired) continue
    const linked = current === "linked"
    const expected = direction === "forward" ? "before" : "after"
    if (current !== expected && !linked) {
      throw new Error("document lifecycle history ownership is ambiguous")
    }

    const sourceDirectory =
      direction === "forward" ? endpoints.before : endpoints.after
    const targetDirectory =
      direction === "forward" ? endpoints.after : endpoints.before
    const source = join(sourceDirectory, file.name)
    const target = join(targetDirectory, file.name)
    if (!linked) {
      ensureDurableDirectory(targetDirectory, getWorkspaceRoot())
      let renamed = false
      try {
        linkSync(source, target)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (
          !["EMLINK", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(
            code ?? ""
          )
        ) {
          throw error
        }
        try {
          lstatSync(target)
          throw new Error("document lifecycle history ownership is ambiguous")
        } catch (targetError) {
          if (!isMissing(targetError)) throw targetError
        }
        renameSync(source, target)
        renamed = true
      }
      fsyncRegularFile(target)
      if (renamed) fsyncRenameParents(source, target)
      else fsyncDirectory(targetDirectory)
      if (
        !matchesDirectHistoryFingerprint(
          fingerprintOptionalRegularFile(target),
          file
        )
      ) {
        throw new Error(
          "document lifecycle history copy did not reach its checkpoint"
        )
      }
    }
    removeDurably(source)
    const hookResult = stepHookForTests?.("history-file-moved")
    if (hookResult instanceof Promise) {
      throw new Error("history-file-moved test hook must be synchronous")
    }
  }
  pruneEmptyHistoryDirectory(
    direction === "forward" ? endpoints.before : endpoints.after
  )
}

function classifyHistory(
  journal: Exclude<DocumentLifecycleJournal, PrefixLifecycleJournal>,
  preparedFiles?: DirectHistoryFile[]
): "before" | "after" | "conflict" {
  if (journal.operationType === "format-transition") return "before"
  const directPlan = directHistoryPlan(journal, preparedFiles)
  if (directPlan) return classifyDirectHistory(journal, directPlan)
  if (journal.operationType === "exact-delete") {
    const paths = deleteHistoryPaths(journal)
    const active = existsSync(paths.active)
    const retired = existsSync(paths.retired)
    if (active) requireRealDirectory(paths.active, "Document history")
    if (retired) requireRealDirectory(paths.retired, "Retired document history")
    if (journal.document.history === "absent") {
      return !active && !retired ? "before" : "conflict"
    }
    if (active && !retired) return "before"
    if (!active && retired) return "after"
    if (journal.phase === "committed" && retired) return "after"
    return "conflict"
  }
  const paths = historyPaths(journal)
  const from = existsSync(paths.from)
  const to = existsSync(paths.to)
  if (from) requireRealDirectory(paths.from, "Document history")
  if (to) requireRealDirectory(paths.to, "Document history")
  if (journal.document.history === "absent") {
    return !from && !to ? "before" : "conflict"
  }
  if (from && !to) return "before"
  if (!from && to) return "after"
  return "conflict"
}

function applyHistory(
  journal: Exclude<DocumentLifecycleJournal, PrefixLifecycleJournal>,
  direction: "forward" | "compensate"
): void {
  if (journal.operationType === "format-transition") return
  const directPlan = directHistoryPlan(journal)
  if (directPlan) {
    applyDirectHistory(journal, directPlan, direction)
    return
  }
  if (journal.operationType === "exact-delete") {
    if (journal.document.history === "absent") {
      if (classifyHistory(journal) === "conflict") {
        throw new Error("document deletion history state is ambiguous")
      }
      return
    }
    const state = classifyHistory(journal)
    const desired = direction === "forward" ? "after" : "before"
    if (state === desired) return
    const expected = direction === "forward" ? "before" : "after"
    if (state !== expected) {
      throw new Error("document deletion history ownership is ambiguous")
    }
    const paths = deleteHistoryPaths(journal)
    const source = direction === "forward" ? paths.active : paths.retired
    const target = direction === "forward" ? paths.retired : paths.active
    ensureDurableDirectory(dirname(target), getWorkspaceRoot())
    renameSync(source, target)
    fsyncRenameParents(source, target)
    return
  }
  if (journal.document.history === "absent") {
    if (classifyHistory(journal) === "conflict") {
      throw new Error("document lifecycle history state is ambiguous")
    }
    return
  }
  const state = classifyHistory(journal)
  const desired = direction === "forward" ? "after" : "before"
  if (state === desired) return
  const expected = direction === "forward" ? "before" : "after"
  if (state !== expected) {
    throw new Error("document lifecycle history ownership is ambiguous")
  }
  const paths = historyPaths(journal)
  const source = direction === "forward" ? paths.from : paths.to
  const target = direction === "forward" ? paths.to : paths.from
  ensureDurableDirectory(dirname(target), getWorkspaceRoot())
  renameSync(source, target)
  fsyncRenameParents(source, target)
}

type AnnotationMovePlan = Pick<
  ExactRenameJournal,
  "document" | "from" | "to" | "annotation"
>

function annotationPaths(journal: AnnotationMovePlan): {
  root: string
  from: string
  to: string
} {
  const root = resolve(getSpacesBaseDir(), journal.from.spaceId)
  assertSafeWorkspacePath(root)
  requireRealDirectory(root, `Space ${journal.from.spaceId}`)
  const annotationDirectory =
    exactRenameBehavior(journal).annotationKind === "doc" ? "docs" : "widgets"
  const from = resolve(
    root,
    "annotations",
    annotationDirectory,
    `${journal.from.logicalPath}.annotations.json`
  )
  const to = resolve(
    root,
    "annotations",
    annotationDirectory,
    `${journal.to.logicalPath}.annotations.json`
  )
  assertSafeContainedPath(root, from)
  assertSafeContainedPath(root, to)
  return { root, from, to }
}

function classifyAnnotation(
  journal: AnnotationMovePlan
): "before" | "intermediate" | "after" | "conflict" {
  if (!journal.annotation) {
    throw new Error("document lifecycle annotation plan is missing")
  }
  const paths = annotationPaths(journal)
  const from = readOptionalRegularFile(paths.from, ARTIFACT_MAX_BYTES)
  const to = readOptionalRegularFile(paths.to, ARTIFACT_MAX_BYTES)
  const before = journal.annotation.before
  const after = journal.annotation.after
  const matches = (bytes: Buffer | null, ref: BlobRef): boolean =>
    Boolean(
      bytes && bytes.byteLength === ref.size && sha256(bytes) === ref.sha256
    )
  const beforeState = matches(from, before) && !to
  const intermediateState = !from && matches(to, before)
  const afterState = !from && matches(to, after)
  if (beforeState) return "before"
  if (intermediateState) return "intermediate"
  if (afterState) return "after"
  return "conflict"
}

function moveAnnotationForward(journal: AnnotationMovePlan): boolean {
  if (!journal.annotation) return false
  const state = classifyAnnotation(journal)
  if (state === "after" || state === "intermediate") return false
  if (state !== "before") {
    throw new Error("document lifecycle annotation state is ambiguous")
  }
  const paths = annotationPaths(journal)
  ensureDurableDirectory(dirname(paths.to), paths.root)
  renameSync(paths.from, paths.to)
  fsyncRenameParents(paths.from, paths.to)
  return true
}

function finishAnnotationForward(
  journal: AnnotationMovePlan,
  artifactRole = "annotation"
): void {
  if (!journal.annotation) return
  const state = classifyAnnotation(journal)
  if (state === "after") return
  if (state !== "intermediate") {
    throw new Error("document lifecycle annotation state is ambiguous")
  }
  const paths = annotationPaths(journal)
  writeDurableFile(
    paths.to,
    artifactBytes(artifactRole, "after", journal.annotation.after)
  )
}

function applyAnnotation(
  journal: AnnotationMovePlan,
  direction: "forward" | "compensate",
  artifactRole = "annotation"
): void {
  if (!journal.annotation) return
  if (direction === "forward") {
    moveAnnotationForward(journal)
    finishAnnotationForward(journal)
    return
  }
  const state = classifyAnnotation(journal)
  if (state === "before") return
  const paths = annotationPaths(journal)
  if (state === "after") {
    writeDurableFile(
      paths.to,
      artifactBytes(artifactRole, "before", journal.annotation.before)
    )
  } else if (state !== "intermediate") {
    throw new Error("document lifecycle annotation state is ambiguous")
  }
  ensureDurableDirectory(dirname(paths.from), paths.root)
  renameSync(paths.to, paths.from)
  fsyncRenameParents(paths.to, paths.from)
}

function prefixEntryAsExactRename(
  journal: PrefixRenameJournal,
  entry: PrefixRenameDocument,
  targetOwned: boolean
): ExactRenameJournal {
  return {
    schemaVersion: journal.schemaVersion,
    planVersion: journal.planVersion,
    operationType: "exact-rename",
    operationId: journal.operationId,
    createdAt: journal.createdAt,
    phase: journal.phase,
    workspace: journal.workspace,
    document: entry.document,
    from: entry.from,
    to: entry.to,
    edits: [],
    annotation: entry.annotation,
    completed: targetOwned ? ["source"] : [],
  }
}

function applyPrefixDocument(
  journal: PrefixRenameJournal,
  index: number,
  direction: "forward" | "compensate",
  targetOwned: boolean
): boolean {
  const entry = journal.documents[index]
  if (!entry) {
    throw new Error("document folder lifecycle cursor is invalid")
  }
  const exact = prefixEntryAsExactRename(journal, entry, targetOwned)
  const historyFiles = readPrefixHistoryManifest(journal, index)
  if (direction === "forward") {
    applyDirectHistory(exact, historyFiles, direction)
    applySource(exact, direction)
    const annotationMoved = moveAnnotationForward(entry)
    finishAnnotationForward(entry, `annotation-${index}`)
    return annotationMoved
  }
  applyAnnotation(entry, direction, `annotation-${index}`)
  applySource(exact, direction)
  applyDirectHistory(exact, historyFiles, direction)
  return false
}

function applyPrefixDocumentsRecovery(
  journal: PrefixRenameJournal,
  direction: "forward" | "compensate"
): void {
  if (direction === "forward") {
    if (
      journal.phase !== "committed" ||
      journal.completedDocuments !== journal.documents.length
    ) {
      throw new Error("document folder lifecycle commit is incomplete")
    }
    return
  }
  if (journal.completedDocuments < journal.documents.length) {
    // The cursor is persisted after the member move, so this destination can
    // already be operation-owned even though the member is not checkpointed.
    applyPrefixDocument(journal, journal.completedDocuments, "compensate", true)
  }
  for (let index = journal.completedDocuments - 1; index >= 0; index -= 1) {
    applyPrefixDocument(journal, index, "compensate", true)
  }
}

function prefixDeleteAnnotationPath(
  journal: PrefixDeleteJournal,
  entry: PrefixDeleteDocument
): string {
  const root = resolve(getSpacesBaseDir(), journal.from.spaceId)
  assertSafeWorkspacePath(root)
  requireRealDirectory(root, `Space ${journal.from.spaceId}`)
  const path = resolve(
    root,
    "annotations",
    prefixDeleteBehavior(entry).reconciliationKind === "widget"
      ? "widgets"
      : "docs",
    `${entry.at.logicalPath}.annotations.json`
  )
  assertSafeContainedPath(root, path)
  return path
}

function classifyPrefixDeleteAnnotation(
  journal: PrefixDeleteJournal,
  entry: PrefixDeleteDocument
): "before" | "after" | "conflict" {
  const path = prefixDeleteAnnotationPath(journal, entry)
  const bytes = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
  if (!entry.annotation) return bytes ? "conflict" : "before"
  if (!bytes) return "after"
  return bytes.byteLength === entry.annotation.size &&
    sha256(bytes) === entry.annotation.sha256
    ? "before"
    : "conflict"
}

function applyPrefixDeleteAnnotation(
  journal: PrefixDeleteJournal,
  entry: PrefixDeleteDocument,
  index: number,
  direction: "forward" | "compensate"
): void {
  if (!entry.annotation) return
  const state = classifyPrefixDeleteAnnotation(journal, entry)
  const desired = direction === "forward" ? "after" : "before"
  if (state === desired) return
  const expected = direction === "forward" ? "before" : "after"
  if (state !== expected) {
    throw new Error("document deletion annotation state is ambiguous")
  }
  const path = prefixDeleteAnnotationPath(journal, entry)
  if (direction === "forward") removeDurably(path)
  else {
    writeDurableFile(
      path,
      artifactBytes(`delete-annotation-${index}`, "before", entry.annotation)
    )
  }
}

function applyPrefixDeleteDocument(
  journal: PrefixDeleteJournal,
  index: number,
  direction: "forward" | "compensate"
): void {
  const entry = journal.documents[index]
  if (!entry) throw new Error("document deletion lifecycle cursor is invalid")
  const exact = prefixEntryAsExactDelete(journal, entry, index)
  const history = readPrefixDeleteHistoryManifest(journal, index)
  if (direction === "forward") {
    if (history) applyDirectHistory(exact, history, direction)
    else applyHistory(exact, direction)
    applyDeleteSource(exact, direction, prefixDeleteQuarantineLeaf(index))
    applyPrefixDeleteAnnotation(journal, entry, index, direction)
    return
  }
  applyPrefixDeleteAnnotation(journal, entry, index, direction)
  applyDeleteSource(exact, direction, prefixDeleteQuarantineLeaf(index))
  if (history) applyDirectHistory(exact, history, direction)
  else applyHistory(exact, direction)
}

function applyPrefixDeleteRecovery(
  journal: PrefixDeleteJournal,
  direction: "forward" | "compensate"
): void {
  if (direction === "forward") {
    if (
      journal.phase !== "committed" ||
      journal.completedDocuments !== journal.documents.length
    ) {
      throw new Error("document deletion lifecycle commit is incomplete")
    }
    for (let index = 0; index < journal.documents.length; index += 1) {
      applyPrefixDeleteDocument(journal, index, direction)
    }
    return
  }
  if (journal.completedDocuments < journal.documents.length) {
    applyPrefixDeleteDocument(journal, journal.completedDocuments, direction)
  }
  for (let index = journal.completedDocuments - 1; index >= 0; index -= 1) {
    applyPrefixDeleteDocument(journal, index, direction)
  }
}

function prefixArchiveState(
  entry: PrefixArchiveDocument,
  index: number,
  side: ArtifactSide,
  preparedBlobs?: ReadonlyMap<string, Buffer>,
  artifactDirectory?: string
): ArchiveFieldState {
  const ref = side === "before" ? entry.archive.before : entry.archive.after
  const prepared = preparedBlobs?.get(`archive-field-${index}:${side}`)
  return parseArchiveFieldState(
    entry.archiveAdapter,
    prepared ??
      artifactBytes(`archive-field-${index}`, side, ref, artifactDirectory)
  )
}

function prefixArchiveMutationPath(
  journal: PrefixArchiveJournal,
  mutation: PrefixArchiveMutation
): string {
  const root = resolve(getSpacesBaseDir(), journal.from.spaceId)
  assertSafeWorkspacePath(root)
  requireRealDirectory(root, `Space ${journal.from.spaceId}`)
  const path = resolve(root, archiveMutationRelativePath(journal, mutation))
  assertSafeContainedPath(root, path)
  return path
}

function applyPrefixArchiveMutation(
  journal: PrefixArchiveJournal,
  mutationIndex: number,
  direction: "forward" | "compensate"
): void {
  const mutation = journal.mutations[mutationIndex]
  if (!mutation) throw new Error("document archive mutation cursor is invalid")
  const entries = mutation.documentIndexes.map((index) => {
    const entry = journal.documents[index]
    if (!entry) throw new Error("document archive mutation index is invalid")
    return { entry, index }
  })
  const path = prefixArchiveMutationPath(journal, mutation)
  const currentBytes = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
  const currentStates = readArchiveFieldStates(
    mutation.archiveAdapter,
    currentBytes,
    entries.map(({ entry }) => entry.at.logicalPath)
  )
  const updates: Array<{ logicalPath: string; state: ArchiveFieldState }> = []
  const desiredStates: ArchiveFieldState[] = []
  for (const [offset, { entry, index }] of entries.entries()) {
    const before = prefixArchiveState(entry, index, "before")
    const after = prefixArchiveState(entry, index, "after")
    const expected = direction === "forward" ? before : after
    const desired = direction === "forward" ? after : before
    const current = currentStates[offset]!
    desiredStates.push(desired)
    if (archiveFieldStatesEqual(current, desired)) continue
    if (!archiveFieldStatesEqual(current, expected)) {
      throw new Error("document archive metadata changed during lifecycle")
    }
    updates.push({ logicalPath: entry.at.logicalPath, state: desired })
  }
  if (updates.length > 0) {
    const rewritten = rewriteArchiveFieldStates(
      mutation.archiveAdapter,
      currentBytes,
      updates
    )
    const validateCurrentMetadata = (): void => {
      const hookResult = stepHookForTests?.(
        "archive-before-metadata-publication"
      )
      if (hookResult instanceof Promise) {
        throw new Error(
          "archive-before-metadata-publication test hook must be synchronous"
        )
      }
      const latest = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
      if (!optionalBytesEqual(latest, currentBytes)) {
        throw new Error("document archive metadata changed before publication")
      }
    }
    if (rewritten) {
      writeDurableFile(path, rewritten, 0o666, validateCurrentMetadata)
    } else if (currentBytes) {
      validateCurrentMetadata()
      removeDurably(path)
    }
  }
  const verifiedBytes = readOptionalRegularFile(path, ARTIFACT_MAX_BYTES)
  const verifiedStates = readArchiveFieldStates(
    mutation.archiveAdapter,
    verifiedBytes,
    entries.map(({ entry }) => entry.at.logicalPath)
  )
  if (
    verifiedStates.some(
      (state, index) => !archiveFieldStatesEqual(state, desiredStates[index]!)
    )
  ) {
    throw new Error("document archive metadata did not reach its checkpoint")
  }
}

function applyPrefixArchiveRecovery(
  journal: PrefixArchiveJournal,
  direction: "forward" | "compensate"
): void {
  if (direction === "forward") {
    for (let index = 0; index < journal.mutations.length; index += 1) {
      applyPrefixArchiveMutation(journal, index, direction)
    }
    return
  }
  if (journal.completedMutations < journal.mutations.length) {
    // The metadata write is durable before its cursor is fsynced. This member
    // may therefore be operation-owned even though it is not checkpointed.
    applyPrefixArchiveMutation(journal, journal.completedMutations, direction)
  }
  for (let index = journal.completedMutations - 1; index >= 0; index -= 1) {
    applyPrefixArchiveMutation(journal, index, direction)
  }
}

function orderedEdits(
  journal: DocumentLifecycleJournal,
  direction: "forward" | "compensate"
): ArtifactEdit[] {
  const sorted = [...journal.edits].sort(
    (a, b) =>
      SIMPLE_ARTIFACT_ORDER.indexOf(a.role) -
      SIMPLE_ARTIFACT_ORDER.indexOf(b.role)
  )
  return direction === "forward" ? sorted : sorted.reverse()
}

function journalStepForRole(role: SimpleArtifactRole): DurableStep {
  return role
}

function markCompleted(
  journal: DocumentLifecycleJournal,
  step: DurableStep
): void {
  if (!journal.completed.includes(step)) journal.completed.push(step)
  writeJournal(journal)
}

async function applyPortableRuntime(
  journal: DocumentLifecycleJournal,
  targetBytes?: Buffer
): Promise<void> {
  if (journal.operationType === "prefix-archive") {
    for (
      let index = journal.completedMutations;
      index < journal.mutations.length;
      index += 1
    ) {
      applyPrefixArchiveMutation(journal, index, "forward")
      await stepHookForTests?.("archive-mutation-written")
      journal.completedMutations = index + 1
      writeJournal(journal)
    }
    markCompleted(journal, "archive-state")
    await stepHookForTests?.("archive-state")
    return
  }
  if (journal.operationType === "format-transition") {
    if (!targetBytes) {
      throw new Error("document format target bytes are unavailable")
    }
    publishFormatTarget(journal, targetBytes)
    await stepHookForTests?.("target-published")
    markCompleted(journal, "target")
    await stepHookForTests?.("target")

    parkFormatSource(journal)
    await stepHookForTests?.("source-moved")
    markCompleted(journal, "source")
    await stepHookForTests?.("source")

    for (const edit of orderedEdits(journal, "forward")) {
      applySimpleEdit(journal, edit, "forward")
      const step = journalStepForRole(edit.role)
      markCompleted(journal, step)
      await stepHookForTests?.(step)
    }
    return
  }
  if (journal.operationType === "exact-delete") {
    applyHistory(journal, "forward")
    markCompleted(journal, "history")
    await stepHookForTests?.("history")

    applyDeleteSource(journal, "forward")
    if (journal.document.sourceState !== "absent") {
      await stepHookForTests?.("source-moved")
      markCompleted(journal, "source")
      await stepHookForTests?.("source")
    }

    for (const edit of orderedEdits(journal, "forward")) {
      applySimpleEdit(journal, edit, "forward")
      const step = journalStepForRole(edit.role)
      markCompleted(journal, step)
      await stepHookForTests?.(step)
    }
    return
  }
  if (journal.operationType === "prefix-rename") {
    for (
      let index = journal.completedDocuments;
      index < journal.documents.length;
      index += 1
    ) {
      const annotationMoved = applyPrefixDocument(
        journal,
        index,
        "forward",
        false
      )
      await stepHookForTests?.("source-moved")
      if (annotationMoved) await stepHookForTests?.("annotation-moved")
      journal.completedDocuments = index + 1
      writeJournal(journal)
    }
    markCompleted(journal, "source")
    await stepHookForTests?.("source")
    for (const edit of orderedEdits(journal, "forward")) {
      applySimpleEdit(journal, edit, "forward")
      const step = journalStepForRole(edit.role)
      markCompleted(journal, step)
      await stepHookForTests?.(step)
    }
    return
  }
  if (journal.operationType === "prefix-delete") {
    for (
      let index = journal.completedDocuments;
      index < journal.documents.length;
      index += 1
    ) {
      applyPrefixDeleteDocument(journal, index, "forward")
      await stepHookForTests?.("source-moved")
      journal.completedDocuments = index + 1
      writeJournal(journal)
    }
    markCompleted(journal, "source")
    await stepHookForTests?.("source")
    for (const edit of orderedEdits(journal, "forward")) {
      applySimpleEdit(journal, edit, "forward")
      const step = journalStepForRole(edit.role)
      markCompleted(journal, step)
      await stepHookForTests?.(step)
    }
    return
  }
  applyHistory(journal, "forward")
  markCompleted(journal, "history")
  await stepHookForTests?.("history")

  applySource(journal, "forward")
  await stepHookForTests?.("source-moved")
  markCompleted(journal, "source")
  await stepHookForTests?.("source")

  for (const edit of orderedEdits(journal, "forward")) {
    if (edit.role === "aliases") {
      const moved = moveAnnotationForward(journal)
      if (moved) await stepHookForTests?.("annotation-moved")
      finishAnnotationForward(journal)
      markCompleted(journal, "annotation")
      await stepHookForTests?.("annotation")
    }
    applySimpleEdit(journal, edit, "forward")
    const step = journalStepForRole(edit.role)
    markCompleted(journal, step)
    await stepHookForTests?.(step)
  }
}

function applyPortableRecovery(
  journal: DocumentLifecycleJournal,
  direction: "forward" | "compensate"
): void {
  if (journal.operationType === "prefix-archive") {
    applyPrefixArchiveRecovery(journal, direction)
    return
  }
  if (direction === "forward") {
    if (journal.operationType === "format-transition") {
      finishFormatSourceForward(journal)
      for (const edit of orderedEdits(journal, direction)) {
        applySimpleEdit(journal, edit, direction)
      }
      return
    }
    if (journal.operationType === "exact-delete") {
      applyHistory(journal, direction)
      applyDeleteSource(journal, direction)
      for (const edit of orderedEdits(journal, direction)) {
        applySimpleEdit(journal, edit, direction)
      }
      return
    }
    if (journal.operationType === "prefix-rename") {
      applyPrefixDocumentsRecovery(journal, direction)
      for (const edit of orderedEdits(journal, direction)) {
        applySimpleEdit(journal, edit, direction)
      }
      return
    }
    if (journal.operationType === "prefix-delete") {
      applyPrefixDeleteRecovery(journal, direction)
      for (const edit of orderedEdits(journal, direction)) {
        applySimpleEdit(journal, edit, direction)
      }
      return
    }
    applyHistory(journal, direction)
    applySource(journal, direction)
    for (const edit of orderedEdits(journal, direction)) {
      if (edit.role === "aliases") applyAnnotation(journal, direction)
      applySimpleEdit(journal, edit, direction)
    }
    return
  }
  if (journal.operationType === "format-transition") {
    // Metadata can be restored without discarding either content endpoint.
    // Only after that succeeds do we restore the parked original and remove
    // an exact, transaction-authored target.
    for (const edit of orderedEdits(journal, direction)) {
      applySimpleEdit(journal, edit, direction)
    }
    compensateFormatSource(journal)
    return
  }
  if (journal.operationType === "exact-delete") {
    for (const edit of orderedEdits(journal, direction)) {
      applySimpleEdit(journal, edit, direction)
    }
    applyDeleteSource(journal, direction)
    applyHistory(journal, direction)
    return
  }
  if (journal.operationType === "prefix-rename") {
    for (const edit of orderedEdits(journal, direction)) {
      applySimpleEdit(journal, edit, direction)
    }
    applyPrefixDocumentsRecovery(journal, direction)
    return
  }
  if (journal.operationType === "prefix-delete") {
    for (const edit of orderedEdits(journal, direction)) {
      applySimpleEdit(journal, edit, direction)
    }
    applyPrefixDeleteRecovery(journal, direction)
    return
  }
  for (const edit of orderedEdits(journal, direction)) {
    applySimpleEdit(journal, edit, direction)
    if (edit.role === "aliases") applyAnnotation(journal, direction)
  }
  applySource(journal, direction)
  applyHistory(journal, direction)
}

function verifyPrefixPortableState(
  journal: PrefixRenameJournal,
  expected: "before" | "after",
  preparedHistory?: DirectHistoryFile[][],
  allowChangedSources = false
): void {
  for (const [index, entry] of journal.documents.entries()) {
    if (expected === "before" && !allowChangedSources) {
      const root = resolve(getSpacesBaseDir(), entry.from.spaceId)
      const sourcePath = resolve(root, entry.from.source.relativePath)
      assertSafeContainedPath(root, sourcePath)
      const fingerprint = fingerprintOptionalDeleteSource(
        entry.from.source,
        sourcePath
      )
      if (
        !fingerprint ||
        fingerprint.size !== entry.document.sourceSize ||
        fingerprint.sha256 !== entry.document.sourceSha256 ||
        (fingerprint.kind === "bundle" &&
          fingerprint.entries !== entry.document.sourceEntries)
      ) {
        throw new Error(
          "document folder lifecycle sources changed during preparation"
        )
      }
    }
    const files =
      preparedHistory?.[index] ?? readPrefixHistoryManifest(journal, index)
    verifyPortableState(
      prefixEntryAsExactRename(journal, entry, expected === "after"),
      expected,
      { directHistoryFiles: files }
    )
  }
}

function verifyPrefixDeletePortableState(
  journal: PrefixDeleteJournal,
  expected: "before" | "after",
  preparedHistory?: Array<DirectHistoryFile[] | undefined>,
  allowRecreatedSources = false,
  artifactDirectory?: string
): void {
  for (const [index, entry] of journal.documents.entries()) {
    const exact = prefixEntryAsExactDelete(journal, entry, index)
    if (
      !deleteSourceMatchesCheckpoint(exact, expected, {
        allowRecreatedSource: allowRecreatedSources,
        quarantineLeaf: prefixDeleteQuarantineLeaf(index),
      })
    ) {
      throw new Error(
        "document deletion sources did not reach their checkpoint"
      )
    }
    const files =
      preparedHistory?.[index] ??
      readPrefixDeleteHistoryManifest(journal, index, artifactDirectory) ??
      undefined
    const history = classifyHistory(exact, files)
    if (entry.document.history === "present" && history !== expected) {
      throw new Error("document deletion history did not reach its checkpoint")
    }
    if (entry.document.history === "absent" && history === "conflict") {
      throw new Error("document deletion history did not remain absent")
    }
    const annotationState = classifyPrefixDeleteAnnotation(journal, entry)
    if (
      entry.annotation
        ? annotationState !== expected
        : annotationState !== "before"
    ) {
      throw new Error(
        "document deletion annotations did not reach their checkpoint"
      )
    }
  }
}

function verifyPrefixEndpointOwnership(
  journal: PrefixRenameJournal,
  expected: "before" | "after"
): void {
  for (const entry of journal.documents) {
    const exact = prefixEntryAsExactRename(journal, entry, expected === "after")
    if (classifySource(exact) !== expected) {
      throw new Error(
        "document folder lifecycle endpoints changed during reconciliation"
      )
    }
  }
}

function verifyPrefixArchivePortableState(
  journal: PrefixArchiveJournal,
  expected: "before" | "after",
  preparedBlobs?: ReadonlyMap<string, Buffer>,
  artifactDirectory?: string
): void {
  const root = resolve(getSpacesBaseDir(), journal.from.spaceId)
  assertSafeWorkspacePath(root)
  requireRealDirectory(root, `Space ${journal.from.spaceId}`)
  for (const [index, entry] of journal.documents.entries()) {
    const relativePath = archiveMetadataRelativePath(entry.archiveAdapter, [
      entry.at.logicalPath,
    ])
    const path = resolve(root, relativePath)
    assertSafeContainedPath(root, path)
    const current = readArchiveFieldStates(
      entry.archiveAdapter,
      readOptionalRegularFile(path, ARTIFACT_MAX_BYTES),
      [entry.at.logicalPath]
    )[0]!
    const checkpoint = prefixArchiveState(
      entry,
      index,
      expected,
      preparedBlobs,
      artifactDirectory
    )
    if (!archiveFieldStatesEqual(current, checkpoint)) {
      throw new Error("document archive metadata did not reach its checkpoint")
    }
  }
}

function verifyPortableState(
  journal: DocumentLifecycleJournal,
  expected: "before" | "after",
  options?: {
    allowRecreatedDeleteSource?: boolean
    allowChangedPrefixSources?: boolean
    directHistoryFiles?: DirectHistoryFile[]
    prefixHistoryFiles?: DirectHistoryFile[][]
    prefixDeleteHistoryFiles?: Array<DirectHistoryFile[] | undefined>
    preparedBlobs?: ReadonlyMap<string, Buffer>
  }
): void {
  if (journal.operationType === "prefix-archive") {
    verifyPrefixArchivePortableState(journal, expected, options?.preparedBlobs)
  } else if (journal.operationType === "prefix-delete") {
    verifyPrefixDeletePortableState(
      journal,
      expected,
      options?.prefixDeleteHistoryFiles,
      options?.allowChangedPrefixSources
    )
  } else if (journal.operationType === "prefix-rename") {
    verifyPrefixPortableState(
      journal,
      expected,
      options?.prefixHistoryFiles,
      options?.allowChangedPrefixSources
    )
  } else if (journal.operationType === "format-transition") {
    const paths = verifiedFormatTransitionPaths(journal)
    const targetValid =
      journal.phase === "committed"
        ? Boolean(fingerprintOptionalRegularFile(paths.to))
        : matchesFingerprint(paths.to, {
            size: journal.document.targetSize,
            sha256: journal.document.targetSha256,
          })
    const valid =
      expected === "before"
        ? matchesFingerprint(paths.from, {
            size: journal.document.sourceSize,
            sha256: journal.document.sourceSha256,
          }) &&
          !fingerprintOptionalRegularFile(paths.to) &&
          !fingerprintOptionalRegularFile(paths.parked) &&
          !fingerprintOptionalRegularFile(paths.staged)
        : !fingerprintOptionalRegularFile(paths.from) &&
          targetValid &&
          matchesFingerprint(paths.parked, {
            size: journal.document.sourceSize,
            sha256: journal.document.sourceSha256,
          }) &&
          !fingerprintOptionalRegularFile(paths.staged)
    if (!valid) {
      throw new Error("document format sources did not reach their checkpoint")
    }
  } else if (journal.operationType === "exact-delete") {
    if (
      !deleteSourceMatchesCheckpoint(journal, expected, {
        allowRecreatedSource: options?.allowRecreatedDeleteSource,
      })
    ) {
      throw new Error("document deletion source did not reach its checkpoint")
    }
    const history = classifyHistory(journal, options?.directHistoryFiles)
    if (journal.document.history === "present" && history !== expected) {
      throw new Error("document deletion history did not reach its checkpoint")
    }
    if (journal.document.history === "absent" && history === "conflict") {
      throw new Error("document deletion history did not remain absent")
    }
  } else {
    if (classifySource(journal) !== expected) {
      throw new Error("document lifecycle source did not reach its checkpoint")
    }
    const history = classifyHistory(journal, options?.directHistoryFiles)
    if (journal.document.history === "present" && history !== expected) {
      throw new Error("document lifecycle history did not reach its checkpoint")
    }
    if (journal.document.history === "absent" && history === "conflict") {
      throw new Error("document lifecycle history did not remain absent")
    }
  }
  for (const edit of journal.edits) {
    if (
      classifyFile(
        simpleEditPath(journal, edit.role),
        edit.before,
        edit.after
      ) !== expected
    ) {
      throw new Error(
        `document lifecycle ${edit.role} did not reach its checkpoint`
      )
    }
  }
  if (journal.operationType === "exact-rename" && journal.annotation) {
    const paths = annotationPaths(journal)
    const from = readOptionalRegularFile(paths.from, ARTIFACT_MAX_BYTES)
    const to = readOptionalRegularFile(paths.to, ARTIFACT_MAX_BYTES)
    const valid =
      expected === "before"
        ? Boolean(
            from &&
            !to &&
            from.byteLength === journal.annotation.before.size &&
            sha256(from) === journal.annotation.before.sha256
          )
        : Boolean(
            !from &&
            to &&
            to.byteLength === journal.annotation.after.size &&
            sha256(to) === journal.annotation.after.sha256
          )
    if (!valid) {
      throw new Error(
        "document lifecycle annotations did not reach their checkpoint"
      )
    }
  }
}

function verifyCapturedBefore(prepared: PreparedJournal): void {
  verifyPortableState(prepared.journal, "before", {
    directHistoryFiles: prepared.directHistoryFiles,
    prefixHistoryFiles: prepared.prefixHistoryFiles,
    prefixDeleteHistoryFiles: prepared.prefixDeleteHistoryFiles,
    preparedBlobs: prepared.blobs,
  })
  if (prepared.journal.operationType === "prefix-archive") {
    verifyRecoveryCatalogCheckpoint(prepared.journal, "before")
  }
}

function readRecoveryDirectory(path: string): Dirent[] {
  try {
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink()) return []
    return readdirSync(path, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

function verifyRecoveryCatalogCheckpoint(
  journal: DocumentLifecycleJournal,
  expected: "before" | "after"
): void {
  const registry = createBuiltinDocumentFormatRegistry()
  const endpoint = expected === "before" ? journal.from : journal.to
  const expectedPrefixEntries =
    journal.operationType === "prefix-rename"
      ? journal.documents.map((entry) =>
          expected === "before" ? entry.from : entry.to
        )
      : journal.operationType === "prefix-archive"
        ? journal.documents.map((entry) => entry.at)
        : journal.operationType === "prefix-delete"
          ? journal.documents.map((entry) => entry.at)
          : null
  const comparisonKeys = new Set(
    (expectedPrefixEntries ?? [endpoint])
      .map((entry) => analyzeDocumentPath(entry.logicalPath).comparisonKey)
      .filter((key): key is string => Boolean(key))
  )
  if (comparisonKeys.size !== (expectedPrefixEntries?.length ?? 1)) {
    throw new Error("document lifecycle catalog checkpoint path is invalid")
  }
  const archivePrefixKey =
    journal.operationType === "prefix-archive" && journal.scope !== "exact"
      ? analyzeDocumentPath(journal.from.logicalPath).comparisonKey
      : null
  const deletePrefixKey =
    journal.operationType === "prefix-delete"
      ? analyzeDocumentPath(journal.from.logicalPath).comparisonKey
      : null
  const spaceRoot = resolve(getSpacesBaseDir(), endpoint.spaceId)
  assertSafeWorkspacePath(spaceRoot)
  requireRealDirectory(spaceRoot, `Space ${endpoint.spaceId}`)
  const claims: Array<{ path: string; source: string }> = []
  let entries = 0
  const account = (): void => {
    entries += 1
    if (entries > RECOVERY_CATALOG_MAX_ENTRIES) {
      throw new Error(
        "document lifecycle catalog checkpoint exceeds its entry limit"
      )
    }
  }
  const maybeClaim = (path: string, source: string): void => {
    const comparisonKey = analyzeDocumentPath(path).comparisonKey
    if (
      comparisonKey &&
      (comparisonKeys.has(comparisonKey) ||
        (archivePrefixKey &&
          documentPathKeyIsAtOrBelow(comparisonKey, archivePrefixKey)) ||
        (deletePrefixKey &&
          documentPathKeyIsAtOrBelow(comparisonKey, deletePrefixKey)))
    ) {
      claims.push({ path, source })
    }
  }
  const scanDocs = (directory: string, segments: string[]): void => {
    for (const entry of readRecoveryDirectory(directory)) {
      account()
      if (entry.isSymbolicLink()) continue
      const nextSegments = [...segments, entry.name]
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        scanDocs(absolute, nextSegments)
        continue
      }
      if (!entry.isFile()) continue
      const extension =
        journal.planVersion === LEGACY_JOURNAL_PLAN_VERSION
          ? entry.name.endsWith(".md")
            ? ".md"
            : entry.name.endsWith(".json")
              ? ".json"
              : null
          : (registry.fileSourceForFilename(entry.name)?.source.extension ??
            null)
      if (!extension) continue
      maybeClaim(
        [...segments, entry.name.slice(0, -extension.length)].join("/"),
        ["docs", ...nextSegments].join("/")
      )
    }
  }
  const scanWidgets = (directory: string, segments: string[]): void => {
    const directoryEntries = readRecoveryDirectory(directory)
    for (let index = 0; index < directoryEntries.length; index += 1) account()
    if (
      segments.length > 0 &&
      directoryEntries.some((entry) => entry.name === "widget.yaml")
    ) {
      maybeClaim(segments.join("/"), ["widgets", ...segments].join("/"))
      return
    }
    for (const entry of directoryEntries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      scanWidgets(join(directory, entry.name), [...segments, entry.name])
    }
  }

  scanDocs(resolve(spaceRoot, "docs"), [])
  scanWidgets(resolve(spaceRoot, "widgets"), [])
  if (
    journal.operationType === "prefix-rename" ||
    journal.operationType === "prefix-archive"
  ) {
    const expectedClaims = new Map(
      expectedPrefixEntries!.map((entry) => [
        entry.logicalPath,
        entry.source.relativePath,
      ])
    )
    if (
      claims.length !== expectedClaims.size ||
      claims.some((claim) => expectedClaims.get(claim.path) !== claim.source)
    ) {
      throw new Error(
        "document folder lifecycle catalog checkpoint did not converge"
      )
    }
    return
  }
  if (journal.operationType === "prefix-delete") {
    const planned = new Map(
      journal.documents.map((entry) => [
        entry.at.logicalPath,
        entry.at.source.relativePath,
      ])
    )
    if (
      expected === "before" &&
      claims.some(
        (claim) =>
          planned.has(claim.path) && planned.get(claim.path) !== claim.source
      )
    ) {
      throw new Error("document deletion catalog checkpoint did not converge")
    }
    return
  }
  if (journal.operationType === "exact-delete") {
    const recreatedSourcePresent = Boolean(
      fingerprintOptionalDeleteSource(
        journal.from.source,
        deleteSourcePaths(journal).source
      )
    )
    const expectedBeforeClaims = recreatedSourcePresent ? 1 : 0
    if (
      (expected === "before" &&
        (claims.length !== expectedBeforeClaims ||
          (expectedBeforeClaims === 1 &&
            (claims[0]?.path !== journal.from.logicalPath ||
              claims[0]?.source !== journal.from.source.relativePath)))) ||
      (expected === "after" &&
        (claims.length > 1 ||
          (claims.length === 1 &&
            claims[0]?.path !== journal.from.logicalPath)))
    ) {
      throw new Error("document deletion catalog checkpoint did not converge")
    }
    return
  }
  if (
    claims.length !== 1 ||
    claims[0]?.path !== endpoint.logicalPath ||
    claims[0].source !== (endpoint as LifecycleEndpoint).source.relativePath
  ) {
    throw new Error("document lifecycle catalog checkpoint did not converge")
  }
}

async function verifyCommittedCatalog(
  journal: DocumentLifecycleJournal
): Promise<void> {
  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId: journal.to.spaceId,
  })
  if (journal.operationType === "prefix-archive") {
    const prefix = analyzeDocumentPath(journal.from.logicalPath)
    if (!prefix.comparisonKey) {
      throw new Error("document archive catalog checkpoint path is invalid")
    }
    const isRelevant = (path: string): boolean => {
      const key = analyzeDocumentPath(path).comparisonKey
      return Boolean(
        key &&
          (journal.scope === "exact"
            ? key === prefix.comparisonKey
            : documentPathKeyIsAtOrBelow(key, prefix.comparisonKey!))
      )
    }
    const relevant = catalog.entries.filter((entry) =>
      entry.kind === "conflict"
        ? entry.claims.some((claim) => isRelevant(claim.path))
        : isRelevant(entry.descriptor.path)
    )
    if (
      relevant.length !== journal.documents.length ||
      relevant.some((entry) => entry.kind !== "document")
    ) {
      throw new Error("document archive catalog checkpoint did not converge")
    }
    for (const planned of journal.documents) {
      const matches = relevant.filter(
        (entry) =>
          entry.kind === "document" &&
          entry.descriptor.path === planned.at.logicalPath &&
          entry.descriptor.documentId === planned.document.id
      )
      if (
        matches.length !== 1 ||
        matches[0]?.kind !== "document" ||
        matches[0].descriptor.format.id !== planned.document.format.id ||
        matches[0].descriptor.format.sourceVersion !==
          planned.document.format.sourceVersion ||
        matches[0].handle.storageProfile !== planned.storageProfileId ||
        matches[0].handle.diagnostics.some(
          (diagnostic) => diagnostic.severity === "error"
        ) ||
        !sameDocumentSource(matches[0].handle.source, planned.at.source)
      ) {
        throw new Error("document archive catalog checkpoint did not converge")
      }
    }
    return
  }
  if (journal.operationType === "prefix-rename") {
    for (const planned of journal.documents) {
      const matches = catalog.entries.filter(
        (entry) =>
          entry.kind === "document" &&
          entry.descriptor.documentId === planned.document.id
      )
      if (
        matches.length !== 1 ||
        matches[0]?.kind !== "document" ||
        matches[0].descriptor.path !== planned.to.logicalPath ||
        matches[0].descriptor.format.id !== planned.document.format.id ||
        matches[0].descriptor.format.sourceVersion !==
          planned.document.format.sourceVersion ||
        matches[0].handle.identity !== "durable" ||
        matches[0].handle.diagnostics.some(
          (diagnostic) => diagnostic.severity === "error"
        ) ||
        matches[0].handle.source.kind !== planned.to.source.kind ||
        matches[0].handle.source.relativePath !== planned.to.source.relativePath
      ) {
        throw new Error(
          "document folder lifecycle catalog checkpoint did not converge"
        )
      }
    }
    return
  }
  if (journal.operationType === "prefix-delete") {
    const retiredIds = new Set(
      journal.documents.map((entry) => entry.document.id)
    )
    const survivingClaim = catalog.entries.some((entry) =>
      entry.kind === "document"
        ? retiredIds.has(entry.descriptor.documentId)
        : entry.claims.some(
            (claim) =>
              claim.kind === "document" && retiredIds.has(claim.documentId)
          )
    )
    if (survivingClaim) {
      throw new Error("document deletion catalog checkpoint did not converge")
    }
    return
  }
  if (journal.operationType === "exact-delete") {
    const comparisonKey = analyzeDocumentPath(
      journal.from.logicalPath
    ).comparisonKey
    const survivingClaim = catalog.entries.some((entry) => {
      if (journal.phase === "applying") {
        if (entry.kind === "document") {
          return (
            analyzeDocumentPath(entry.descriptor.path).comparisonKey ===
            comparisonKey
          )
        }
        return entry.claims.some(
          (claim) =>
            claim.kind === "document" &&
            analyzeDocumentPath(claim.path).comparisonKey === comparisonKey
        )
      }
      return entry.kind === "document"
        ? entry.descriptor.documentId === journal.document.id
        : entry.claims.some(
            (claim) =>
              claim.kind === "document" &&
              claim.documentId === journal.document.id
          )
    })
    if (survivingClaim) {
      throw new Error("document deletion catalog checkpoint did not converge")
    }
    return
  }
  const matches = catalog.entries.filter(
    (entry) =>
      entry.kind === "document" &&
      entry.descriptor.documentId === journal.document.id
  )
  if (
    matches.length !== 1 ||
    matches[0]?.kind !== "document" ||
    matches[0].descriptor.path !== journal.to.logicalPath ||
    matches[0].handle.identity !== "durable" ||
    matches[0].handle.diagnostics.some(
      (diagnostic) => diagnostic.severity === "error"
    ) ||
    (journal.operationType === "exact-rename" &&
      (matches[0].descriptor.format.id !== journal.document.format.id ||
        matches[0].descriptor.format.sourceVersion !==
          journal.document.format.sourceVersion ||
        !sameDocumentSource(matches[0].handle.source, journal.to.source))) ||
    (journal.operationType === "format-transition" &&
      (matches[0].descriptor.format.id !== journal.document.afterFormat.id ||
        matches[0].descriptor.format.sourceVersion !==
          journal.document.afterFormat.sourceVersion ||
        matches[0].handle.source.kind !== journal.to.source.kind ||
        matches[0].handle.source.relativePath !==
          journal.to.source.relativePath))
  ) {
    throw new Error("document lifecycle catalog checkpoint did not converge")
  }
}

function clearRecoveredCollaborationState(
  journal: DocumentLifecycleJournal
): void {
  if (journal.operationType === "prefix-archive") return
  if (
    (journal.operationType === "exact-delete" &&
      !exactDeleteBehavior(journal).usesDocCollaboration) ||
    (journal.operationType === "exact-rename" &&
      !exactRenameBehavior(journal).usesDocCollaboration)
  ) {
    return
  }
  const base = join(
    getAppDir(),
    "yjs",
    workspaceCacheKey(),
    journal.from.spaceId
  )
  assertSafeAppPath(base)
  const logicalPaths =
    journal.operationType === "prefix-rename"
      ? journal.documents
          .filter((entry) => prefixRenameBehavior(entry).usesDocCollaboration)
          .flatMap((entry) => [entry.from.logicalPath, entry.to.logicalPath])
      : journal.operationType === "prefix-delete"
        ? journal.documents
            .filter((entry) => prefixDeleteBehavior(entry).usesDocCollaboration)
            .map((entry) => entry.at.logicalPath)
        : [journal.from.logicalPath, journal.to.logicalPath]
  for (const logicalPath of logicalPaths) {
    const path = resolve(base, `${logicalPath}.bin`)
    assertSafeAppPath(path)
    rmSync(path, { force: true })
  }
}

function removeLifecycleCleanupTombstones(): void {
  const parent = lifecycleWorkspaceDirectory()
  let removed = false
  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.name.startsWith(".cleanup-")) continue
      const path = join(parent, entry.name)
      try {
        assertSafeAppPath(path)
        rmSync(path, { recursive: true, force: true })
        removed = true
      } catch (error) {
        console.warn(
          `[document-lifecycle] could not remove settled cleanup state ${path}`,
          error
        )
      }
    }
  } catch (error) {
    if (!isMissing(error)) {
      console.warn(
        "[document-lifecycle] could not inspect settled cleanup state",
        error
      )
    }
  }
  if (removed) {
    try {
      fsyncDirectory(parent)
    } catch (error) {
      console.warn(
        "[document-lifecycle] could not durably prune settled cleanup state",
        error
      )
    }
  }
}

function removeAbandonedPreparationDirectories(): void {
  const parent = lifecycleWorkspaceDirectory()
  let removed = false
  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.name.startsWith(".preparing-")) continue
      const path = join(parent, entry.name)
      try {
        assertSafeAppPath(path)
        rmSync(path, { recursive: true, force: true })
        removed = true
      } catch (error) {
        console.warn(
          `[document-lifecycle] could not remove abandoned preparation state ${path}`,
          error
        )
      }
    }
  } catch (error) {
    if (!isMissing(error)) {
      console.warn(
        "[document-lifecycle] could not inspect abandoned preparation state",
        error
      )
    }
  }
  if (removed) {
    try {
      fsyncDirectory(parent)
    } catch (error) {
      console.warn(
        "[document-lifecycle] could not durably prune abandoned preparation state",
        error
      )
    }
  }
}

interface ReconciliationMarker extends RecoveredDocumentLifecycle {
  directory: string
}

function reconciliationDirectory(operationId: string): string {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new Error("document lifecycle operation id is invalid")
  }
  return join(
    lifecycleWorkspaceDirectory(),
    `${RECONCILIATION_PREFIX}${operationId}`
  )
}

function markerFromJournal(
  journal: DocumentLifecycleJournal,
  directory: string
): ReconciliationMarker {
  return {
    operationId: journal.operationId,
    spaceId: journal.from.spaceId,
    docPath:
      journal.phase === "committed"
        ? journal.to.logicalPath
        : journal.from.logicalPath,
    directory,
  }
}

function readReconciliationMarkers(): ReconciliationMarker[] {
  const parent = lifecycleWorkspaceDirectory()
  let entries: Dirent[]
  try {
    entries = readdirSync(parent, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  const names = entries.filter((entry) =>
    entry.name.startsWith(RECONCILIATION_PREFIX)
  )
  if (names.length > 1) {
    throw new Error("multiple document reconciliations require recovery")
  }
  return names.map((entry) => {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error("document reconciliation state is not a real directory")
    }
    const directory = join(parent, entry.name)
    assertSafeAppPath(directory)
    const journal = parseJournal(join(directory, "journal.json"))
    if (entry.name !== `${RECONCILIATION_PREFIX}${journal.operationId}`) {
      throw new Error("document reconciliation state has the wrong identity")
    }
    return markerFromJournal(journal, directory)
  })
}

function settleJournalForReconciliation(
  journal: DocumentLifecycleJournal
): ReconciliationMarker {
  const active = activeDirectory()
  if (!existsSync(active)) {
    const existing = readReconciliationMarkers().find(
      (marker) => marker.operationId === journal.operationId
    )
    if (existing) return existing
    throw new Error("document lifecycle journal disappeared before settlement")
  }
  const reconciliation = reconciliationDirectory(journal.operationId)
  if (existsSync(reconciliation)) {
    throw new Error("document reconciliation state already exists")
  }
  renameSync(active, reconciliation)
  fsyncRenameParents(active, reconciliation)
  const hookResult = stepHookForTests?.("cleanup-renamed")
  if (hookResult instanceof Promise) {
    throw new Error("cleanup-renamed test hook must be synchronous")
  }
  return markerFromJournal(journal, reconciliation)
}

function removeReconciliationMarker(marker: ReconciliationMarker): void {
  const parent = lifecycleWorkspaceDirectory()
  if (!existsSync(marker.directory)) return
  const tombstone = join(parent, `.cleanup-${randomBytes(8).toString("hex")}`)
  renameSync(marker.directory, tombstone)
  fsyncRenameParents(marker.directory, tombstone)
  try {
    rmSync(tombstone, { recursive: true, force: true })
    fsyncDirectory(parent)
  } catch (error) {
    // active/ is already durably absent. This directory is ignorable garbage,
    // so cleanup failure cannot turn a committed rename into a reported error.
    console.warn(
      `[document-lifecycle] deferred settled cleanup state ${tombstone}`,
      error
    )
  }
}

export async function reconcileRecoveredDocumentLifecycles(
  recoveries: readonly RecoveredDocumentLifecycle[],
  options?: {
    skipPrefixArchivePublicationFor?: string
    skipPrefixDeletePublicationFor?: string
  }
): Promise<void> {
  for (const recovery of recoveries) {
    const marker = readReconciliationMarkers().find(
      (candidate) => candidate.operationId === recovery.operationId
    )
    if (!marker) {
      throw new Error("document reconciliation state disappeared")
    }
    if (
      marker.spaceId !== recovery.spaceId ||
      marker.docPath !== recovery.docPath
    ) {
      throw new Error("document reconciliation endpoint changed unexpectedly")
    }
    const journalBeforeReconciliation = parseJournal(
      join(marker.directory, "journal.json")
    )
    if (journalBeforeReconciliation.operationType === "prefix-archive") {
      const changedIndexes = new Set(
        journalBeforeReconciliation.mutations.flatMap(
          (mutation) => mutation.documentIndexes
        )
      )
      if (options?.skipPrefixArchivePublicationFor !== marker.operationId) {
        for (const index of changedIndexes) {
          const entry = journalBeforeReconciliation.documents[index]
          if (!entry) {
            throw new Error("document archive reconciliation member is invalid")
          }
          if (
            journalBeforeReconciliation.phase === "committed" &&
            prefixArchiveBehavior(entry).reconciliationKind === "widget"
          ) {
            await notifyWorkspaceChangeAndWait({
              type: "widget",
              spaceId: entry.at.spaceId,
              widgetId: entry.at.logicalPath,
            })
          } else if (journalBeforeReconciliation.phase === "committed") {
            notifyDocContentChanged(entry.at.spaceId, entry.at.logicalPath)
          }
        }
        if (journalBeforeReconciliation.phase === "committed") {
          await notifyWorkspaceChangeAndWait({
            type: "documentCorpus",
            spaceId: journalBeforeReconciliation.from.spaceId,
          })
        }
      }
      const journal = parseJournal(join(marker.directory, "journal.json"))
      if (
        journal.operationType !== "prefix-archive" ||
        journal.operationId !== marker.operationId
      ) {
        throw new Error(
          "document archive reconciliation identity changed unexpectedly"
        )
      }
      verifyPrefixArchivePortableState(
        journal,
        journal.phase === "committed" ? "after" : "before",
        undefined,
        marker.directory
      )
      if (journal.phase === "committed") await verifyCommittedCatalog(journal)
      else verifyRecoveryCatalogCheckpoint(journal, "before")
      removeReconciliationMarker(marker)
      continue
    }
    if (journalBeforeReconciliation.operationType === "prefix-rename") {
      const endpointSide =
        journalBeforeReconciliation.phase === "committed" ? "to" : "from"
      for (const entry of journalBeforeReconciliation.documents) {
        const endpoint = entry[endpointSide]
        const behavior = prefixRenameBehavior(entry)
        const context = {
          updatedBy: "external",
          source: "filesystem",
          reason: "Reconciled after document folder move",
        }
        if (behavior.reconciliationKind === "widget") {
          const { recordExternalWidgetChangeLocked } =
            await import("./widget-version-store.ts")
          await recordExternalWidgetChangeLocked(
            endpoint.spaceId,
            endpoint.logicalPath,
            context
          )
          await notifyWorkspaceChangeAndWait({
            type: "widget",
            spaceId: endpoint.spaceId,
            widgetId: endpoint.logicalPath,
          })
        } else {
          const provenance = await recordExternalDocChange(
            endpoint.spaceId,
            endpoint.logicalPath,
            context
          )
          if (provenance) {
            await yjsManager.syncFromDisk(
              endpoint.spaceId,
              endpoint.logicalPath
            )
          }
          await notifyWorkspaceChangeAndWait({
            type: "doc",
            spaceId: endpoint.spaceId,
            docPath: endpoint.logicalPath,
          })
        }
      }
      const journal = parseJournal(join(marker.directory, "journal.json"))
      if (
        journal.operationType !== "prefix-rename" ||
        journal.operationId !== marker.operationId
      ) {
        throw new Error("document reconciliation identity changed unexpectedly")
      }
      verifyPrefixEndpointOwnership(
        journal,
        journal.phase === "committed" ? "after" : "before"
      )
      removeReconciliationMarker(marker)
      continue
    }
    if (journalBeforeReconciliation.operationType === "prefix-delete") {
      const journal = parseJournal(join(marker.directory, "journal.json"))
      if (
        journal.operationType !== "prefix-delete" ||
        journal.operationId !== marker.operationId
      ) {
        throw new Error("document reconciliation identity changed unexpectedly")
      }
      const expected = journal.phase === "committed" ? "after" : "before"
      verifyPrefixDeletePortableState(
        journal,
        expected,
        undefined,
        journal.phase === "applying",
        marker.directory
      )
      if (journal.phase === "committed") await verifyCommittedCatalog(journal)
      else verifyRecoveryCatalogCheckpoint(journal, "before")
      const sourceChanged = journal.documents.map((entry, index) =>
        prefixDeleteSourceChangedForReconciliation(journal, entry, index)
      )
      for (const [index, entry] of journal.documents.entries()) {
        finishDeleteSourceCleanup(
          prefixEntryAsExactDelete(journal, entry, index),
          prefixDeleteQuarantineLeaf(index)
        )
      }
      await stepHookForTests?.("delete-source-cleaned")
      if (options?.skipPrefixDeletePublicationFor !== marker.operationId) {
        for (const [index, entry] of journal.documents.entries()) {
          const changed = sourceChanged[index] ?? true
          const behavior = prefixDeleteBehavior(entry)
          if (changed && behavior.reconciliationKind === "widget") {
            const { recordExternalWidgetChangeLocked } =
              await import("./widget-version-store.ts")
            await recordExternalWidgetChangeLocked(
              entry.at.spaceId,
              entry.at.logicalPath,
              {
                updatedBy: "external",
                source: "filesystem",
                reason:
                  "Reconciled an external edit during document folder deletion",
              }
            )
          } else if (changed) {
            const provenance = await recordExternalDocChange(
              entry.at.spaceId,
              entry.at.logicalPath,
              {
                updatedBy: "external",
                source: "filesystem",
                reason:
                  "Reconciled an external edit during document folder deletion",
              }
            )
            if (provenance && behavior.usesDocCollaboration) {
              await yjsManager.syncFromDisk(
                entry.at.spaceId,
                entry.at.logicalPath
              )
            }
          }
          if (changed || journal.phase === "committed") {
            await notifyWorkspaceChangeAndWait(
              behavior.reconciliationKind === "widget"
                ? {
                    type: "widget",
                    spaceId: entry.at.spaceId,
                    widgetId: entry.at.logicalPath,
                  }
                : {
                    type: "doc",
                    spaceId: entry.at.spaceId,
                    docPath: entry.at.logicalPath,
                  }
            )
          }
        }
        await notifyWorkspaceChangeAndWait({
          type: "documentCorpus",
          spaceId: journal.from.spaceId,
        })
      }
      removeReconciliationMarker(marker)
      continue
    }
    const transitionPaths =
      journalBeforeReconciliation.operationType === "format-transition"
        ? verifiedFormatTransitionPaths(journalBeforeReconciliation)
        : null
    const capturedFormatTarget =
      transitionPaths && journalBeforeReconciliation.phase === "committed"
        ? readOptionalRegularFile(transitionPaths.to, SOURCE_MAX_BYTES)
        : null
    const capturedCompensatedSource =
      transitionPaths && journalBeforeReconciliation.phase === "applying"
        ? readOptionalRegularFile(transitionPaths.from, SOURCE_MAX_BYTES)
        : null
    const plannedFormatTarget =
      journalBeforeReconciliation.operationType === "format-transition" &&
      journalBeforeReconciliation.phase === "committed" &&
      capturedFormatTarget?.byteLength ===
        journalBeforeReconciliation.document.targetSize &&
      sha256(capturedFormatTarget) ===
        journalBeforeReconciliation.document.targetSha256
    const compensatedFormatSource =
      journalBeforeReconciliation.operationType === "format-transition" &&
      journalBeforeReconciliation.phase === "applying" &&
      capturedCompensatedSource?.byteLength ===
        journalBeforeReconciliation.document.sourceSize &&
      sha256(capturedCompensatedSource) ===
        journalBeforeReconciliation.document.sourceSha256
    const compensatedDeleteSourceUnchanged =
      journalBeforeReconciliation.operationType === "exact-delete" &&
      journalBeforeReconciliation.phase === "applying" &&
      journalBeforeReconciliation.document.sourceState !== "absent" &&
      !fingerprintOptionalDeleteSource(
        journalBeforeReconciliation.from.source,
        deleteSourcePaths(journalBeforeReconciliation).quarantine
      ) &&
      matchesDeleteSourceFingerprint(
        journalBeforeReconciliation,
        deleteSourcePaths(journalBeforeReconciliation).source
      )
    const committedFormatTransition =
      journalBeforeReconciliation.operationType === "format-transition" &&
      journalBeforeReconciliation.phase === "committed"
    const context =
      journalBeforeReconciliation.operationType === "format-transition" &&
      plannedFormatTarget
        ? journalBeforeReconciliation.context
        : {
            updatedBy: "external",
            source: "filesystem",
            reason:
              journalBeforeReconciliation.operationType === "format-transition"
                ? "Reconciled external edit after document format transition"
                : journalBeforeReconciliation.operationType === "exact-delete"
                  ? "Reconciled external edit during document deletion"
                  : "Reconciled after document move",
          }
    if (committedFormatTransition) {
      await stepHookForTests?.("reconciliation-target-captured")
    }
    // A compensated transition restored the exact captured source. With no
    // prior provenance, recording it as an external change would invent both
    // a user edit and a version for a conversion that never committed.
    let provenance: Awaited<ReturnType<typeof recordExternalDocChange>>
    if (journalBeforeReconciliation.operationType === "exact-delete") {
      const behavior = exactDeleteBehavior(journalBeforeReconciliation)
      if (
        journalBeforeReconciliation.phase === "applying" &&
        compensatedDeleteSourceUnchanged
      ) {
        provenance = undefined
      } else if (behavior.reconciliationKind === "widget") {
        const { recordExternalWidgetChangeLocked } =
          await import("./widget-version-store.ts")
        provenance = await recordExternalWidgetChangeLocked(
          marker.spaceId,
          marker.docPath,
          context
        )
      } else {
        provenance = await recordExternalDocChange(
          marker.spaceId,
          marker.docPath,
          context
        )
      }
    } else if (
      journalBeforeReconciliation.operationType === "exact-rename" &&
      exactRenameBehavior(journalBeforeReconciliation).reconciliationKind ===
        "widget"
    ) {
      const { recordExternalWidgetChangeLocked } =
        await import("./widget-version-store.ts")
      provenance = await recordExternalWidgetChangeLocked(
        marker.spaceId,
        marker.docPath,
        context
      )
    } else if (compensatedFormatSource) {
      provenance = undefined
    } else if (committedFormatTransition) {
      // The parked source remains the authoritative pre-conversion content
      // even when an external editor changed the committed target.
      const safeTransitionPaths = verifiedFormatTransitionPaths(
        journalBeforeReconciliation
      )
      const parked = readOptionalRegularFile(
        safeTransitionPaths.parked,
        SOURCE_MAX_BYTES
      )
      if (
        parked &&
        (parked.byteLength !==
          journalBeforeReconciliation.document.sourceSize ||
          sha256(parked) !== journalBeforeReconciliation.document.sourceSha256)
      ) {
        throw new Error(
          "parked document format source changed before history reconciliation"
        )
      }
      if (!capturedFormatTarget) {
        throw new Error(
          "committed document format target is missing before history reconciliation"
        )
      }
      verifiedFormatTransitionPaths(journalBeforeReconciliation)
      provenance = await recordRecoveredDocFormatTransition(
        marker.spaceId,
        marker.docPath,
        journalBeforeReconciliation.document.format.id,
        parked,
        journalBeforeReconciliation.document.afterFormat.id,
        capturedFormatTarget,
        context
      )
    } else {
      if (journalBeforeReconciliation.operationType === "format-transition") {
        verifiedFormatTransitionPaths(journalBeforeReconciliation)
      }
      provenance = await recordExternalDocChange(
        marker.spaceId,
        marker.docPath,
        context
      )
    }
    if (
      provenance &&
      !(
        journalBeforeReconciliation.operationType === "exact-delete" &&
        !exactDeleteBehavior(journalBeforeReconciliation).usesDocCollaboration
      ) &&
      !(
        journalBeforeReconciliation.operationType === "exact-rename" &&
        !exactRenameBehavior(journalBeforeReconciliation).usesDocCollaboration
      )
    ) {
      if (journalBeforeReconciliation.operationType === "format-transition") {
        verifiedFormatTransitionPaths(journalBeforeReconciliation)
      }
      await yjsManager.syncFromDisk(marker.spaceId, marker.docPath)
    }
    if (journalBeforeReconciliation.operationType === "format-transition") {
      verifiedFormatTransitionPaths(journalBeforeReconciliation)
    }
    if (
      journalBeforeReconciliation.operationType !== "exact-delete" ||
      journalBeforeReconciliation.phase === "committed" ||
      !compensatedDeleteSourceUnchanged
    ) {
      await notifyWorkspaceChangeAndWait(
        (journalBeforeReconciliation.operationType === "exact-delete" &&
          exactDeleteBehavior(journalBeforeReconciliation)
            .reconciliationKind === "widget") ||
          (journalBeforeReconciliation.operationType === "exact-rename" &&
            exactRenameBehavior(journalBeforeReconciliation)
              .reconciliationKind === "widget")
          ? {
              type: "widget",
              spaceId: marker.spaceId,
              widgetId: marker.docPath,
            }
          : {
              type: "doc",
              spaceId: marker.spaceId,
              docPath: marker.docPath,
            }
      )
    }
    // Suppressed watcher activity is replayed before reconciliation reaches
    // this point. Check endpoint ownership again at the last durable boundary:
    // a writer that recreated the old path during the move must keep recovery
    // active instead of becoming an invisible second document behind an alias.
    const journal = parseJournal(join(marker.directory, "journal.json"))
    const reboundMarker = markerFromJournal(journal, marker.directory)
    if (
      reboundMarker.operationId !== marker.operationId ||
      reboundMarker.spaceId !== marker.spaceId ||
      reboundMarker.docPath !== marker.docPath
    ) {
      throw new Error("document reconciliation identity changed unexpectedly")
    }
    const expected = journal.phase === "committed" ? "after" : "before"
    if (journal.operationType === "format-transition") {
      let paths = verifiedFormatTransitionPaths(journal)
      const sourceValid =
        expected === "before"
          ? Boolean(fingerprintOptionalRegularFile(paths.from)) &&
            !fingerprintOptionalRegularFile(paths.to) &&
            !fingerprintOptionalRegularFile(paths.parked) &&
            !fingerprintOptionalRegularFile(paths.staged)
          : !fingerprintOptionalRegularFile(paths.from) &&
            Boolean(fingerprintOptionalRegularFile(paths.to)) &&
            !fingerprintOptionalRegularFile(paths.staged) &&
            (!fingerprintOptionalRegularFile(paths.parked) ||
              matchesFingerprint(paths.parked, {
                size: journal.document.sourceSize,
                sha256: journal.document.sourceSha256,
              }))
      if (!sourceValid) {
        throw new Error(
          "document lifecycle endpoints changed during reconciliation"
        )
      }
      if (fingerprintOptionalRegularFile(paths.parked)) {
        if (
          !matchesFingerprint(paths.parked, {
            size: journal.document.sourceSize,
            sha256: journal.document.sourceSha256,
          })
        ) {
          throw new Error(
            "parked document format source changed during reconciliation"
          )
        }
        paths = verifiedFormatTransitionPaths(journal)
        removeDurably(paths.parked)
      }
    } else if (journal.operationType === "exact-delete") {
      if (
        !deleteSourceMatchesCheckpoint(journal, expected, {
          allowRecreatedSource: journal.phase === "applying",
        })
      ) {
        throw new Error(
          "document deletion endpoints changed during reconciliation"
        )
      }
      finishDeleteSourceCleanup(journal)
      await stepHookForTests?.("delete-source-cleaned")
    } else if (journal.operationType === "prefix-rename") {
      verifyPrefixEndpointOwnership(journal, expected)
    } else if (journal.operationType === "prefix-archive") {
      verifyPrefixArchivePortableState(
        journal,
        expected,
        undefined,
        marker.directory
      )
    } else if (journal.operationType === "prefix-delete") {
      throw new Error("document deletion reconciliation was not isolated")
    } else if (classifySource(journal) !== expected) {
      throw new Error(
        "document lifecycle endpoints changed during reconciliation"
      )
    }
    removeReconciliationMarker(marker)
  }
}

async function executePrepared(
  prepared: PreparedJournal,
  invalidateShares: (artifacts: ShareArtifact[]) => Promise<number>
): Promise<void> {
  const journal = prepared.journal
  let collaborationStateApplied = false
  try {
    createJournal(prepared)
    if (journal.operationType === "exact-rename") {
      const behavior = exactRenameBehavior(journal)
      await invalidateShares([
        {
          kind: behavior.shareKind,
          spaceId: journal.from.spaceId,
          artifactKey: journal.from.logicalPath,
        },
        {
          kind: behavior.shareKind,
          spaceId: journal.to.spaceId,
          artifactKey: journal.to.logicalPath,
        },
      ])
      markCompleted(journal, "share-revoked")
      await stepHookForTests?.("share-revoked")
    } else if (journal.operationType === "prefix-rename") {
      await invalidateShares(
        journal.documents.flatMap((entry) =>
          [entry.from, entry.to].map((endpoint) => ({
            kind: prefixRenameBehavior(entry).shareKind,
            spaceId: endpoint.spaceId,
            artifactKey: endpoint.logicalPath,
          }))
        )
      )
      markCompleted(journal, "share-revoked")
      await stepHookForTests?.("share-revoked")
    } else if (journal.operationType === "prefix-archive" && journal.archived) {
      await invalidateShares(
        journal.documents.map((entry) => ({
          kind: prefixArchiveBehavior(entry).shareKind,
          spaceId: entry.at.spaceId,
          artifactKey: entry.at.logicalPath,
        }))
      )
      markCompleted(journal, "share-revoked")
      await stepHookForTests?.("share-revoked")
    } else if (journal.operationType === "prefix-delete") {
      await invalidateShares(
        journal.documents.map((entry) => ({
          kind: prefixDeleteBehavior(entry).shareKind,
          spaceId: entry.at.spaceId,
          artifactKey: entry.at.logicalPath,
        }))
      )
      markCompleted(journal, "share-revoked")
      await stepHookForTests?.("share-revoked")
    } else if (journal.operationType === "exact-delete") {
      const behavior = exactDeleteBehavior(journal)
      await invalidateShares([
        {
          kind: behavior.shareKind,
          spaceId: journal.from.spaceId,
          artifactKey: journal.from.logicalPath,
        },
      ])
      markCompleted(journal, "share-revoked")
      await stepHookForTests?.("share-revoked")
    }

    await applyPortableRuntime(journal, prepared.targetBytes)
    verifyPortableState(journal, "after")
    await verifyCommittedCatalog(journal)
    journal.phase = "committed"
    markCompleted(journal, "committed")
    await stepHookForTests?.("committed")

    if (
      journal.operationType === "exact-rename" &&
      exactRenameBehavior(journal).usesDocCollaboration
    ) {
      await yjsManager.renameState(
        journal.from.spaceId,
        journal.from.logicalPath,
        journal.to.logicalPath
      )
    } else if (journal.operationType === "prefix-rename") {
      const moves = prefixDocMoves(journal)
      if (moves.length > 0) {
        await yjsManager.renameStatesBatch(journal.from.spaceId, moves)
      }
    } else if (journal.operationType === "prefix-archive") {
      // Archive metadata never owns document collaboration state.
    } else if (
      journal.operationType !== "exact-rename" ||
      exactRenameBehavior(journal).usesDocCollaboration
    ) {
      clearRecoveredCollaborationState(journal)
    }
    collaborationStateApplied = true
    settleJournalForReconciliation(journal)
  } catch (error) {
    if (error instanceof SimulatedDocumentLifecycleCrash) throw error
    let current: DocumentLifecycleJournal | null
    try {
      current = readJournal()
    } catch (recoveryError) {
      requireWorkspaceRecovery("document lifecycle journal is unreadable")
      throw new AggregateError(
        [error, recoveryError],
        "document rename requires startup recovery"
      )
    }
    if (!current) {
      try {
        const settled = readReconciliationMarkers().find(
          (marker) => marker.operationId === journal.operationId
        )
        if (settled && journal.phase === "committed") return
      } catch (recoveryError) {
        requireWorkspaceRecovery(
          "document lifecycle settlement state is unreadable"
        )
        throw new AggregateError(
          [error, recoveryError],
          "document rename requires startup recovery"
        )
      }
      throw error
    }
    if (current.operationId !== journal.operationId) {
      requireWorkspaceRecovery(
        "another document lifecycle operation requires recovery"
      )
      throw new AggregateError(
        [error],
        "document rename encountered another active recovery operation"
      )
    }
    if (current.phase === "committed") {
      try {
        applyPortableRecovery(current, "forward")
        verifyPortableState(current, "after")
        await verifyCommittedCatalog(current)
        if (!collaborationStateApplied) {
          if (current.operationType === "prefix-rename") {
            const moves = prefixDocMoves(current)
            if (moves.length > 0) {
              await yjsManager.renameStatesBatch(current.from.spaceId, moves)
            }
          } else if (current.operationType === "prefix-archive") {
            // Archive metadata never owns document collaboration state.
          } else {
            clearRecoveredCollaborationState(current)
          }
          collaborationStateApplied = true
        }
        settleJournalForReconciliation(current)
        return
      } catch (recoveryError) {
        requireWorkspaceRecovery("committed document rename is unsettled")
        throw new AggregateError(
          [error, recoveryError],
          "committed document rename requires startup recovery"
        )
      }
    }
    try {
      applyPortableRecovery(current, "compensate")
      verifyPortableState(current, "before", {
        allowRecreatedDeleteSource: true,
        allowChangedPrefixSources: true,
      })
      verifyRecoveryCatalogCheckpoint(current, "before")
      settleJournalForReconciliation(current)
    } catch (recoveryError) {
      requireWorkspaceRecovery("document rename compensation is unsettled")
      throw new AggregateError(
        [error, recoveryError],
        "document rename compensation requires startup recovery"
      )
    }
    throw new CompensatedDocumentLifecycleError(error)
  }
}

function suppressionPaths(journal: DocumentLifecycleJournal): string[] {
  if (journal.operationType === "prefix-archive") {
    return [
      ...new Set(
        journal.mutations.flatMap((mutation) => {
          const path = prefixArchiveMutationPath(journal, mutation)
          return [path, durableFileTemporaryPath(path)]
        })
      ),
    ]
  }
  if (journal.operationType === "prefix-rename") {
    const root = resolve(getSpacesBaseDir(), journal.from.spaceId)
    const suppressed: string[] = []
    for (const entry of journal.documents) {
      const source = resolve(root, entry.from.source.relativePath)
      const target = resolve(root, entry.to.source.relativePath)
      assertSafeContainedPath(root, source)
      assertSafeContainedPath(root, target)
      suppressed.push(source, target)
      if (prefixRenameBehavior(entry).parksBundleSource) {
        const exact = prefixEntryAsExactRename(journal, entry, false)
        const parking = renameSourceParkingPaths(exact)
        for (const sourcePath of existingBundlePaths(source)) {
          const suffix = sourcePath.slice(source.length)
          suppressed.push(
            sourcePath,
            `${target}${suffix}`,
            `${parking.parked}${suffix}`
          )
        }
        suppressed.push(
          parking.parked,
          join(source, "widget.yaml"),
          join(target, "widget.yaml"),
          `${join(target, "widget.yaml")}.worktable-${journal.operationId}.tmp`
        )
      }
      for (let path = dirname(target); path !== root; path = dirname(path)) {
        assertSafeContainedPath(root, path)
        suppressed.push(path)
      }
      if (entry.annotation) {
        const annotation = annotationPaths(entry)
        suppressed.push(annotation.from, annotation.to)
        for (
          let path = dirname(annotation.to);
          path !== annotation.root;
          path = dirname(path)
        ) {
          assertSafeContainedPath(annotation.root, path)
          suppressed.push(path)
        }
      }
    }
    for (const edit of journal.edits) {
      suppressed.push(simpleEditPath(journal, edit.role))
    }
    return [...new Set(suppressed)]
  }
  if (journal.operationType === "prefix-delete") {
    const root = resolve(getSpacesBaseDir(), journal.from.spaceId)
    const suppressed: string[] = []
    for (const [index, entry] of journal.documents.entries()) {
      const exact = prefixEntryAsExactDelete(journal, entry, index)
      const paths = deleteSourcePaths(exact, prefixDeleteQuarantineLeaf(index))
      suppressed.push(paths.source, paths.quarantine)
      if (entry.at.source.kind === "bundle") {
        suppressed.push(...existingBundlePaths(paths.source))
      }
      suppressed.push(prefixDeleteAnnotationPath(journal, entry))
      for (
        let path = dirname(paths.source);
        path !== root;
        path = dirname(path)
      ) {
        assertSafeContainedPath(root, path)
        suppressed.push(path)
      }
    }
    for (const edit of journal.edits) {
      suppressed.push(simpleEditPath(journal, edit.role))
    }
    return [...new Set(suppressed)]
  }
  const paths = sourcePaths(journal)
  const suppressed = [paths.from, paths.to]
  if (journal.operationType === "format-transition") {
    const formatPaths = formatTransitionPaths(journal)
    suppressed.push(formatPaths.parked, formatPaths.staged)
  } else if (journal.operationType === "exact-delete") {
    const deletePaths = deleteSourcePaths(journal)
    suppressed.push(deletePaths.quarantine)
    if (journal.from.source.kind === "bundle") {
      suppressed.push(...existingBundlePaths(deletePaths.source))
    }
  } else if (
    journal.operationType === "exact-rename" &&
    exactRenameBehavior(journal).parksBundleSource
  ) {
    const parking = renameSourceParkingPaths(journal)
    const bundlePaths = existingBundlePaths(paths.from)
    for (const sourcePath of bundlePaths) {
      const suffix = sourcePath.slice(paths.from.length)
      suppressed.push(
        sourcePath,
        `${paths.to}${suffix}`,
        `${parking.parked}${suffix}`
      )
    }
    suppressed.push(
      parking.parked,
      join(paths.from, "widget.yaml"),
      join(paths.to, "widget.yaml"),
      `${join(paths.to, "widget.yaml")}.worktable-${journal.operationId}.tmp`
    )
  }
  for (
    let path = dirname(paths.to);
    path !== paths.root;
    path = dirname(path)
  ) {
    assertSafeContainedPath(paths.root, path)
    suppressed.push(path)
  }
  for (const edit of journal.edits) {
    suppressed.push(simpleEditPath(journal, edit.role))
  }
  if (journal.annotation) {
    const annotation = annotationPaths(journal)
    suppressed.push(annotation.from, annotation.to)
    for (
      let path = dirname(annotation.to);
      path !== annotation.root;
      path = dirname(path)
    ) {
      assertSafeContainedPath(annotation.root, path)
      suppressed.push(path)
    }
  }
  return [...new Set(suppressed)]
}

/**
 * Move one Markdown or rich-text document through the recoverable exact-rename
 * transaction. A provisional legacy Doc receives its durable ID in the same
 * commit that publishes its new path.
 */
async function moveDurableDocumentExactlySerialized(
  spaceId: string,
  from: string,
  to: string
): Promise<DurableExactRenameOutcome> {
  const root = resolve(getSpacesBaseDir(), spaceId)
  const storePaths = [
    join(root, "space.json"),
    join(root, "docs.meta.json"),
    join(root, "documents.meta.json"),
  ]
  let outcome: DurableExactRenameOutcome | undefined
  let operationError: unknown
  try {
    outcome = await withVersionKeyLocks(
      [
        { spaceId, kind: "docs", key: from },
        { spaceId, kind: "docs", key: to },
      ],
      () =>
        withStoreWriteLocks(storePaths, () =>
          withDocAliasLock(spaceId, () =>
            withAnnotationStoreLock(spaceId, () =>
              withHostedDocumentShareLifecycle(async (invalidateShares) => {
                let prepared: PreparedJournal | null
                try {
                  prepared = await prepareExactRename(spaceId, from, to)
                } catch (error) {
                  if (error instanceof DocumentLifecyclePreconditionError) {
                    return { handled: true, error: error.message }
                  }
                  throw error
                }
                if (!prepared) return { handled: false }
                const journal = prepared.journal
                if (journal.operationType !== "exact-rename") {
                  throw new Error("document move plan has the wrong type")
                }
                const paths = suppressionPaths(journal)
                for (const path of paths) suppressPath(path)
                const source = sourcePaths(journal)
                let replayPath: string | null = null
                const replay = () =>
                  replayPath ? { spaceId, docPath: replayPath } : null
                if (exactRenameBehavior(journal).reconciliationKind === "widget") {
                  prepareSuppressedHtmlFileReplay(source.from, spaceId, () => replayPath)
                  prepareSuppressedHtmlFileReplay(source.to, spaceId, () => replayPath)
                } else {
                  prepareSuppressedDocReplay(source.from, replay)
                  prepareSuppressedDocReplay(source.to, replay)
                }
                try {
                  try {
                    await executePrepared(prepared, invalidateShares)
                  } catch (error) {
                    if (!existsSync(activeDirectory())) replayPath = from
                    throw error
                  }
                  replayPath = to
                  return {
                    handled: true,
                    documentId: journal.document.id,
                  }
                } finally {
                  for (const path of paths) unsuppressPath(path)
                }
              })
            )
          )
        )
    )
  } catch (error) {
    operationError = error
  }

  if (operationError !== undefined) throw operationError
  if (!outcome) throw new Error("document move did not produce an outcome")
  return outcome
}

/** Reconcile content only after stable-ID data has reached its new endpoint. */
async function reconcileDocumentMove<T>(operation: () => Promise<T>): Promise<T> {
  let result: T | undefined
  let operationError: unknown
  try {
    result = await operation()
  } catch (error) {
    operationError = error
  }
  if (!(operationError instanceof SimulatedDocumentLifecycleCrash)) {
    try {
      const pending = readReconciliationMarkers().map(
        ({ operationId, spaceId, docPath }) => ({ operationId, spaceId, docPath })
      )
      await reconcileRecoveredDocumentLifecycles(pending)
    } catch (error) {
      requireWorkspaceRecovery("document move content reconciliation is incomplete")
      throw new AggregateError(
        operationError === undefined ? [error] : [operationError, error],
        "document move requires content reconciliation"
      )
    }
  }
  if (operationError !== undefined) throw operationError
  return result as T
}

export function moveDurableDocumentExactlyLocked(
  spaceId: string,
  from: string,
  to: string
): Promise<DurableExactRenameOutcome> {
  return withWorkspaceLifecycleLock(() =>
    reconcileDocumentMove(() =>
      withDocumentDataV2ExactMove(spaceId, from, to, () =>
        moveDurableDocumentExactlySerialized(spaceId, from, to)
      )
    )
  )
}

async function materializeHealthyHtmlSamePath(
  spaceId: string,
  path: string
): Promise<DurableExactRenameOutcome> {
  if (
    !CanonicalIdSchema.safeParse(spaceId).success ||
    !WidgetIdSchema.safeParse(path).success ||
    analyzeDocumentPath(path, { enforceNewPathGrammar: true }).canonicalPath !==
      path
  ) {
    return { handled: true, error: `HTML document not found: ${path}` }
  }
  const catalog = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
  })
  if (
    catalog.inventoryDiagnostics.some(
      (diagnostic) => diagnostic.severity === "error"
    )
  ) {
    return {
      handled: true,
      error: "Document inventory must be repaired before moving documents",
    }
  }
  const matches = catalog.entries.filter(
    (entry) => entry.kind === "document" && entry.descriptor.path === path
  )
  const source = matches.length === 1 ? matches[0] : undefined
  if (
    !source ||
    source.kind !== "document" ||
    source.handle.storageProfile !==
      DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle ||
    source.handle.diagnostics.some(
      (diagnostic) => diagnostic.severity === "error"
    )
  ) {
    return { handled: true, error: `HTML document not found: ${path}` }
  }
  const profile = documentStorageProfiles.get(
    DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
  )
  const expectedSource = profile.sourceForLogicalPath?.(
    source.descriptor.format,
    path
  )
  if (
    !expectedSource ||
    !sameDocumentSource(source.handle.source, expectedSource)
  ) {
    return {
      handled: true,
      error: "Durable document source does not match its logical path",
    }
  }
  if (source.handle.identity === "durable") {
    return { handled: true, documentId: source.descriptor.documentId }
  }

  const inventory = await readDocumentInventory(spaceId)
  let documentId: DocumentId
  do documentId = mintDocumentId()
  while (inventory.entries.has(documentId))
  await updateDocumentInventory(spaceId, {
    upsert: [
      {
        documentId,
        path,
        format: source.descriptor.format,
        source: source.handle.source,
      },
    ],
  })
  const committed = await buildDocumentCatalog({
    workspaceRoot: getWorkspaceRoot(),
    spaceId,
  })
  const stable = committed.entries.find(
    (entry) =>
      entry.kind === "document" &&
      entry.descriptor.path === path &&
      entry.descriptor.documentId === documentId &&
      entry.handle.identity === "durable" &&
      entry.handle.storageProfile ===
        DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
  )
  if (!stable) {
    throw new Error("HTML document identity did not materialize")
  }
  return { handled: true, documentId }
}

async function moveDurableHtmlExactlySerialized(
  spaceId: string,
  from: string,
  to: string
): Promise<DurableExactRenameOutcome> {
  if (from === to) return materializeHealthyHtmlSamePath(spaceId, from)

  const root = resolve(getSpacesBaseDir(), spaceId)
  const storePaths = [
    join(root, "space.json"),
    join(root, "widgets.meta.json"),
    join(root, "documents.meta.json"),
  ]
  let outcome: DurableExactRenameOutcome | undefined
  let operationError: unknown
  try {
    outcome = await withVersionKeyLocks(
      [
        { spaceId, kind: "widgets", key: from },
        { spaceId, kind: "widgets", key: to },
      ],
      () =>
        withStoreWriteLocks(storePaths, () =>
          withDocAliasLock(spaceId, () =>
            withAnnotationStoreLock(spaceId, () =>
              withHostedDocumentShareLifecycle(async (invalidateShares) => {
                let prepared: PreparedJournal | null
                try {
                  prepared = await prepareExactRename(
                    spaceId,
                    from,
                    to,
                    DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
                  )
                } catch (error) {
                  if (error instanceof DocumentLifecyclePreconditionError) {
                    return { handled: true, error: error.message }
                  }
                  throw error
                }
                if (!prepared) return { handled: false }
                const journal = prepared.journal
                if (
                  journal.operationType !== "exact-rename" ||
                  exactRenameBehavior(journal).reconciliationKind !== "widget"
                ) {
                  throw new Error("HTML document move plan has the wrong type")
                }
                const paths = suppressionPaths(journal)
                for (const path of paths) suppressPath(path)
                const source = sourcePaths(journal)
                const parking = renameSourceParkingPaths(journal).parked
                let replayPath: string | null = null
                let replayScheduled = false
                const replayExternalChange = async (): Promise<void> => {
                  if (replayScheduled || !replayPath) return
                  replayScheduled = true
                  const path = replayPath
                  const { withWidgetWriteLock } =
                    await import("./widget-store.ts")
                  await withWidgetWriteLock(spaceId, path, async () => {
                    const { recordExternalWidgetChangeLocked } =
                      await import("./widget-version-store.ts")
                    await recordExternalWidgetChangeLocked(spaceId, path, {
                      updatedBy: "external",
                      source: "filesystem",
                      reason: "Replayed an external edit during document move",
                    })
                    await notifyWorkspaceChangeAndWait({
                      type: "widget",
                      spaceId,
                      widgetId: path,
                    })
                  })
                }
                for (const path of paths.filter(
                  (candidate) =>
                    candidate === source.from ||
                    candidate.startsWith(`${source.from}${sep}`) ||
                    candidate === source.to ||
                    candidate.startsWith(`${source.to}${sep}`) ||
                    candidate === parking ||
                    candidate.startsWith(`${parking}${sep}`)
                )) {
                  prepareSuppressedPathReplay(path, replayExternalChange)
                }
                try {
                  try {
                    await executePrepared(prepared, invalidateShares)
                  } catch (error) {
                    if (!existsSync(activeDirectory())) replayPath = from
                    throw error
                  }
                  replayPath = to
                  return {
                    handled: true,
                    documentId: journal.document.id,
                  }
                } finally {
                  for (const path of paths) unsuppressPath(path)
                }
              })
            )
          )
        )
    )
  } catch (error) {
    operationError = error
  }

  if (!(operationError instanceof SimulatedDocumentLifecycleCrash)) {
    try {
      const pending = readReconciliationMarkers().map(
        ({ operationId, spaceId: pendingSpaceId, docPath }) => ({
          operationId,
          spaceId: pendingSpaceId,
          docPath,
        })
      )
      await reconcileRecoveredDocumentLifecycles(pending)
    } catch (reconciliationError) {
      requireWorkspaceRecovery("HTML document reconciliation is incomplete")
      throw new AggregateError(
        operationError === undefined
          ? [reconciliationError]
          : [operationError, reconciliationError],
        "HTML document move requires content reconciliation"
      )
    }
  }
  if (operationError !== undefined) throw operationError
  if (!outcome) throw new Error("HTML document move did not produce an outcome")
  return outcome
}

/** Move one legacy HTML document generation through its recoverable bundle transaction. */
export function moveDurableHtmlExactlyLocked(
  spaceId: string,
  from: string,
  to: string
): Promise<DurableExactRenameOutcome> {
  return withWorkspaceLifecycleLock(() =>
    withDocumentDataV2ExactMove(spaceId, from, to, () =>
      moveDurableHtmlExactlySerialized(spaceId, from, to)
    )
  )
}

async function moveDurableDocumentsByPrefixSerialized(
  spaceId: string,
  fromPrefix: string,
  toPrefix: string,
  expectedMoves: readonly DurablePrefixRenameMove[]
): Promise<DurablePrefixRenameOutcome> {
  const root = resolve(getSpacesBaseDir(), spaceId)
  const storePaths = [
    join(root, "space.json"),
    join(root, "documents.meta.json"),
    ...(expectedMoves.some(
      (move) =>
        move.storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile
    )
      ? [join(root, "docs.meta.json")]
      : []),
    ...(expectedMoves.some(
      (move) =>
        move.storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
    )
      ? [join(root, "widgets.meta.json")]
      : []),
  ]
  const versionKeys = expectedMoves.flatMap(
    ({ from, to, storageProfileId }) => {
      const kind =
        storageProfileId === DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
          ? ("widgets" as const)
          : ("docs" as const)
      return [
        { spaceId, kind, key: from },
        { spaceId, kind, key: to },
      ]
    }
  )
  let outcome: DurablePrefixRenameOutcome | undefined
  let operationError: unknown
  try {
    outcome = await withVersionKeyLocks(versionKeys, () =>
      withStoreWriteLocks(storePaths, () =>
        withDocAliasLock(spaceId, () =>
          withAnnotationStoreLock(spaceId, () =>
            withHostedDocumentShareLifecycle(async (invalidateShares) => {
              let prepared: PreparedJournal | null
              try {
                prepared = await preparePrefixRename(
                  spaceId,
                  fromPrefix,
                  toPrefix,
                  expectedMoves
                )
              } catch (error) {
                if (error instanceof DocumentLifecyclePreconditionError) {
                  return { handled: true, error: error.message }
                }
                throw error
              }
              if (!prepared) return { handled: false }
              const journal = prepared.journal
              if (journal.operationType !== "prefix-rename") {
                throw new Error("document folder move plan has the wrong type")
              }
              const paths = suppressionPaths(journal)
              for (const path of paths) suppressPath(path)
              let replaySide: "from" | "to" | null = null
              const replayEndpoints = new Map<
                string,
                { from?: PrefixRenameDocument; to?: PrefixRenameDocument }
              >()
              for (const entry of journal.documents) {
                for (const side of ["from", "to"] as const) {
                  const path = resolve(root, entry[side].source.relativePath)
                  const current = replayEndpoints.get(path) ?? {}
                  current[side] = entry
                  replayEndpoints.set(path, current)
                }
              }
              for (const [path, endpoints] of replayEndpoints) {
                const entry = endpoints.from ?? endpoints.to
                if (
                  !entry ||
                  !prefixRenameBehavior(entry).usesDocCollaboration
                ) {
                  continue
                }
                prepareSuppressedDocReplay(path, () => {
                  if (!replaySide) return null
                  const selected = endpoints[replaySide]
                  return selected
                    ? {
                        spaceId,
                        docPath: selected[replaySide].logicalPath,
                      }
                    : null
                })
              }
              const replayedWidgets = new Set<number>()
              for (const [index, entry] of journal.documents.entries()) {
                if (
                  prefixRenameBehavior(entry).reconciliationKind !== "widget"
                ) {
                  continue
                }
                const exact = prefixEntryAsExactRename(journal, entry, false)
                const source = sourcePaths(exact)
                const parking = renameSourceParkingPaths(exact).parked
                if (!prefixRenameBehavior(entry).parksBundleSource) {
                  const replayPath = () => replaySide ? entry[replaySide].logicalPath : null
                  prepareSuppressedHtmlFileReplay(source.from, spaceId, replayPath)
                  prepareSuppressedHtmlFileReplay(source.to, spaceId, replayPath)
                  continue
                }
                const replayExternalChange = async (): Promise<void> => {
                  if (replayedWidgets.has(index) || !replaySide) return
                  replayedWidgets.add(index)
                  const path = entry[replaySide].logicalPath
                  const { withWidgetWriteLock } =
                    await import("./widget-store.ts")
                  await withWidgetWriteLock(spaceId, path, async () => {
                    const { recordExternalWidgetChangeLocked } =
                      await import("./widget-version-store.ts")
                    await recordExternalWidgetChangeLocked(spaceId, path, {
                      updatedBy: "external",
                      source: "filesystem",
                      reason:
                        "Replayed an external edit during document folder move",
                    })
                    await notifyWorkspaceChangeAndWait({
                      type: "widget",
                      spaceId,
                      widgetId: path,
                    })
                  })
                }
                for (const path of paths.filter(
                  (candidate) =>
                    candidate === source.from ||
                    candidate.startsWith(`${source.from}${sep}`) ||
                    candidate === source.to ||
                    candidate.startsWith(`${source.to}${sep}`) ||
                    candidate === parking ||
                    candidate.startsWith(`${parking}${sep}`)
                )) {
                  prepareSuppressedPathReplay(path, replayExternalChange)
                }
              }
              try {
                try {
                  await executePrepared(prepared, invalidateShares)
                } catch (error) {
                  if (!existsSync(activeDirectory())) replaySide = "from"
                  throw error
                }
                replaySide = "to"
                return {
                  handled: true,
                  renamed: journal.documents.map((entry) => ({
                    from: entry.from.logicalPath,
                    to: entry.to.logicalPath,
                    documentId: entry.document.id,
                  })),
                }
              } finally {
                for (const path of paths) unsuppressPath(path)
              }
            })
          )
        )
      )
    )
  } catch (error) {
    operationError = error
  }

  if (operationError !== undefined) throw operationError
  if (!outcome) {
    throw new Error("document folder move did not produce an outcome")
  }
  return outcome
}

export function moveDurableDocumentsByPrefixLocked(
  spaceId: string,
  fromPrefix: string,
  toPrefix: string,
  expectedMoves: readonly DurablePrefixRenameMove[]
): Promise<DurablePrefixRenameOutcome> {
  return withWorkspaceLifecycleLock(() =>
    reconcileDocumentMove(() =>
      withDocumentDataV2PrefixMove(spaceId, expectedMoves, () =>
        moveDurableDocumentsByPrefixSerialized(
          spaceId,
          fromPrefix,
          toPrefix,
          expectedMoves
        )
      )
    )
  )
}

async function setDurableDocumentsArchivedByPrefixSerialized(
  spaceId: string,
  prefix: string,
  archived: boolean,
  expectedDocuments: readonly DurablePrefixArchiveDocument[],
  context?: DurablePrefixArchiveContext,
  allowExact = false
): Promise<DurablePrefixArchiveOutcome> {
  const root = resolve(getSpacesBaseDir(), spaceId)
  const storePaths = [
    ...new Set(
      expectedDocuments.flatMap((expected) => {
        const adapter = documentStorageProfiles.get(
          expected.storageProfileId
        ).archiveAdapter
        return adapter
          ? [
              resolve(
                root,
                archiveMetadataRelativePath(adapter, [expected.path])
              ),
            ]
          : []
      })
    ),
  ]
  let outcome: DurablePrefixArchiveOutcome | undefined
  let preparedOperationId: string | undefined
  let operationError: unknown
  try {
    outcome = await withStoreWriteLocks(storePaths, () =>
      withHostedDocumentShareLifecycle(async (invalidateShares) => {
        let prepared: PreparedJournal | null
        try {
          prepared = await preparePrefixArchive(
            spaceId,
            prefix,
            archived,
            expectedDocuments,
            context,
            allowExact
          )
        } catch (error) {
          if (error instanceof DocumentLifecyclePreconditionError) {
            return { handled: true, error: error.message }
          }
          throw error
        }
        if (!prepared) return { handled: false }
        const journal = prepared.journal
        if (journal.operationType !== "prefix-archive") {
          throw new Error("document folder archive plan has the wrong type")
        }
        preparedOperationId = journal.operationId
        const paths = suppressionPaths(journal)
        const replayedWidgets = new Set<string>()
        const { captureWidgetVersionContent } =
          await import("./widget-version-store.ts")
        const widgetBaselines = new Map<string, string | null>()
        for (const mutation of journal.mutations) {
          if (
            mutation.archiveAdapter !==
            DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyWidgetManifest
          ) {
            continue
          }
          const entry = journal.documents[mutation.documentIndexes[0]!]
          if (!entry) {
            throw new Error("document archive replay member is invalid")
          }
          const beforeContent = await captureWidgetVersionContent(
            spaceId,
            entry.at.logicalPath
          )
          widgetBaselines.set(
            entry.at.logicalPath,
            beforeContent ? stableVersionHash(beforeContent) : null
          )
        }
        for (const path of paths) suppressPath(path)
        for (const mutation of journal.mutations) {
          if (
            mutation.archiveAdapter !==
            DOCUMENT_ARCHIVE_ADAPTER_IDS.legacyWidgetManifest
          ) {
            continue
          }
          const entry = journal.documents[mutation.documentIndexes[0]!]
          if (!entry) {
            throw new Error("document archive replay member is invalid")
          }
          const beforeHash = widgetBaselines.get(entry.at.logicalPath) ?? null
          const path = prefixArchiveMutationPath(journal, mutation)
          prepareSuppressedPathReplay(path, async () => {
            if (replayedWidgets.has(entry.at.logicalPath)) return
            replayedWidgets.add(entry.at.logicalPath)
            const { withWidgetWriteLock } = await import("./widget-store.ts")
            await withWidgetWriteLock(
              spaceId,
              entry.at.logicalPath,
              async () => {
                const current = await captureWidgetVersionContent(
                  spaceId,
                  entry.at.logicalPath
                )
                if (!current || stableVersionHash(current) === beforeHash) {
                  return
                }
                const { recordExternalWidgetChangeLocked } =
                  await import("./widget-version-store.ts")
                await recordExternalWidgetChangeLocked(
                  spaceId,
                  entry.at.logicalPath,
                  {
                    updatedBy: "external",
                    source: "filesystem",
                    reason: "Replayed an edit during document folder archive",
                  }
                )
                await notifyWorkspaceChangeAndWait({
                  type: "widget",
                  spaceId,
                  widgetId: entry.at.logicalPath,
                })
              }
            )
          })
        }
        try {
          await executePrepared(prepared, invalidateShares)
          const changedIndexes = new Set(
            journal.mutations.flatMap((mutation) => mutation.documentIndexes)
          )
          return {
            handled: true,
            changed: [...changedIndexes]
              .sort((left, right) => left - right)
              .map((index) => {
                const entry = journal.documents[index]!
                return {
                  path: entry.at.logicalPath,
                  documentId: entry.document.id,
                  storageProfileId: entry.storageProfileId,
                }
              }),
          }
        } finally {
          for (const path of paths) unsuppressPath(path)
        }
      })
    )
  } catch (error) {
    operationError = error
  }

  if (!(operationError instanceof SimulatedDocumentLifecycleCrash)) {
    try {
      const pending = readReconciliationMarkers().map(
        ({ operationId, spaceId: pendingSpaceId, docPath }) => ({
          operationId,
          spaceId: pendingSpaceId,
          docPath,
        })
      )
      await reconcileRecoveredDocumentLifecycles(pending, {
        skipPrefixArchivePublicationFor: preparedOperationId,
      })
    } catch (reconciliationError) {
      requireWorkspaceRecovery(
        "document folder archive reconciliation is incomplete"
      )
      throw new AggregateError(
        operationError === undefined
          ? [reconciliationError]
          : [operationError, reconciliationError],
        "document folder archive requires reconciliation"
      )
    }
  }
  if (operationError !== undefined) throw operationError
  if (!outcome) {
    throw new Error("document folder archive did not produce an outcome")
  }
  return outcome
}

/** Change one bounded mixed-format subtree's archive state durably. */
export function setDurableDocumentsArchivedByPrefixLocked(
  spaceId: string,
  prefix: string,
  archived: boolean,
  expectedDocuments: readonly DurablePrefixArchiveDocument[],
  context?: DurablePrefixArchiveContext
): Promise<DurablePrefixArchiveOutcome> {
  return withWorkspaceLifecycleLock(() =>
    setDurableDocumentsArchivedByPrefixSerialized(
      spaceId,
      prefix,
      archived,
      expectedDocuments,
      context
    )
  )
}

/** Change one exact managed document's archive state through the same journal. */
export function setDurableDocumentArchivedExactlyLocked(
  spaceId: string,
  path: string,
  archived: boolean,
  expectedDocument: DurablePrefixArchiveDocument,
  context?: DurablePrefixArchiveContext
): Promise<DurablePrefixArchiveOutcome> {
  return withWorkspaceLifecycleLock(() =>
    setDurableDocumentsArchivedByPrefixSerialized(
      spaceId,
      path,
      archived,
      [expectedDocument],
      context,
      true
    )
  )
}

async function deleteDurableDocumentsByPrefixSerialized(
  spaceId: string,
  prefix: string,
  expectedDocuments: readonly DurablePrefixDeleteDocument[]
): Promise<DurablePrefixDeleteOutcome> {
  const root = resolve(getSpacesBaseDir(), spaceId)
  const storePaths = [
    join(root, "space.json"),
    join(root, "documents.meta.json"),
    ...(expectedDocuments.some(
      (entry) => entry.deleteAdapter === DOCUMENT_DELETE_ADAPTER_IDS.legacyDoc
    )
      ? [join(root, "docs.meta.json")]
      : []),
    ...(expectedDocuments.some(
      (entry) => entry.deleteAdapter === DOCUMENT_DELETE_ADAPTER_IDS.legacyHtml
    )
      ? [join(root, "widgets.meta.json")]
      : []),
  ]
  const versionKeys = expectedDocuments.map((entry) => ({
    spaceId,
    kind:
      entry.deleteAdapter === DOCUMENT_DELETE_ADAPTER_IDS.legacyHtml
        ? ("widgets" as const)
        : ("docs" as const),
    key: entry.path,
  }))
  let outcome: DurablePrefixDeleteOutcome | undefined
  let preparedOperationId: string | undefined
  let operationError: unknown
  try {
    outcome = await withVersionKeyLocks(versionKeys, () =>
      withStoreWriteLocks(storePaths, () =>
        withDocAliasLock(spaceId, () =>
          withAnnotationStoreLock(spaceId, () =>
            withHostedDocumentShareLifecycle(async (invalidateShares) => {
              let prepared: PreparedJournal | null
              try {
                prepared = await preparePrefixDelete(
                  spaceId,
                  prefix,
                  expectedDocuments
                )
              } catch (error) {
                if (error instanceof DocumentLifecyclePreconditionError) {
                  return { handled: true, error: error.message }
                }
                throw error
              }
              if (!prepared) return { handled: false }
              const journal = prepared.journal
              if (journal.operationType !== "prefix-delete") {
                throw new Error(
                  "document folder deletion plan has the wrong type"
                )
              }
              preparedOperationId = journal.operationId
              const paths = suppressionPaths(journal)
              for (const path of paths) suppressPath(path)
              let replayExternalChanges = false
              for (const [index, entry] of journal.documents.entries()) {
                const exact = prefixEntryAsExactDelete(journal, entry, index)
                const source = deleteSourcePaths(
                  exact,
                  prefixDeleteQuarantineLeaf(index)
                ).source
                if (prefixDeleteBehavior(entry).usesDocCollaboration) {
                  prepareSuppressedDocReplay(source, () =>
                    replayExternalChanges
                      ? { spaceId, docPath: entry.at.logicalPath }
                      : null
                  )
                  continue
                }
                let replayed = false
                const replayExternalWidgetChange = async (): Promise<void> => {
                  if (replayed || !replayExternalChanges) return
                  replayed = true
                  let changed: boolean
                  try {
                    changed =
                      journal.phase === "committed"
                        ? Boolean(
                            fingerprintOptionalDeleteSource(
                              entry.at.source,
                              source
                            )
                          )
                        : !matchesDeleteSourceFingerprint(exact, source)
                  } catch {
                    changed = true
                  }
                  if (!changed) return
                  const { recordExternalWidgetChange } =
                    await import("./widget-version-store.ts")
                  await recordExternalWidgetChange(
                    spaceId,
                    entry.at.logicalPath,
                    {
                      updatedBy: "external",
                      source: "filesystem",
                      reason:
                        "Replayed an external edit during document folder deletion",
                    }
                  )
                  await notifyWorkspaceChangeAndWait({
                    type: "widget",
                    spaceId,
                    widgetId: entry.at.logicalPath,
                  })
                }
                for (const sourcePath of paths.filter(
                  (candidate) =>
                    candidate === source ||
                    candidate.startsWith(`${source}${sep}`)
                )) {
                  prepareSuppressedPathReplay(
                    sourcePath,
                    replayExternalWidgetChange
                  )
                }
              }
              try {
                try {
                  await executePrepared(prepared, invalidateShares)
                } finally {
                  if (!existsSync(activeDirectory())) {
                    replayExternalChanges = true
                  }
                }
                return {
                  handled: true,
                  deleted: journal.documents.map((entry) => ({
                    path: entry.at.logicalPath,
                    documentId: entry.document.id,
                    storageProfileId: entry.storageProfileId,
                  })),
                }
              } finally {
                for (const path of paths) unsuppressPath(path)
              }
            })
          )
        )
      )
    )
  } catch (error) {
    operationError = error
  }

  if (!(operationError instanceof SimulatedDocumentLifecycleCrash)) {
    try {
      const pending = readReconciliationMarkers().map(
        ({ operationId, spaceId: pendingSpaceId, docPath }) => ({
          operationId,
          spaceId: pendingSpaceId,
          docPath,
        })
      )
      await reconcileRecoveredDocumentLifecycles(pending, {
        skipPrefixDeletePublicationFor: preparedOperationId,
      })
    } catch (reconciliationError) {
      requireWorkspaceRecovery(
        "document folder deletion reconciliation is incomplete"
      )
      throw new AggregateError(
        operationError === undefined
          ? [reconciliationError]
          : [operationError, reconciliationError],
        "document folder deletion requires reconciliation"
      )
    }
  }
  if (operationError !== undefined) throw operationError
  if (!outcome) {
    throw new Error("document folder deletion did not produce an outcome")
  }
  return outcome
}

/** Retire one bounded mixed-format subtree as one durable generation. */
export function deleteDurableDocumentsByPrefixLocked(
  spaceId: string,
  prefix: string,
  expectedDocuments: readonly DurablePrefixDeleteDocument[]
): Promise<DurablePrefixDeleteOutcome> {
  return withWorkspaceLifecycleLock(() =>
    withDocumentDataV2PrefixDelete(
      spaceId,
      expectedDocuments.map((document) => document.path),
      () =>
        deleteDurableDocumentsByPrefixSerialized(
          spaceId,
          prefix,
          expectedDocuments
        )
    )
  )
}

/** File-backed HTML replay must wait for the owning namespace transaction. */
function prepareSuppressedHtmlFileReplay(
  source: string,
  spaceId: string,
  pathAfterTransaction: () => string | null
): void {
  prepareSuppressedPathReplay(source, async () => {
    const path = pathAfterTransaction()
    if (!path) return
    const { recordExternalWidgetChange } = await import("./widget-version-store.ts")
    await recordExternalWidgetChange(spaceId, path, {
      updatedBy: "external",
      source: "filesystem",
      reason: "Replayed an external edit during document lifecycle",
    })
    await notifyWorkspaceChangeAndWait({ type: "widget", spaceId, widgetId: path })
  })
}

async function deleteDurableDocExactlySerialized(
  spaceId: string,
  path: string
): Promise<DurableExactDeleteOutcome> {
  const root = resolve(getSpacesBaseDir(), spaceId)
  const storePaths = [
    join(root, "space.json"),
    join(root, "docs.meta.json"),
    join(root, "documents.meta.json"),
  ]
  let outcome: DurableExactDeleteOutcome | undefined
  let operationError: unknown
  try {
    outcome = await withVersionKeyLocks(
      [{ spaceId, kind: "docs", key: path }],
      () =>
        withStoreWriteLocks(storePaths, () =>
          withDocAliasLock(spaceId, () =>
            withAnnotationStoreLock(spaceId, () =>
              withHostedDocumentShareLifecycle(async (invalidateShares) => {
                let prepared: PreparedJournal | null
                try {
                  prepared = await prepareExactDelete(
                    spaceId,
                    path,
                    DOCUMENT_STORAGE_PROFILE_IDS.legacyDocFile
                  )
                } catch (error) {
                  if (error instanceof DocumentLifecyclePreconditionError) {
                    return { handled: true, error: error.message }
                  }
                  throw error
                }
                if (!prepared) return { handled: false }
                const journal = prepared.journal
                if (journal.operationType !== "exact-delete") {
                  throw new Error("document deletion plan has the wrong type")
                }
                const paths = suppressionPaths(journal)
                for (const suppressedPath of paths) {
                  suppressPath(suppressedPath)
                }
                const source = deleteSourcePaths(journal)
                let replayExternalChange = false
                if (exactDeleteBehavior(journal).reconciliationKind === "widget") {
                  prepareSuppressedHtmlFileReplay(source.source, spaceId, () =>
                    replayExternalChange ? path : null
                  )
                } else {
                  prepareSuppressedDocReplay(source.source, () =>
                    replayExternalChange ? { spaceId, docPath: path } : null
                  )
                }
                try {
                  try {
                    await executePrepared(prepared, invalidateShares)
                  } catch (error) {
                    if (!existsSync(activeDirectory())) {
                      replayExternalChange = true
                    }
                    throw error
                  }
                  return {
                    handled: true,
                    documentId: journal.document.id,
                  }
                } finally {
                  for (const suppressedPath of paths) {
                    unsuppressPath(suppressedPath)
                  }
                }
              })
            )
          )
        )
    )
  } catch (error) {
    operationError = error
  }

  if (!(operationError instanceof SimulatedDocumentLifecycleCrash)) {
    try {
      const pending = readReconciliationMarkers().map(
        ({ operationId, spaceId: pendingSpaceId, docPath }) => ({
          operationId,
          spaceId: pendingSpaceId,
          docPath,
        })
      )
      await reconcileRecoveredDocumentLifecycles(pending)
    } catch (reconciliationError) {
      requireWorkspaceRecovery("document content reconciliation is incomplete")
      throw new AggregateError(
        operationError === undefined
          ? [reconciliationError]
          : [operationError, reconciliationError],
        "document deletion requires content reconciliation"
      )
    }
  }
  if (operationError !== undefined) throw operationError
  if (!outcome) throw new Error("document deletion did not produce an outcome")
  return outcome
}

/** Retire one durable legacy Doc and every path-keyed companion atomically. */
export function deleteDurableDocExactlyLocked(
  spaceId: string,
  path: string
): Promise<DurableExactDeleteOutcome> {
  return withWorkspaceLifecycleLock(() =>
    withDocumentDataV2ExactDelete(spaceId, path, () =>
      deleteDurableDocExactlySerialized(spaceId, path)
    )
  )
}

async function deleteDurableHtmlExactlySerialized(
  spaceId: string,
  path: string
): Promise<DurableExactDeleteOutcome> {
  const root = resolve(getSpacesBaseDir(), spaceId)
  const storePaths = [
    join(root, "space.json"),
    join(root, "widgets.meta.json"),
    join(root, "documents.meta.json"),
  ]
  let outcome: DurableExactDeleteOutcome | undefined
  let operationError: unknown
  try {
    outcome = await withVersionKeyLocks(
      [{ spaceId, kind: "widgets", key: path }],
      () =>
        withStoreWriteLocks(storePaths, () =>
          withAnnotationStoreLock(spaceId, () =>
            withHostedDocumentShareLifecycle(async (invalidateShares) => {
              let prepared: PreparedJournal | null
              try {
                prepared = await prepareExactDelete(
                  spaceId,
                  path,
                  DOCUMENT_STORAGE_PROFILE_IDS.legacyHtmlBundle
                )
              } catch (error) {
                if (error instanceof DocumentLifecyclePreconditionError) {
                  return { handled: true, error: error.message }
                }
                throw error
              }
              if (!prepared) return { handled: false }
              const journal = prepared.journal
              if (journal.operationType !== "exact-delete") {
                throw new Error("HTML deletion plan has the wrong type")
              }
              const paths = suppressionPaths(journal)
              for (const suppressedPath of paths) suppressPath(suppressedPath)
              try {
                const source = deleteSourcePaths(journal).source
                let replayScheduled = false
                const replayExternalChange = async (): Promise<void> => {
                  if (replayScheduled) return
                  replayScheduled = true
                  const { withWidgetWriteLock } =
                    await import("./widget-store.ts")
                  await withWidgetWriteLock(spaceId, path, async () => {
                    let changed: boolean
                    try {
                      changed =
                        journal.phase === "committed"
                          ? Boolean(
                              fingerprintOptionalDeleteSource(
                                journal.from.source,
                                source
                              )
                            )
                          : !matchesDeleteSourceFingerprint(journal, source)
                    } catch {
                      changed = true
                    }
                    if (!changed) return
                    const { recordExternalWidgetChangeLocked } =
                      await import("./widget-version-store.ts")
                    await recordExternalWidgetChangeLocked(spaceId, path, {
                      updatedBy: "external",
                      source: "filesystem",
                      reason:
                        "Replayed an external edit during document deletion",
                    })
                    await notifyWorkspaceChangeAndWait({
                      type: "widget",
                      spaceId,
                      widgetId: path,
                    })
                  })
                }
                for (const sourcePath of paths.filter(
                  (candidate) =>
                    candidate === source ||
                    candidate.startsWith(`${source}${sep}`)
                )) {
                  prepareSuppressedPathReplay(sourcePath, replayExternalChange)
                }
                await executePrepared(prepared, invalidateShares)
                return {
                  handled: true,
                  documentId: journal.document.id,
                }
              } finally {
                for (const suppressedPath of paths) {
                  unsuppressPath(suppressedPath)
                }
              }
            })
          )
        )
    )
  } catch (error) {
    operationError = error
  }

  if (!(operationError instanceof SimulatedDocumentLifecycleCrash)) {
    try {
      const pending = readReconciliationMarkers().map(
        ({ operationId, spaceId: pendingSpaceId, docPath }) => ({
          operationId,
          spaceId: pendingSpaceId,
          docPath,
        })
      )
      await reconcileRecoveredDocumentLifecycles(pending)
    } catch (reconciliationError) {
      requireWorkspaceRecovery("HTML document reconciliation is incomplete")
      throw new AggregateError(
        operationError === undefined
          ? [reconciliationError]
          : [operationError, reconciliationError],
        "HTML document deletion requires content reconciliation"
      )
    }
  }
  if (operationError !== undefined) throw operationError
  if (!outcome) {
    throw new Error("HTML document deletion did not produce an outcome")
  }
  return outcome
}

/** Retire one durable legacy HTML bundle and its generation-bound state. */
export function deleteDurableHtmlExactlyLocked(
  spaceId: string,
  path: string
): Promise<DurableExactDeleteOutcome> {
  return withWorkspaceLifecycleLock(() =>
    withDocumentDataV2ExactDelete(spaceId, path, () =>
      deleteDurableHtmlExactlySerialized(spaceId, path)
    )
  )
}

/**
 * Change one durable legacy Doc between Markdown and rich-text storage while
 * retaining its stable identity and logical path. Provisional Docs fall back
 * to the compatibility store until their IDs have been materialized.
 */
async function transitionDurableDocumentFormatSerialized(
  options: DurableFormatTransitionOptions
): Promise<DurableFormatTransitionOutcome> {
  const root = resolve(getSpacesBaseDir(), options.spaceId)
  const storePaths = [
    join(root, "docs.meta.json"),
    join(root, "documents.meta.json"),
  ]
  let outcome: DurableFormatTransitionOutcome | undefined
  let operationError: unknown
  try {
    outcome = await withVersionKeyLocks(
      [{ spaceId: options.spaceId, kind: "docs", key: options.docPath }],
      () =>
        withStoreWriteLocks(storePaths, () =>
          withAnnotationStoreLock(options.spaceId, async () => {
            let prepared: PreparedJournal | null
            try {
              prepared = await prepareFormatTransition(options)
            } catch (error) {
              if (error instanceof DocumentLifecyclePreconditionError) {
                return { handled: true, error: error.message }
              }
              throw error
            }
            if (!prepared) return { handled: false }
            const journal = prepared.journal
            if (journal.operationType !== "format-transition") {
              throw new Error("document format plan has the wrong type")
            }
            const paths = suppressionPaths(journal)
            for (const path of paths) suppressPath(path)
            const source = sourcePaths(journal)
            prepareSuppressedDocReplay(source.from, {
              spaceId: options.spaceId,
              docPath: options.docPath,
            })
            prepareSuppressedDocReplay(source.to, {
              spaceId: options.spaceId,
              docPath: options.docPath,
            })
            try {
              await executePrepared(prepared, async () => 0)
              return {
                handled: true,
                documentId: journal.document.id,
              }
            } finally {
              for (const path of paths) unsuppressPath(path)
            }
          })
        )
    )
  } catch (error) {
    operationError = error
  }

  if (!(operationError instanceof SimulatedDocumentLifecycleCrash)) {
    if (operationError === undefined && outcome?.handled && !outcome.error) {
      try {
        await options.onCommitted?.()
      } catch (error) {
        console.error(
          `[document-lifecycle] failed to finalize format transition for ${options.spaceId}/${options.docPath}:`,
          error
        )
      }
    }
    try {
      const pending = readReconciliationMarkers().map(
        ({ operationId, spaceId, docPath }) => ({
          operationId,
          spaceId,
          docPath,
        })
      )
      await reconcileRecoveredDocumentLifecycles(pending)
    } catch (reconciliationError) {
      requireWorkspaceRecovery("document content reconciliation is incomplete")
      throw new AggregateError(
        operationError === undefined
          ? [reconciliationError]
          : [operationError, reconciliationError],
        "document format transition requires content reconciliation"
      )
    }
  }
  if (operationError !== undefined) throw operationError
  if (!outcome) {
    throw new Error("document format transition did not produce an outcome")
  }
  return outcome
}

export function transitionDurableDocumentFormatLocked(
  options: DurableFormatTransitionOptions
): Promise<DurableFormatTransitionOutcome> {
  return withWorkspaceLifecycleLock(() =>
    transitionDurableDocumentFormatSerialized(options)
  )
}

/**
 * Recover the current workspace before adoption, services, watchers, or the
 * listener can observe a partial document locator transition.
 */
export function recoverInterruptedDocumentLifecycles(): RecoveredDocumentLifecycle[] {
  removeAbandonedPreparationDirectories()
  removeLifecycleCleanupTombstones()
  const existingMarkers = readReconciliationMarkers()
  const journal = readJournal()
  if (!journal) {
    return existingMarkers.map(({ operationId, spaceId, docPath }) => ({
      operationId,
      spaceId,
      docPath,
    }))
  }
  if (existingMarkers.length > 0) {
    throw new Error(
      "active document recovery conflicts with pending reconciliation"
    )
  }
  if (journal.phase === "committed") {
    applyPortableRecovery(journal, "forward")
    verifyPortableState(journal, "after")
    verifyRecoveryCatalogCheckpoint(journal, "after")
    clearRecoveredCollaborationState(journal)
  } else {
    applyPortableRecovery(journal, "compensate")
    verifyPortableState(journal, "before", {
      allowRecreatedDeleteSource: true,
      allowChangedPrefixSources: true,
    })
    verifyRecoveryCatalogCheckpoint(journal, "before")
  }
  const marker = settleJournalForReconciliation(journal)
  return [
    {
      operationId: marker.operationId,
      spaceId: marker.spaceId,
      docPath: marker.docPath,
    },
  ]
}
