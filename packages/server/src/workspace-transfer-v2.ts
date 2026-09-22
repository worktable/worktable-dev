import { mapWithConcurrency } from "./bounded-concurrency.ts"
import { createHash, randomBytes } from "node:crypto"
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
} from "node:fs"
import type { Stats } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  utimes,
} from "node:fs/promises"
import { Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path"
import { promisify } from "node:util"
import { JSDOM } from "jsdom"
import * as yauzl from "yauzl"
import * as yazl from "yazl"
import {
  DocumentGenerationManifestV2Schema,
  type DocumentGenerationManifestV2,
} from "@worktable/types"
import { ensureAppDir, getAppDir } from "./app-storage.ts"
import { isAtomicWriteTemporaryFileName } from "./atomic-file.ts"
import { blocksToMarkdownSafe } from "./markdown.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { readBoundedRegularFile } from "./bounded-file.ts"
import {
  assertDocumentGenerationFormatOwnership,
  documentGenerationManifestContentHash,
  expectedDocumentGenerationInventory,
} from "./document-version-store-v2.ts"
import { versionIdTimestamp } from "./version-store.ts"
import { removeWorkspaceTree } from "./workspace-tree-cleanup.ts"
import {
  classifyWorkspaceTarget,
  getWorkspaceRoot,
  isIgnoredEmptyWorkspaceEntry,
  isWorkspaceManifest,
  writeWorkspaceManifestBytesAt,
  type WorkspaceManifest,
} from "./workspace.ts"

export const WORKSPACE_EXPORT_V2_TYPE = "worktable.workspace-export" as const
export const WORKSPACE_EXPORT_V2_VERSION = 2 as const
export const WORKSPACE_EXPORT_V2_MEDIA_TYPE =
  "application/vnd.worktable.workspace+zip" as const
export const WORKSPACE_EXPORT_V2_EXTENSION = ".wtb" as const

// These are the supported product envelope, not theoretical ZIP ceilings.
// They leave substantial headroom over a large daily workspace while bounding
// upload time, replacement staging, manifest memory, and decompression work.
export const WORKSPACE_EXPORT_V2_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
export const WORKSPACE_EXPORT_V2_MAX_EXPANDED_BYTES = 8 * 1024 * 1024 * 1024
export const WORKSPACE_EXPORT_V2_MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
export const WORKSPACE_EXPORT_V2_MAX_WORKSPACE_ENTRIES = 100_000
export const WORKSPACE_EXPORT_V2_MAX_ARCHIVE_ENTRIES = 200_000
export const WORKSPACE_EXPORT_V2_MAX_MANIFEST_BYTES = 32 * 1024 * 1024
export const WORKSPACE_EXPORT_V2_MAX_WORKSPACE_MANIFEST_BYTES = 1024 * 1024
const WORKSPACE_EXPORT_V2_MAX_ARCHIVE_EXPANDED_BYTES =
  WORKSPACE_EXPORT_V2_MAX_EXPANDED_BYTES + 128 * 1024 * 1024

const DAY_MS = 24 * 60 * 60 * 1000
const HISTORY_CLASSIFICATION_MAX_BYTES = 16 * 1024 * 1024
const HISTORY_CLASSIFICATION_CONCURRENCY = 8
const VIEWER_MAX_RENDER_FILE_BYTES = 16 * 1024 * 1024
const VIEWER_MAX_GENERATED_BYTES = 64 * 1024 * 1024
const VIEWER_MAX_LISTED_FILES = 20_000
const VIEWER_MAX_TITLE_BYTES = 512
const EXPORT_CAPTURE_LOCK_TIMEOUT_MS = 30_000
const SECURE_READ_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_NOFOLLOW ?? 0) |
  (fsConstants.O_NONBLOCK ?? 0)

export type WorkspaceExportHistoryPolicy =
  | { mode: "all" }
  | { mode: "age"; maxAgeDays: number }
  | { mode: "count"; maxPerItem: number }
  | { mode: "none" }

export interface WorkspaceExportV2File {
  path: string
  size: number
  mode: number
  mtime: string
  sha256: string
}

export interface WorkspaceExportV2Directory {
  path: string
  mode: number
  mtime: string
}

export interface WorkspaceExportV2Manifest {
  type: typeof WORKSPACE_EXPORT_V2_TYPE
  version: typeof WORKSPACE_EXPORT_V2_VERSION
  exportId: string
  exportedAt: string
  generator: {
    version: string
  }
  archive: {
    root: string
    container: "zip"
    compression: "deflate"
  }
  source: {
    workspaceId: string
    workspaceName: string
  }
  history: {
    requested: WorkspaceExportHistoryPolicy
    complete: boolean
    includedFiles: number
    includedBytes: number
    omittedFiles: number
    omittedBytes: number
    meaningfulCheckpoints: number
    oldestIncludedAt?: string
    newestIncludedAt?: string
    warnings: string[]
  }
  integrity: {
    sourceCheckpoint: string
    contentCheckpoint: string
    directories: WorkspaceExportV2Directory[]
    files: WorkspaceExportV2File[]
  }
  viewer: {
    status: "complete" | "partial" | "failed"
    warnings: string[]
  }
}

export interface WorkspaceExportV2Result {
  manifest: WorkspaceExportV2Manifest
  destination: string
  bytes: number
  sha256: string
}

export interface WorkspaceExportV2Inspection {
  manifest: WorkspaceExportV2Manifest
  archivePath: string
  archiveBytes: number
  archiveSha256: string
}

interface SourceEntry {
  path: string
  absolute: string
  kind: "directory" | "file"
  size: number
  mode: number
  mtime: Date
  dev: number
  ino: number
  ctimeMs: number
  mtimeMs: number
}

interface SourceRootIdentity {
  absolute: string
  canonical: string
  dev: number
  ino: number
  ctimeMs: number
  mtimeMs: number
  mode: number
}

interface SourceInventory {
  root: SourceRootIdentity
  entries: SourceEntry[]
}

interface VersionCandidate extends SourceEntry {
  kind: "file"
  group: string
  unit: string
  id: string
  timestamp: number | null
  meaningful: boolean
  classified: boolean
}

interface CapturedEntry extends WorkspaceExportV2File {
  absolute: string
}

interface ViewerSourceEntry {
  path: string
  size: number
}

interface ArchiveEntry {
  entry: yauzl.Entry
  path: string
  directory: boolean
}

let historyClassificationHookForTests:
  | ((entry: { path: string; size: number }) => Promise<void>)
  | null = null
let captureEntryHookForTests:
  | ((entry: { path: string; kind: "directory" | "file" }) => Promise<void>)
  | null = null
let beforePublishHookForTests: (() => Promise<void>) | null = null
let viewerGeneratedLimitForTests: number | null = null
let archiveLimitForTests: number | null = null
let manifestLimitForTests: number | null = null
let pipelineStartHookForTests: (() => void) | null = null
let captureRemovalHookForTests: (() => Promise<void>) | null = null

export function setHistoryClassificationHookForTests(
  hook: ((entry: { path: string; size: number }) => Promise<void>) | null
): void {
  historyClassificationHookForTests = hook
}

export function setWorkspaceExportCaptureHookForTests(
  hook:
    | ((entry: { path: string; kind: "directory" | "file" }) => Promise<void>)
    | null
): void {
  captureEntryHookForTests = hook
}

export function setWorkspaceExportBeforePublishHookForTests(
  hook: (() => Promise<void>) | null
): void {
  beforePublishHookForTests = hook
}

export function setWorkspaceExportViewerGeneratedLimitForTests(
  bytes: number | null
): void {
  viewerGeneratedLimitForTests = bytes
}

export function setWorkspaceExportArchiveLimitForTests(
  bytes: number | null
): void {
  archiveLimitForTests = bytes
}

export function setWorkspaceExportManifestLimitForTests(
  bytes: number | null
): void {
  manifestLimitForTests = bytes
}

export function setWorkspaceExportPipelineStartHookForTests(
  hook: (() => void) | null
): void {
  pipelineStartHookForTests = hook
}

export function setWorkspaceExportCaptureRemovalHookForTests(
  hook: (() => Promise<void>) | null
): void {
  captureRemovalHookForTests = hook
}

class WorkspaceChangedDuringExportError extends Error {
  constructor(path: string) {
    super(`workspace changed during export: ${path}; retry`)
    this.name = "WorkspaceChangedDuringExportError"
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex")
}

/**
 * Portable manifests are ordered by Unicode code point, never by the host
 * locale. For valid scalar values this is also UTF-8 byte order. The order is
 * part of the checkpoint contract and must be identical across local, hosted,
 * Linux, macOS, and Windows importers.
 */
function comparePortableText(left: string, right: string): number {
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCodePoint = left.codePointAt(leftIndex)!
    const rightCodePoint = right.codePointAt(rightIndex)!
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint < rightCodePoint ? -1 : 1
    }
    leftIndex += leftCodePoint > 0xffff ? 2 : 1
    rightIndex += rightCodePoint > 0xffff ? 2 : 1
  }
  if (leftIndex === left.length && rightIndex === right.length) return 0
  return leftIndex === left.length ? -1 : 1
}

function canonicalCheckpoint(
  directories: WorkspaceExportV2Directory[],
  files: WorkspaceExportV2File[]
): string {
  // A portable content identity must survive filesystem timestamp precision,
  // permission-model, and umask differences. Mode and mtime remain useful
  // best-effort extraction metadata, but are deliberately not integrity.
  return sha256(
    JSON.stringify({
      directories: directories.map(({ path }) => ({ path })),
      files: files.map(({ path, size, sha256: hash }) => ({
        path,
        size,
        sha256: hash,
      })),
    })
  )
}

function validateWorkspaceExportSource(value: unknown): {
  workspaceId: string
  workspaceName: string
} {
  if (!value || typeof value !== "object") {
    throw new Error("workspace package source identity is invalid")
  }
  const source = value as Record<string, unknown>
  if (
    typeof source["workspaceId"] !== "string" ||
    source["workspaceId"].trim().length === 0 ||
    Buffer.byteLength(source["workspaceId"], "utf8") > 500 ||
    typeof source["workspaceName"] !== "string" ||
    source["workspaceName"].trim().length === 0 ||
    Buffer.byteLength(source["workspaceName"], "utf8") > 500
  ) {
    throw new Error("workspace package source identity is invalid")
  }
  return {
    workspaceId: source["workspaceId"],
    workspaceName: source["workspaceName"],
  }
}

function assertPortableOwnerAccess(
  directories: Array<Pick<WorkspaceExportV2Directory, "path" | "mode">>,
  files: Array<Pick<WorkspaceExportV2File, "path" | "mode">>
): void {
  for (const directory of directories) {
    const required = directory.path === "." ? 0o700 : 0o500
    if ((directory.mode & required) !== required) {
      throw new Error(
        `workspace directory is not owner-accessible for portability: ${directory.path}`
      )
    }
  }
  for (const file of files) {
    if ((file.mode & 0o400) !== 0o400) {
      throw new Error(
        `workspace file is not owner-readable for portability: ${file.path}`
      )
    }
  }
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  )
}

function portablePath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/")
}

/** Resolve symlinks in the existing prefix without requiring the leaf to exist. */
async function canonicalPotentialPath(value: string): Promise<string> {
  const missing: string[] = []
  let cursor = value
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missing.reverse())
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error
      }
      const parent = dirname(cursor)
      if (parent === cursor) throw error
      missing.push(basename(cursor))
      cursor = parent
    }
  }
}

export function validateWorkspaceExportV2Path(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 1024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.normalize("NFC") !== value
  ) {
    throw new Error("workspace package contains an invalid path")
  }
  const normalized = posix.normalize(value)
  const parts = value.split("/")
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    parts.some(
      (part) =>
        Buffer.byteLength(part, "utf8") > 255 ||
        // Windows rejects these characters and control bytes in path
        // components, even though Unix filesystems permit them.
        // eslint-disable-next-line no-control-regex -- portable paths exclude C0 controls
        /[<>:"|?*\u0000-\u001f]/u.test(part) ||
        /[. ]$/u.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)
    )
  ) {
    throw new Error(`workspace package contains an unsafe path: ${value}`)
  }
  return value
}

function validateHistoryPolicy(
  policy: WorkspaceExportHistoryPolicy
): WorkspaceExportHistoryPolicy {
  switch (policy.mode) {
    case "all":
    case "none":
      return policy
    case "age":
      if (
        !Number.isInteger(policy.maxAgeDays) ||
        policy.maxAgeDays < 1 ||
        policy.maxAgeDays > 36_500
      ) {
        throw new Error("history age must be between 1 and 36500 days")
      }
      return policy
    case "count":
      if (
        !Number.isInteger(policy.maxPerItem) ||
        policy.maxPerItem < 1 ||
        policy.maxPerItem > 10_000
      ) {
        throw new Error("history count must be between 1 and 10000 per item")
      }
      return policy
    default:
      throw new Error("workspace package uses an unsupported history mode")
  }
}

function sanitizedArchiveRoot(name: string): string {
  const suffix = " Worktable Export"
  const safe = name
    .normalize("NFC")
    // eslint-disable-next-line no-control-regex -- ZIP roots exclude C0 controls
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[.\s]+$/g, "")
    .trim()
  const maxNameBytes = 255 - Buffer.byteLength(suffix)
  let bytes = 0
  let truncated = ""
  for (const character of safe) {
    const characterBytes = Buffer.byteLength(character)
    if (bytes + characterBytes > maxNameBytes) break
    truncated += character
    bytes += characterBytes
  }
  return `${truncated || "Worktable"}${suffix}`
}

function generatedArchivePath(root: string, path: string): string {
  return validateWorkspaceExportV2Path(`${root}/${path}`)
}

function sameSourceIdentity(
  expected:
    | SourceEntry
    | Pick<SourceRootIdentity, "dev" | "ino" | "ctimeMs" | "mtimeMs" | "mode">,
  actual: Stats
): boolean {
  return (
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.ctimeMs === expected.ctimeMs &&
    actual.mtimeMs === expected.mtimeMs &&
    (actual.mode & 0o777) === expected.mode
  )
}

const WORKSPACE_TRANSACTION_ARTIFACT_PATTERNS = [
  /^spaces\/[^/]+\/annotations\/\.store\.lock(?:\.(?:candidate|stale)-[^/]+)?$/,
  /^spaces\/[^/]+\/document-data\/[^/]+\/annotations\.json\.lock(?:\.(?:candidate|stale)-[^/]+)?$/,
  /^spaces\/[^/]+\/document-data\/[^/]+\/state\/\.write-lock(?:\.(?:candidate|stale)-[^/]+)?$/,
  /^spaces\/[^/]+\/document-data\/[^/]+\/state\/revisions\/\.pending-[^/]+(?:\/.*)?$/,
  /^versions\/[^/]+\/documents\/[^/]+\/\.write-lock(?:\.(?:candidate|stale)-[^/]+)?$/,
  /^versions\/[^/]+\/documents\/[^/]+\/\.pending-[^/]+(?:\/.*)?$/,
  /^versions\/[^/]+\/\.retired\/documents\/[^/]+\/[^/]+\/\.write-lock(?:\.(?:candidate|stale)-[^/]+)?$/,
  /^versions\/[^/]+\/\.retired\/documents\/[^/]+\/[^/]+\/\.pending-[^/]+(?:\/.*)?$/,
]

function isWorkspaceTransactionArtifact(path: string): boolean {
  return (
    isAtomicWriteTemporaryFileName(basename(path)) ||
    WORKSPACE_TRANSACTION_ARTIFACT_PATTERNS.some((pattern) =>
      pattern.test(path)
    )
  )
}

async function listSourceEntries(
  root: string,
  options: { paths?: "portable" | "local"; signal?: AbortSignal } = {}
): Promise<SourceInventory> {
  const canonicalRoot = await realpath(root)
  const rootInfo = await lstat(root)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("workspace export requires a real workspace directory")
  }
  const entries: SourceEntry[] = []
  const collisionPaths = new Set<string>()

  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => comparePortableText(left.name, right.name))
    for (const child of children) {
      options.signal?.throwIfAborted()
      const absolute = join(directory, child.name)
      const info = await lstat(absolute)
      const localPath = portablePath(root, absolute)
      if (isWorkspaceTransactionArtifact(localPath)) continue
      const path =
        options.paths === "local"
          ? localPath
          : validateWorkspaceExportV2Path(localPath)
      if (options.paths !== "local") {
        const collisionPath = path.toLocaleLowerCase("en-US")
        if (collisionPaths.has(collisionPath)) {
          throw new Error(`workspace contains case-colliding paths: ${path}`)
        }
        collisionPaths.add(collisionPath)
      }
      if (info.isSymbolicLink()) {
        throw new Error(`workspace export refuses symlink: ${path}`)
      }
      const canonical = await realpath(absolute)
      if (!isInside(canonicalRoot, canonical)) {
        throw new Error(`workspace path escaped during export: ${path}`)
      }
      if (info.isDirectory()) {
        entries.push({
          path,
          absolute,
          kind: "directory",
          size: 0,
          mode: info.mode & 0o777,
          mtime: info.mtime,
          dev: info.dev,
          ino: info.ino,
          ctimeMs: info.ctimeMs,
          mtimeMs: info.mtimeMs,
        })
        await visit(absolute)
      } else if (info.isFile()) {
        if (info.size > WORKSPACE_EXPORT_V2_MAX_FILE_BYTES) {
          throw new Error(`workspace file exceeds the v2 limit: ${path}`)
        }
        if (
          path === "worktable.workspace.json" &&
          info.size > WORKSPACE_EXPORT_V2_MAX_WORKSPACE_MANIFEST_BYTES
        ) {
          throw new Error("workspace manifest exceeds the portable size limit")
        }
        entries.push({
          path,
          absolute,
          kind: "file",
          size: info.size,
          mode: info.mode & 0o777,
          mtime: info.mtime,
          dev: info.dev,
          ino: info.ino,
          ctimeMs: info.ctimeMs,
          mtimeMs: info.mtimeMs,
        })
      } else {
        throw new Error(`workspace export refuses special file: ${path}`)
      }
      if (entries.length > WORKSPACE_EXPORT_V2_MAX_WORKSPACE_ENTRIES) {
        throw new Error("workspace exceeds the v2 entry limit")
      }
    }
  }

  await visit(root)
  return {
    root: {
      absolute: root,
      canonical: canonicalRoot,
      dev: rootInfo.dev,
      ino: rootInfo.ino,
      ctimeMs: rootInfo.ctimeMs,
      mtimeMs: rootInfo.mtimeMs,
      mode: rootInfo.mode & 0o777,
    },
    entries,
  }
}

async function assertSourceAncestors(
  entry: SourceEntry,
  inventory: SourceInventory,
  directories: Map<string, SourceEntry>
): Promise<void> {
  const rootInfo = await lstat(inventory.root.absolute)
  if (
    !rootInfo.isDirectory() ||
    rootInfo.isSymbolicLink() ||
    !sameSourceIdentity(inventory.root, rootInfo) ||
    (await realpath(inventory.root.absolute)) !== inventory.root.canonical
  ) {
    throw new WorkspaceChangedDuringExportError("workspace root")
  }
  const parts = entry.path.split("/")
  for (let depth = 1; depth < parts.length; depth += 1) {
    const path = parts.slice(0, depth).join("/")
    const expected = directories.get(path)
    if (!expected) {
      throw new WorkspaceChangedDuringExportError(path)
    }
    const info = await lstat(expected.absolute)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      !sameSourceIdentity(expected, info)
    ) {
      throw new WorkspaceChangedDuringExportError(path)
    }
    const canonical = await realpath(expected.absolute)
    if (!isInside(inventory.root.canonical, canonical)) {
      throw new WorkspaceChangedDuringExportError(path)
    }
  }
}

async function readSourceFile(
  entry: SourceEntry,
  inventory: SourceInventory,
  directories: Map<string, SourceEntry>
): Promise<Buffer> {
  await assertSourceAncestors(entry, inventory, directories)
  const before = await lstat(entry.absolute)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !sameSourceIdentity(entry, before)
  ) {
    throw new WorkspaceChangedDuringExportError(entry.path)
  }
  const handle = await open(entry.absolute, SECURE_READ_FLAGS)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameSourceIdentity(entry, opened)) {
      throw new WorkspaceChangedDuringExportError(entry.path)
    }
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (bytes.byteLength !== entry.size || !sameSourceIdentity(entry, after)) {
      throw new WorkspaceChangedDuringExportError(entry.path)
    }
    await assertSourceAncestors(entry, inventory, directories)
    return bytes
  } finally {
    await handle.close()
  }
}

async function classifyVersion(
  entry: SourceEntry,
  inventory: SourceInventory,
  directories: Map<string, SourceEntry>,
  files: Map<string, SourceEntry>,
  v2EntriesByUnit: Map<string, SourceEntry[]>,
  v2Classifications: Map<
    string,
    Promise<
      Pick<
        VersionCandidate,
        "group" | "unit" | "id" | "timestamp" | "meaningful" | "classified"
      >
    >
  >
): Promise<VersionCandidate> {
  await historyClassificationHookForTests?.({
    path: entry.path,
    size: entry.size,
  })
  const parts = entry.path.split("/")
  const v2 = v2GenerationLocation(entry.path)
  if (v2) {
    const { group, unit, id } = v2
    let classification = v2Classifications.get(unit)
    if (!classification) {
      classification = (async () => {
        const fallback = {
          group,
          unit,
          id,
          timestamp: versionIdTimestamp(id),
          meaningful: false,
          classified: false,
        }
        const manifestEntry = files.get(`${unit}/manifest.json`)
        if (
          !manifestEntry ||
          manifestEntry.kind !== "file" ||
          manifestEntry.size > HISTORY_CLASSIFICATION_MAX_BYTES
        ) {
          return fallback
        }
        try {
          const manifest = DocumentGenerationManifestV2Schema.parse(
            JSON.parse(
              (
                await readSourceFile(manifestEntry, inventory, directories)
              ).toString("utf8")
            )
          )
          if (
            manifest.spaceId !== v2.spaceId ||
            manifest.documentId !== v2.documentId ||
            manifest.id !== id
          ) {
            return fallback
          }
          if (
            !(await verifyV2GenerationForClassification(
              unit,
              manifest,
              v2EntriesByUnit.get(unit) ?? [],
              inventory,
              directories
            ))
          ) {
            return fallback
          }
          const createdAt = Date.parse(manifest.createdAt)
          return {
            group,
            unit,
            id,
            timestamp: Number.isNaN(createdAt)
              ? versionIdTimestamp(id)
              : createdAt,
            meaningful: manifest.checkpoint?.meaningful === true,
            classified: true,
          }
        } catch (error) {
          if (error instanceof WorkspaceChangedDuringExportError) throw error
          return fallback
        }
      })()
      v2Classifications.set(unit, classification)
    }
    return { ...entry, kind: "file", ...(await classification) }
  }
  const id = basename(entry.path, ".json")
  let timestamp = versionIdTimestamp(id)
  let meaningful = false
  let classified =
    entry.kind === "file" &&
    entry.path.endsWith(".json") &&
    parts.length >= 5 &&
    parts[0] === "versions" &&
    (parts[2] === "docs" || parts[2] === "widgets")
  if (entry.size > HISTORY_CLASSIFICATION_MAX_BYTES) {
    classified = false
  }
  if (classified) {
    try {
      const parsed = JSON.parse(
        (await readSourceFile(entry, inventory, directories)).toString("utf8")
      ) as {
        createdAt?: unknown
        checkpoint?: { meaningful?: unknown }
      }
      meaningful = parsed.checkpoint?.meaningful === true
      if (timestamp === null && typeof parsed.createdAt === "string") {
        const parsedTimestamp = Date.parse(parsed.createdAt)
        timestamp = Number.isNaN(parsedTimestamp) ? null : parsedTimestamp
      }
    } catch (error) {
      if (error instanceof WorkspaceChangedDuringExportError) throw error
      classified = false
    }
  }
  return {
    ...entry,
    kind: "file",
    group: dirname(entry.path),
    unit: entry.path,
    id,
    timestamp,
    meaningful,
    classified,
  }
}

function v2GenerationLocation(path: string): {
  spaceId: string
  documentId: string
  group: string
  unit: string
  id: string
} | null {
  const parts = path.split("/")
  if (
    parts.length >= 5 &&
    parts[0] === "versions" &&
    parts[2] === "documents" &&
    !parts[4]!.startsWith(".")
  ) {
    return {
      spaceId: parts[1]!,
      documentId: parts[3]!,
      group: parts.slice(0, 4).join("/"),
      unit: parts.slice(0, 5).join("/"),
      id: parts[4]!,
    }
  }
  if (
    parts.length >= 7 &&
    parts[0] === "versions" &&
    parts[2] === ".retired" &&
    parts[3] === "documents" &&
    !parts[6]!.startsWith(".")
  ) {
    return {
      spaceId: parts[1]!,
      documentId: parts[4]!,
      group: parts.slice(0, 6).join("/"),
      unit: parts.slice(0, 7).join("/"),
      id: parts[6]!,
    }
  }
  return null
}

async function verifyV2GenerationForClassification(
  unit: string,
  manifest: DocumentGenerationManifestV2,
  unitEntries: SourceEntry[],
  inventory: SourceInventory,
  directories: Map<string, SourceEntry>
): Promise<boolean> {
  // Classification is advisory. Large histories remain included
  // conservatively rather than turning a bounded export into a full-history
  // verification pass.
  if (manifest.totalBytes > HISTORY_CLASSIFICATION_MAX_BYTES) return false
  assertDocumentGenerationFormatOwnership(manifest)

  const expected = expectedDocumentGenerationInventory(manifest)
  const actual = new Map<string, SourceEntry>()
  for (const entry of unitEntries) {
    if (entry.path === unit) continue
    const relativePath = entry.path.slice(unit.length + 1)
    if (!relativePath || actual.has(relativePath)) return false
    actual.set(relativePath, entry)
  }
  if (actual.size !== expected.size) return false
  for (const [path, kind] of expected) {
    if (actual.get(path)?.kind !== kind) return false
  }

  const declaredEntries = [
    ...manifest.authoredSource.entries.map((entry) => ({
      ...entry,
      inventoryPath: `source/${entry.path}`,
    })),
    ...manifest.companions.flatMap((companion) =>
      companion.entries.map((entry) => ({
        ...entry,
        inventoryPath: `companions/${companion.key}/${entry.path}`,
      }))
    ),
  ]
  let totalBytes = 0
  for (const declared of declaredEntries) {
    const entry = actual.get(declared.inventoryPath)
    if (!entry || entry.kind !== "file" || entry.size !== declared.bytes) {
      return false
    }
    const bytes = await readSourceFile(entry, inventory, directories)
    if (
      bytes.byteLength !== declared.bytes ||
      createHash("sha256").update(bytes).digest("hex") !== declared.sha256
    ) {
      return false
    }
    totalBytes += bytes.byteLength
  }
  return (
    totalBytes === manifest.totalBytes &&
    documentGenerationManifestContentHash(manifest) === manifest.contentHash
  )
}

function unclassifiedVersion(entry: SourceEntry): VersionCandidate {
  const id = basename(entry.path, ".json")
  return {
    ...entry,
    kind: "file",
    group: dirname(entry.path),
    unit: entry.path,
    id,
    timestamp: versionIdTimestamp(id),
    meaningful: false,
    classified: false,
  }
}

async function selectEntries(
  inventory: SourceInventory,
  policy: WorkspaceExportHistoryPolicy,
  exportedAt: Date
): Promise<{
  entries: SourceEntry[]
  history: WorkspaceExportV2Manifest["history"]
}> {
  const { entries } = inventory
  const directories = new Map(
    entries
      .filter(
        (entry): entry is SourceEntry & { kind: "directory" } =>
          entry.kind === "directory"
      )
      .map((entry) => [entry.path, entry])
  )
  const current = entries.filter((entry) => !entry.path.startsWith("versions/"))
  const versionDirectories = entries.filter(
    (entry) => entry.kind === "directory" && entry.path.startsWith("versions/")
  )
  const rawVersionFiles = entries.filter(
    (entry): entry is SourceEntry & { kind: "file" } =>
      entry.kind === "file" && entry.path.startsWith("versions/")
  )
  const versionFileEntries = new Map(
    rawVersionFiles.map((entry) => [entry.path, entry])
  )
  const v2EntriesByUnit = new Map<string, SourceEntry[]>()
  for (const entry of entries) {
    const v2 = v2GenerationLocation(entry.path)
    if (!v2) continue
    const grouped = v2EntriesByUnit.get(v2.unit) ?? []
    grouped.push(entry)
    v2EntriesByUnit.set(v2.unit, grouped)
  }
  const v2Classifications = new Map<
    string,
    Promise<
      Pick<
        VersionCandidate,
        "group" | "unit" | "id" | "timestamp" | "meaningful" | "classified"
      >
    >
  >()
  // "none" only needs inventory totals. Avoid loading history content merely
  // to omit it, especially when this policy is chosen for a large workspace.
  const versionFiles =
    policy.mode !== "none"
      ? await mapWithConcurrency(
          rawVersionFiles,
          HISTORY_CLASSIFICATION_CONCURRENCY,
          (entry) =>
            classifyVersion(
              entry,
              inventory,
              directories,
              versionFileEntries,
              v2EntriesByUnit,
              v2Classifications
            )
        )
      : rawVersionFiles.map(unclassifiedVersion)
  const included = new Set<string>()
  const warnings: string[] = []
  let additionalUnclassifiable = 0

  if (policy.mode === "all") {
    for (const file of versionFiles) included.add(file.path)
  } else if (policy.mode !== "none") {
    const units = new Map<
      string,
      { candidate: VersionCandidate; files: VersionCandidate[] }
    >()
    for (const file of versionFiles) {
      if (!file.classified || file.timestamp === null) {
        included.add(file.path)
        if (warnings.length < 100) {
          warnings.push(
            `Included unclassifiable history entry conservatively: ${file.path}`
          )
        } else {
          additionalUnclassifiable += 1
        }
        continue
      }
      const unit = units.get(file.unit) ?? { candidate: file, files: [] }
      unit.files.push(file)
      units.set(file.unit, unit)
    }
    const byGroup = new Map<
      string,
      Array<{ candidate: VersionCandidate; files: VersionCandidate[] }>
    >()
    for (const unit of units.values()) {
      const group = byGroup.get(unit.candidate.group) ?? []
      group.push(unit)
      byGroup.set(unit.candidate.group, group)
    }
    const cutoff =
      policy.mode === "age"
        ? exportedAt.getTime() - policy.maxAgeDays * DAY_MS
        : null
    for (const group of byGroup.values()) {
      group.sort(
        (left, right) =>
          (right.candidate.timestamp ?? 0) - (left.candidate.timestamp ?? 0) ||
          comparePortableText(right.candidate.id, left.candidate.id)
      )
      for (const [index, unit] of group.entries()) {
        const file = unit.candidate
        const selected =
          file.meaningful ||
          index === 0 ||
          (policy.mode === "age"
            ? (file.timestamp ?? 0) >= (cutoff ?? 0)
            : index < policy.maxPerItem)
        if (selected) {
          for (const entry of unit.files) included.add(entry.path)
        }
      }
    }
  }
  if (additionalUnclassifiable > 0) {
    warnings.push(
      `${additionalUnclassifiable.toLocaleString()} additional unclassifiable history entries were included conservatively`
    )
  }

  const includedHistory = versionFiles.filter((file) => included.has(file.path))
  const omittedHistory = versionFiles.filter((file) => !included.has(file.path))
  const includedDirectoryPaths = new Set<string>()
  for (const file of includedHistory) {
    let cursor = dirname(file.path)
    while (cursor !== "." && cursor.startsWith("versions")) {
      includedDirectoryPaths.add(cursor)
      cursor = dirname(cursor)
    }
  }
  const selectedDirectories = versionDirectories.filter((entry) =>
    includedDirectoryPaths.has(entry.path)
  )
  const dates = includedHistory
    .map((file) => file.timestamp)
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right)

  return {
    entries: [...current, ...selectedDirectories, ...includedHistory].sort(
      (left, right) => comparePortableText(left.path, right.path)
    ),
    history: {
      requested: policy,
      complete: omittedHistory.length === 0,
      includedFiles: includedHistory.length,
      includedBytes: includedHistory.reduce((sum, file) => sum + file.size, 0),
      omittedFiles: omittedHistory.length,
      omittedBytes: omittedHistory.reduce((sum, file) => sum + file.size, 0),
      meaningfulCheckpoints: new Set(
        includedHistory
          .filter((file) => file.meaningful)
          .map((file) => file.unit)
      ).size,
      ...(dates[0]
        ? { oldestIncludedAt: new Date(dates[0]).toISOString() }
        : {}),
      ...(dates.at(-1)
        ? { newestIncludedAt: new Date(dates.at(-1)!).toISOString() }
        : {}),
      warnings,
    },
  }
}

async function copyAndHash(
  source: SourceEntry,
  destination: string,
  inventory: SourceInventory,
  directories: Map<string, SourceEntry>,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  await assertSourceAncestors(source, inventory, directories)
  const before = await lstat(source.absolute)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !sameSourceIdentity(source, before)
  ) {
    throw new WorkspaceChangedDuringExportError(source.path)
  }
  const handle = await open(source.absolute, SECURE_READ_FLAGS)
  const hash = createHash("sha256")
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameSourceIdentity(source, opened)) {
      throw new WorkspaceChangedDuringExportError(source.path)
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      meter,
      createWriteStream(destination, {
        flags: "wx",
        mode: source.mode,
      }),
      { signal }
    )
    const after = await handle.stat()
    if (
      bytes !== source.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new WorkspaceChangedDuringExportError(source.path)
    }
    await assertSourceAncestors(source, inventory, directories)
    await chmod(destination, source.mode)
    await utimes(destination, source.mtime, source.mtime)
    return hash.digest("hex")
  } finally {
    await handle.close()
  }
}

async function hashSourceEntry(
  source: SourceEntry,
  inventory: SourceInventory,
  directories: Map<string, SourceEntry>
): Promise<string> {
  await assertSourceAncestors(source, inventory, directories)
  const before = await lstat(source.absolute)
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !sameSourceIdentity(source, before)
  ) {
    throw new WorkspaceChangedDuringExportError(source.path)
  }
  const handle = await open(source.absolute, SECURE_READ_FLAGS)
  const hash = createHash("sha256")
  let bytes = 0
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || !sameSourceIdentity(source, opened)) {
      throw new WorkspaceChangedDuringExportError(source.path)
    }
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const data = chunk as Buffer
      bytes += data.byteLength
      hash.update(data)
    }
    const after = await handle.stat()
    if (bytes !== source.size || !sameSourceIdentity(source, after)) {
      throw new WorkspaceChangedDuringExportError(source.path)
    }
    await assertSourceAncestors(source, inventory, directories)
    return hash.digest("hex")
  } finally {
    await handle.close()
  }
}

interface CapturedWorkspace {
  root: string
  directories: WorkspaceExportV2Directory[]
  files: CapturedEntry[]
}
interface CaptureOptions {
  signal?: AbortSignal
  deferCleanup?: (capture: CapturedWorkspace) => void
}

async function captureEntries(
  entries: SourceEntry[],
  inventory: SourceInventory,
  options: CaptureOptions = {}
): Promise<CapturedWorkspace> {
  const transfers = workspaceExportCapturesRoot()
  await mkdir(transfers, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(transfers, "export-"))
  const directories: WorkspaceExportV2Directory[] = []
  const files: CapturedEntry[] = []
  const sourceDirectories = new Map(
    inventory.entries
      .filter(
        (entry): entry is SourceEntry & { kind: "directory" } =>
          entry.kind === "directory"
      )
      .map((entry) => [entry.path, entry])
  )
  try {
    await mapWithConcurrency(entries, 8, async (entry) => {
      options.signal?.throwIfAborted()
      try {
        const output = join(root, ...entry.path.split("/"))
        if (entry.kind === "directory") {
          await assertSourceAncestors(entry, inventory, sourceDirectories)
          const current = await lstat(entry.absolute)
          if (
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            !sameSourceIdentity(entry, current)
          ) {
            throw new WorkspaceChangedDuringExportError(entry.path)
          }
          await mkdir(output, { recursive: true, mode: 0o700 })
          directories.push({
            path: entry.path,
            mode: entry.mode,
            mtime: entry.mtime.toISOString(),
          })
        } else {
          const hash = await copyAndHash(
            entry,
            output,
            inventory,
            sourceDirectories,
            options.signal
          )
          files.push({
            path: entry.path,
            absolute: output,
            size: entry.size,
            mode: entry.mode,
            mtime: entry.mtime.toISOString(),
            sha256: hash,
          })
        }
        await captureEntryHookForTests?.({
          path: entry.path,
          kind: entry.kind,
        })
        options.signal?.throwIfAborted()
      } catch (error) {
        if (
          ["ENOENT", "ENOTDIR", "ELOOP"].includes(
            (error as NodeJS.ErrnoException).code ?? ""
          )
        )
          throw new WorkspaceChangedDuringExportError(entry.path)
        throw error
      }
    })
    for (const directory of [...directories].sort(
      (left, right) =>
        right.path.split("/").length - left.path.split("/").length
    )) {
      const output = join(root, ...directory.path.split("/"))
      await chmod(output, directory.mode)
      const mtime = new Date(directory.mtime)
      await utimes(output, mtime, mtime)
    }
    directories.sort((left, right) =>
      comparePortableText(left.path, right.path)
    )
    files.sort((left, right) => comparePortableText(left.path, right.path))
    return { root, directories, files }
  } catch (error) {
    if (options.deferCleanup) {
      options.deferCleanup({ root, directories, files })
      throw error
    }
    for (const directory of [...directories].sort(
      (left, right) =>
        left.path.split("/").length - right.path.split("/").length
    )) {
      await chmod(join(root, ...directory.path.split("/")), 0o700).catch(
        () => undefined
      )
    }
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

function workspaceExportCapturesRoot(): string {
  return join(ensureAppDir(), "workspace-transfers", "captures")
}

function workspaceExportCaptureLockPath(): string {
  return join(ensureAppDir(), "workspace-transfers", "capture.lock")
}

async function removeCapture(
  capture: Awaited<ReturnType<typeof captureEntries>>
): Promise<void> {
  await captureRemovalHookForTests?.()
  for (const directory of [...capture.directories].sort(
    (left, right) => left.path.split("/").length - right.path.split("/").length
  )) {
    await chmod(join(capture.root, ...directory.path.split("/")), 0o700).catch(
      () => undefined
    )
  }
  await rm(capture.root, { recursive: true, force: true })
}

async function removeAbandonedCapture(root: string): Promise<void> {
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()!
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("workspace export capture must be a real directory")
    }
    await chmod(directory, 0o700)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(join(directory, entry.name))
      }
    }
  }
  await rm(root, { recursive: true, force: true })
}

/**
 * Remove captures whose owning process no longer holds the cross-process
 * capture lock. The lock's PID-incarnation check makes immediate startup
 * recovery safe without an age guess that could delete a long active export.
 */
export async function cleanupAbandonedWorkspaceExportCaptures(): Promise<number> {
  try {
    return await withCrossProcessLock(
      workspaceExportCaptureLockPath(),
      {
        label: "Workspace export capture cleanup",
        staleMs: 0,
        retryMs: 10,
        timeoutMs: 25,
      },
      async () => {
        const captures = workspaceExportCapturesRoot()
        await mkdir(captures, { recursive: true, mode: 0o700 })
        let removed = 0
        for (const entry of await readdir(captures, {
          withFileTypes: true,
        })) {
          if (
            !entry.isDirectory() ||
            entry.isSymbolicLink() ||
            !/^export-[A-Za-z0-9_-]+$/.test(entry.name)
          ) {
            continue
          }
          await removeAbandonedCapture(join(captures, entry.name))
          removed += 1
        }
        return removed
      }
    )
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("is locked by another Worktable process")
    ) {
      return 0
    }
    throw error
  }
}

function assertSourceInventoryUnchanged(
  expected: SourceInventory,
  actual: SourceInventory
): void {
  if (
    expected.root.canonical !== actual.root.canonical ||
    expected.root.absolute !== actual.root.absolute ||
    expected.root.dev !== actual.root.dev ||
    expected.root.ino !== actual.root.ino ||
    expected.root.ctimeMs !== actual.root.ctimeMs ||
    expected.root.mtimeMs !== actual.root.mtimeMs ||
    expected.root.mode !== actual.root.mode ||
    expected.entries.length !== actual.entries.length
  ) {
    throw new WorkspaceChangedDuringExportError("workspace inventory")
  }
  for (let index = 0; index < expected.entries.length; index += 1) {
    const before = expected.entries[index]!
    const after = actual.entries[index]!
    if (
      before.path !== after.path ||
      before.kind !== after.kind ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.ctimeMs !== after.ctimeMs ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new WorkspaceChangedDuringExportError(before.path)
    }
  }
}

async function captureConsistentWorkspace(
  sourceRoot: string,
  historyPolicy: WorkspaceExportHistoryPolicy,
  exportedAt: Date,
  options: CaptureOptions = {}
): Promise<{
  selected: Awaited<ReturnType<typeof selectEntries>>
  capture: Awaited<ReturnType<typeof captureEntries>>
}> {
  let capture: Awaited<ReturnType<typeof captureEntries>> | null = null
  try {
    options.signal?.throwIfAborted()
    const inventory = await listSourceEntries(sourceRoot, {
      signal: options.signal,
    })
    const selected = await selectEntries(inventory, historyPolicy, exportedAt)
    const expandedBytes = selected.entries.reduce(
      (sum, entry) => sum + (entry.kind === "file" ? entry.size : 0),
      0
    )
    if (expandedBytes > WORKSPACE_EXPORT_V2_MAX_EXPANDED_BYTES) {
      throw new Error("workspace export exceeds the v2 expanded-size limit")
    }
    capture = await captureEntries(selected.entries, inventory, options)
    let current: SourceInventory
    try {
      current = await listSourceEntries(sourceRoot, { signal: options.signal })
    } catch (error) {
      throw new WorkspaceChangedDuringExportError(
        error instanceof Error ? error.message : "workspace inventory"
      )
    }
    assertSourceInventoryUnchanged(inventory, current)
    return { selected, capture }
  } catch (error) {
    if (capture) {
      if (options.deferCleanup) options.deferCleanup(capture)
      else await removeCapture(capture)
    }
    throw error
  }
}

export interface PortableWorkspaceInventory {
  directories: WorkspaceExportV2Directory[]
  files: WorkspaceExportV2File[]
}

/** Hash an admitted tree, including its identity manifest, without copying it. */
export async function inspectPortableWorkspaceTree(
  workspaceRoot: string
): Promise<PortableWorkspaceInventory> {
  const inventory = await listSourceEntries(resolve(workspaceRoot))
  const directoryEntries = inventory.entries.filter(
    (entry): entry is SourceEntry & { kind: "directory" } =>
      entry.kind === "directory"
  )
  const directoriesByPath = new Map(
    directoryEntries.map((entry) => [entry.path, entry])
  )
  const fileEntries = inventory.entries.filter(
    (entry): entry is SourceEntry & { kind: "file" } => entry.kind === "file"
  )
  const files = await mapWithConcurrency(
    fileEntries,
    HISTORY_CLASSIFICATION_CONCURRENCY,
    async (entry): Promise<WorkspaceExportV2File> => ({
      path: entry.path,
      size: entry.size,
      mode: entry.mode,
      mtime: entry.mtime.toISOString(),
      sha256: await hashSourceEntry(entry, inventory, directoriesByPath),
    })
  )
  let current: SourceInventory
  try {
    current = await listSourceEntries(resolve(workspaceRoot))
  } catch (error) {
    throw new WorkspaceChangedDuringExportError(
      error instanceof Error ? error.message : "prepared workspace"
    )
  }
  assertSourceInventoryUnchanged(inventory, current)
  return {
    directories: directoryEntries
      .map((entry) => ({
        path: entry.path,
        mode: entry.mode,
        mtime: entry.mtime.toISOString(),
      }))
      .sort((left, right) => comparePortableText(left.path, right.path)),
    files: files.sort((left, right) =>
      comparePortableText(left.path, right.path)
    ),
  }
}

export function portableWorkspaceCheckpoint(
  inventory: PortableWorkspaceInventory
): string {
  return canonicalCheckpoint(inventory.directories, inventory.files)
}

/** Replacement deliberately preserves destination identity separately. */
export async function calculateWorkspaceContentCheckpoint(
  workspaceRoot: string
): Promise<string> {
  const inventory = await inspectPortableWorkspaceTree(workspaceRoot)
  return canonicalCheckpoint(
    inventory.directories,
    inventory.files.filter((file) => file.path !== "worktable.workspace.json")
  )
}

/**
 * Share export's exact full-history capture with directory snapshot consumers.
 * The mutation barrier covers only flush/capture. The capture lock protects its
 * private lifetime from the export janitor until the consumer finishes.
 */
export async function withPortableWorkspaceCapture<T>(
  consume: (
    capture: PortableWorkspaceInventory & {
      root: string
      manifest: WorkspaceManifest
    }
  ) => Promise<T>,
  options: {
    workspaceRoot?: string
    withCaptureBarrier?: <R>(work: () => Promise<R>) => Promise<R>
    signal?: AbortSignal
  } = {}
): Promise<T> {
  const sourceRoot = resolve(options.workspaceRoot ?? getWorkspaceRoot())
  const canonicalRoot = await realpath(sourceRoot)
  const appData = await canonicalPotentialPath(resolve(getAppDir()))
  if (isInside(canonicalRoot, appData))
    throw new Error(
      "workspace app storage must be outside the portable workspace"
    )
  return withCrossProcessLock(
    workspaceExportCaptureLockPath(),
    {
      label: "Workspace snapshot capture",
      staleMs: 0,
      retryMs: 100,
      timeoutMs: EXPORT_CAPTURE_LOCK_TIMEOUT_MS,
    },
    async () => {
      let pendingCleanup: CapturedWorkspace | undefined
      const work = () =>
        captureConsistentWorkspace(sourceRoot, { mode: "all" }, new Date(), {
          signal: options.signal,
          deferCleanup: (capture) => {
            pendingCleanup = capture
          },
        })
      try {
        const { capture } = options.withCaptureBarrier
          ? await options.withCaptureBarrier(work)
          : await work()
        pendingCleanup = capture
        const manifestFile = capture.files.find(
          (file) => file.path === "worktable.workspace.json"
        )
        if (!manifestFile) throw new Error("workspace snapshot has no manifest")
        const manifest: unknown = JSON.parse(
          await readBoundedRegularFile(
            manifestFile.absolute,
            WORKSPACE_EXPORT_V2_MAX_WORKSPACE_MANIFEST_BYTES
          )
        )
        if (!isWorkspaceManifest(manifest))
          throw new Error("workspace manifest is invalid or unsupported")
        const files = capture.files.map(
          ({ path, size, mode, mtime, sha256 }) => ({
            path,
            size,
            mode,
            mtime,
            sha256,
          })
        )
        assertPortableOwnerAccess(capture.directories, files)
        return await consume({
          root: capture.root,
          manifest,
          directories: capture.directories,
          files,
        })
      } finally {
        if (pendingCleanup) await removeCapture(pendingCleanup)
      }
    }
  )
}

/**
 * Hash an existing local workspace without imposing export portability rules.
 * This keeps legacy names representable during a staged migration while the
 * shared source inventory still rejects symlinks, special files, escapes, and
 * concurrent filesystem changes.
 */
export async function calculateLocalWorkspaceContentCheckpoints(
  workspaceRoot: string
): Promise<{
  workspaceContentCheckpoint: string
  materializationBaseCheckpoint: string
  files: number
  bytes: number
}> {
  const resolvedRoot = resolve(workspaceRoot)
  const inventory = await listSourceEntries(resolvedRoot, { paths: "local" })
  const directoryEntries = inventory.entries.filter(
    (entry): entry is SourceEntry & { kind: "directory" } =>
      entry.kind === "directory"
  )
  const directoriesByPath = new Map(
    directoryEntries.map((entry) => [entry.path, entry])
  )
  const fileEntries = inventory.entries.filter(
    (entry): entry is SourceEntry & { kind: "file" } => entry.kind === "file"
  )
  const files = await mapWithConcurrency(
    fileEntries,
    HISTORY_CLASSIFICATION_CONCURRENCY,
    async (entry): Promise<WorkspaceExportV2File> => ({
      path: entry.path,
      size: entry.size,
      mode: entry.mode,
      mtime: entry.mtime.toISOString(),
      sha256: await hashSourceEntry(entry, inventory, directoriesByPath),
    })
  )
  let current: SourceInventory
  try {
    current = await listSourceEntries(resolvedRoot, { paths: "local" })
  } catch (error) {
    throw new WorkspaceChangedDuringExportError(
      error instanceof Error ? error.message : "existing workspace"
    )
  }
  assertSourceInventoryUnchanged(inventory, current)
  const directories = directoryEntries
    .map((entry) => ({
      path: entry.path,
      mode: entry.mode,
      mtime: entry.mtime.toISOString(),
    }))
    .sort((left, right) => comparePortableText(left.path, right.path))
  files.sort((left, right) => comparePortableText(left.path, right.path))
  return {
    workspaceContentCheckpoint: canonicalCheckpoint(directories, files),
    materializationBaseCheckpoint: canonicalCheckpoint(
      directories,
      files.filter(
        (file) => !/^spaces\/[^/]+\/documents\.meta\.json$/u.test(file.path)
      )
    ),
    files: files.length,
    bytes: files.reduce((total, file) => total + file.size, 0),
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value
  const suffix = "…"
  const contentLimit = maxBytes - Buffer.byteLength(suffix, "utf8")
  let bytes = 0
  let truncated = ""
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8")
    if (bytes + characterBytes > contentLimit) break
    truncated += character
    bytes += characterBytes
  }
  return `${truncated}${suffix}`
}

function boundedViewerTitle(value: string, fallback: string): string {
  return truncateUtf8(value.trim() || fallback, VIEWER_MAX_TITLE_BYTES)
}

function renderMarkdown(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .map((line) => {
      const heading = /^(#{1,6})\s+(.+)$/.exec(line)
      if (heading) {
        const level = heading[1]!.length
        return `<h${level}>${escapeHtml(heading[2]!)}</h${level}>`
      }
      if (line.startsWith("```")) return ""
      if (line.trim() === "") return "<br>"
      return `<p>${escapeHtml(line)}</p>`
    })
    .join("\n")
}

function viewerPage(title: string, body: string, extraHead = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data: file:; frame-src file:">
<title>${escapeHtml(title)}</title>
${extraHead}
<style>
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body{max-width:920px;margin:0 auto;padding:32px;line-height:1.55;background:#f7f5f0;color:#26231f}
a{color:#765b2d}article,.card{background:#fff;border-radius:16px;padding:24px;margin:16px 0;box-shadow:0 8px 30px rgba(40,34,25,.08)}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
input{width:100%;box-sizing:border-box;padding:12px 14px;border:1px solid #c9c2b8;border-radius:10px;background:#fff;color:inherit}
li{margin:8px 0}.muted{color:#746e65;font-size:.9rem}iframe{width:100%;min-height:520px;border:0;border-radius:12px;background:white}
@media(prefers-color-scheme:dark){body{background:#1b1916;color:#ece7df}.card,article{background:#26231f}a{color:#e0bb76}input{background:#26231f;border-color:#514a40}}
</style>
</head>
<body>${body}</body>
</html>`
}

function safePreviewHtml(source: string): string {
  const allowed = new Set([
    "a",
    "abbr",
    "article",
    "aside",
    "b",
    "blockquote",
    "br",
    "caption",
    "code",
    "dd",
    "del",
    "details",
    "div",
    "dl",
    "dt",
    "em",
    "figcaption",
    "figure",
    "footer",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "header",
    "hr",
    "i",
    "ins",
    "kbd",
    "li",
    "main",
    "mark",
    "nav",
    "ol",
    "p",
    "pre",
    "q",
    "s",
    "samp",
    "section",
    "small",
    "span",
    "strong",
    "sub",
    "summary",
    "sup",
    "table",
    "tbody",
    "td",
    "tfoot",
    "th",
    "thead",
    "time",
    "tr",
    "u",
    "ul",
    "var",
  ])
  const removeWithContents = new Set([
    "applet",
    "audio",
    "base",
    "canvas",
    "embed",
    "frame",
    "frameset",
    "iframe",
    "img",
    "link",
    "meta",
    "noscript",
    "object",
    "picture",
    "script",
    "source",
    "style",
    "template",
    "track",
    "video",
  ])
  const safeAttributes = new Set([
    "abbr",
    "aria-label",
    "colspan",
    "datetime",
    "dir",
    "lang",
    "open",
    "rowspan",
    "scope",
    "start",
    "title",
    "value",
  ])
  const dom = new JSDOM(source)
  const document = dom.window.document
  for (const element of [...document.body.querySelectorAll("*")]) {
    const tag = element.localName
    if (removeWithContents.has(tag)) {
      element.remove()
      continue
    }
    if (!allowed.has(tag)) {
      element.replaceWith(...element.childNodes)
      continue
    }
    for (const attribute of [...element.attributes]) {
      if (!safeAttributes.has(attribute.name.toLowerCase())) {
        element.removeAttribute(attribute.name)
      }
    }
  }
  const policy =
    "default-src 'none'; style-src 'none'; img-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'"
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy}">`
  // Keep the defense-in-depth policy before the sanitized fragment. The
  // allowlist removes navigation, resource, script, style, form, and embedded
  // content rather than relying on CSP to intercept attempted network loads.
  return `<!doctype html><html><head>${meta}</head><body>${document.body.innerHTML}</body></html>`
}

async function generateViewer<T extends ViewerSourceEntry>(
  captured: T[],
  history: WorkspaceExportV2Manifest["history"],
  readText: (file: T) => Promise<string>
): Promise<{
  files: Map<string, Buffer>
  status: WorkspaceExportV2Manifest["viewer"]
}> {
  const generatedLimit =
    viewerGeneratedLimitForTests ?? VIEWER_MAX_GENERATED_BYTES
  const output = new Map<string, Buffer>()
  const warnings: string[] = []
  let additionalWarnings = 0
  const rows: Array<{ html: string; generatedPaths: string[] }> = []
  let sequence = 0
  let generatedBytes = 0
  let rowBytes = 0
  let listedFiles = 0

  const addWarning = (warning: string) => {
    if (warnings.length < 100) warnings.push(warning.slice(0, 2_000))
    else additionalWarnings += 1
  }
  const addOmittedFilesWarning = () => {
    const warning =
      "Additional current files are available in workspace/ but omitted from the offline index"
    if (!warnings.includes(warning)) addWarning(warning)
  }
  const addRow = (html: string, generatedPaths: string[]): boolean => {
    const bytes = Buffer.byteLength(html, "utf8") + (rows.length > 0 ? 1 : 0)
    // Keep the in-memory index body bounded before joining it. The exact final
    // index and every generated asset are reconciled against the same budget
    // below, once warnings and the fixed viewer shell are known.
    if (rowBytes + bytes > generatedLimit) return false
    rows.push({ html, generatedPaths })
    rowBytes += bytes
    return true
  }

  for (const file of captured) {
    if (
      file.path === "worktable.workspace.json" ||
      file.path.startsWith("versions/")
    ) {
      continue
    }
    if (listedFiles >= VIEWER_MAX_LISTED_FILES) {
      addOmittedFilesWarning()
      break
    }
    listedFiles += 1
    const rawHref = `workspace/${file.path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`
    const htmlDocument = /\/widgets\/.+\/index\.html$/.test(file.path)
    let contentPage: string | null = null
    let title = boundedViewerTitle(file.path, "Workspace file")
    const pendingGenerated = new Map<string, Buffer>()
    try {
      if (file.size > VIEWER_MAX_RENDER_FILE_BYTES) {
        throw new Error(
          `larger than the ${VIEWER_MAX_RENDER_FILE_BYTES / 1024 / 1024} MiB offline rendering limit; raw file remains available`
        )
      }
      if (/\/docs\/.+\.md$/.test(file.path)) {
        const markdown = await readText(file)
        title = boundedViewerTitle(
          markdown
            .split(/\r?\n/)
            .find((line) => line.startsWith("# "))
            ?.slice(2) ?? "",
          file.path
        )
        contentPage = viewerPage(
          title,
          `<p><a href="../../${rawHref}">Open raw file</a></p><article>${renderMarkdown(markdown)}</article>`
        )
      } else if (/\/docs\/.+\.json$/.test(file.path)) {
        const parsed = JSON.parse(await readText(file))
        const blocks = Array.isArray(parsed) ? parsed : []
        const markdown = (await blocksToMarkdownSafe(blocks)) ?? ""
        contentPage = viewerPage(
          title,
          `<p><a href="../../${rawHref}">Open raw file</a></p><article>${renderMarkdown(markdown)}</article>`
        )
      } else if (htmlDocument) {
        const html = await readText(file)
        const previewPath = `browse/content/preview-${sequence}.html`
        const preview = Buffer.from(safePreviewHtml(html))
        if (generatedBytes + preview.byteLength > generatedLimit) {
          throw new Error(
            "offline viewer reached its generated-content limit; raw file remains available"
          )
        }
        pendingGenerated.set(previewPath, preview)
        contentPage = viewerPage(
          title,
          `<p>Sandboxed preview. To inspect the source, extract the package and open <code>${escapeHtml(file.path)}</code> in a text editor.</p><article><iframe sandbox src="./preview-${sequence}.html" title="${escapeHtml(title)}"></iframe></article>`
        )
      } else if (
        /\/(?:records|annotations|threads)\//.test(file.path) ||
        file.path.startsWith("threads/")
      ) {
        const text = await readText(file)
        contentPage = viewerPage(
          title,
          `<p><a href="../../${rawHref}">Open raw file</a></p><article><pre>${escapeHtml(text)}</pre></article>`
        )
      }
    } catch (error) {
      addWarning(
        `Could not render ${file.path}: ${error instanceof Error ? error.message : String(error)}`
      )
    }

    if (contentPage) {
      const pagePath = `browse/content/item-${sequence}.html`
      const page = Buffer.from(contentPage)
      pendingGenerated.set(pagePath, page)
      const pendingBytes = [...pendingGenerated.values()].reduce(
        (sum, buffer) => sum + buffer.byteLength,
        0
      )
      const row = `<li data-entry="${escapeHtml(`${title} ${file.path}`.toLowerCase())}"><a href="${pagePath}">${escapeHtml(title)}</a><div class="muted">${escapeHtml(file.path)}</div></li>`
      if (generatedBytes + pendingBytes <= generatedLimit) {
        if (!addRow(row, [...pendingGenerated.keys()])) {
          addOmittedFilesWarning()
          break
        }
        for (const [path, buffer] of pendingGenerated) {
          output.set(path, buffer)
        }
        generatedBytes += pendingBytes
        sequence += 1
        continue
      }
      addWarning(
        `Could not render ${file.path}: offline viewer reached its generated-content limit; raw file remains available`
      )
    }
    const rawRow = htmlDocument
      ? `<li data-entry="${escapeHtml(`${title} ${file.path}`.toLowerCase())}"><span>${escapeHtml(title)}</span><div class="muted">${escapeHtml(file.path)} · extract and inspect as text</div></li>`
      : `<li data-entry="${escapeHtml(`${title} ${file.path}`.toLowerCase())}"><a href="${rawHref}">${escapeHtml(title)}</a><div class="muted">${escapeHtml(file.path)} · raw file</div></li>`
    if (!addRow(rawRow, [])) {
      addOmittedFilesWarning()
      break
    }
  }
  if (additionalWarnings > 0) {
    warnings.push(
      `${additionalWarnings.toLocaleString()} additional files could not be rendered`
    )
  }

  const renderIndex = (): Buffer =>
    Buffer.from(
      viewerPage(
        "Worktable Export",
        `<h1>Worktable Export</h1>
<p>This is a read-only, offline view of the current workspace content.</p>
<div class="card"><strong>History:</strong> ${history.includedFiles.toLocaleString()} included, ${history.omittedFiles.toLocaleString()} omitted. Raw included snapshots are under <code>workspace/versions/</code>.</div>
<input id="filter" type="search" aria-label="Filter exported content" placeholder="Filter docs, records, annotations, and threads">
<ul id="entries">${rows.map((row) => row.html).join("\n")}</ul>
${warnings.length ? `<div class="card"><strong>Viewer warnings</strong><ul>${warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></div>` : ""}
<script>
const input=document.getElementById("filter");
const entries=[...document.querySelectorAll("#entries > li")];
input.addEventListener("input",()=>{const q=input.value.toLowerCase();for(const row of entries)row.hidden=!row.dataset.entry.includes(q)});
</script>`
      )
    )
  const readme = Buffer.from(
    `Worktable workspace export\n\nOpen "Open Worktable Export.html" to browse current content without Worktable.\nThe exact portable workspace is in workspace/ and can be opened by Worktable.\nThis .wtb package is a standard ZIP archive and can be opened by regular ZIP tools.\nImporting into an existing Worktable replaces content; it does not sync or merge.\n`
  )
  let index = renderIndex()
  if (generatedBytes + index.byteLength + readme.byteLength > generatedLimit) {
    addOmittedFilesWarning()
    index = renderIndex()
    let indexBytes = index.byteLength
    let total = generatedBytes + indexBytes + readme.byteLength
    while (rows.length > 0 && total > generatedLimit) {
      const removed = rows.pop()!
      const removedRowBytes =
        Buffer.byteLength(removed.html, "utf8") + (rows.length > 0 ? 1 : 0)
      rowBytes -= removedRowBytes
      indexBytes -= removedRowBytes
      for (const path of removed.generatedPaths) {
        const buffer = output.get(path)
        if (!buffer) continue
        generatedBytes -= buffer.byteLength
        output.delete(path)
      }
      total = generatedBytes + indexBytes + readme.byteLength
    }
    index = renderIndex()
  }
  if (generatedBytes + index.byteLength + readme.byteLength > generatedLimit) {
    throw new Error(
      "offline viewer metadata exceeds its generated-content limit"
    )
  }
  output.set("Open Worktable Export.html", index)
  output.set("README.txt", readme)
  return {
    files: output,
    status: {
      status: warnings.length === 0 ? "complete" : "partial",
      warnings,
    },
  }
}

async function generateViewerBundle<T extends ViewerSourceEntry>(
  files: T[],
  history: WorkspaceExportV2Manifest["history"],
  readText: (file: T) => Promise<string>
): ReturnType<typeof generateViewer<T>> {
  return generateViewer(files, history, readText).catch((error: unknown) => ({
    files: new Map<string, Buffer>([
      [
        "README.txt",
        Buffer.from(
          "This Worktable export contains the exact portable workspace under workspace/. The offline viewer could not be generated.\n"
        ),
      ],
    ]),
    status: {
      status: "failed" as const,
      warnings: [error instanceof Error ? error.message : String(error)],
    },
  }))
}

function packageVersion(): string {
  return process.env["WORKTABLE_VERSION"]?.trim() || "development"
}

async function pipeZip(
  zip: yazl.ZipFile,
  destination: string,
  maximumBytes: number
): Promise<void> {
  let bytes = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength
      if (bytes > maximumBytes) {
        callback(new Error("workspace export exceeds the v2 archive limit"))
        return
      }
      callback(null, chunk)
    },
  })
  await pipeline(
    zip.outputStream,
    meter,
    createWriteStream(destination, {
      flags: "wx",
      mode: 0o600,
    })
  )
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

type WorkspaceExportV2WriteOptions = {
  force?: boolean
  history?: WorkspaceExportHistoryPolicy
  workspaceRoot?: string
  withCaptureBarrier?: <T>(capture: () => Promise<T>) => Promise<T>
}

export async function writeWorkspaceExportV2(
  destination: string,
  options: WorkspaceExportV2WriteOptions = {}
): Promise<WorkspaceExportV2Result> {
  // Reject a misconfigured app-data root before lock acquisition creates it.
  // Portable workspace content must never gain machine-local transfer state.
  const sourceRoot = resolve(options.workspaceRoot ?? getWorkspaceRoot())
  const canonicalRoot = await realpath(sourceRoot)
  const configuredAppData = await canonicalPotentialPath(resolve(getAppDir()))
  if (isInside(canonicalRoot, configuredAppData)) {
    throw new Error(
      "workspace app storage must be outside the portable workspace"
    )
  }
  return withCrossProcessLock(
    workspaceExportCaptureLockPath(),
    {
      label: "Workspace export capture",
      staleMs: 0,
      retryMs: 100,
      timeoutMs: EXPORT_CAPTURE_LOCK_TIMEOUT_MS,
    },
    () => writeWorkspaceExportV2WithCaptureLock(destination, options)
  )
}

async function writeWorkspaceExportV2WithCaptureLock(
  destination: string,
  options: WorkspaceExportV2WriteOptions
): Promise<WorkspaceExportV2Result> {
  const historyPolicy = validateHistoryPolicy(
    options.history ?? { mode: "all" }
  )
  const sourceRoot = resolve(options.workspaceRoot ?? getWorkspaceRoot())
  const canonicalRoot = await realpath(sourceRoot)
  const output = resolve(
    destination.endsWith(WORKSPACE_EXPORT_V2_EXTENSION)
      ? destination
      : `${destination}${WORKSPACE_EXPORT_V2_EXTENSION}`
  )
  const canonicalOutput = await canonicalPotentialPath(output)
  if (isInside(canonicalRoot, canonicalOutput)) {
    throw new Error("workspace exports must be written outside the workspace")
  }
  const configuredAppData = await canonicalPotentialPath(resolve(getAppDir()))
  if (isInside(canonicalRoot, configuredAppData)) {
    throw new Error(
      "workspace app storage must be outside the portable workspace"
    )
  }
  const appData = await realpath(ensureAppDir())
  if (isInside(canonicalRoot, appData)) {
    throw new Error(
      "workspace app storage must be outside the portable workspace"
    )
  }
  await mkdir(dirname(output), { recursive: true })
  const outputParent = await realpath(dirname(output))
  const outputParentIdentity = await lstat(outputParent)
  const writeOutput = join(outputParent, basename(output))
  if (isInside(canonicalRoot, writeOutput)) {
    throw new Error("workspace exports must be written outside the workspace")
  }
  let expectedDestination: Awaited<ReturnType<typeof lstat>> | null = null
  try {
    const existing = await lstat(writeOutput)
    if (!options.force) throw new Error("export destination already exists")
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error("forced export destination must be a regular file")
    }
    expectedDestination = existing
  } catch (error) {
    if (
      !(error instanceof Error && "code" in error && error.code === "ENOENT")
    ) {
      throw error
    }
  }

  const exportedAt = new Date()
  const captureWorkspace = () =>
    captureConsistentWorkspace(sourceRoot, historyPolicy, exportedAt)
  const { selected, capture } = options.withCaptureBarrier
    ? await options.withCaptureBarrier(captureWorkspace)
    : await captureWorkspace()
  const temporary = join(
    outputParent,
    `.${basename(output)}.${randomBytes(8).toString("hex")}.partial`
  )
  const archiveLimit =
    archiveLimitForTests ?? WORKSPACE_EXPORT_V2_MAX_ARCHIVE_BYTES

  try {
    const manifestFile = capture.files.find(
      (file) => file.path === "worktable.workspace.json"
    )
    if (!manifestFile) throw new Error("workspace export has no manifest")
    let sourceManifest: unknown
    try {
      sourceManifest = JSON.parse(await readFile(manifestFile.absolute, "utf8"))
    } catch {
      throw new Error("workspace manifest is missing or unreadable")
    }
    if (!isWorkspaceManifest(sourceManifest)) {
      throw new Error("workspace manifest is invalid or unsupported")
    }
    const source = validateWorkspaceExportSource({
      workspaceId: sourceManifest.id,
      workspaceName: sourceManifest.name,
    })
    const root = sanitizedArchiveRoot(source.workspaceName)
    const publicFiles = capture.files.map(
      ({ path, size, mode, mtime, sha256: hash }) => ({
        path,
        size,
        mode,
        mtime,
        sha256: hash,
      })
    )
    assertPortableOwnerAccess(capture.directories, publicFiles)
    const contentFiles = publicFiles.filter(
      (file) => file.path !== "worktable.workspace.json"
    )
    const contentDirectories = capture.directories.filter(
      (directory) => directory.path !== "."
    )
    const viewer = await generateViewerBundle(
      capture.files,
      selected.history,
      (file) => readFile(file.absolute, "utf8")
    )
    for (const directory of capture.directories) {
      generatedArchivePath(root, `workspace/${directory.path}`)
    }
    for (const file of capture.files) {
      generatedArchivePath(root, `workspace/${file.path}`)
    }
    for (const path of viewer.files.keys()) {
      generatedArchivePath(root, path)
    }
    generatedArchivePath(root, "worktable-export.json")
    const manifest: WorkspaceExportV2Manifest = {
      type: WORKSPACE_EXPORT_V2_TYPE,
      version: WORKSPACE_EXPORT_V2_VERSION,
      exportId: `exp_${randomBytes(16).toString("base64url")}`,
      exportedAt: exportedAt.toISOString(),
      generator: { version: packageVersion() },
      archive: {
        root,
        container: "zip",
        compression: "deflate",
      },
      source: {
        workspaceId: source.workspaceId,
        workspaceName: source.workspaceName,
      },
      history: selected.history,
      integrity: {
        sourceCheckpoint: canonicalCheckpoint(capture.directories, publicFiles),
        contentCheckpoint: canonicalCheckpoint(
          contentDirectories,
          contentFiles
        ),
        directories: capture.directories,
        files: publicFiles,
      },
      viewer: viewer.status,
    }
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
    const manifestLimit =
      manifestLimitForTests ?? WORKSPACE_EXPORT_V2_MAX_MANIFEST_BYTES
    if (manifestBytes.byteLength > manifestLimit) {
      throw new Error("workspace export manifest exceeds the v2 limit")
    }

    const zip = new yazl.ZipFile()
    pipelineStartHookForTests?.()
    const writing = pipeZip(zip, temporary, archiveLimit)
    for (const directory of capture.directories) {
      zip.addEmptyDirectory(`${root}/workspace/${directory.path}`, {
        mode: directory.mode,
        mtime: new Date(directory.mtime),
      })
    }
    for (const file of capture.files) {
      zip.addFile(file.absolute, `${root}/workspace/${file.path}`, {
        mode: file.mode,
        mtime: new Date(file.mtime),
        compress: true,
        compressionLevel: 6,
      })
    }
    for (const [path, contents] of viewer.files) {
      zip.addBuffer(contents, `${root}/${path}`, {
        mtime: exportedAt,
        mode: 0o600,
        compress: true,
        compressionLevel: 6,
      })
    }
    zip.addBuffer(manifestBytes, `${root}/worktable-export.json`, {
      mtime: exportedAt,
      mode: 0o600,
      compress: true,
      compressionLevel: 6,
    })
    zip.end({
      forceZip64Format: false,
      comment: "Worktable workspace export v2",
    })
    await writing
    await chmod(temporary, 0o600)
    const bytes = (await stat(temporary)).size
    if (bytes > archiveLimit) {
      throw new Error("workspace export exceeds the v2 archive limit")
    }
    const archiveSha256 = await hashFile(temporary)
    await beforePublishHookForTests?.()
    const currentOutputParent = await realpath(dirname(output))
    const currentParentIdentity = await lstat(currentOutputParent)
    if (
      currentOutputParent !== outputParent ||
      currentParentIdentity.dev !== outputParentIdentity.dev ||
      currentParentIdentity.ino !== outputParentIdentity.ino ||
      !currentParentIdentity.isDirectory() ||
      isInside(canonicalRoot, currentOutputParent)
    ) {
      throw new Error("export destination parent changed; retry")
    }
    try {
      const currentDestination = await lstat(writeOutput)
      if (
        !expectedDestination ||
        !currentDestination.isFile() ||
        currentDestination.isSymbolicLink() ||
        currentDestination.dev !== expectedDestination.dev ||
        currentDestination.ino !== expectedDestination.ino
      ) {
        throw new Error("export destination changed; retry")
      }
    } catch (error) {
      const missing =
        error instanceof Error && "code" in error && error.code === "ENOENT"
      if (!missing || expectedDestination) throw error
    }
    await rename(temporary, writeOutput)
    return {
      manifest,
      destination: writeOutput,
      bytes,
      sha256: archiveSha256,
    }
  } finally {
    try {
      await removeCapture(capture)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}

const openZip = promisify<string, yauzl.Options, yauzl.ZipFile>(
  yauzl.open as never
)

function entryUnixMode(entry: yauzl.Entry): number {
  return (entry.externalFileAttributes >>> 16) & 0xffff
}

function assertRegularArchiveEntry(
  entry: yauzl.Entry,
  directory: boolean
): void {
  if (entry.isEncrypted())
    throw new Error("encrypted workspace packages are not supported")
  if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
    throw new Error(
      `unsupported ZIP compression method: ${entry.compressionMethod}`
    )
  }
  const mode = entryUnixMode(entry)
  const kind = mode & 0o170000
  if (kind !== 0 && kind !== (directory ? 0o040000 : 0o100000)) {
    throw new Error(
      `workspace package contains a special entry: ${entry.fileName}`
    )
  }
}

async function collectArchiveEntries(
  zip: yauzl.ZipFile
): Promise<ArchiveEntry[]> {
  return await new Promise((resolveEntries, reject) => {
    const entries: ArchiveEntry[] = []
    const seen = new Set<string>()
    let expandedBytes = 0
    zip.once("error", reject)
    zip.on("entry", (entry: yauzl.Entry) => {
      try {
        if (entries.length >= WORKSPACE_EXPORT_V2_MAX_ARCHIVE_ENTRIES) {
          throw new Error("workspace package exceeds the archive entry limit")
        }
        const directory = entry.fileName.endsWith("/")
        const rawPath = directory ? entry.fileName.slice(0, -1) : entry.fileName
        const path = validateWorkspaceExportV2Path(rawPath)
        const collision = path.toLocaleLowerCase("en-US")
        if (seen.has(path) || seen.has(collision)) {
          throw new Error(`duplicate or colliding archive path: ${path}`)
        }
        seen.add(path)
        seen.add(collision)
        assertRegularArchiveEntry(entry, directory)
        if (entry.uncompressedSize > WORKSPACE_EXPORT_V2_MAX_FILE_BYTES) {
          throw new Error(`workspace package entry is too large: ${path}`)
        }
        expandedBytes += entry.uncompressedSize
        if (expandedBytes > WORKSPACE_EXPORT_V2_MAX_ARCHIVE_EXPANDED_BYTES) {
          throw new Error(
            "workspace package exceeds the total expanded-size limit"
          )
        }
        entries.push({ entry, path, directory })
        zip.readEntry()
      } catch (error) {
        reject(error)
        zip.close()
      }
    })
    zip.once("end", () => resolveEntries(entries))
    zip.readEntry()
  })
}

async function readZipEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  maximum: number
): Promise<Buffer> {
  const stream = await new Promise<NodeJS.ReadableStream>(
    (resolveStream, reject) => {
      zip.openReadStream(entry, (error, opened) => {
        if (error) reject(error)
        else resolveStream(opened)
      })
    }
  )
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk)
    total += buffer.byteLength
    if (total > maximum)
      throw new Error("workspace package entry exceeds its limit")
    chunks.push(buffer)
  }
  return Buffer.concat(chunks, total)
}

function parseManifest(value: unknown): WorkspaceExportV2Manifest {
  if (!value || typeof value !== "object")
    throw new Error("invalid workspace package manifest")
  const manifest = value as WorkspaceExportV2Manifest
  if (
    manifest.type !== WORKSPACE_EXPORT_V2_TYPE ||
    manifest.version !== WORKSPACE_EXPORT_V2_VERSION ||
    typeof manifest.exportId !== "string" ||
    !/^exp_[A-Za-z0-9_-]{22}$/.test(manifest.exportId) ||
    !Number.isFinite(Date.parse(manifest.exportedAt)) ||
    !manifest.generator ||
    typeof manifest.generator.version !== "string" ||
    manifest.generator.version.length > 200 ||
    !manifest.archive ||
    manifest.archive.container !== "zip" ||
    manifest.archive.compression !== "deflate" ||
    typeof manifest.archive.root !== "string" ||
    !manifest.source ||
    !manifest.history ||
    !manifest.viewer ||
    !manifest.integrity ||
    !Array.isArray(manifest.integrity.files) ||
    !Array.isArray(manifest.integrity.directories) ||
    !/^[0-9a-f]{64}$/.test(manifest.integrity.sourceCheckpoint) ||
    !/^[0-9a-f]{64}$/.test(manifest.integrity.contentCheckpoint)
  ) {
    throw new Error("workspace package manifest is invalid or unsupported")
  }
  manifest.source = validateWorkspaceExportSource(manifest.source)
  validateWorkspaceExportV2Path(manifest.archive.root)
  validateHistoryPolicy(manifest.history.requested)
  if (
    typeof manifest.history.complete !== "boolean" ||
    !Number.isSafeInteger(manifest.history.includedFiles) ||
    manifest.history.includedFiles < 0 ||
    !Number.isSafeInteger(manifest.history.includedBytes) ||
    manifest.history.includedBytes < 0 ||
    !Number.isSafeInteger(manifest.history.omittedFiles) ||
    manifest.history.omittedFiles < 0 ||
    !Number.isSafeInteger(manifest.history.omittedBytes) ||
    manifest.history.omittedBytes < 0 ||
    !Number.isSafeInteger(manifest.history.meaningfulCheckpoints) ||
    manifest.history.meaningfulCheckpoints < 0 ||
    !Array.isArray(manifest.history.warnings) ||
    manifest.history.warnings.length > 10_000 ||
    manifest.history.warnings.some(
      (warning) => typeof warning !== "string" || warning.length > 2_000
    ) ||
    (manifest.history.oldestIncludedAt !== undefined &&
      !Number.isFinite(Date.parse(manifest.history.oldestIncludedAt))) ||
    (manifest.history.newestIncludedAt !== undefined &&
      !Number.isFinite(Date.parse(manifest.history.newestIncludedAt))) ||
    !["complete", "partial", "failed"].includes(manifest.viewer.status) ||
    !Array.isArray(manifest.viewer.warnings) ||
    manifest.viewer.warnings.length > 10_000 ||
    manifest.viewer.warnings.some(
      (warning) => typeof warning !== "string" || warning.length > 2_000
    )
  ) {
    throw new Error("workspace package summary metadata is invalid")
  }
  const paths = new Set<string>()
  const collisionPaths = new Set<string>()
  let expanded = 0
  for (const directory of manifest.integrity.directories) {
    directory.path = validateWorkspaceExportV2Path(directory.path)
    const requiredOwnerMode = directory.path === "." ? 0o700 : 0o500
    if (
      paths.has(directory.path) ||
      collisionPaths.has(directory.path.toLocaleLowerCase("en-US")) ||
      !Number.isInteger(directory.mode) ||
      directory.mode < 0 ||
      directory.mode > 0o777 ||
      (directory.mode & requiredOwnerMode) !== requiredOwnerMode ||
      !Number.isFinite(Date.parse(directory.mtime))
    ) {
      throw new Error(`invalid workspace package directory: ${directory.path}`)
    }
    paths.add(directory.path)
    collisionPaths.add(directory.path.toLocaleLowerCase("en-US"))
  }
  for (const file of manifest.integrity.files) {
    file.path = validateWorkspaceExportV2Path(file.path)
    if (
      paths.has(file.path) ||
      collisionPaths.has(file.path.toLocaleLowerCase("en-US")) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > WORKSPACE_EXPORT_V2_MAX_FILE_BYTES ||
      !Number.isInteger(file.mode) ||
      file.mode < 0 ||
      file.mode > 0o777 ||
      (file.mode & 0o400) !== 0o400 ||
      !Number.isFinite(Date.parse(file.mtime)) ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    ) {
      throw new Error(`invalid workspace package file: ${file.path}`)
    }
    if (
      file.path === "worktable.workspace.json" &&
      file.size > WORKSPACE_EXPORT_V2_MAX_WORKSPACE_MANIFEST_BYTES
    ) {
      throw new Error("workspace manifest exceeds the portable size limit")
    }
    expanded += file.size
    if (expanded > WORKSPACE_EXPORT_V2_MAX_EXPANDED_BYTES) {
      throw new Error("workspace package exceeds the expanded size limit")
    }
    paths.add(file.path)
    collisionPaths.add(file.path.toLocaleLowerCase("en-US"))
  }
  if (paths.size > WORKSPACE_EXPORT_V2_MAX_WORKSPACE_ENTRIES) {
    throw new Error("workspace package exceeds the workspace entry limit")
  }
  const filePaths = new Set(manifest.integrity.files.map((file) => file.path))
  const directoryPaths = new Set(
    manifest.integrity.directories.map((directory) => directory.path)
  )
  if (!filePaths.has("worktable.workspace.json")) {
    throw new Error("workspace package has no portable workspace manifest")
  }
  for (const path of paths) {
    const parts = path.split("/")
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join("/")
      if (filePaths.has(parent)) {
        throw new Error(
          `workspace package path is nested beneath a file: ${path}`
        )
      }
      if (!directoryPaths.has(parent)) {
        throw new Error(
          `workspace package path has an undeclared parent directory: ${path}`
        )
      }
    }
  }
  const sortedDirectories = [...manifest.integrity.directories].sort(
    (left, right) => comparePortableText(left.path, right.path)
  )
  const sortedFiles = [...manifest.integrity.files].sort((left, right) =>
    comparePortableText(left.path, right.path)
  )
  const includedHistoryFiles = sortedFiles.filter((file) =>
    file.path.startsWith("versions/")
  )
  if (
    manifest.history.includedFiles !== includedHistoryFiles.length ||
    manifest.history.includedBytes !==
      includedHistoryFiles.reduce((sum, file) => sum + file.size, 0) ||
    manifest.history.meaningfulCheckpoints > manifest.history.includedFiles ||
    manifest.history.complete !== (manifest.history.omittedFiles === 0)
  ) {
    throw new Error(
      "workspace package history summary does not match its entries"
    )
  }
  if (
    canonicalCheckpoint(sortedDirectories, sortedFiles) !==
    manifest.integrity.sourceCheckpoint
  ) {
    throw new Error("workspace package checkpoint does not match its entries")
  }
  const contentFiles = sortedFiles.filter(
    (file) => file.path !== "worktable.workspace.json"
  )
  if (
    canonicalCheckpoint(sortedDirectories, contentFiles) !==
    manifest.integrity.contentCheckpoint
  ) {
    throw new Error("workspace package content checkpoint is invalid")
  }
  manifest.integrity.directories = sortedDirectories
  manifest.integrity.files = sortedFiles
  return manifest
}

function assertDeclaredArchiveLayout(
  entries: ArchiveEntry[],
  manifest: WorkspaceExportV2Manifest
): void {
  const root = manifest.archive.root
  const workspaceRoot = `${root}/workspace`
  const allowedDirectories = new Set([
    root,
    workspaceRoot,
    `${root}/browse`,
    `${root}/browse/content`,
    ...manifest.integrity.directories.map((directory) =>
      directory.path === "."
        ? workspaceRoot
        : `${workspaceRoot}/${directory.path}`
    ),
  ])
  const allowedFiles = new Set([
    `${root}/worktable-export.json`,
    `${root}/README.txt`,
    `${root}/Open Worktable Export.html`,
    ...manifest.integrity.files.map((file) => `${workspaceRoot}/${file.path}`),
  ])
  const viewerPrefix = `${root}/browse/content/`

  for (const item of entries) {
    const declared = item.directory
      ? allowedDirectories.has(item.path)
      : allowedFiles.has(item.path) ||
        (item.path.startsWith(viewerPrefix) &&
          /^(?:item|preview)-\d+\.html$/u.test(
            item.path.slice(viewerPrefix.length)
          ))
    if (!declared) {
      throw new Error(
        `workspace package contains an undeclared archive entry: ${item.path}`
      )
    }
  }
}

async function assertOfflineViewerMatches(
  zip: yauzl.ZipFile,
  entries: ArchiveEntry[],
  manifest: WorkspaceExportV2Manifest,
  workspaceFiles: Map<string, ArchiveEntry>
): Promise<void> {
  const generated = await generateViewerBundle(
    manifest.integrity.files,
    manifest.history,
    async (file) => {
      const archived = workspaceFiles.get(file.path)
      if (!archived) {
        throw new Error(`workspace package file is missing: ${file.path}`)
      }
      return (await readZipEntry(zip, archived.entry, file.size)).toString(
        "utf8"
      )
    }
  )
  if (
    generated.status.status !== manifest.viewer.status ||
    generated.status.warnings.length !== manifest.viewer.warnings.length ||
    generated.status.warnings.some(
      (warning, index) => warning !== manifest.viewer.warnings[index]
    )
  ) {
    throw new Error(
      "workspace package offline viewer status does not match its contents"
    )
  }

  const rootPrefix = `${manifest.archive.root}/`
  const workspacePrefix = `${rootPrefix}workspace/`
  const manifestPath = `${rootPrefix}worktable-export.json`
  const actualViewer = new Map(
    entries
      .filter(
        (item) =>
          !item.directory &&
          item.path !== manifestPath &&
          !item.path.startsWith(workspacePrefix)
      )
      .map((item) => [item.path.slice(rootPrefix.length), item])
  )
  if (
    actualViewer.size !== generated.files.size ||
    [...actualViewer.keys()].some((path) => !generated.files.has(path))
  ) {
    throw new Error(
      "workspace package offline viewer files do not match its contents"
    )
  }
  for (const [path, expected] of generated.files) {
    const actual = actualViewer.get(path)
    if (
      !actual ||
      actual.entry.uncompressedSize !== expected.byteLength ||
      !(await readZipEntry(zip, actual.entry, expected.byteLength)).equals(
        expected
      )
    ) {
      throw new Error(
        `workspace package offline viewer file is invalid: ${path}`
      )
    }
  }
}

async function openAndInspectArchive(sourceFile: string): Promise<{
  zip: yauzl.ZipFile
  manifest: WorkspaceExportV2Manifest
  entries: ArchiveEntry[]
}> {
  const archivePath = resolve(sourceFile)
  const archiveInfo = await stat(archivePath)
  if (
    !archiveInfo.isFile() ||
    archiveInfo.size > WORKSPACE_EXPORT_V2_MAX_ARCHIVE_BYTES
  ) {
    throw new Error("workspace package exceeds the archive size limit")
  }
  const zip = await openZip(archivePath, {
    autoClose: false,
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: true,
  })
  try {
    const entries = await collectArchiveEntries(zip)
    const roots = new Set(entries.map((item) => item.path.split("/")[0]))
    if (roots.size !== 1)
      throw new Error("workspace package must contain one root directory")
    const root = [...roots][0]!
    const manifestEntry = entries.find(
      (item) => !item.directory && item.path === `${root}/worktable-export.json`
    )
    if (!manifestEntry) throw new Error("workspace package has no v2 manifest")
    const manifestBytes = await readZipEntry(
      zip,
      manifestEntry.entry,
      WORKSPACE_EXPORT_V2_MAX_MANIFEST_BYTES
    )
    let parsed: unknown
    try {
      parsed = JSON.parse(manifestBytes.toString("utf8"))
    } catch {
      throw new Error("workspace package manifest is not valid JSON")
    }
    const manifest = parseManifest(parsed)
    if (manifest.archive.root !== root) {
      throw new Error("workspace package root does not match its manifest")
    }
    assertDeclaredArchiveLayout(entries, manifest)
    const actualWorkspaceFiles = new Map(
      entries
        .filter(
          (item) =>
            !item.directory && item.path.startsWith(`${root}/workspace/`)
        )
        .map((item) => [item.path.slice(`${root}/workspace/`.length), item])
    )
    if (actualWorkspaceFiles.size !== manifest.integrity.files.length) {
      throw new Error("workspace package contains undeclared portable files")
    }
    const actualWorkspaceDirectories = new Set(
      entries
        .filter(
          (item) => item.directory && item.path.startsWith(`${root}/workspace/`)
        )
        .map((item) => item.path.slice(`${root}/workspace/`.length))
    )
    const declaredDirectories = new Set(
      manifest.integrity.directories.map((directory) => directory.path)
    )
    if (
      actualWorkspaceDirectories.size !== declaredDirectories.size ||
      [...actualWorkspaceDirectories].some(
        (path) => !declaredDirectories.has(path)
      )
    ) {
      throw new Error(
        "workspace package directory declarations do not match its contents"
      )
    }
    for (const file of manifest.integrity.files) {
      const actual = actualWorkspaceFiles.get(file.path)
      if (!actual || actual.entry.uncompressedSize !== file.size) {
        throw new Error(
          `workspace package file metadata does not match: ${file.path}`
        )
      }
    }
    await assertOfflineViewerMatches(
      zip,
      entries,
      manifest,
      actualWorkspaceFiles
    )
    return { zip, manifest, entries }
  } catch (error) {
    zip.close()
    throw error
  }
}

export async function inspectWorkspaceExportV2(
  sourceFile: string
): Promise<WorkspaceExportV2Inspection> {
  const archivePath = resolve(sourceFile)
  const { zip, manifest } = await openAndInspectArchive(archivePath)
  zip.close()
  return {
    manifest,
    archivePath,
    archiveBytes: (await stat(archivePath)).size,
    archiveSha256: await hashFile(archivePath),
  }
}

export async function extractWorkspaceExportV2(
  sourceFile: string,
  destination: string
): Promise<WorkspaceExportV2Manifest> {
  const { zip, manifest, entries } = await openAndInspectArchive(sourceFile)
  const rootPrefix = `${manifest.archive.root}/workspace/`
  const declared = new Map(
    manifest.integrity.files.map((file) => [file.path, file])
  )
  try {
    for (const directory of manifest.integrity.directories) {
      const output = join(destination, ...directory.path.split("/"))
      await mkdir(output, { recursive: true, mode: 0o700 })
    }
    for (const item of entries) {
      if (item.directory || !item.path.startsWith(rootPrefix)) continue
      const path = item.path.slice(rootPrefix.length)
      const metadata = declared.get(path)
      if (!metadata)
        throw new Error(`undeclared workspace package file: ${path}`)
      const output = join(destination, ...path.split("/"))
      await mkdir(dirname(output), { recursive: true, mode: 0o700 })
      const stream = await new Promise<NodeJS.ReadableStream>(
        (resolveStream, reject) => {
          zip.openReadStream(item.entry, (error, opened) => {
            if (error) reject(error)
            else resolveStream(opened)
          })
        }
      )
      const hash = createHash("sha256")
      let bytes = 0
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.byteLength
          if (bytes > metadata.size) {
            callback(
              new Error(`workspace package file exceeds declared size: ${path}`)
            )
            return
          }
          hash.update(chunk)
          callback(null, chunk)
        },
      })
      await pipeline(
        stream,
        meter,
        createWriteStream(output, { flags: "wx", mode: 0o600 })
      )
      if (bytes !== metadata.size || hash.digest("hex") !== metadata.sha256) {
        throw new Error(`workspace package integrity check failed: ${path}`)
      }
      await chmod(output, metadata.mode).catch(() => undefined)
      const mtime = new Date(metadata.mtime)
      await utimes(output, mtime, mtime).catch(() => undefined)
    }
    for (const directory of [...manifest.integrity.directories].sort(
      (left, right) =>
        right.path.split("/").length - left.path.split("/").length
    )) {
      const output = join(destination, ...directory.path.split("/"))
      await chmod(output, directory.mode).catch(() => undefined)
      const mtime = new Date(directory.mtime)
      await utimes(output, mtime, mtime).catch(() => undefined)
    }
    return manifest
  } finally {
    zip.close()
  }
}

export async function importWorkspaceExportV2(
  sourceFile: string,
  destination: string
): Promise<WorkspaceManifest> {
  const target = resolve(destination)
  const classification = classifyWorkspaceTarget(target)
  if (
    classification.outcome !== "missing" &&
    classification.outcome !== "empty"
  ) {
    throw new Error(
      "import destination must be missing or empty; existing workspaces are never replaced"
    )
  }
  const parent = dirname(target)
  await mkdir(parent, { recursive: true })
  const staging = join(
    parent,
    `.${basename(target)}.worktable-import-${randomBytes(8).toString("hex")}`
  )
  let removedEmptyTarget = false
  try {
    await mkdir(staging, { mode: 0o700 })
    const manifest = await extractWorkspaceExportV2(sourceFile, staging)
    const sourceManifestPath = join(staging, "worktable.workspace.json")
    let sourceManifest: unknown
    try {
      sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"))
    } catch {
      throw new Error("workspace package has no readable workspace manifest")
    }
    if (
      !isWorkspaceManifest(sourceManifest) ||
      sourceManifest.id !== manifest.source.workspaceId ||
      sourceManifest.name !== manifest.source.workspaceName
    ) {
      throw new Error(
        "workspace package source manifest does not match metadata"
      )
    }
    const newManifest: WorkspaceManifest = {
      type: "worktable.workspace",
      version: sourceManifest.version,
      id: `ws_${randomBytes(16).toString("base64url")}`,
      name: manifest.source.workspaceName,
      createdAt: new Date().toISOString(),
      cloud: { status: "unlinked" },
      provenance: {
        mode: "daily",
        source: {
          workspaceId: manifest.source.workspaceId,
          label: `Export ${manifest.exportId}`,
        },
        snapshotAt: manifest.exportedAt,
        oneWay: true,
      },
    }
    writeWorkspaceManifestBytesAt(
      staging,
      `${JSON.stringify(newManifest, null, 2)}\n`
    )
    if (classification.outcome === "empty") {
      const currentEntries = await readdir(target)
      if (!currentEntries.every(isIgnoredEmptyWorkspaceEntry)) {
        throw new Error(
          "import destination changed after validation; no files were replaced"
        )
      }
      for (const entry of currentEntries) {
        await rm(join(target, entry), { recursive: true, force: true })
      }
      await rmdir(target)
      removedEmptyTarget = true
    }
    await rename(staging, target)
    return newManifest
  } catch (error) {
    await removeWorkspaceTree(staging)
    if (removedEmptyTarget) await mkdir(target, { recursive: true })
    throw error
  }
}

export async function isWorkspaceExportV2(
  sourceFile: string
): Promise<boolean> {
  const handle = await open(resolve(sourceFile), "r")
  try {
    const magic = Buffer.alloc(4)
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0)
    return bytesRead === 4 && magic[0] === 0x50 && magic[1] === 0x4b
  } finally {
    await handle.close()
  }
}
