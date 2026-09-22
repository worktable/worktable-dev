import { randomBytes } from "node:crypto"
import { chmod, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { ensureAppDir } from "./app-storage.ts"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { onWorkspaceChange } from "./workspace-events.ts"
import { assertWorkspaceAvailable } from "./workspace-safety.ts"

export const ShareKind = z.enum(["doc", "html"])
export type ShareKind = z.infer<typeof ShareKind>

export interface ShareArtifact {
  kind: ShareKind
  spaceId: string
  artifactKey: string
}

export interface DocumentShare extends ShareArtifact {
  token: string
  createdAt: string
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

const StoredShare = z
  .object({
    token: z.string().regex(TOKEN_PATTERN),
    kind: ShareKind,
    spaceId: z.string().min(1).max(256),
    artifactKey: z.string().min(1).max(2048),
    workspaceEpoch: z.string().regex(TOKEN_PATTERN),
    createdAt: z.iso.datetime(),
  })
  .strict()
type StoredShare = z.infer<typeof StoredShare>

const ShareFile = z
  .object({
    type: z.literal("worktable.document-shares"),
    version: z.literal(1),
    shares: z.array(StoredShare),
  })
  .strict()
type ShareFile = z.infer<typeof ShareFile>

let mutationQueue: Promise<unknown> = Promise.resolve()
let lifecycleQueue: Promise<unknown> = Promise.resolve()

function shareFilePath(): string {
  return join(ensureAppDir(), "document-shares.json")
}

function emptyFile(): ShareFile {
  return {
    type: "worktable.document-shares",
    version: 1,
    shares: [],
  }
}

function sameArtifact(share: ShareArtifact, artifact: ShareArtifact): boolean {
  return (
    share.kind === artifact.kind &&
    share.spaceId === artifact.spaceId &&
    share.artifactKey === artifact.artifactKey
  )
}

function publicShare(share: StoredShare): DocumentShare {
  return {
    token: share.token,
    kind: share.kind,
    spaceId: share.spaceId,
    artifactKey: share.artifactKey,
    createdAt: share.createdAt,
  }
}

async function loadFile(): Promise<ShareFile> {
  try {
    return ShareFile.parse(JSON.parse(await readFile(shareFilePath(), "utf8")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile()
    throw new Error("Invalid document share state", { cause: error })
  }
}

async function saveFile(file: ShareFile): Promise<void> {
  const path = shareFilePath()
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  try {
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    await chmod(path, 0o600)
    await fsyncShareDirectory(dirname(path))
  } finally {
    await rm(temporary, { force: true })
  }
}

async function fsyncShareDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, "r")
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    const unsupported = ["EINVAL", "ENOTSUP", "ENOSYS"].includes(code ?? "")
    const unsupportedOnWindows =
      process.platform === "win32" &&
      ["EACCES", "EISDIR", "EPERM"].includes(code ?? "")
    if (!unsupported && !unsupportedOnWindows) throw error
  } finally {
    await handle?.close()
  }
}

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const locked = () => {
    assertWorkspaceAvailable()
    return withCrossProcessLock(
      `${shareFilePath()}.lock`,
      { label: "Document share state" },
      operation
    )
  }
  const next = mutationQueue.then(locked, locked)
  mutationQueue = next.catch(() => undefined)
  return next
}

function serializedLifecycle<T>(operation: () => Promise<T>): Promise<T> {
  const locked = () => {
    assertWorkspaceAvailable()
    return withCrossProcessLock(
      `${shareFilePath()}.lifecycle.lock`,
      { label: "Document share lifecycle" },
      operation
    )
  }
  const next = lifecycleQueue.then(locked, locked)
  lifecycleQueue = next.catch(() => undefined)
  return next
}

/**
 * Hold the capability lifecycle boundary across a multi-step artifact move.
 * Callers inside this boundary must use the `WithinLifecycle` mutation below
 * to avoid recursively acquiring the same lock.
 */
export function withDocumentShareLifecycle<T>(
  operation: () => Promise<T>
): Promise<T> {
  return serializedLifecycle(operation)
}

async function createDocumentShareState(
  artifact: ShareArtifact
): Promise<DocumentShare> {
  return serialized(async () => {
    const [file, workspaceEpoch] = await Promise.all([
      loadFile(),
      getWorkspaceCollaborationEpoch(),
    ])
    const current = file.shares.find(
      (candidate) =>
        candidate.workspaceEpoch === workspaceEpoch &&
        sameArtifact(candidate, artifact)
    )
    if (current) return publicShare(current)

    const share: StoredShare = {
      ...artifact,
      token: randomBytes(32).toString("base64url"),
      workspaceEpoch,
      createdAt: new Date().toISOString(),
    }
    file.shares = file.shares.filter(
      (candidate) => !sameArtifact(candidate, artifact)
    )
    file.shares.push(share)
    await saveFile(file)
    return publicShare(share)
  })
}

/** Return the current share for an artifact, ignoring prior workspace epochs. */
export async function getDocumentShare(
  artifact: ShareArtifact
): Promise<DocumentShare | null> {
  const [file, workspaceEpoch] = await Promise.all([
    loadFile(),
    getWorkspaceCollaborationEpoch(),
  ])
  const share = file.shares.find(
    (candidate) =>
      candidate.workspaceEpoch === workspaceEpoch &&
      sameArtifact(candidate, artifact)
  )
  return share ? publicShare(share) : null
}

/** Create at most one active capability for an artifact. */
export async function createDocumentShare(
  artifact: ShareArtifact
): Promise<DocumentShare> {
  return serializedLifecycle(() => createDocumentShareState(artifact))
}

/**
 * Check artifact eligibility and register its capability as one lifecycle
 * operation. Artifact removal invalidation uses the same cross-process lock,
 * so a concurrent archive, delete, or rename cannot leave a late share behind.
 */
export async function createDocumentShareIfEligible(
  artifact: ShareArtifact,
  isEligible: () => Promise<boolean>
): Promise<DocumentShare | null> {
  return serializedLifecycle(async () => {
    if (!(await isEligible())) return null
    return createDocumentShareState(artifact)
  })
}

/** Resolve a capability without revealing stale workspace generations. */
export async function resolveDocumentShare(
  token: string
): Promise<DocumentShare | null> {
  return withResolvedDocumentShare(token, async (share) => share)
}

/**
 * Keep capability resolution and its artifact read on one lifecycle side of
 * revocation, so a path cannot change owners between those two operations.
 */
export async function withResolvedDocumentShare<T>(
  token: string,
  use: (share: DocumentShare) => Promise<T>
): Promise<T | null> {
  if (!TOKEN_PATTERN.test(token)) return null
  return serializedLifecycle(async () => {
    const [file, workspaceEpoch] = await Promise.all([
      loadFile(),
      getWorkspaceCollaborationEpoch(),
    ])
    const share = file.shares.find(
      (candidate) =>
        candidate.token === token &&
        candidate.workspaceEpoch === workspaceEpoch
    )
    return share ? use(publicShare(share)) : null
  })
}

/** Stop the current share. Re-sharing creates a fresh capability. */
export async function stopDocumentShare(
  artifact: ShareArtifact
): Promise<boolean> {
  return (await invalidateDocumentShares([artifact])) > 0
}

/** Irreversibly invalidate links when artifact identities go away. */
export async function invalidateDocumentShares(
  artifacts: ShareArtifact[]
): Promise<number> {
  if (artifacts.length === 0) return 0
  return serializedLifecycle(() =>
    invalidateDocumentSharesWithinLifecycle(artifacts)
  )
}

/** Invalidate shares while the caller already holds the lifecycle boundary. */
export function invalidateDocumentSharesWithinLifecycle(
  artifacts: ShareArtifact[]
): Promise<number> {
  if (artifacts.length === 0) return Promise.resolve(0)
  return serialized(async () => {
    const file = await loadFile()
    const keys = new Set(
      artifacts.map(
        (artifact) =>
          `${artifact.kind}\0${artifact.spaceId}\0${artifact.artifactKey}`
      )
    )
    const remaining = file.shares.filter(
      (candidate) =>
        !keys.has(
          `${candidate.kind}\0${candidate.spaceId}\0${candidate.artifactKey}`
        )
    )
    const invalidated = file.shares.length - remaining.length
    if (invalidated === 0) return 0
    file.shares = remaining
    await saveFile(file)
    return invalidated
  })
}

/** Invalidate every share beneath a Space lifecycle boundary. */
export async function invalidateDocumentSharesForSpace(
  spaceId: string
): Promise<number> {
  return serializedLifecycle(() =>
    serialized(async () => {
      const file = await loadFile()
      const remaining = file.shares.filter(
        (candidate) => candidate.spaceId !== spaceId
      )
      const invalidated = file.shares.length - remaining.length
      if (invalidated === 0) return 0
      file.shares = remaining
      await saveFile(file)
      return invalidated
    })
  )
}

export function invalidateDocumentShare(
  artifact: ShareArtifact
): Promise<boolean> {
  return stopDocumentShare(artifact)
}

/** Workspace replacement invalidates every capability from the old content. */
export async function invalidateAllDocumentShares(): Promise<void> {
  await serializedLifecycle(() =>
    serialized(async () => {
      const file = await loadFile()
      if (file.shares.length === 0) return
      await saveFile(emptyFile())
    })
  )
}

onWorkspaceChange((event) => {
  if (event.type === "workspaceReset") {
    return invalidateAllDocumentShares()
  }
  if (event.type === "space") {
    return import("./shared-artifact.ts").then(
      async ({ sharedSpaceIdentityIsCurrent }) => {
        if (await sharedSpaceIdentityIsCurrent(event.spaceId)) return
        await invalidateDocumentSharesForSpace(event.spaceId)
      }
    )
  }
  if (event.type === "doc" || event.type === "widget") {
    const artifact: ShareArtifact =
      event.type === "doc"
        ? {
            kind: "doc",
            spaceId: event.spaceId,
            artifactKey: event.docPath,
          }
        : {
            kind: "html",
            spaceId: event.spaceId,
            artifactKey: event.widgetId,
          }
    // Keep the store independent of the artifact readers during module
    // initialization: those readers use store.ts, whose mutation paths import
    // this share store through the lifecycle adapter.
    return import("./shared-artifact.ts").then(
      async ({ sharedArtifactIdentityIsCurrent }) => {
        if (await sharedArtifactIdentityIsCurrent(artifact)) return
        await invalidateDocumentShares([artifact])
      }
    )
  }
})
