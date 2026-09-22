import { mapWithConcurrency } from "./bounded-concurrency.ts"
import { createHash, randomBytes } from "node:crypto"
import { lstat, mkdir, open, realpath, rename } from "node:fs/promises"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { z } from "zod"
import { readBoundedRegularFile } from "./bounded-file.ts"
import { removeWorkspaceTree } from "./workspace-tree-cleanup.ts"
import { getWorkspaceRoot, isWorkspaceManifest } from "./workspace.ts"
import {
  inspectPortableWorkspaceTree,
  portableWorkspaceCheckpoint,
  validateWorkspaceExportV2Path,
  withPortableWorkspaceCapture,
  WORKSPACE_EXPORT_V2_MAX_EXPANDED_BYTES,
  WORKSPACE_EXPORT_V2_MAX_MANIFEST_BYTES,
  WORKSPACE_EXPORT_V2_MAX_WORKSPACE_ENTRIES,
  WORKSPACE_EXPORT_V2_MAX_WORKSPACE_MANIFEST_BYTES,
  type PortableWorkspaceInventory,
} from "./workspace-transfer-v2.ts"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const path = z.string().refine((value) => {
  try {
    return validateWorkspaceExportV2Path(value) === value
  } catch {
    return false
  }
})
const metadata = {
  path,
  mode: z.number().int().min(0).max(0o777),
  mtime: z.iso.datetime(),
}
export const WorkspaceSnapshotManifestSchema = z.object({
  type: z.literal("worktable.workspace-snapshot"),
  backupFormatVersion: z.literal(1),
  snapshotId: z.string().regex(/^snap_[A-Za-z0-9_-]{22}$/),
  capturedAt: z.iso.datetime(),
  workspaceId: z.string().min(1).max(1024),
  workspaceStorageVersion: z.union([z.literal(1), z.literal(2)]),
  sourceRelease: z.string().min(1).max(128),
  sourceCheckpoint: digest,
  contentCheckpoint: digest,
  files: z
    .array(
      z.object({
        ...metadata,
        size: z.number().int().nonnegative(),
        sha256: digest,
      })
    )
    .max(WORKSPACE_EXPORT_V2_MAX_WORKSPACE_ENTRIES),
  directories: z
    .array(z.object(metadata))
    .max(WORKSPACE_EXPORT_V2_MAX_WORKSPACE_ENTRIES),
})
export type WorkspaceSnapshotManifest = z.infer<
  typeof WorkspaceSnapshotManifestSchema
>

function contained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return (
    !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  )
}

async function sync(path: string): Promise<void> {
  const handle = await open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Snapshot publication is separate from the short live-writer capture barrier. */
export async function writeWorkspaceSnapshot(
  destination: string,
  options: Parameters<typeof withPortableWorkspaceCapture>[1] = {}
): Promise<WorkspaceSnapshotManifest> {
  const sourceRoot = await realpath(options.workspaceRoot ?? getWorkspaceRoot())
  const output = resolve(destination)
  // Reject before creating any destination directory within the workspace.
  if (contained(sourceRoot, output))
    throw new Error("snapshot destination must be outside the workspace")
  const parent = await realpath(dirname(output))
  if (contained(sourceRoot, parent))
    throw new Error("snapshot destination must be outside the workspace")
  const parentInfo = await lstat(parent)
  const target = join(parent, basename(output))
  try {
    await lstat(target)
    throw new Error("snapshot destination already exists")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const temporary = join(
    parent,
    `.worktable-snapshot-${randomBytes(16).toString("hex")}`
  )
  await mkdir(temporary, { mode: 0o700 })
  let published = false
  try {
    const manifest = await withPortableWorkspaceCapture(async (capture) => {
      const inventory: PortableWorkspaceInventory = {
        files: capture.files,
        directories: capture.directories,
      }
      const result: WorkspaceSnapshotManifest = {
        type: "worktable.workspace-snapshot",
        backupFormatVersion: 1,
        snapshotId: `snap_${randomBytes(16).toString("base64url")}`,
        capturedAt: new Date().toISOString(),
        workspaceId: capture.manifest.id,
        workspaceStorageVersion: capture.manifest.version,
        sourceRelease:
          process.env["WORKTABLE_VERSION"]?.trim() || "development",
        sourceCheckpoint: portableWorkspaceCheckpoint(inventory),
        contentCheckpoint: portableWorkspaceCheckpoint({
          ...inventory,
          files: inventory.files.filter(
            (file) => file.path !== "worktable.workspace.json"
          ),
        }),
        ...inventory,
      }
      const bytes = JSON.stringify(result)
      WorkspaceSnapshotManifestSchema.parse(result)
      if (Buffer.byteLength(bytes) > WORKSPACE_EXPORT_V2_MAX_MANIFEST_BYTES)
        throw new Error("snapshot manifest exceeds the supported size")
      // Both roots are app-owned staging on the same filesystem. Moving gives
      // the job custody before export scratch cleanup can reclaim the capture.
      await rename(capture.root, join(temporary, "workspace"))
      const handle = await open(join(temporary, "snapshot.json"), "wx", 0o600)
      try {
        await handle.writeFile(bytes)
        await handle.sync()
      } finally {
        await handle.close()
      }
      return result
    }, options)
    await mapWithConcurrency(manifest.files, 8, (file) =>
      sync(join(temporary, "workspace", file.path))
    )
    for (const directory of [...manifest.directories].sort(
      (a, b) => b.path.split("/").length - a.path.split("/").length
    )) {
      await sync(join(temporary, "workspace", directory.path))
    }
    await sync(join(temporary, "workspace"))
    await sync(temporary)
    const current = await lstat(parent)
    if (
      current.dev !== parentInfo.dev ||
      current.ino !== parentInfo.ino ||
      (await realpath(dirname(output))) !== parent
    )
      throw new Error("snapshot parent changed during capture")
    // An existing non-empty snapshot cannot be replaced by directory rename.
    // The caller also serializes each job destination through its job lease.
    await rename(temporary, target)
    published = true
    await sync(parent)
    return manifest
  } finally {
    if (!published) await removeWorkspaceTree(temporary)
  }
}

/** Validate downloaded snapshot bytes before they become a workspace. */
export async function inspectWorkspaceSnapshot(
  directory: string,
  expected?: { workspaceId: string; sourceCheckpoint?: string }
): Promise<WorkspaceSnapshotManifest> {
  const root = resolve(directory)
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("snapshot must be a real directory")
  const raw = await readBoundedRegularFile(
    join(root, "snapshot.json"),
    WORKSPACE_EXPORT_V2_MAX_MANIFEST_BYTES
  )
  const manifest = WorkspaceSnapshotManifestSchema.parse(JSON.parse(raw))
  if (
    expected &&
    (manifest.workspaceId !== expected.workspaceId ||
      (expected.sourceCheckpoint &&
        manifest.sourceCheckpoint !== expected.sourceCheckpoint))
  )
    throw new Error("snapshot identity does not match the requested checkpoint")
  if (
    manifest.files.length + manifest.directories.length >
      WORKSPACE_EXPORT_V2_MAX_WORKSPACE_ENTRIES ||
    manifest.files.reduce((sum, file) => sum + file.size, 0) >
      WORKSPACE_EXPORT_V2_MAX_EXPANDED_BYTES
  )
    throw new Error("snapshot exceeds the supported workspace limits")
  if (
    portableWorkspaceCheckpoint(manifest) !== manifest.sourceCheckpoint ||
    portableWorkspaceCheckpoint({
      ...manifest,
      files: manifest.files.filter(
        (file) => file.path !== "worktable.workspace.json"
      ),
    }) !== manifest.contentCheckpoint
  )
    throw new Error("snapshot manifest integrity failed")
  const actual = await inspectPortableWorkspaceTree(join(root, "workspace"))
  if (portableWorkspaceCheckpoint(actual) !== manifest.sourceCheckpoint)
    throw new Error("snapshot workspace integrity failed")
  const actualModes = new Map(
    [...actual.files, ...actual.directories].map((entry) => [
      entry.path,
      entry.mode,
    ])
  )
  if (
    [...manifest.files, ...manifest.directories].some(
      (entry) => actualModes.get(entry.path) !== entry.mode
    )
  )
    throw new Error("snapshot workspace permissions changed")
  const headerBytes = await readBoundedRegularFile(
    join(root, "workspace", "worktable.workspace.json"),
    WORKSPACE_EXPORT_V2_MAX_WORKSPACE_MANIFEST_BYTES
  )
  if (
    createHash("sha256").update(headerBytes).digest("hex") !==
    manifest.files.find((file) => file.path === "worktable.workspace.json")
      ?.sha256
  )
    throw new Error("snapshot workspace manifest changed during validation")
  const header: unknown = JSON.parse(headerBytes)
  if (
    !isWorkspaceManifest(header) ||
    header.id !== manifest.workspaceId ||
    header.version !== manifest.workspaceStorageVersion
  )
    throw new Error("snapshot workspace manifest does not match its metadata")
  return manifest
}
