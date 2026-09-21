import { lstat, mkdir, opendir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { requireSafeLegacySpaceId } from "./legacy-space-id.ts"

const ANNOTATION_V2_CUTOVER_MARKER = ".document-annotations-v2"

function legacyAnnotationCutoverPath(input: {
  workspaceRoot: string
  spaceId: string
}): string {
  const spaceId = requireSafeLegacySpaceId(input.spaceId)
  return join(
    input.workspaceRoot,
    "spaces",
    spaceId,
    "annotations",
    ANNOTATION_V2_CUTOVER_MARKER
  )
}

/** Retire queued V1 mutations before releasing the Space-wide cutover lock. */
export async function markLegacyAnnotationStoreCutover(input: {
  workspaceRoot: string
  spaceId: string
}): Promise<void> {
  const path = legacyAnnotationCutoverPath(input)
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, "worktable.document-annotations-v2\n", {
      encoding: "utf8",
      flag: "wx",
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
}

export async function assertLegacyAnnotationStoreWritable(input: {
  workspaceRoot: string
  spaceId: string
}): Promise<void> {
  try {
    await lstat(legacyAnnotationCutoverPath(input))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error
    if (!(await hasCommittedDocumentAnnotationsV2(input))) return
  }
  throw new Error("legacy annotation writes are retired for this Space")
}

async function hasCommittedDocumentAnnotationsV2(input: {
  workspaceRoot: string
  spaceId: string
}): Promise<boolean> {
  const spaceId = requireSafeLegacySpaceId(input.spaceId)
  const root = join(input.workspaceRoot, "spaces", spaceId, "document-data")
  let rootInfo
  try {
    rootInfo = await lstat(root)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return false
    throw error
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("document annotation V2 root is not a real directory")
  }
  const directory = await opendir(root)
  for await (const entry of directory) {
    if (entry.isSymbolicLink()) {
      throw new Error("document annotation V2 owner is not a real directory")
    }
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name, "annotations.json")
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error("document annotation V2 file is not a real file")
      }
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") continue
      throw error
    }
  }
  return false
}

/**
 * Serialize V1 annotation mutations and the one-way V1-to-V2 cutover across
 * every Worktable process that can access the same workspace.
 */
export function withLegacyAnnotationStoreLock<T>(
  input: { workspaceRoot: string; spaceId: string },
  operation: () => Promise<T>
): Promise<T> {
  const spaceId = requireSafeLegacySpaceId(input.spaceId)
  return withCrossProcessLock(
    join(input.workspaceRoot, "spaces", spaceId, "annotations", ".store.lock"),
    { label: `Space ${spaceId} annotations` },
    operation
  )
}
