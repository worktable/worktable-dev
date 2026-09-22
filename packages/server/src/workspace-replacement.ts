import { randomBytes } from "node:crypto"
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { basename, dirname, join, relative, resolve, sep } from "node:path"
import {
  calculateLocalWorkspaceContentCheckpoints,
  calculateWorkspaceContentCheckpoint,
  extractWorkspaceExportV2,
  WORKSPACE_EXPORT_V2_MAX_WORKSPACE_MANIFEST_BYTES,
  type WorkspaceExportV2Manifest,
} from "./workspace-transfer-v2.ts"
import {
  getWorkspaceRoot,
  isWorkspaceManifest,
  writeWorkspaceManifestBytesAt,
  type WorkspaceManifest,
} from "./workspace.ts"
import { removeWorkspaceTree } from "./workspace-tree-cleanup.ts"
import { workspaceStorageLayoutFromManifest } from "./workspace-storage-v2.ts"

export interface PreparedWorkspaceReplacement {
  stagingPath: string
  backupPath: string
  source: WorkspaceExportV2Manifest["source"]
  exportedAt: string
  history: WorkspaceExportV2Manifest["history"]
  contentCheckpoint: string
  files: number
  bytes: number
}

export interface WorkspaceReplacementPaths {
  stagingPath: string
  backupPath: string
}

export interface WorkspaceReplacementTransaction {
  commit(): Promise<void>
  rollback(): Promise<void>
}

export interface BeginWorkspaceReplacementOptions {
  /**
   * Imports retain the destination identity. Storage migrations instead admit
   * the verified manifest already present in the staged workspace.
   */
  manifest?: "preserve-destination" | "use-staged" | "checkpoint"
  /** Checkpoint restores are bound to a validated full tree, including its manifest. */
  expectedSourceCheckpoint?: string
  /** Imports use portable paths; local migrations preserve legacy filesystem names. */
  checkpointPaths?: "portable" | "local"
  /** Final caller-owned validation after preparation and before the first rename. */
  validateBeforeSwap?: () => Promise<void>
}

let beforeWorkspaceReplacementCommitForTests: (() => Promise<void>) | null =
  null
let renameWorkspaceReplacementForTests:
  | ((source: string, destination: string) => Promise<void>)
  | null = null

export function setWorkspaceReplacementCommitHookForTests(
  hook: (() => Promise<void>) | null
): void {
  beforeWorkspaceReplacementCommitForTests = hook
}

export function setWorkspaceReplacementRenameHookForTests(
  hook: ((source: string, destination: string) => Promise<void>) | null
): void {
  renameWorkspaceReplacementForTests = hook
}

function renameWorkspaceReplacement(
  source: string,
  destination: string
): Promise<void> {
  return (
    renameWorkspaceReplacementForTests?.(source, destination) ??
    rename(source, destination)
  )
}

export function createWorkspaceReplacementPaths(): WorkspaceReplacementPaths {
  const workspaceRoot = resolve(getWorkspaceRoot())
  const parent = dirname(workspaceRoot)
  return {
    stagingPath: join(
      parent,
      `.${basename(workspaceRoot)}.worktable-replace-${randomBytes(10).toString("hex")}`
    ),
    backupPath: join(
      parent,
      `.${basename(workspaceRoot)}.worktable-backup-${randomBytes(10).toString("hex")}`
    ),
  }
}

function isGeneratedReplacementPath(
  candidate: string,
  workspaceRoot: string,
  kind: "replace" | "backup"
): boolean {
  const resolved = resolve(candidate)
  const prefix = `.${basename(workspaceRoot)}.worktable-${kind}-`
  return (
    dirname(resolved) === dirname(workspaceRoot) &&
    basename(resolved).startsWith(prefix) &&
    /^[0-9a-f]{20}$/u.test(basename(resolved).slice(prefix.length))
  )
}

export function workspaceCommittedBackupPath(backupPath: string): string {
  return `${resolve(backupPath)}.committed`
}

export function workspaceRollbackMarkerPath(backupPath: string): string {
  return `${resolve(backupPath)}.rollback`
}

function workspaceFailedReplacementPath(stagingPath: string): string {
  return `${resolve(stagingPath)}.failed`
}

function assertReplacementArtifactPaths(
  stagingPath: string,
  backupPath: string
): { staging: string; backup: string } {
  const workspaceRoot = resolve(getWorkspaceRoot())
  const staging = resolve(stagingPath)
  const backup = resolve(backupPath)
  if (
    !isGeneratedReplacementPath(staging, workspaceRoot, "replace") ||
    !isGeneratedReplacementPath(backup, workspaceRoot, "backup")
  ) {
    throw new Error("workspace replacement artifact paths are invalid")
  }
  return { staging, backup }
}

export async function discardCommittedWorkspaceReplacement(
  stagingPath: string,
  backupPath: string
): Promise<void> {
  const { staging, backup } = assertReplacementArtifactPaths(
    stagingPath,
    backupPath
  )
  await removeWorkspaceTree(workspaceCommittedBackupPath(backup))
  await rm(workspaceRollbackMarkerPath(backup), { force: true })
  await removeWorkspaceTree(workspaceFailedReplacementPath(staging))
}

export async function discardRolledBackWorkspaceReplacement(
  stagingPath: string,
  backupPath: string
): Promise<void> {
  const { staging, backup } = assertReplacementArtifactPaths(
    stagingPath,
    backupPath
  )
  await removeWorkspaceTree(staging)
  await removeWorkspaceTree(workspaceFailedReplacementPath(staging))
  await rm(workspaceRollbackMarkerPath(backup), { force: true })
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

async function readCurrentManifest(): Promise<{
  bytes: Buffer
  value: WorkspaceManifest
}> {
  const bytes = await readFile(
    join(getWorkspaceRoot(), "worktable.workspace.json")
  )
  let value: unknown
  try {
    value = JSON.parse(bytes.toString("utf8"))
  } catch {
    throw new Error("the current workspace manifest is unreadable")
  }
  if (!isWorkspaceManifest(value)) {
    throw new Error("the current workspace manifest is invalid")
  }
  return { bytes, value }
}

/**
 * Verify and extract an import beside the active workspace. Preparing outside
 * the live root keeps validation online while guaranteeing the later rename is
 * on the same filesystem.
 */
export async function prepareWorkspaceReplacement(
  sourceFile: string,
  paths: WorkspaceReplacementPaths = createWorkspaceReplacementPaths()
): Promise<PreparedWorkspaceReplacement> {
  const workspaceRoot = resolve(getWorkspaceRoot())
  const stagingPath = resolve(paths.stagingPath)
  const backupPath = resolve(paths.backupPath)
  if (
    !isGeneratedReplacementPath(stagingPath, workspaceRoot, "replace") ||
    !isGeneratedReplacementPath(backupPath, workspaceRoot, "backup")
  ) {
    throw new Error("workspace replacement preparation paths are invalid")
  }
  try {
    await mkdir(stagingPath, { mode: 0o700 })
    const exported = await extractWorkspaceExportV2(sourceFile, stagingPath)
    const sourceManifestPath = join(stagingPath, "worktable.workspace.json")
    let sourceManifest: unknown
    try {
      const sourceManifestInfo = await stat(sourceManifestPath)
      if (
        !sourceManifestInfo.isFile() ||
        sourceManifestInfo.size >
          WORKSPACE_EXPORT_V2_MAX_WORKSPACE_MANIFEST_BYTES
      ) {
        throw new Error("the imported workspace manifest is too large")
      }
      sourceManifest = JSON.parse(await readFile(sourceManifestPath, "utf8"))
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "the imported workspace manifest is too large"
      ) {
        throw error
      }
      throw new Error("the imported workspace manifest is unreadable")
    }
    if (
      !isWorkspaceManifest(sourceManifest) ||
      sourceManifest.id !== exported.source.workspaceId ||
      sourceManifest.name !== exported.source.workspaceName
    ) {
      throw new Error(
        "the imported workspace identity does not match its package"
      )
    }
    const preparedContentCheckpoint =
      await calculateWorkspaceContentCheckpoint(stagingPath)
    if (preparedContentCheckpoint !== exported.integrity.contentCheckpoint) {
      throw new Error(
        "the imported workspace content does not match its package checkpoint"
      )
    }

    return {
      stagingPath,
      backupPath,
      source: exported.source,
      exportedAt: exported.exportedAt,
      history: exported.history,
      // The portable checkpoint is paths, sizes, and file hashes. Filesystem
      // modes and timestamps are best-effort metadata and cannot make an
      // otherwise identical import fail across operating systems.
      contentCheckpoint: exported.integrity.contentCheckpoint,
      files: exported.integrity.files.length,
      bytes: exported.integrity.files.reduce((sum, file) => sum + file.size, 0),
    }
  } catch (error) {
    await removeWorkspaceTree(stagingPath)
    throw error
  }
}

export async function discardPreparedWorkspaceReplacement(
  stagingPath: string
): Promise<void> {
  const workspaceRoot = resolve(getWorkspaceRoot())
  const candidate = resolve(stagingPath)
  if (!isGeneratedReplacementPath(candidate, workspaceRoot, "replace")) {
    throw new Error("prepared replacement cleanup path is invalid")
  }
  await removeWorkspaceTree(candidate)
}

/**
 * Move a prepared workspace into place. Callers must stop all workspace
 * readers/writers before entering this transaction and either commit after a
 * successful restart or roll back on failure.
 */
export async function beginPreparedWorkspaceReplacement(
  stagingPath: string,
  backupPath: string | undefined,
  expectedContentCheckpoint: string,
  expectedDestinationContentCheckpoint: string,
  options: BeginWorkspaceReplacementOptions = {}
): Promise<WorkspaceReplacementTransaction> {
  const workspaceRoot = resolve(getWorkspaceRoot())
  const parent = dirname(workspaceRoot)
  const resolvedStaging = resolve(stagingPath)
  if (!isGeneratedReplacementPath(resolvedStaging, workspaceRoot, "replace")) {
    throw new Error("prepared replacement is not beside the active workspace")
  }
  const [workspaceInfo, stagingInfo] = await Promise.all([
    lstat(workspaceRoot),
    lstat(resolvedStaging),
  ])
  if (
    !workspaceInfo.isDirectory() ||
    workspaceInfo.isSymbolicLink() ||
    !stagingInfo.isDirectory() ||
    stagingInfo.isSymbolicLink()
  ) {
    throw new Error("workspace replacement requires real directories")
  }
  const canonicalParent = await realpath(parent)
  if (
    !isInside(canonicalParent, await realpath(workspaceRoot)) ||
    !isInside(canonicalParent, await realpath(resolvedStaging))
  ) {
    throw new Error("workspace replacement path escaped its parent")
  }
  const calculateCheckpoint = async (root: string): Promise<string> =>
    options.checkpointPaths === "local"
      ? (await calculateLocalWorkspaceContentCheckpoints(root))
          .workspaceContentCheckpoint
      : calculateWorkspaceContentCheckpoint(root)
  const currentContentCheckpoint = await calculateCheckpoint(resolvedStaging)
  if (currentContentCheckpoint !== expectedContentCheckpoint) {
    throw new Error(
      "prepared workspace content changed after review; prepare the import again"
    )
  }
  const replacementManifest = JSON.parse(
    await readFile(join(resolvedStaging, "worktable.workspace.json"), "utf8")
  ) as unknown
  const stagedManifestAdmitted =
    (options.manifest ?? "preserve-destination") === "use-staged"
      ? workspaceStorageLayoutFromManifest(replacementManifest).kind === "v2"
      : isWorkspaceManifest(replacementManifest)
  if (!stagedManifestAdmitted) {
    throw new Error("prepared replacement no longer has a valid manifest")
  }
  if (options.manifest === "checkpoint") {
    const { inspectPortableWorkspaceTree, portableWorkspaceCheckpoint } =
      await import("./workspace-transfer-v2.ts")
    if (
      !options.expectedSourceCheckpoint ||
      portableWorkspaceCheckpoint(
        await inspectPortableWorkspaceTree(resolvedStaging)
      ) !== options.expectedSourceCheckpoint
    ) {
      throw new Error("prepared checkpoint changed after validation")
    }
  }
  const backup = resolve(
    backupPath ??
      join(
        parent,
        `.${basename(workspaceRoot)}.worktable-backup-${randomBytes(10).toString("hex")}`
      )
  )
  if (!isGeneratedReplacementPath(backup, workspaceRoot, "backup")) {
    throw new Error("prepared replacement backup is not beside the workspace")
  }
  const committedBackup = workspaceCommittedBackupPath(backup)
  const rollbackMarker = workspaceRollbackMarkerPath(backup)
  for (const artifact of [committedBackup, rollbackMarker]) {
    try {
      await lstat(artifact)
      throw new Error("workspace replacement recovery artifact already exists")
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error
      }
    }
  }

  // Preparation happens while the current workspace remains online. Capture
  // destination identity only after its writers have stopped so changes made
  // while the user reviews the package cannot be reverted.
  const currentDestinationContentCheckpoint =
    await calculateCheckpoint(workspaceRoot)
  if (
    currentDestinationContentCheckpoint !== expectedDestinationContentCheckpoint
  ) {
    throw new Error(
      "the active workspace changed after replacement confirmation; review and retry"
    )
  }
  if ((options.manifest ?? "preserve-destination") === "preserve-destination") {
    const current = await readCurrentManifest()
    writeWorkspaceManifestBytesAt(resolvedStaging, current.bytes)
  } else if (options.manifest === "checkpoint") {
    const current = await readCurrentManifest()
    const saved = replacementManifest as WorkspaceManifest
    if (saved.id !== current.value.id)
      throw new Error("checkpoint belongs to another workspace")
    // Layout and content travel together. Keep only current identity/access
    // fields; copying the entire destination manifest can mislabel V1 as V2.
    writeWorkspaceManifestBytesAt(
      resolvedStaging,
      Buffer.from(
        JSON.stringify({
          ...saved,
          id: current.value.id,
          name: current.value.name,
          createdAt: current.value.createdAt,
          cloud: current.value.cloud,
        }) + "\n"
      )
    )
  }
  await chmod(resolvedStaging, workspaceInfo.mode & 0o777)
  await options.validateBeforeSwap?.()
  await renameWorkspaceReplacement(workspaceRoot, backup)
  try {
    // The destination was hashed immediately before this same-filesystem
    // atomic rename. Rehashing the identical tree here would only extend the
    // interval in which the configured workspace root is absent.
    await renameWorkspaceReplacement(resolvedStaging, workspaceRoot)
  } catch (error) {
    await renameWorkspaceReplacement(backup, workspaceRoot)
    throw error
  }

  let settled = false
  return {
    async commit() {
      if (settled) return
      await beforeWorkspaceReplacementCommitForTests?.()
      // This rename is the durable commit point. Startup recovery only rolls
      // back a live `.worktable-backup-*`; a `.committed` tree is cleanup
      // debris and must never replace the active imported workspace.
      await renameWorkspaceReplacement(backup, committedBackup)
      settled = true
    },
    async rollback() {
      if (settled) return
      settled = true
      const failed = workspaceFailedReplacementPath(resolvedStaging)
      // This marker is durable before rollback starts and remains until the
      // failed job status is durable. Recovery can therefore distinguish a
      // restored original workspace from a committed import.
      await writeFile(rollbackMarker, "rollback\n", {
        mode: 0o600,
        flag: "wx",
      })
      try {
        if ((await stat(workspaceRoot)).isDirectory()) {
          await renameWorkspaceReplacement(workspaceRoot, failed)
        }
      } catch {
        await removeWorkspaceTree(workspaceRoot)
      }
      await renameWorkspaceReplacement(backup, workspaceRoot)
      await removeWorkspaceTree(failed)
    },
  }
}
