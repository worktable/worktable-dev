import { createHash } from "node:crypto"
import {
  lstat,
  mkdtemp,
  opendir,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { z } from "zod"
import {
  AnnotationFileSchema,
  CanonicalIdSchema,
  compareDocumentStorageText,
  DocumentAnnotationFileV2Schema,
  DocumentAnnotationTargetV2Schema,
  DocumentAnnotationV2Schema,
  DocumentGenerationEntrySchema,
  DocumentPortableStateManifestV2Schema,
  DocumentPortableStatePointerV2Schema,
  type AnnotationTarget,
  type DocumentAnnotationFileV2,
  type DocumentAnnotationTargetV2,
  type DocumentAnnotationV2,
  type DocumentFormatClaim,
  type DocumentId,
  type DocumentPortableStateManifestV2,
} from "@worktable/types"
import { atomicWriteText } from "./atomic-file.ts"
import {
  BoundedFileReadError,
  readBoundedRegularFile,
  readBoundedRegularFileBytes,
} from "./bounded-file.ts"
import { mapWithConcurrency } from "./bounded-concurrency.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import {
  markLegacyAnnotationStoreCutover,
  withLegacyAnnotationStoreLock,
} from "./legacy-annotation-lock.ts"
import { requireSafeLegacySpaceId } from "./legacy-space-id.ts"
import { analyzeDocumentPath, parseNewDocumentPath } from "./document-path.ts"
import {
  createBuiltinDocumentFormatRegistry,
  type DocumentFormatRegistry,
} from "./document-format-registry.ts"
import {
  DOCUMENT_GENERATION_MANIFEST_MAX_BYTES,
  DOCUMENT_GENERATION_MAX_ENTRIES,
  DOCUMENT_GENERATION_MAX_ENTRY_BYTES,
  DOCUMENT_GENERATION_MAX_TOTAL_BYTES,
  type DocumentGenerationPayloadEntry,
} from "./document-version-store-v2.ts"
import {
  documentAnnotationsV2Path,
  documentDataV2Directory,
  documentPortableStateV2CurrentPath,
  documentPortableStateV2Directory,
  documentPortableStateV2RevisionDirectory,
  ensureRealDocumentStorageDirectory,
  requireRealDocumentStorageDirectory,
} from "./workspace-storage-v2.ts"

export const LEGACY_DOCUMENT_SELECTOR_TYPES = {
  richTextBlock: "worktable.rich-text-block",
  richTextRange: "worktable.rich-text-range",
} as const

export const DOCUMENT_ANNOTATIONS_V2_MAX_BYTES = 16 * 1024 * 1024
export const DOCUMENT_PORTABLE_STATE_REVISIONS_KEPT = 2
const DOCUMENT_PORTABLE_STATE_READ_CONCURRENCY = 32

type LegacyDocumentAnnotationTarget = Extract<
  AnnotationTarget,
  { type: "doc" | "block" | "text" | "widget" }
>

export type LegacyAnnotationTranslation =
  | { kind: "resolved"; target: LegacyDocumentAnnotationTarget }
  | {
      kind: "unresolved"
      reason: "unsupported-selector" | "incompatible-legacy-target"
      target: DocumentAnnotationTargetV2
    }

export interface ReadDocumentPortableStateV2Result {
  manifest: DocumentPortableStateManifestV2
  entries: DocumentGenerationPayloadEntry[]
}

const stateLocks = new Map<string, Promise<void>>()
const annotationLocks = new Map<string, Promise<void>>()
const builtinFormatRegistry = createBuiltinDocumentFormatRegistry()

async function withLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  locks.set(key, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (locks.get(key) === tail) locks.delete(key)
  }
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

async function readAtomicallyReplacedText(
  path: string,
  maxBytes: number
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await readBoundedRegularFile(path, maxBytes)
    } catch (error) {
      if (
        attempt > 0 ||
        !(error instanceof BoundedFileReadError) ||
        error.reason !== "changed"
      ) {
        throw error
      }
    }
  }
  throw new Error("atomically replaced document data remained unstable")
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson)
  if (!object(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedJson(value[key])])
  )
}

function jsonRevision(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortedJson(value)))
    .digest("hex")
}

function normalizeJsonValue(value: unknown): unknown {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new Error("document data is not JSON serializable")
  }
  return JSON.parse(serialized)
}

function requirePortableLogicalPath(path: string): string {
  const parsed = parseNewDocumentPath(path)
  if ("error" in parsed || parsed.path !== path) {
    throw new Error("document data logical path is not portable")
  }
  return path
}

function requireSafeLegacyLogicalPath(path: string): string {
  const analysis = analyzeDocumentPath(path)
  if (!analysis.safe || !analysis.canonicalPath) {
    throw new Error("legacy document data logical path is unsafe")
  }
  return path
}

function annotationRevision(file: Record<string, unknown>): string {
  const content = { ...file }
  delete content["revision"]
  return jsonRevision(content)
}

function optionalStrings(
  value: Record<string, unknown>,
  keys: readonly string[]
): Record<string, string | number> {
  return Object.fromEntries(
    keys.flatMap((key) => {
      const field = value[key]
      return typeof field === "string" || typeof field === "number"
        ? [[key, field]]
        : []
    })
  )
}

export function translateLegacyDocumentAnnotationTarget(
  target: AnnotationTarget,
  input: { documentId: DocumentId; logicalPath: string }
): DocumentAnnotationTargetV2 | null {
  const base = {
    type: "document" as const,
    documentId: input.documentId,
    path: requireSafeLegacyLogicalPath(input.logicalPath),
  }
  if (target.type === "doc") {
    if (target.docPath !== input.logicalPath) return null
    return base
  }
  if (target.type === "widget") {
    if (target.widgetId !== input.logicalPath) return null
    return base
  }
  if (target.type === "block") {
    if (target.docPath !== input.logicalPath) return null
    return DocumentAnnotationTargetV2Schema.parse({
      ...base,
      selector: {
        type: LEGACY_DOCUMENT_SELECTOR_TYPES.richTextBlock,
        version: 1,
        data: {
          blockId: target.blockId,
          ...optionalStrings(target, [
            "blockType",
            "quote",
            "prefix",
            "suffix",
            "blockTextHash",
          ]),
        },
      },
    })
  }
  if (target.type === "text") {
    if (target.docPath !== input.logicalPath) return null
    return DocumentAnnotationTargetV2Schema.parse({
      ...base,
      selector: {
        type: LEGACY_DOCUMENT_SELECTOR_TYPES.richTextRange,
        version: 1,
        data: {
          blockId: target.blockId,
          ...optionalStrings(target, [
            "start",
            "end",
            "quote",
            "prefix",
            "suffix",
          ]),
        },
      },
    })
  }
  return null
}

const BlockSelectorDataSchema = z
  .object({
    blockId: z.string().min(1),
    blockType: z.string().optional(),
    quote: z.string().optional(),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
    blockTextHash: z.string().optional(),
  })
  .passthrough()

const RangeSelectorDataSchema = z
  .object({
    blockId: z.string().min(1),
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
    quote: z.string().optional(),
    prefix: z.string().optional(),
    suffix: z.string().optional(),
  })
  .passthrough()

export function translateDocumentAnnotationTargetV2ToLegacy(
  target: DocumentAnnotationTargetV2,
  legacyKind: "docs" | "widgets"
): LegacyAnnotationTranslation {
  if (!target.selector) {
    return {
      kind: "resolved",
      target:
        legacyKind === "docs"
          ? { type: "doc", docPath: target.path }
          : { type: "widget", widgetId: target.path },
    }
  }
  if (legacyKind !== "docs") {
    return {
      kind: "unresolved",
      reason: "incompatible-legacy-target",
      target,
    }
  }
  if (
    target.selector.type === LEGACY_DOCUMENT_SELECTOR_TYPES.richTextBlock &&
    target.selector.version === 1
  ) {
    const data = BlockSelectorDataSchema.safeParse(target.selector.data)
    if (data.success) {
      const { blockId, blockType, quote, prefix, suffix, blockTextHash } =
        data.data
      return {
        kind: "resolved",
        target: {
          type: "block",
          docPath: target.path,
          blockId,
          ...(blockType !== undefined ? { blockType } : {}),
          ...(quote !== undefined ? { quote } : {}),
          ...(prefix !== undefined ? { prefix } : {}),
          ...(suffix !== undefined ? { suffix } : {}),
          ...(blockTextHash !== undefined ? { blockTextHash } : {}),
        },
      }
    }
  }
  if (
    target.selector.type === LEGACY_DOCUMENT_SELECTOR_TYPES.richTextRange &&
    target.selector.version === 1
  ) {
    const data = RangeSelectorDataSchema.safeParse(target.selector.data)
    if (data.success) {
      const { blockId, start, end, quote, prefix, suffix } = data.data
      return {
        kind: "resolved",
        target: {
          type: "text",
          docPath: target.path,
          blockId,
          ...(start !== undefined ? { start } : {}),
          ...(end !== undefined ? { end } : {}),
          ...(quote !== undefined ? { quote } : {}),
          ...(prefix !== undefined ? { prefix } : {}),
          ...(suffix !== undefined ? { suffix } : {}),
        },
      }
    }
  }
  return { kind: "unresolved", reason: "unsupported-selector", target }
}

export async function readDocumentAnnotationsV2(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
}): Promise<DocumentAnnotationFileV2 | null> {
  const path = documentAnnotationsV2Path(
    input.workspaceRoot,
    input.spaceId,
    input.documentId
  )
  if (!(await pathExists(path))) return null
  await requireRealDocumentStorageDirectory(input.workspaceRoot, dirname(path))
  const raw = JSON.parse(
    await readAtomicallyReplacedText(path, DOCUMENT_ANNOTATIONS_V2_MAX_BYTES)
  )
  const file = DocumentAnnotationFileV2Schema.parse(raw)
  requireSafeLegacyLogicalPath(file.logicalPath)
  if (file.revision !== annotationRevision(file)) {
    throw new Error("document annotation revision mismatch")
  }
  if (file.spaceId !== input.spaceId || file.documentId !== input.documentId) {
    throw new Error("document annotation identity mismatch")
  }
  if (
    file.annotations.some(
      (annotation) =>
        annotation.spaceId !== file.spaceId ||
        annotation.target.documentId !== file.documentId ||
        annotation.target.path !== file.logicalPath
    )
  ) {
    throw new Error("document annotation owner mismatch")
  }
  return file
}

function withDocumentAnnotationWriteLocks<T>(
  input: {
    workspaceRoot: string
    spaceId: string
    documentId: DocumentId
    legacyKind?: "docs" | "widgets"
  },
  path: string,
  operation: () => Promise<T>
): Promise<T> {
  const publish = () =>
    withCrossProcessLock(
      `${path}.lock`,
      { label: `Document ${input.documentId} annotations` },
      operation
    )
  return input.legacyKind
    ? withLegacyAnnotationStoreLock(
        { workspaceRoot: input.workspaceRoot, spaceId: input.spaceId },
        async () => {
          const result = await publish()
          // The Space-wide legacy lock remains held through this commit point:
          // failed validation or publication leaves V1 writable, while queued
          // V1 writers observe the marker before they can mutate.
          await markLegacyAnnotationStoreCutover(input)
          return result
        }
      )
    : publish()
}

export async function writeDocumentAnnotationsV2(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
  logicalPath: string
  annotations: DocumentAnnotationV2[]
  /** Include while switching an existing V1 annotation file to V2. */
  legacyKind?: "docs" | "widgets"
  expectedRevision?: string | null
  updatedAt?: string
}): Promise<DocumentAnnotationFileV2> {
  const path = documentAnnotationsV2Path(
    input.workspaceRoot,
    input.spaceId,
    input.documentId
  )
  return withLock(annotationLocks, path, async () => {
    await ensureRealDocumentStorageDirectory(
      input.workspaceRoot,
      documentDataV2Directory(
        input.workspaceRoot,
        input.spaceId,
        input.documentId
      )
    )
    return withDocumentAnnotationWriteLocks(input, path, async () => {
      const existing = await readDocumentAnnotationsV2(input)
      let currentRevision = existing?.revision ?? null
      if (!existing && input.legacyKind) {
        const compatible = await readCompatibleDocumentAnnotationsV2({
          ...input,
          legacyKind: input.legacyKind,
        })
        currentRevision = compatible.file.revision
      }
      if (
        input.expectedRevision !== undefined &&
        currentRevision !== input.expectedRevision
      ) {
        throw new Error("document annotations changed before write")
      }
      const logicalPath = input.legacyKind
        ? requireSafeLegacyLogicalPath(input.logicalPath)
        : requirePortableLogicalPath(input.logicalPath)
      const annotations = input.annotations.map((annotation) => {
        const parsed = DocumentAnnotationV2Schema.parse(annotation)
        if (
          parsed.spaceId !== input.spaceId ||
          parsed.target.documentId !== input.documentId ||
          parsed.target.path !== logicalPath
        ) {
          throw new Error("document annotation owner mismatch")
        }
        return parsed
      })
      const base = {
        type: "worktable.document-annotations" as const,
        version: 2 as const,
        spaceId: input.spaceId,
        documentId: input.documentId,
        logicalPath,
        updatedAt: input.updatedAt ?? new Date().toISOString(),
        annotations,
      }
      const normalizedBase = normalizeJsonValue(base) as Record<
        string,
        unknown
      >
      const file = DocumentAnnotationFileV2Schema.parse({
        ...normalizedBase,
        revision: annotationRevision(normalizedBase),
      })
      const serialized = `${JSON.stringify(file, null, 2)}\n`
      if (Buffer.byteLength(serialized, "utf8") > DOCUMENT_ANNOTATIONS_V2_MAX_BYTES) {
        throw new Error("document annotations exceed their size limit")
      }
      await atomicWriteText(path, serialized)
      return file
    })
  })
}

function legacyAnnotationPath(input: {
  workspaceRoot: string
  spaceId: string
  logicalPath: string
  legacyKind: "docs" | "widgets"
}): string {
  const spaceId = requireSafeLegacySpaceId(input.spaceId)
  const path = requireSafeLegacyLogicalPath(input.logicalPath)
  const root = resolve(
    input.workspaceRoot,
    "spaces",
    spaceId,
    "annotations",
    input.legacyKind
  )
  const file = resolve(root, `${path}.annotations.json`)
  const fromRoot = relative(root, file)
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error("legacy document annotation path escapes its store")
  }
  return file
}

export async function readCompatibleDocumentAnnotationsV2(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
  logicalPath: string
  legacyKind: "docs" | "widgets"
}): Promise<{ store: "v2" | "legacy-v1"; file: DocumentAnnotationFileV2 }> {
  const current = CanonicalIdSchema.safeParse(input.spaceId).success
    ? await readDocumentAnnotationsV2(input)
    : null
  if (current) return { store: "v2", file: current }

  const path = legacyAnnotationPath(input)
  if (!(await pathExists(path))) {
    return {
      store: "legacy-v1",
      file: emptyCompatibleDocumentAnnotationsV2(input),
    }
  }
  await requireRealDocumentStorageDirectory(input.workspaceRoot, dirname(path))
  const legacy = AnnotationFileSchema.parse(
    JSON.parse(
      await readBoundedRegularFile(path, DOCUMENT_ANNOTATIONS_V2_MAX_BYTES)
    )
  )
  if (legacy.spaceId !== input.spaceId) {
    throw new Error("legacy document annotation identity mismatch")
  }
  const annotations = legacy.annotations.map((annotation) => {
    const target = translateLegacyDocumentAnnotationTarget(annotation.target, {
      documentId: input.documentId,
      logicalPath: input.logicalPath,
    })
    if (!target) {
      throw new Error(
        `legacy annotation target cannot migrate: ${annotation.id}`
      )
    }
    return DocumentAnnotationV2Schema.parse({ ...annotation, target })
  })
  const base = {
    type: "worktable.document-annotations" as const,
    version: 2 as const,
    spaceId: input.spaceId,
    documentId: input.documentId,
    logicalPath: requireSafeLegacyLogicalPath(input.logicalPath),
    updatedAt: normalizedLegacyAnnotationTimestamp(legacy.updatedAt),
    annotations,
  }
  return {
    store: "legacy-v1",
    file: DocumentAnnotationFileV2Schema.parse({
      ...base,
      revision: annotationRevision(base),
    }),
  }
}

function emptyCompatibleDocumentAnnotationsV2(input: {
  spaceId: string
  documentId: DocumentId
  logicalPath: string
}): DocumentAnnotationFileV2 {
  const base = {
    type: "worktable.document-annotations" as const,
    version: 2 as const,
    spaceId: input.spaceId,
    documentId: input.documentId,
    logicalPath: requireSafeLegacyLogicalPath(input.logicalPath),
    updatedAt: new Date(0).toISOString(),
    annotations: [] as DocumentAnnotationV2[],
  }
  return DocumentAnnotationFileV2Schema.parse({
    ...base,
    revision: annotationRevision(base),
  })
}

function normalizedLegacyAnnotationTimestamp(value: string): string {
  return z.string().datetime().safeParse(value).success
    ? value
    : new Date(0).toISOString()
}

function normalizedStateEntries(
  entries: DocumentGenerationPayloadEntry[]
): Array<DocumentGenerationPayloadEntry & { sha256: string }> {
  if (
    entries.length === 0 ||
    entries.length > DOCUMENT_GENERATION_MAX_ENTRIES
  ) {
    throw new Error("document portable state has an invalid entry count")
  }
  const normalized = entries
    .map((entry) => {
      DocumentGenerationEntrySchema.shape.path.parse(entry.path)
      if (entry.bytes.byteLength > DOCUMENT_GENERATION_MAX_ENTRY_BYTES) {
        throw new Error(`document state entry is too large: ${entry.path}`)
      }
      return {
        ...entry,
        sha256: createHash("sha256").update(entry.bytes).digest("hex"),
      }
    })
    .sort((left, right) =>
      compareDocumentStorageText(left.path, right.path)
    )
  const seen = new Set<string>()
  for (const entry of normalized) {
    const comparisonPath = entry.path.toLocaleLowerCase("en-US")
    if (seen.has(comparisonPath)) {
      throw new Error(`duplicate document state entry: ${entry.path}`)
    }
    const segments = comparisonPath.split("/")
    let prefix = ""
    for (let index = 0; index < segments.length - 1; index += 1) {
      prefix = prefix ? `${prefix}/${segments[index]}` : segments[index]!
      if (seen.has(prefix)) {
        throw new Error("document state entry paths overlap")
      }
    }
    seen.add(comparisonPath)
  }
  const totalBytes = normalized.reduce(
    (total, entry) => total + entry.bytes.byteLength,
    0
  )
  if (totalBytes > DOCUMENT_GENERATION_MAX_TOTAL_BYTES) {
    throw new Error("document portable state exceeds its byte limit")
  }
  return normalized
}

function stateRevision(
  identity: {
    spaceId: string
    documentId: DocumentId
    logicalPath: string
    format: DocumentFormatClaim
    stateVersion: number
  },
  entries: Array<DocumentGenerationPayloadEntry & { sha256: string }>
): string {
  const hash = createHash("sha256")
  hash.update(`${JSON.stringify(sortedJson(identity))}\0`)
  for (const entry of entries) {
    hash.update(
      `state\0${entry.path}\0${entry.bytes.byteLength}\0${entry.sha256}\0`
    )
  }
  return hash.digest("hex")
}

async function writeStateEntry(
  root: string,
  entry: DocumentGenerationPayloadEntry
): Promise<void> {
  const path = join(root, "entries", entry.path)
  await ensureRealDocumentStorageDirectory(root, dirname(path))
  await writeFile(path, entry.bytes, { flag: "wx" })
}

async function readStateRevisionAt(
  root: string,
  registry: DocumentFormatRegistry
): Promise<ReadDocumentPortableStateV2Result> {
  await requireRealDocumentStorageDirectory(root, root)
  const manifest = DocumentPortableStateManifestV2Schema.parse(
    JSON.parse(
      await readBoundedRegularFile(
        join(root, "manifest.json"),
        DOCUMENT_GENERATION_MANIFEST_MAX_BYTES
      )
    )
  )
  await assertExactStateRevisionInventory(root, manifest)
  requirePortableLogicalPath(manifest.logicalPath)
  const registration = registry.get(manifest.format.id)
  if (
    !registration?.sourceVersions.includes(manifest.format.sourceVersion) ||
    registration.portableState === "none"
  ) {
    throw new Error("document format does not admit portable state")
  }
  const entries = await mapWithConcurrency(
    manifest.entries,
    DOCUMENT_PORTABLE_STATE_READ_CONCURRENCY,
    async (entry) => {
      const path = join(root, "entries", entry.path)
      await requireRealDocumentStorageDirectory(root, dirname(path))
      const bytes = await readBoundedRegularFileBytes(
        path,
        Math.min(entry.bytes, DOCUMENT_GENERATION_MAX_ENTRY_BYTES)
      )
      const hash = createHash("sha256").update(bytes).digest("hex")
      if (bytes.byteLength !== entry.bytes || hash !== entry.sha256) {
        throw new Error(`document state entry hash mismatch: ${entry.path}`)
      }
      return { path: entry.path, bytes }
    }
  )
  const totalBytes = entries.reduce(
    (total, entry) => total + entry.bytes.byteLength,
    0
  )
  const hashed = entries.map((entry) => ({
    ...entry,
    sha256: createHash("sha256").update(entry.bytes).digest("hex"),
  }))
  if (
    totalBytes !== manifest.totalBytes ||
    stateRevision(
      {
        spaceId: manifest.spaceId,
        documentId: manifest.documentId,
        logicalPath: manifest.logicalPath,
        format: manifest.format,
        stateVersion: manifest.stateVersion,
      },
      hashed
    ) !== manifest.revision
  ) {
    throw new Error("document portable state revision mismatch")
  }
  return { manifest, entries }
}

async function assertExactStateRevisionInventory(
  root: string,
  manifest: DocumentPortableStateManifestV2
): Promise<void> {
  const expected = new Map<string, "directory" | "file">([
    ["manifest.json", "file"],
    ["entries", "directory"],
  ])
  for (const entry of manifest.entries) {
    const segments = entry.path.split("/")
    let parent = "entries"
    for (const segment of segments.slice(0, -1)) {
      parent = `${parent}/${segment}`
      expected.set(parent, "directory")
    }
    expected.set(`entries/${entry.path}`, "file")
  }

  const observed = new Set<string>()
  const visit = async (relativeDirectory: string): Promise<void> => {
    const absoluteDirectory = relativeDirectory
      ? join(root, ...relativeDirectory.split("/"))
      : root
    const directory = await opendir(absoluteDirectory)
    for await (const entry of directory) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name
      if (entry.isSymbolicLink()) {
        throw new BoundedFileReadError(
          "symlink",
          join(root, ...relativePath.split("/"))
        )
      }
      const expectedKind = expected.get(relativePath)
      const actualKind = entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : null
      if (!expectedKind || actualKind !== expectedKind) {
        throw new Error(
          `document portable state contains an undeclared entry: ${relativePath}`
        )
      }
      observed.add(relativePath)
      if (actualKind === "directory") await visit(relativePath)
    }
  }
  await visit("")
  for (const path of expected.keys()) {
    if (!observed.has(path)) {
      throw new Error(
        `document portable state is missing a declared entry: ${path}`
      )
    }
  }
}

async function readStatePointer(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
}): Promise<string | null> {
  const path = documentPortableStateV2CurrentPath(
    input.workspaceRoot,
    input.spaceId,
    input.documentId
  )
  if (!(await pathExists(path))) return null
  await requireRealDocumentStorageDirectory(input.workspaceRoot, dirname(path))
  return DocumentPortableStatePointerV2Schema.parse(
    JSON.parse(await readAtomicallyReplacedText(path, 4096))
  ).revision
}

export async function readDocumentPortableStateV2(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
  registry?: DocumentFormatRegistry
}): Promise<ReadDocumentPortableStateV2Result | null> {
  const registry = input.registry ?? builtinFormatRegistry
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const revision = await readStatePointer(input)
    if (!revision) return null
    const root = documentPortableStateV2RevisionDirectory(
      input.workspaceRoot,
      input.spaceId,
      input.documentId,
      revision
    )
    try {
      await requireRealDocumentStorageDirectory(input.workspaceRoot, root)
      const state = await readStateRevisionAt(root, registry)
      if (
        state.manifest.spaceId !== input.spaceId ||
        state.manifest.documentId !== input.documentId ||
        state.manifest.revision !== revision
      ) {
        throw new Error("document portable state identity mismatch")
      }
      return state
    } catch (error) {
      // An opened revision can be pruned between its payload read and final
      // identity check. Retry only when the authoritative pointer advanced;
      // a stable missing, unreadable, or corrupt revision still fails closed.
      if (attempt > 0 || (await readStatePointer(input)) === revision) {
        throw error
      }
    }
  }
  throw new Error("document portable state changed while it was read")
}

export async function writeDocumentPortableStateV2(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
  logicalPath: string
  format: DocumentFormatClaim
  stateVersion: number
  entries: DocumentGenerationPayloadEntry[]
  registry?: DocumentFormatRegistry
  expectedRevision?: string | null
  updatedAt?: string
}): Promise<DocumentPortableStateManifestV2> {
  const registry = input.registry ?? builtinFormatRegistry
  const registration = registry.get(input.format.id)
  if (
    !registration?.sourceVersions.includes(input.format.sourceVersion) ||
    registration.portableState === "none"
  ) {
    throw new Error("document format does not admit portable state")
  }
  const stateRoot = documentPortableStateV2Directory(
    input.workspaceRoot,
    input.spaceId,
    input.documentId
  )
  return withLock(stateLocks, stateRoot, async () => {
    await ensureRealDocumentStorageDirectory(input.workspaceRoot, stateRoot)
    return withCrossProcessLock(
      join(stateRoot, ".write-lock"),
      { label: `Document ${input.documentId} portable state` },
      async () => {
        const priorRevision = await readStatePointer(input)
        if (
          input.expectedRevision !== undefined &&
          priorRevision !== input.expectedRevision
        ) {
          throw new Error("document portable state changed before write")
        }
        const logicalPath = requirePortableLogicalPath(input.logicalPath)
        const entries = normalizedStateEntries(input.entries)
        const revision = stateRevision(
          {
            spaceId: input.spaceId,
            documentId: input.documentId,
            logicalPath,
            format: input.format,
            stateVersion: input.stateVersion,
          },
          entries
        )
        const totalBytes = entries.reduce(
          (total, entry) => total + entry.bytes.byteLength,
          0
        )
        const manifest = DocumentPortableStateManifestV2Schema.parse({
          type: "worktable.document-state",
          version: 2,
          spaceId: input.spaceId,
          documentId: input.documentId,
          logicalPath,
          format: input.format,
          stateVersion: input.stateVersion,
          updatedAt: input.updatedAt ?? new Date().toISOString(),
          revision,
          entries: entries.map((entry) => ({
            path: entry.path,
            bytes: entry.bytes.byteLength,
            sha256: entry.sha256,
          })),
          totalBytes,
        })
        const revisionsRoot = join(stateRoot, "revisions")
        await ensureRealDocumentStorageDirectory(
          input.workspaceRoot,
          revisionsRoot
        )
        const destination = documentPortableStateV2RevisionDirectory(
          input.workspaceRoot,
          input.spaceId,
          input.documentId,
          revision
        )
        let storedManifest = manifest
        if (await pathExists(destination)) {
          const existing = await readStateRevisionAt(destination, registry)
          if (
            existing.manifest.documentId !== input.documentId ||
            existing.manifest.revision !== revision
          ) {
            throw new Error("document portable state revision collision")
          }
          storedManifest = existing.manifest
          if (priorRevision === revision) return storedManifest
        } else {
          const staging = await mkdtemp(join(revisionsRoot, ".pending-"))
          try {
            for (const entry of entries) await writeStateEntry(staging, entry)
            const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`
            if (
              Buffer.byteLength(serializedManifest, "utf8") >
              DOCUMENT_GENERATION_MANIFEST_MAX_BYTES
            ) {
              throw new Error("document portable state manifest is too large")
            }
            await writeFile(
              join(staging, "manifest.json"),
              serializedManifest,
              {
                encoding: "utf8",
                flag: "wx",
              }
            )
            const verified = await readStateRevisionAt(staging, registry)
            if (verified.manifest.revision !== revision) {
              throw new Error(
                "staged document portable state verification failed"
              )
            }
            await rename(staging, destination)
          } catch (error) {
            await rm(staging, { recursive: true, force: true })
            throw error
          }
        }
        await atomicWriteText(
          documentPortableStateV2CurrentPath(
            input.workspaceRoot,
            input.spaceId,
            input.documentId
          ),
          `${JSON.stringify(
            DocumentPortableStatePointerV2Schema.parse({
              type: "worktable.document-state-pointer",
              version: 2,
              revision,
            }),
            null,
            2
          )}\n`
        )
        const keep = new Set([
          revision,
          ...(DOCUMENT_PORTABLE_STATE_REVISIONS_KEPT > 1 && priorRevision
            ? [priorRevision]
            : []),
        ])
        // current.json is the commit point. The entire obsolete-revision
        // cleanup phase is best-effort so an enumeration or removal failure
        // cannot turn an already-published write into an ambiguous failure.
        await (async () => {
          for (const entry of await readdir(revisionsRoot, {
            withFileTypes: true,
          })) {
            if (
              entry.isDirectory() &&
              !entry.name.startsWith(".") &&
              !keep.has(entry.name)
            ) {
              await rm(join(revisionsRoot, entry.name), {
                recursive: true,
                force: true,
              })
            }
          }
        })().catch(() => undefined)
        return storedManifest
      }
    )
  })
}
