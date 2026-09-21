import { createHash, randomBytes } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises"
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
import {
  classifyWorkspaceTarget,
  getWorkspaceRoot,
  isIgnoredEmptyWorkspaceEntry,
  isWorkspaceManifest,
  type WorkspaceManifest,
} from "./workspace.ts"

export const WORKSPACE_EXPORT_TYPE = "worktable.workspace-export" as const
export const WORKSPACE_EXPORT_VERSION = 1 as const
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 256 * 1024 * 1024
export const WORKSPACE_EXPORT_MAX_ENCODED_BYTES = 360 * 1024 * 1024
export const WORKSPACE_EXPORT_MAX_ENTRIES = 50_000
const SECURE_READ_FLAGS =
  fsConstants.O_RDONLY |
  (fsConstants.O_NOFOLLOW ?? 0) |
  (fsConstants.O_NONBLOCK ?? 0)
const SECURE_WRITE_FLAGS =
  fsConstants.O_WRONLY |
  (fsConstants.O_NOFOLLOW ?? 0) |
  (fsConstants.O_NONBLOCK ?? 0)

export interface WorkspaceExportFile {
  path: string
  size: number
  mode: number
  sha256: string
  data: string
}

export interface WorkspaceExportBundle {
  type: typeof WORKSPACE_EXPORT_TYPE
  version: typeof WORKSPACE_EXPORT_VERSION
  exportId: string
  exportedAt: string
  sourceWorkspaceId: string
  sourceWorkspaceName: string
  sourceCheckpoint: string
  directories: string[]
  files: WorkspaceExportFile[]
}

function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex")
}

function checkpoint(
  files: Array<Pick<WorkspaceExportFile, "path" | "size" | "sha256">>
): string {
  return sha256(
    JSON.stringify(
      files.map(({ path, size, sha256: hash }) => ({
        path,
        size,
        sha256: hash,
      }))
    )
  )
}

function portablePath(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/")
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return (
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  )
}

function sameEntry(
  left: Awaited<ReturnType<typeof stat>>,
  right: Awaited<ReturnType<typeof stat>>
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** Resolve symlinks in the existing prefix without requiring the leaf to exist. */
async function canonicalPotentialPath(value: string): Promise<string> {
  const missing: string[] = []
  let cursor = value
  while (true) {
    try {
      return resolve(await realpath(cursor), ...missing.reverse())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
      const parent = dirname(cursor)
      if (parent === cursor) throw err
      missing.push(basename(cursor))
      cursor = parent
    }
  }
}

function validateRelativePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/")
  ) {
    throw new Error("export contains an invalid workspace path")
  }
  const normalized = posix.normalize(value)
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    throw new Error(`export contains an unsafe workspace path: ${value}`)
  }
  return value
}

async function readWorkspaceFile(
  absolute: string,
  path: string,
  expected: Awaited<ReturnType<typeof lstat>>,
  canonicalRoot: string
): Promise<{ data: Buffer; mode: number }> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    // O_NOFOLLOW closes the lstat/open race for symlinks. O_NONBLOCK prevents
    // a swapped FIFO from hanging before fstat can reject it.
    handle = await open(absolute, SECURE_READ_FLAGS)
  } catch (err) {
    if (
      ["ELOOP", "EMLINK"].includes((err as NodeJS.ErrnoException).code ?? "")
    ) {
      throw new Error(`workspace export refuses symlink: ${path}`)
    }
    throw err
  }

  try {
    const opened = await handle.stat()
    if (!opened.isFile()) {
      throw new Error(`workspace export refuses special file: ${path}`)
    }
    // On platforms without O_NOFOLLOW, descriptor identity still catches a
    // path swapped between lstat and open. Normal in-place edits keep identity.
    if (!sameEntry(opened, expected)) {
      throw new Error(`workspace changed during export: ${path}; retry`)
    }
    // O_NOFOLLOW protects the leaf, but not a parent directory replaced with a
    // symlink. Resolve the path after opening it, require that resolution to
    // remain inside the canonical workspace root, and confirm that it still
    // names the descriptor we are about to read.
    const canonical = await realpath(absolute)
    if (!isWithin(canonicalRoot, canonical)) {
      throw new Error(`workspace path escaped during export: ${path}; retry`)
    }
    const reachable = await stat(canonical)
    if (!sameEntry(opened, reachable)) {
      throw new Error(`workspace changed during export: ${path}; retry`)
    }
    if (opened.size > MAX_FILE_BYTES) {
      throw new Error(`workspace file exceeds the v1 export limit: ${path}`)
    }

    const chunks: Buffer[] = []
    let captured = 0
    while (true) {
      const remaining = MAX_FILE_BYTES + 1 - captured
      if (remaining <= 0) {
        throw new Error(`workspace file exceeds the v1 export limit: ${path}`)
      }
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, remaining))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead === 0) break
      captured += bytesRead
      if (captured > MAX_FILE_BYTES) {
        throw new Error(`workspace file exceeds the v1 export limit: ${path}`)
      }
      chunks.push(buffer.subarray(0, bytesRead))
    }
    return { data: Buffer.concat(chunks, captured), mode: opened.mode & 0o777 }
  } finally {
    await handle.close()
  }
}

async function assertWorkspaceDirectory(
  absolute: string,
  path: string,
  expected: Awaited<ReturnType<typeof stat>>,
  canonicalRoot: string
): Promise<void> {
  const canonical = await realpath(absolute)
  if (!isWithin(canonicalRoot, canonical)) {
    throw new Error(`workspace path escaped during export: ${path}; retry`)
  }
  const reachable = await stat(canonical)
  if (!reachable.isDirectory() || !sameEntry(expected, reachable)) {
    throw new Error(`workspace changed during export: ${path}; retry`)
  }
}

function capturedManifest(files: WorkspaceExportFile[]): WorkspaceManifest {
  const entry = files.find((file) => file.path === "worktable.workspace.json")
  if (!entry) throw new Error("workspace export has no workspace manifest")
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(entry.data, "base64").toString("utf8"))
  } catch {
    throw new Error("workspace manifest is missing or unreadable")
  }
  if (!isWorkspaceManifest(parsed)) {
    throw new Error("workspace manifest is invalid or unsupported")
  }
  if (parsed.version !== 1) {
    throw new Error(
      "workspace export V1 does not support Storage V2; use the current workspace export"
    )
  }
  return parsed
}

function serializeWorkspaceExport(bundle: WorkspaceExportBundle): string {
  const serialized = `${JSON.stringify(bundle, null, 2)}\n`
  if (
    Buffer.byteLength(serialized, "utf8") > WORKSPACE_EXPORT_MAX_ENCODED_BYTES
  ) {
    throw new Error("workspace export exceeds the v1 encoded size limit")
  }
  return serialized
}

/** Build a complete snapshot from the workspace provider's root. */
export async function createWorkspaceExport(): Promise<WorkspaceExportBundle> {
  const root = resolve(getWorkspaceRoot())
  const canonicalRoot = await realpath(root)
  const rootInfo = await stat(canonicalRoot)
  if (!rootInfo.isDirectory())
    throw new Error("workspace root is not a directory")
  const directories: string[] = []
  const files: WorkspaceExportFile[] = []
  let total = 0

  const visit = async (
    directory: string,
    path: string,
    expected: Awaited<ReturnType<typeof stat>>
  ): Promise<void> => {
    await assertWorkspaceDirectory(directory, path, expected, canonicalRoot)
    const entries = await readdir(directory, { withFileTypes: true })
    // If the directory changed while readdir was in flight, do not consume its
    // entries through a replacement path.
    await assertWorkspaceDirectory(directory, path, expected, canonicalRoot)
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const absolute = join(directory, entry.name)
      const info = await lstat(absolute)
      const entryPath = validateRelativePath(portablePath(root, absolute))
      if (info.isSymbolicLink()) {
        throw new Error(`workspace export refuses symlink: ${entryPath}`)
      }
      if (info.isDirectory()) {
        await assertWorkspaceDirectory(absolute, entryPath, info, canonicalRoot)
        directories.push(entryPath)
        if (directories.length + files.length > WORKSPACE_EXPORT_MAX_ENTRIES) {
          throw new Error("workspace exceeds the v1 export entry limit")
        }
        await visit(absolute, entryPath, info)
        continue
      }
      if (!info.isFile()) {
        throw new Error(`workspace export refuses special file: ${entryPath}`)
      }
      if (info.size > MAX_FILE_BYTES) {
        throw new Error(
          `workspace file exceeds the v1 export limit: ${entryPath}`
        )
      }
      const { data, mode } = await readWorkspaceFile(
        absolute,
        entryPath,
        info,
        canonicalRoot
      )
      total += data.byteLength
      if (total > MAX_TOTAL_BYTES) {
        throw new Error("workspace exceeds the v1 export size limit")
      }
      files.push({
        path: entryPath,
        size: data.byteLength,
        mode,
        sha256: sha256(data),
        data: data.toString("base64"),
      })
      if (directories.length + files.length > WORKSPACE_EXPORT_MAX_ENTRIES) {
        throw new Error("workspace exceeds the v1 export entry limit")
      }
    }
    // A completed export is only returned if every directory still names the
    // same in-root directory after its children were captured.
    await assertWorkspaceDirectory(directory, path, expected, canonicalRoot)
  }
  await visit(root, "workspace root", rootInfo)
  files.sort((a, b) => a.path.localeCompare(b.path))
  directories.sort()
  // Metadata comes from the exact manifest bytes in the snapshot, never from
  // an earlier live read that could disagree after a concurrent rename.
  const manifest = capturedManifest(files)

  const bundle: WorkspaceExportBundle = {
    type: WORKSPACE_EXPORT_TYPE,
    version: WORKSPACE_EXPORT_VERSION,
    exportId: `exp_${randomBytes(16).toString("base64url")}`,
    exportedAt: new Date().toISOString(),
    sourceWorkspaceId: manifest.id,
    sourceWorkspaceName: manifest.name,
    sourceCheckpoint: checkpoint(files),
    directories,
    files,
  }
  // The importer caps the encoded file before parsing it. Enforce that same
  // cap here so every successfully-created bundle is importable by v1.
  serializeWorkspaceExport(bundle)
  return bundle
}

export async function writeWorkspaceExport(
  destination: string,
  options: { force?: boolean } = {}
): Promise<WorkspaceExportBundle> {
  const output = resolve(destination)
  const workspaceRoot = await realpath(resolve(getWorkspaceRoot()))
  const canonicalOutput = await canonicalPotentialPath(output)
  if (isWithin(workspaceRoot, canonicalOutput)) {
    throw new Error("workspace exports must be written outside the workspace")
  }

  // Validate before walking the workspace. --force is only an overwrite
  // contract for an existing regular export file.
  if (options.force) {
    try {
      const existing = await lstat(output)
      if (!existing.isFile()) {
        throw new Error("forced export destination must be a regular file")
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
  }

  const bundle = await createWorkspaceExport()
  await mkdir(dirname(output), { recursive: true })
  // Resolve the parent again after the potentially long snapshot. Operating on
  // this canonical parent keeps a concurrently swapped alias from redirecting
  // the write, and repeats the outside-workspace boundary at the last moment.
  const writeOutput = join(await realpath(dirname(output)), basename(output))
  if (isWithin(workspaceRoot, writeOutput)) {
    throw new Error("workspace exports must be written outside the workspace")
  }
  const serialized = serializeWorkspaceExport(bundle)
  let expected: Awaited<ReturnType<typeof lstat>> | null = null
  if (options.force) {
    try {
      expected = await lstat(writeOutput)
      if (!expected.isFile()) {
        throw new Error("forced export destination must be a regular file")
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    }
  }

  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(
      writeOutput,
      options.force && expected
        ? SECURE_WRITE_FLAGS
        : SECURE_WRITE_FLAGS | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600
    )
  } catch (err) {
    if (
      options.force &&
      ["ELOOP", "EMLINK"].includes((err as NodeJS.ErrnoException).code ?? "")
    ) {
      throw new Error("forced export destination must be a regular file")
    }
    throw err
  }

  try {
    const opened = await handle.stat()
    if (!opened.isFile()) {
      throw new Error("export destination must be a regular file")
    }
    if (expected && !sameEntry(opened, expected)) {
      throw new Error("export destination changed while writing; retry")
    }
    // Permission changes and truncation happen through the verified descriptor,
    // never through a path that another process can swap to a symlink.
    await handle.chmod(0o600)
    if (expected) await handle.truncate(0)
    await handle.writeFile(serialized, { encoding: "utf8" })
    await handle.sync()
  } finally {
    await handle.close()
  }
  return bundle
}

function parseBundle(value: unknown): WorkspaceExportBundle {
  if (!value || typeof value !== "object")
    throw new Error("invalid workspace export")
  const raw = value as Partial<WorkspaceExportBundle>
  if (
    raw.type !== WORKSPACE_EXPORT_TYPE ||
    raw.version !== WORKSPACE_EXPORT_VERSION
  ) {
    throw new Error("unsupported workspace export type or version")
  }
  if (
    typeof raw.exportId !== "string" ||
    !/^exp_[A-Za-z0-9_-]{22}$/.test(raw.exportId) ||
    typeof raw.exportedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.exportedAt)) ||
    typeof raw.sourceWorkspaceId !== "string" ||
    typeof raw.sourceWorkspaceName !== "string" ||
    typeof raw.sourceCheckpoint !== "string" ||
    !/^[0-9a-f]{64}$/.test(raw.sourceCheckpoint) ||
    !Array.isArray(raw.directories) ||
    !Array.isArray(raw.files)
  ) {
    throw new Error("workspace export metadata is invalid")
  }
  if (
    raw.directories.length + raw.files.length >
    WORKSPACE_EXPORT_MAX_ENTRIES
  ) {
    throw new Error("workspace export exceeds entry limit")
  }
  const seen = new Set<string>()
  const directories = raw.directories.map((path) => {
    const valid = validateRelativePath(path)
    if (seen.has(valid)) throw new Error(`duplicate export path: ${valid}`)
    seen.add(valid)
    return valid
  })
  let total = 0
  const files = raw.files.map((entry) => {
    if (!entry || typeof entry !== "object")
      throw new Error("invalid export file entry")
    const path = validateRelativePath(entry.path)
    if (seen.has(path)) throw new Error(`duplicate export path: ${path}`)
    seen.add(path)
    if (
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      entry.size > MAX_FILE_BYTES ||
      !Number.isInteger(entry.mode) ||
      entry.mode < 0 ||
      entry.mode > 0o777 ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      typeof entry.data !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        entry.data
      )
    ) {
      throw new Error(`invalid export file metadata: ${path}`)
    }
    const data = Buffer.from(entry.data, "base64")
    if (data.byteLength !== entry.size || sha256(data) !== entry.sha256) {
      throw new Error(`workspace export integrity check failed: ${path}`)
    }
    total += data.byteLength
    if (total > MAX_TOTAL_BYTES)
      throw new Error("workspace export exceeds size limit")
    return { ...entry, path } as WorkspaceExportFile
  })
  const filePaths = new Set(files.map((file) => file.path))
  for (const path of [...directories, ...filePaths]) {
    const parts = path.split("/")
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/")
      if (filePaths.has(ancestor)) {
        throw new Error(`export path is nested beneath a file: ${path}`)
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  directories.sort()
  if (checkpoint(files) !== raw.sourceCheckpoint) {
    throw new Error("workspace export checkpoint does not match its files")
  }
  const manifestEntry = files.find(
    (file) => file.path === "worktable.workspace.json"
  )
  if (!manifestEntry)
    throw new Error("workspace export has no workspace manifest")
  const sourceManifest = JSON.parse(
    Buffer.from(manifestEntry.data, "base64").toString("utf8")
  ) as unknown
  if (
    !isWorkspaceManifest(sourceManifest) ||
    sourceManifest.id !== raw.sourceWorkspaceId ||
    sourceManifest.name !== raw.sourceWorkspaceName
  ) {
    throw new Error(
      "workspace export source manifest does not match its metadata"
    )
  }
  return { ...raw, directories, files } as WorkspaceExportBundle
}

/** Import as a fresh, independent workspace assembled off to the side. */
export async function importWorkspaceExport(
  sourceFile: string,
  destination: string
): Promise<WorkspaceManifest> {
  const sourceInfo = await stat(resolve(sourceFile))
  if (sourceInfo.size > WORKSPACE_EXPORT_MAX_ENCODED_BYTES) {
    throw new Error("workspace export file exceeds the v1 encoded size limit")
  }
  const bundle = parseBundle(
    JSON.parse(await readFile(resolve(sourceFile), "utf8"))
  )
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
  const newManifest: WorkspaceManifest = {
    type: "worktable.workspace",
    version: 1,
    id: `ws_${randomBytes(16).toString("base64url")}`,
    name: bundle.sourceWorkspaceName,
    createdAt: new Date().toISOString(),
    cloud: { status: "unlinked" },
    provenance: {
      mode: "daily",
      source: {
        workspaceId: bundle.sourceWorkspaceId,
        label: `Export ${bundle.exportId}`,
      },
      snapshotAt: bundle.exportedAt,
      oneWay: true,
    },
  }

  let removedEmptyTarget = false
  try {
    await mkdir(staging)
    for (const directory of bundle.directories) {
      await mkdir(join(staging, ...directory.split("/")), { recursive: true })
    }
    for (const file of bundle.files) {
      if (file.path === "worktable.workspace.json") continue
      const output = join(staging, ...file.path.split("/"))
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, Buffer.from(file.data, "base64"), {
        mode: file.mode,
      })
      await chmod(output, file.mode)
    }
    await writeFile(
      join(staging, "worktable.workspace.json"),
      `${JSON.stringify(newManifest, null, 2)}\n`,
      { mode: 0o600 }
    )
    if (classification.outcome === "empty") {
      const entries = await readdir(target)
      if (!entries.every(isIgnoredEmptyWorkspaceEntry)) {
        throw new Error(
          "import destination changed after validation; no files were replaced"
        )
      }
      for (const entry of entries) {
        await rm(join(target, entry), { recursive: true, force: true })
      }
      await rmdir(target)
      removedEmptyTarget = true
    }
    await rename(staging, target)
    return newManifest
  } catch (err) {
    await rm(staging, { recursive: true, force: true })
    if (removedEmptyTarget) await mkdir(target, { recursive: true })
    throw err
  }
}
