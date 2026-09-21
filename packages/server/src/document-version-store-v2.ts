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
import {
  CanonicalIdSchema,
  compareDocumentStorageText,
  DOCUMENT_GENERATION_MAX_ENTRIES,
  DOCUMENT_GENERATION_MAX_ENTRY_BYTES,
  DOCUMENT_GENERATION_MAX_TOTAL_BYTES,
  DocumentGenerationEntrySchema,
  DocumentGenerationManifestV2Schema,
  type DocumentFormatClaim,
  type DocumentGenerationManifestV2,
  type DocumentId,
  type DocumentProvenance,
} from "@worktable/types"
import {
  BoundedFileReadError,
  readBoundedRegularFile,
  readBoundedRegularFileBytes,
} from "./bounded-file.ts"
import { atomicWriteText } from "./atomic-file.ts"
import { mapWithConcurrency } from "./bounded-concurrency.ts"
import { analyzeDocumentPath, parseNewDocumentPath } from "./document-path.ts"
import {
  createBuiltinDocumentFormatRegistry,
  type DocumentFormatRegistry,
} from "./document-format-registry.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { requireSafeLegacySpaceId } from "./legacy-space-id.ts"
import { versionIdTimestamp } from "./version-store.ts"
import {
  documentGenerationV2Directory,
  documentVersionsV2Directory,
  ensureRealDocumentStorageDirectory,
  requireRealDocumentStorageDirectory,
} from "./workspace-storage-v2.ts"

export {
  DOCUMENT_GENERATION_MAX_ENTRIES,
  DOCUMENT_GENERATION_MAX_ENTRY_BYTES,
  DOCUMENT_GENERATION_MAX_TOTAL_BYTES,
} from "@worktable/types"
export const DOCUMENT_GENERATION_MANIFEST_MAX_BYTES = 4 * 1024 * 1024
const DOCUMENT_GENERATION_READ_CONCURRENCY = 32
export const DOCUMENT_GENERATION_DEFAULT_RETENTION = {
  maxNonCheckpointGenerations: 200,
  maxNonCheckpointBytes: 512 * 1024 * 1024,
} as const

export interface DocumentGenerationPayloadEntry {
  path: string
  bytes: Uint8Array
}

export interface DocumentGenerationPayloadSource {
  kind: "file" | "bundle"
  entries: DocumentGenerationPayloadEntry[]
}

export interface DocumentGenerationPayloadCompanion {
  key: string
  entries: DocumentGenerationPayloadEntry[]
}

export interface WriteDocumentGenerationV2Input {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
  generationId: string
  logicalPath: string
  format: DocumentFormatClaim
  operation: "create" | "update" | "checkpoint"
  createdAt: string
  createdBy: string
  source: string
  reason?: string
  provenance?: DocumentProvenance
  checkpoint?: DocumentGenerationManifestV2["checkpoint"]
  /** Promote the prior generation before this write releases the retention lock. */
  previousGenerationCheckpoint?: {
    generationId: string
    checkpoint: NonNullable<DocumentGenerationManifestV2["checkpoint"]>
  }
  authoredSource: DocumentGenerationPayloadSource
  companions?: DocumentGenerationPayloadCompanion[]
  registry?: DocumentFormatRegistry
}

export interface ReadDocumentGenerationV2Result {
  manifest: DocumentGenerationManifestV2
  authoredSource: {
    kind: "file" | "bundle"
    entries: Array<DocumentGenerationPayloadEntry>
  }
  companions: Array<DocumentGenerationPayloadCompanion>
}

const generationLocks = new Map<string, Promise<void>>()
const builtinFormatRegistry = createBuiltinDocumentFormatRegistry()

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

async function caseCollidingGeneration(
  parent: string,
  generationId: string
): Promise<string | null> {
  const folded = generationId.toLowerCase()
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      entry.name.toLowerCase() === folded
    ) {
      return entry.name
    }
  }
  return null
}

async function withDocumentGenerationLock<T>(
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = generationLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  generationLocks.set(key, tail)
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (generationLocks.get(key) === tail) generationLocks.delete(key)
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function normalizedPayloadEntries(
  entries: DocumentGenerationPayloadEntry[],
  expectedKind: "source" | "companion"
): Array<DocumentGenerationPayloadEntry & { sha256: string }> {
  if (entries.length === 0) {
    throw new Error(`document generation ${expectedKind} is empty`)
  }
  if (entries.length > DOCUMENT_GENERATION_MAX_ENTRIES) {
    throw new Error(
      `document generation ${expectedKind} exceeds its entry limit`
    )
  }
  const seen = new Set<string>()
  return entries
    .map((entry) => {
      DocumentGenerationEntrySchema.shape.path.parse(entry.path)
      if (seen.has(entry.path)) {
        throw new Error(`duplicate document generation entry: ${entry.path}`)
      }
      seen.add(entry.path)
      if (entry.bytes.byteLength > DOCUMENT_GENERATION_MAX_ENTRY_BYTES) {
        throw new Error(
          `document generation entry exceeds its byte limit: ${entry.path}`
        )
      }
      return { ...entry, sha256: sha256(entry.bytes) }
    })
    .sort((left, right) =>
      compareDocumentStorageText(left.path, right.path)
    )
}

function contentHash(input: {
  source: Array<DocumentGenerationPayloadEntry & { sha256: string }>
  companions: Array<{
    key: string
    entries: Array<DocumentGenerationPayloadEntry & { sha256: string }>
  }>
}): string {
  return documentGenerationManifestContentHash({
    authoredSource: {
      kind: "bundle",
      entries: input.source.map((entry) => ({
        path: entry.path,
        bytes: entry.bytes.byteLength,
        sha256: entry.sha256,
      })),
    },
    companions: input.companions.map((companion) => ({
      key: companion.key,
      entries: companion.entries.map((entry) => ({
        path: entry.path,
        bytes: entry.bytes.byteLength,
        sha256: entry.sha256,
      })),
    })),
  })
}

export function documentGenerationManifestContentHash(
  manifest: Pick<
    DocumentGenerationManifestV2,
    "authoredSource" | "companions"
  >
): string {
  const hash = createHash("sha256")
  for (const entry of manifest.authoredSource.entries) {
    hash.update(
      `source\0${entry.path}\0${entry.bytes}\0${entry.sha256}\0`
    )
  }
  for (const companion of manifest.companions) {
    for (const entry of companion.entries) {
      hash.update(
        `companion\0${companion.key}\0${entry.path}\0${entry.bytes}\0${entry.sha256}\0`
      )
    }
  }
  return hash.digest("hex")
}

export function expectedDocumentGenerationInventory(
  manifest: Pick<
    DocumentGenerationManifestV2,
    "authoredSource" | "companions"
  >
): ReadonlyMap<string, "directory" | "file"> {
  const expected = new Map<string, "directory" | "file">([
    ["manifest.json", "file"],
    ["source", "directory"],
  ])
  const addFile = (root: string, path: string) => {
    const segments = path.split("/")
    let parent = root
    for (const segment of segments.slice(0, -1)) {
      parent = `${parent}/${segment}`
      expected.set(parent, "directory")
    }
    expected.set(`${root}/${path}`, "file")
  }
  for (const entry of manifest.authoredSource.entries) {
    addFile("source", entry.path)
  }
  if (manifest.companions.length > 0) {
    expected.set("companions", "directory")
  }
  for (const companion of manifest.companions) {
    const root = `companions/${companion.key}`
    expected.set(root, "directory")
    for (const entry of companion.entries) addFile(root, entry.path)
  }
  return expected
}

export function assertDocumentGenerationFormatOwnership(
  manifest: Pick<DocumentGenerationManifestV2, "format" | "companions">,
  registry: DocumentFormatRegistry = builtinFormatRegistry
): void {
  const registration = registry.get(manifest.format.id)
  const allowedCompanions = new Set(
    registration?.sourceVersions.includes(manifest.format.sourceVersion)
      ? registration.versionedCompanionKeys
      : []
  )
  for (const companion of manifest.companions) {
    if (!allowedCompanions.has(companion.key)) {
      throw new Error(
        `document generation companion is not allowlisted: ${companion.key}`
      )
    }
  }
}

async function assertExactGenerationInventory(
  generationRoot: string,
  manifest: DocumentGenerationManifestV2
): Promise<void> {
  const expected = expectedDocumentGenerationInventory(manifest)
  const observed = new Set<string>()
  const visit = async (relativeDirectory: string): Promise<void> => {
    const absoluteDirectory = relativeDirectory
      ? join(generationRoot, ...relativeDirectory.split("/"))
      : generationRoot
    const directory = await opendir(absoluteDirectory)
    for await (const entry of directory) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name
      const expectedKind = expected.get(relativePath)
      if (entry.isSymbolicLink()) {
        throw new BoundedFileReadError(
          "symlink",
          join(generationRoot, ...relativePath.split("/"))
        )
      }
      const actualKind = entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : null
      if (!expectedKind || actualKind !== expectedKind) {
        throw new Error(
          `document generation contains an undeclared entry: ${relativePath}`
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
        `document generation is missing a declared entry: ${path}`
      )
    }
  }
}

function preparedGeneration(input: WriteDocumentGenerationV2Input): {
  manifest: DocumentGenerationManifestV2
  source: Array<DocumentGenerationPayloadEntry & { sha256: string }>
  companions: Array<{
    key: string
    entries: Array<DocumentGenerationPayloadEntry & { sha256: string }>
  }>
} {
  const parsedPath = parseNewDocumentPath(input.logicalPath)
  if ("error" in parsedPath || parsedPath.path !== input.logicalPath) {
    throw new Error("document generation logical path is not portable")
  }
  const source = normalizedPayloadEntries(
    input.authoredSource.entries,
    "source"
  )
  if (input.authoredSource.kind === "file" && source.length !== 1) {
    throw new Error("single-file document generation must contain one entry")
  }

  const registry = input.registry ?? builtinFormatRegistry
  const registered = registry.get(input.format.id)
  const allowed = new Set(
    registered?.sourceVersions.includes(input.format.sourceVersion)
      ? registered.versionedCompanionKeys
      : []
  )
  const companionKeys = new Set<string>()
  const companions = (input.companions ?? [])
    .map((companion) => {
      if (!allowed.has(companion.key)) {
        throw new Error(
          `document generation companion is not allowlisted: ${companion.key}`
        )
      }
      if (companionKeys.has(companion.key)) {
        throw new Error(
          `duplicate document generation companion: ${companion.key}`
        )
      }
      companionKeys.add(companion.key)
      return {
        key: companion.key,
        entries: normalizedPayloadEntries(companion.entries, "companion"),
      }
    })
    .sort((left, right) =>
      compareDocumentStorageText(left.key, right.key)
    )

  const entryCount =
    source.length +
    companions.reduce((count, companion) => count + companion.entries.length, 0)
  if (entryCount > DOCUMENT_GENERATION_MAX_ENTRIES) {
    throw new Error("document generation exceeds its total entry limit")
  }
  const totalBytes = [
    ...source,
    ...companions.flatMap((item) => item.entries),
  ].reduce((total, entry) => total + entry.bytes.byteLength, 0)
  if (totalBytes > DOCUMENT_GENERATION_MAX_TOTAL_BYTES) {
    throw new Error("document generation exceeds its total byte limit")
  }

  const manifest = DocumentGenerationManifestV2Schema.parse({
    type: "worktable.document-generation",
    version: 2,
    id: input.generationId,
    spaceId: input.spaceId,
    documentId: input.documentId,
    logicalPath: input.logicalPath,
    format: input.format,
    operation: input.operation,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    source: input.source,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.provenance ? { provenance: input.provenance } : {}),
    ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
    authoredSource: {
      kind: input.authoredSource.kind,
      entries: source.map((entry) => ({
        path: entry.path,
        bytes: entry.bytes.byteLength,
        sha256: entry.sha256,
      })),
    },
    companions: companions.map((companion) => ({
      key: companion.key,
      entries: companion.entries.map((entry) => ({
        path: entry.path,
        bytes: entry.bytes.byteLength,
        sha256: entry.sha256,
      })),
    })),
    totalBytes,
    contentHash: contentHash({ source, companions }),
  })
  return { manifest, source, companions }
}

async function writeEntry(
  generationRoot: string,
  relativePath: string,
  bytes: Uint8Array
): Promise<void> {
  const path = join(generationRoot, relativePath)
  await ensureRealDocumentStorageDirectory(generationRoot, dirname(path))
  await writeFile(path, bytes, { flag: "wx" })
}

async function writePreparedGeneration(
  staging: string,
  prepared: ReturnType<typeof preparedGeneration>
): Promise<void> {
  for (const entry of prepared.source) {
    await writeEntry(staging, join("source", entry.path), entry.bytes)
  }
  for (const companion of prepared.companions) {
    for (const entry of companion.entries) {
      await writeEntry(
        staging,
        join("companions", companion.key, entry.path),
        entry.bytes
      )
    }
  }
  const manifestBytes = `${JSON.stringify(prepared.manifest, null, 2)}\n`
  if (
    Buffer.byteLength(manifestBytes) > DOCUMENT_GENERATION_MANIFEST_MAX_BYTES
  ) {
    throw new Error("document generation manifest exceeds its byte limit")
  }
  // The manifest is the admission marker inside the staging generation and is
  // written only after every declared byte is durable in that directory.
  await writeFile(join(staging, "manifest.json"), manifestBytes, {
    encoding: "utf8",
    flag: "wx",
  })
}

async function realDirectory(path: string): Promise<void> {
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`document generation is not a real directory: ${path}`)
  }
}

async function readGenerationManifestAt(
  generationRoot: string
): Promise<DocumentGenerationManifestV2> {
  await realDirectory(generationRoot)
  const manifestText = new TextDecoder("utf-8", { fatal: true }).decode(
    await readBoundedRegularFileBytes(
      join(generationRoot, "manifest.json"),
      DOCUMENT_GENERATION_MANIFEST_MAX_BYTES
    )
  )
  const manifest = DocumentGenerationManifestV2Schema.parse(
    JSON.parse(manifestText)
  )
  const parsedPath = parseNewDocumentPath(manifest.logicalPath)
  if ("error" in parsedPath || parsedPath.path !== manifest.logicalPath) {
    throw new Error("document generation logical path is not portable")
  }
  return manifest
}

async function readEntry(
  root: string,
  entry: { path: string; bytes: number; sha256: string }
): Promise<DocumentGenerationPayloadEntry> {
  const path = join(root, entry.path)
  await requireRealDocumentStorageDirectory(root, dirname(path))
  const bytes = await readBoundedRegularFileBytes(
    path,
    Math.min(DOCUMENT_GENERATION_MAX_ENTRY_BYTES, entry.bytes)
  )
  if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
    throw new Error(`document generation entry hash mismatch: ${entry.path}`)
  }
  return { path: entry.path, bytes }
}

async function readGenerationAt(
  generationRoot: string,
  registry: DocumentFormatRegistry = builtinFormatRegistry
): Promise<ReadDocumentGenerationV2Result> {
  const manifest = await readGenerationManifestAt(generationRoot)
  await assertExactGenerationInventory(generationRoot, manifest)
  assertDocumentGenerationFormatOwnership(manifest, registry)
  const authoredEntries = await mapWithConcurrency(
    manifest.authoredSource.entries,
    DOCUMENT_GENERATION_READ_CONCURRENCY,
    (entry) => readEntry(join(generationRoot, "source"), entry)
  )
  const companions = []
  for (const companion of manifest.companions) {
    companions.push({
      key: companion.key,
      entries: await mapWithConcurrency(
        companion.entries,
        DOCUMENT_GENERATION_READ_CONCURRENCY,
        (entry) =>
          readEntry(join(generationRoot, "companions", companion.key), entry)
      ),
    })
  }
  const totalBytes = [
    ...authoredEntries,
    ...companions.flatMap((item) => item.entries),
  ].reduce((total, entry) => total + entry.bytes.byteLength, 0)
  const hashedSource = authoredEntries.map((entry) => ({
    ...entry,
    sha256: sha256(entry.bytes),
  }))
  const hashedCompanions = companions.map((companion) => ({
    key: companion.key,
    entries: companion.entries.map((entry) => ({
      ...entry,
      sha256: sha256(entry.bytes),
    })),
  }))
  if (
    totalBytes !== manifest.totalBytes ||
    contentHash({ source: hashedSource, companions: hashedCompanions }) !==
      manifest.contentHash
  ) {
    throw new Error("document generation content hash mismatch")
  }
  return {
    manifest,
    authoredSource: {
      kind: manifest.authoredSource.kind,
      entries: authoredEntries,
    },
    companions,
  }
}

function checkedRetention(retention: {
  maxNonCheckpointGenerations: number
  maxNonCheckpointBytes: number
  minimumCreatedAt?: string
}): {
  maxNonCheckpointGenerations: number
  maxNonCheckpointBytes: number
  minimumCreatedAt?: string
} {
  if (
    !Number.isSafeInteger(retention.maxNonCheckpointGenerations) ||
    retention.maxNonCheckpointGenerations < 1 ||
    !Number.isSafeInteger(retention.maxNonCheckpointBytes) ||
    retention.maxNonCheckpointBytes < 1 ||
    (retention.minimumCreatedAt !== undefined &&
      !Number.isFinite(Date.parse(retention.minimumCreatedAt)))
  ) {
    throw new Error("document generation retention budget is invalid")
  }
  return retention
}

async function pruneDocumentGenerationsAt(
  input: {
    workspaceRoot: string
    spaceId: string
    documentId: DocumentId
    registry?: DocumentFormatRegistry
  },
  retention: {
    maxNonCheckpointGenerations: number
    maxNonCheckpointBytes: number
    minimumCreatedAt?: string
  }
): Promise<number> {
  const manifests = await listDocumentGenerationsV2(input)
  const minimumCreatedAt = retention.minimumCreatedAt
    ? Date.parse(retention.minimumCreatedAt)
    : null
  let kept = 0
  let keptBytes = 0
  const remove: DocumentGenerationManifestV2[] = []
  const retained: DocumentGenerationManifestV2[] = []
  for (const manifest of manifests) {
    if (manifest.checkpoint?.meaningful) continue
    const withinCount = kept < retention.maxNonCheckpointGenerations
    const withinBytes =
      kept === 0 ||
      keptBytes + manifest.totalBytes <= retention.maxNonCheckpointBytes
    const withinAge =
      kept === 0 ||
      minimumCreatedAt === null ||
      Date.parse(manifest.createdAt) >= minimumCreatedAt
    if (withinCount && withinBytes && withinAge) {
      kept += 1
      keptBytes += manifest.totalBytes
      retained.push(manifest)
    } else {
      remove.push(manifest)
    }
  }
  if (remove.length > 0) {
    for (const manifest of retained) {
      const generation = await readGenerationAt(
        documentGenerationV2Directory(
          input.workspaceRoot,
          input.spaceId,
          input.documentId,
          manifest.id
        ),
        input.registry
      )
      if (
        generation.manifest.id !== manifest.id ||
        generation.manifest.spaceId !== input.spaceId ||
        generation.manifest.documentId !== input.documentId
      ) {
        throw new Error("document generation identity mismatch")
      }
    }
  }
  for (const manifest of remove) {
    await rm(
      documentGenerationV2Directory(
        input.workspaceRoot,
        input.spaceId,
        input.documentId,
        manifest.id
      ),
      { recursive: true, force: true }
    )
  }
  return remove.length
}

export async function writeDocumentGenerationV2(
  input: WriteDocumentGenerationV2Input
): Promise<DocumentGenerationManifestV2> {
  const prepared = preparedGeneration(input)
  const parent = documentVersionsV2Directory(
    input.workspaceRoot,
    input.spaceId,
    input.documentId
  )
  return withDocumentGenerationLock(parent, async () => {
    await ensureRealDocumentStorageDirectory(input.workspaceRoot, parent)
    return withCrossProcessLock(
      join(parent, ".write-lock"),
      { label: `Document ${input.documentId} version history` },
      async () => {
        const destination = documentGenerationV2Directory(
          input.workspaceRoot,
          input.spaceId,
          input.documentId,
          input.generationId
        )
        const collision = await caseCollidingGeneration(
          parent,
          input.generationId
        )
        if (collision) {
          throw new Error(
            `document generation already exists: ${collision}`
          )
        }
        const staging = await mkdtemp(join(parent, ".pending-"))
        try {
          await writePreparedGeneration(staging, prepared)
          const verified = await readGenerationAt(staging, input.registry)
          if (verified.manifest.contentHash !== prepared.manifest.contentHash) {
            throw new Error("staged document generation verification failed")
          }
          await rename(staging, destination)
          if (input.previousGenerationCheckpoint) {
            await markDocumentGenerationCheckpointAt({
              workspaceRoot: input.workspaceRoot,
              spaceId: input.spaceId,
              documentId: input.documentId,
              generationId: input.previousGenerationCheckpoint.generationId,
              checkpoint: input.previousGenerationCheckpoint.checkpoint,
              registry: input.registry,
            })
          }
          return prepared.manifest
        } catch (error) {
          await rm(staging, { recursive: true, force: true })
          throw error
        }
      }
    )
  })
}

/** Caller owns both the in-process generation lock and cross-process lock. */
async function markDocumentGenerationCheckpointAt(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
  generationId: string
  checkpoint: NonNullable<DocumentGenerationManifestV2["checkpoint"]>
  registry?: DocumentFormatRegistry
}): Promise<boolean> {
  const generationRoot = documentGenerationV2Directory(
    input.workspaceRoot,
    input.spaceId,
    input.documentId,
    input.generationId
  )
  if (!(await pathExists(generationRoot))) return false
  await requireRealDocumentStorageDirectory(input.workspaceRoot, generationRoot)
  const current = await readGenerationAt(generationRoot, input.registry)
  if (
    current.manifest.id !== input.generationId ||
    current.manifest.spaceId !== input.spaceId ||
    current.manifest.documentId !== input.documentId
  ) {
    throw new Error("document generation identity mismatch")
  }
  if (current.manifest.checkpoint?.meaningful) return true
  const updated = DocumentGenerationManifestV2Schema.parse({
    ...current.manifest,
    checkpoint: input.checkpoint,
  })
  if (
    updated.contentHash !== current.manifest.contentHash ||
    documentGenerationManifestContentHash(updated) !==
      current.manifest.contentHash
  ) {
    throw new Error("document checkpoint changed generation content")
  }
  const manifestBytes = `${JSON.stringify(updated, null, 2)}\n`
  if (
    Buffer.byteLength(manifestBytes) > DOCUMENT_GENERATION_MANIFEST_MAX_BYTES
  ) {
    throw new Error("document generation manifest exceeds its byte limit")
  }
  await atomicWriteText(join(generationRoot, "manifest.json"), manifestBytes)
  const verified = await readGenerationAt(generationRoot, input.registry)
  if (
    verified.manifest.contentHash !== current.manifest.contentHash ||
    verified.manifest.checkpoint?.meaningful !== true
  ) {
    throw new Error("document checkpoint verification failed")
  }
  return true
}

/**
 * Promote an immutable generation to a meaningful checkpoint without changing
 * any captured source bytes. The manifest rewrite is serialized with version
 * creation and retention both in-process and across Worktable processes.
 */
export async function markDocumentGenerationCheckpointV2(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
  generationId: string
  checkpoint: NonNullable<DocumentGenerationManifestV2["checkpoint"]>
  registry?: DocumentFormatRegistry
}): Promise<boolean> {
  const parent = documentVersionsV2Directory(
    input.workspaceRoot,
    input.spaceId,
    input.documentId
  )
  return withDocumentGenerationLock(parent, async () => {
    if (!(await pathExists(parent))) return false
    await requireRealDocumentStorageDirectory(input.workspaceRoot, parent)
    return withCrossProcessLock(
      join(parent, ".write-lock"),
      { label: `Document ${input.documentId} version checkpoint` },
      async () =>
        markDocumentGenerationCheckpointAt({
          workspaceRoot: input.workspaceRoot,
          spaceId: input.spaceId,
          documentId: input.documentId,
          generationId: input.generationId,
          checkpoint: input.checkpoint,
          registry: input.registry,
        })
    )
  })
}

export async function readDocumentGenerationV2(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
  generationId: string
  registry?: DocumentFormatRegistry
}): Promise<ReadDocumentGenerationV2Result | null> {
  const root = documentGenerationV2Directory(
    input.workspaceRoot,
    input.spaceId,
    input.documentId,
    input.generationId
  )
  if (!(await pathExists(root))) return null
  await requireRealDocumentStorageDirectory(input.workspaceRoot, root)
  const result = await readGenerationAt(root, input.registry)
  if (
    result.manifest.id !== input.generationId ||
    result.manifest.spaceId !== input.spaceId ||
    result.manifest.documentId !== input.documentId
  ) {
    throw new Error("document generation identity mismatch")
  }
  return result
}

export async function listDocumentGenerationsV2(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
  registry?: DocumentFormatRegistry
  checkpointsOnly?: boolean
}): Promise<DocumentGenerationManifestV2[]> {
  const root = documentVersionsV2Directory(
    input.workspaceRoot,
    input.spaceId,
    input.documentId
  )
  if (!(await pathExists(root))) return []
  await requireRealDocumentStorageDirectory(input.workspaceRoot, root)
  const manifests: DocumentGenerationManifestV2[] = []
  const foldedIds = new Set<string>()
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue
    const folded = entry.name.toLowerCase()
    if (foldedIds.has(folded)) {
      throw new Error("document generation IDs collide across filesystems")
    }
    foldedIds.add(folded)
    const generationRoot = documentGenerationV2Directory(
      input.workspaceRoot,
      input.spaceId,
      input.documentId,
      entry.name
    )
    const manifest = await readGenerationManifestAt(generationRoot)
    if (
      manifest.id !== entry.name ||
      manifest.spaceId !== input.spaceId ||
      manifest.documentId !== input.documentId
    ) {
      throw new Error("document generation identity mismatch")
    }
    if (input.checkpointsOnly && manifest.checkpoint?.meaningful !== true) {
      continue
    }
    manifests.push(manifest)
  }
  return manifests.sort(compareCreatedAtNewestFirst)
}

export async function pruneDocumentGenerationsV2(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
  registry?: DocumentFormatRegistry
  retention?: {
    maxNonCheckpointGenerations: number
    maxNonCheckpointBytes: number
    minimumCreatedAt?: string
  }
  authorizeRetention?: () => boolean
}): Promise<number> {
  const parent = documentVersionsV2Directory(
    input.workspaceRoot,
    input.spaceId,
    input.documentId
  )
  return withDocumentGenerationLock(parent, async () => {
    if (!(await pathExists(parent))) return 0
    await requireRealDocumentStorageDirectory(input.workspaceRoot, parent)
    return withCrossProcessLock(
      join(parent, ".write-lock"),
      { label: `Document ${input.documentId} version retention` },
      async () => {
        if (input.authorizeRetention && !input.authorizeRetention()) return 0
        return await pruneDocumentGenerationsAt(
          input,
          checkedRetention(
            input.retention ?? DOCUMENT_GENERATION_DEFAULT_RETENTION
          )
        )
      }
    )
  })
}

export type LegacyDocumentVersionKind = "docs" | "widgets"

export interface LegacyDocumentVersionLocator {
  kind: LegacyDocumentVersionKind
  key: string
}

export interface CompatibleDocumentVersionSummary {
  store: "v2" | "legacy-v1"
  legacyKind?: LegacyDocumentVersionKind
  id: string
  createdAt: string
  createdBy: string
  source: string
  reason?: string
  operation: "create" | "update" | "checkpoint"
  checkpoint?: DocumentGenerationManifestV2["checkpoint"]
}

export type CompatibleDocumentVersion =
  | {
      store: "v2"
      generation: ReadDocumentGenerationV2Result
    }
  | {
      store: "legacy-v1"
      legacyKind: LegacyDocumentVersionKind
      snapshot: Record<string, unknown>
    }

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function compareCreatedAtNewestFirst(
  left: { id: string; createdAt: string },
  right: { id: string; createdAt: string }
): number {
  const byTime = Date.parse(right.createdAt) - Date.parse(left.createdAt)
  return byTime || compareDocumentStorageText(right.id, left.id)
}

function legacyVersionDirectory(input: {
  workspaceRoot: string
  spaceId: string
  locator: LegacyDocumentVersionLocator
}): string {
  const spaceId = requireSafeLegacySpaceId(input.spaceId)
  const analysis = analyzeDocumentPath(input.locator.key)
  if (!analysis.safe || !analysis.canonicalPath) {
    throw new Error("legacy document version key is unsafe")
  }
  const root = resolve(
    input.workspaceRoot,
    "versions",
    spaceId,
    input.locator.kind
  )
  const directory = resolve(root, input.locator.key)
  const fromRoot = relative(root, directory)
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error("legacy document version key escapes its store")
  }
  return directory
}

function compatibleCheckpoint(
  value: unknown
): DocumentGenerationManifestV2["checkpoint"] {
  if (value === undefined) return undefined
  if (!object(value)) throw new Error("legacy version checkpoint is invalid")
  const legacyLabel = value["label"]
  let projectedLabel = ""
  if (typeof legacyLabel === "string") {
    for (const character of legacyLabel) {
      if (projectedLabel.length + character.length > 200) break
      projectedLabel += character
    }
  }
  const parsed = DocumentGenerationManifestV2Schema.shape.checkpoint.safeParse({
    meaningful: value["meaningful"],
    kind: value["kind"],
    ...(typeof legacyLabel === "string" ? { label: projectedLabel } : {}),
    ...(typeof value["sourceCategory"] === "string"
      ? { sourceCategory: value["sourceCategory"] }
      : {}),
    ...(object(value["transition"]) ? { transition: value["transition"] } : {}),
  })
  if (!parsed.success) throw new Error("legacy version checkpoint is invalid")
  return parsed.data
}

function legacyVersionSummary(
  snapshot: Record<string, unknown>,
  locator: LegacyDocumentVersionLocator,
  expectedId: string
): CompatibleDocumentVersionSummary {
  const expectedType =
    locator.kind === "docs"
      ? "worktable.doc-version"
      : "worktable.widget-version"
  const identityKey = locator.kind === "docs" ? "docPath" : "widgetId"
  if (
    snapshot["type"] !== expectedType ||
    snapshot["version"] !== 1 ||
    snapshot["id"] !== expectedId ||
    snapshot[identityKey] !== locator.key ||
    typeof snapshot["createdAt"] !== "string" ||
    typeof snapshot["createdBy"] !== "string" ||
    typeof snapshot["source"] !== "string" ||
    (snapshot["operation"] !== "create" &&
      snapshot["operation"] !== "update" &&
      snapshot["operation"] !== "checkpoint") ||
    !object(snapshot["after"])
  ) {
    throw new Error(`legacy document version is invalid: ${expectedId}`)
  }
  return {
    store: "legacy-v1",
    legacyKind: locator.kind,
    id: expectedId,
    createdAt: Number.isNaN(Date.parse(snapshot["createdAt"]))
      ? new Date(versionIdTimestamp(expectedId) ?? 0).toISOString()
      : snapshot["createdAt"],
    createdBy: snapshot["createdBy"],
    source: snapshot["source"],
    ...(typeof snapshot["reason"] === "string"
      ? { reason: snapshot["reason"] }
      : {}),
    operation: snapshot["operation"],
    ...(snapshot["checkpoint"] !== undefined
      ? { checkpoint: compatibleCheckpoint(snapshot["checkpoint"]) }
      : {}),
  }
}

async function readLegacyDocumentVersionAt(input: {
  workspaceRoot: string
  spaceId: string
  locator: LegacyDocumentVersionLocator
  versionId: string
}): Promise<{
  summary: CompatibleDocumentVersionSummary
  snapshot: Record<string, unknown>
} | null> {
  const versionId = requireSafeLegacyVersionId(input.versionId)
  const directory = legacyVersionDirectory(input)
  if (!(await pathExists(directory))) return null
  await requireRealDocumentStorageDirectory(input.workspaceRoot, directory)
  const path = join(directory, `${versionId}.json`)
  if (!(await pathExists(path))) return null
  const parsed = JSON.parse(
    await readBoundedRegularFile(path, DOCUMENT_GENERATION_MAX_TOTAL_BYTES)
  )
  if (!object(parsed)) {
    throw new Error(`legacy document version is invalid: ${versionId}`)
  }
  if (parsed["spaceId"] !== input.spaceId) {
    throw new Error(`legacy document version identity mismatch: ${versionId}`)
  }
  return {
    summary: legacyVersionSummary(parsed, input.locator, versionId),
    snapshot: parsed,
  }
}

function requireSafeLegacyVersionId(versionId: string): string {
  if (
    versionId.length === 0 ||
    versionId.length > 200 ||
    versionId === "." ||
    versionId === ".." ||
    versionId.includes("/") ||
    versionId.includes("\\") ||
    versionId.includes("\0")
  ) {
    throw new Error("legacy document version ID is unsafe")
  }
  return versionId
}

export async function listLegacyDocumentVersionsV1(input: {
  workspaceRoot: string
  spaceId: string
  locator: LegacyDocumentVersionLocator
  checkpointsOnly?: boolean
}): Promise<CompatibleDocumentVersionSummary[]> {
  const directory = legacyVersionDirectory(input)
  if (!(await pathExists(directory))) return []
  await requireRealDocumentStorageDirectory(input.workspaceRoot, directory)
  const summaries: CompatibleDocumentVersionSummary[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue
    const versionId = entry.name.slice(0, -".json".length)
    const result = await readLegacyDocumentVersionAt({
      ...input,
      versionId,
    }).catch(() => null)
    if (!result) continue
    if (input.checkpointsOnly && !result.summary.checkpoint?.meaningful) {
      continue
    }
    summaries.push(result.summary)
  }
  return summaries.sort(compareCreatedAtNewestFirst)
}

export async function listCompatibleDocumentVersionsV2(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
  legacy?: LegacyDocumentVersionLocator
  checkpointsOnly?: boolean
}): Promise<CompatibleDocumentVersionSummary[]> {
  const currentManifests = CanonicalIdSchema.safeParse(input.spaceId).success
    ? await listDocumentGenerationsV2(input)
    : []
  const current = currentManifests.map(
    (manifest): CompatibleDocumentVersionSummary => ({
      store: "v2",
      id: manifest.id,
      createdAt: manifest.createdAt,
      createdBy: manifest.createdBy,
      source: manifest.source,
      ...(manifest.reason ? { reason: manifest.reason } : {}),
      operation: manifest.operation,
      ...(manifest.checkpoint ? { checkpoint: manifest.checkpoint } : {}),
    })
  )
  const legacy = input.legacy
    ? await listLegacyDocumentVersionsV1({
        ...input,
        locator: input.legacy,
      })
    : []
  const seen = new Set<string>()
  return [...current, ...legacy]
    .filter((entry) => {
      if (seen.has(entry.id)) return false
      seen.add(entry.id)
      return true
    })
    .filter(
      (entry) => !input.checkpointsOnly || entry.checkpoint?.meaningful === true
    )
    .sort(compareCreatedAtNewestFirst)
}

export async function readCompatibleDocumentVersionV2(input: {
  workspaceRoot: string
  spaceId: string
  documentId: DocumentId
  versionId: string
  store: "v2" | "legacy-v1"
  registry?: DocumentFormatRegistry
  legacy?: LegacyDocumentVersionLocator
}): Promise<CompatibleDocumentVersion | null> {
  if (input.store === "v2") {
    const generation = await readDocumentGenerationV2({
      ...input,
      generationId: input.versionId,
    })
    return generation ? { store: "v2", generation } : null
  }
  if (!input.legacy) {
    throw new Error("legacy document version locator is required")
  }
  const legacy = await readLegacyDocumentVersionAt({
    ...input,
    locator: input.legacy,
  })
  return legacy
    ? {
        store: "legacy-v1",
        legacyKind: input.legacy.kind,
        snapshot: legacy.snapshot,
      }
    : null
}
