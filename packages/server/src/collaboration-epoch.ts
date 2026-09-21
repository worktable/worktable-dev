import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { ensureAppDir } from "./app-storage.ts"
import { workspaceCacheKey } from "./workspace.ts"
import { onWorkspaceChange } from "./workspace-events.ts"

const EPOCH_PATTERN = /^[A-Za-z0-9_-]{43}$/
const epochOperations = new Map<string, Promise<string>>()

function epochPath(): string {
  return join(ensureAppDir(), "yjs", workspaceCacheKey(), "epoch")
}

function newEpoch(): string {
  return randomBytes(32).toString("base64url")
}

async function writeEpoch(path: string, epoch: string): Promise<string> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  try {
    await writeFile(temporary, `${epoch}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    await rename(temporary, path)
    await chmod(path, 0o600)
    return epoch
  } finally {
    await rm(temporary, { force: true })
  }
}

async function readOrCreateEpoch(path: string): Promise<string> {
  try {
    const epoch = (await readFile(path, "utf8")).trim()
    if (EPOCH_PATTERN.test(epoch)) {
      await chmod(path, 0o600)
      return epoch
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  return writeEpoch(path, newEpoch())
}

function retainOperation(
  path: string,
  operation: Promise<string>
): Promise<string> {
  epochOperations.set(path, operation)
  void operation.catch(() => {
    if (epochOperations.get(path) === operation) epochOperations.delete(path)
  })
  return operation
}

/**
 * Stable across ordinary process restarts, but machine-local so it never
 * travels inside a portable workspace.
 */
export function getWorkspaceCollaborationEpoch(): Promise<string> {
  const path = epochPath()
  return epochOperations.get(path) ?? retainOperation(path, readOrCreateEpoch(path))
}

/** Advance the browser collaboration namespace after a workspace replacement. */
export function rotateWorkspaceCollaborationEpoch(): Promise<string> {
  const path = epochPath()
  const predecessor = epochOperations.get(path)
  const operation = (
    predecessor ? predecessor.catch(() => undefined) : Promise.resolve()
  ).then(() => writeEpoch(path, newEpoch()))
  return retainOperation(path, operation)
}

// Replacement and any future non-filesystem backend share the same reset seam.
onWorkspaceChange((event) => {
  if (event.type === "workspaceReset") {
    return rotateWorkspaceCollaborationEpoch()
  }
})
