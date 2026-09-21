import { chmodSync, lstatSync, readdirSync, rmSync } from "node:fs"
import { chmod, lstat, readdir, rm } from "node:fs/promises"
import { join } from "node:path"

function makeDirectoriesOwnerWritableSync(root: string): void {
  let info
  try {
    info = lstatSync(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return

  chmodSync(root, (info.mode & 0o777) | 0o700)
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      makeDirectoriesOwnerWritableSync(join(root, entry.name))
    }
  }
}

async function makeDirectoriesOwnerWritable(root: string): Promise<void> {
  let info
  try {
    info = await lstat(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return
    throw error
  }
  if (!info.isDirectory() || info.isSymbolicLink()) return

  await chmod(root, (info.mode & 0o777) | 0o700)
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await makeDirectoriesOwnerWritable(join(root, entry.name))
    }
  }
}

/**
 * Remove a Worktable-owned tree even when a portable package preserved
 * read-only directory modes. Callers must validate the root path before using
 * this low-level helper; it never follows directory symlinks while normalizing.
 */
export async function removeWorkspaceTree(root: string): Promise<void> {
  await makeDirectoriesOwnerWritable(root)
  await rm(root, { recursive: true, force: true })
}

/**
 * Synchronous counterpart for startup recovery, which must finish before the
 * server adopts or creates a workspace root.
 */
export function removeWorkspaceTreeSync(root: string): void {
  makeDirectoriesOwnerWritableSync(root)
  rmSync(root, { recursive: true, force: true })
}
