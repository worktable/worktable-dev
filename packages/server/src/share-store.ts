import { createHash, randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, open, readFile, rename, rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { ensureAppDir } from "./app-storage.ts"
import { getWorkspaceCollaborationEpoch } from "./collaboration-epoch.ts"
import { withCrossProcessLock } from "./cross-process-lock.ts"
import { workspaceCacheKey } from "./workspace.ts"
import { onWorkspaceChange } from "./workspace-events.ts"
import { assertWorkspaceAvailable } from "./workspace-safety.ts"

// The earlier version's links, one per document path, in
// <appDir>/document-shares/<workspace>.json. No route makes links here any more: the boot
// move reads this file into the links store, views fall back to it for a link
// not yet moved, and lifecycle events still stop such a link. The create
// functions remain for tests that act as an older binary.

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

// Each Worktable on this machine keeps its links in its own file, so
// unlinking or replacing one Worktable never touches another's links. Older
// releases kept every Worktable's links in one file; a Worktable takes its own
// links out of that file the first time this process needs them.
const LEGACY_SHARE_FILE = "document-shares.json"
const claimedLegacyShares = new Set<string>()

function shareFilePath(): string {
  return join(ensureAppDir(), "document-shares", `${workspaceCacheKey()}.json`)
}

function legacyShareFilePath(): string {
  return join(ensureAppDir(), LEGACY_SHARE_FILE)
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

async function loadShareFile(path: string): Promise<ShareFile> {
  try {
    return ShareFile.parse(JSON.parse(await readFile(path, "utf8")))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyFile()
    throw new Error("Invalid document share state", { cause: error })
  }
}

async function loadFile(): Promise<ShareFile> {
  return loadShareFile(shareFilePath())
}

async function saveFile(file: ShareFile): Promise<void> {
  await saveShareState(shareFilePath(), `${JSON.stringify(file, null, 2)}\n`)
}

/**
 * Move this Worktable's links out of the file older releases shared between
 * every Worktable on the machine. A link belongs to the Worktable whose
 * current collaboration epoch it carries, so its token keeps resolving here
 * and nowhere else. Links of other Worktables stay for those Worktables to
 * claim. The copy is written before the shared file is shortened, so an
 * interrupted move repeats without losing or duplicating a link. The caller
 * holds this Worktable's mutation lock.
 */
async function claimLegacySharesLocked(): Promise<void> {
  const path = shareFilePath()
  if (claimedLegacyShares.has(path)) return
  await withCrossProcessLock(
    `${legacyShareFilePath()}.lock`,
    { label: "Document share state" },
    async () => {
      const legacy = await loadShareFile(legacyShareFilePath())
      const epoch = await getWorkspaceCollaborationEpoch()
      const claimed = legacy.shares.filter(
        (share) => share.workspaceEpoch === epoch
      )
      if (claimed.length > 0) {
        const current = await loadShareFile(path)
        const tokens = new Set(current.shares.map((share) => share.token))
        for (const share of claimed) {
          if (tokens.has(share.token)) continue
          // One link per artifact, the newest, as sharing again replaces the
          // old link. An older release run in between may have made a newer
          // one; an older link must not come back.
          const existing = current.shares.find(
            (candidate) =>
              candidate.workspaceEpoch === epoch &&
              sameArtifact(candidate, share)
          )
          if (
            existing &&
            Date.parse(existing.createdAt) >= Date.parse(share.createdAt)
          ) {
            continue
          }
          current.shares = current.shares.filter(
            (candidate) => candidate !== existing
          )
          current.shares.push(share)
          tokens.add(share.token)
        }
        await saveShareState(path, `${JSON.stringify(current, null, 2)}\n`)
        const remaining = legacy.shares.filter(
          (share) => share.workspaceEpoch !== epoch
        )
        // An older release reads this file strictly, so it stays a valid file
        // even when no Worktable's links are left in it.
        await saveShareState(
          legacyShareFilePath(),
          `${JSON.stringify({ ...legacy, shares: remaining }, null, 2)}\n`
        )
      }
    }
  )
  claimedLegacyShares.add(path)
}

async function saveShareState(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  try {
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(content, "utf8")
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
  return queuedMutation(() => {
    assertWorkspaceAvailable()
    return lockedMutation(operation)
  })
}

function queuedMutation<T>(locked: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(locked, locked)
  mutationQueue = next.catch(() => undefined)
  return next
}

function lockedMutation<T>(operation: () => Promise<T>): Promise<T> {
  return withCrossProcessLock(
    `${shareFilePath()}.lock`,
    { label: "Document share state" },
    async () => {
      await claimLegacySharesLocked()
      return operation()
    }
  )
}

/** Readers call this first, outside the mutation lock, so they see claimed links. */
async function ensureLegacySharesClaimed(): Promise<void> {
  if (claimedLegacyShares.has(shareFilePath())) return
  await queuedMutation(() => lockedMutation(async () => undefined))
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
  await ensureLegacySharesClaimed()
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
  await ensureLegacySharesClaimed()
  return serializedLifecycle(async () => {
    const [file, workspaceEpoch] = await Promise.all([
      loadFile(),
      getWorkspaceCollaborationEpoch(),
    ])
    const share = file.shares.find(
      (candidate) =>
        candidate.token === token && candidate.workspaceEpoch === workspaceEpoch
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

/** A share as this file stores it, for the one-time move into links (v2). */
export interface StoredDocumentShare extends DocumentShare {
  workspaceEpoch: string
}

/** Whether an earlier version ever wrote the file. */
/**
 * Whether this Worktable may have links to move: its own file, or the file
 * older releases shared between Worktables, which the move claims from.
 */
export function documentSharesFileExists(): boolean {
  return existsSync(shareFilePath()) || existsSync(legacyShareFilePath())
}

/** Every share in the file, without taking its locks. */
export async function readStoredDocumentShares(): Promise<
  StoredDocumentShare[]
> {
  await ensureLegacySharesClaimed()
  return (await loadFile()).shares.map((share) => ({
    ...publicShare(share),
    workspaceEpoch: share.workspaceEpoch,
  }))
}

/**
 * Remove the shares that moved to links (v2), so an older binary reads a
 * valid file and serves none of them: once all have moved, a valid empty
 * file. `moved` says true for a share that moved or was dropped, false for
 * one to keep here for now, and null for one it doesn't know, which an older
 * binary made since the file was read. Returns false, changing nothing, when
 * any share is unknown. Otherwise `afterRemoving` sees the former shares
 * and those durably removed; both steps happen under the file's
 * locks, so an older binary changes nothing in between.
 */
export async function removeMovedDocumentShares(
  moved: (share: StoredDocumentShare) => boolean | null,
  afterRemoving: (
    present: readonly StoredDocumentShare[],
    removing: readonly StoredDocumentShare[],
    recoveredDigests: readonly string[]
  ) => void
): Promise<boolean> {
  return serializedLifecycle(() =>
    serialized(async () => {
      const file = await loadFile()
      const present = file.shares.map((share) => ({
        ...publicShare(share),
        workspaceEpoch: share.workspaceEpoch,
      }))
      const journalPath = `${shareFilePath()}.moving`
      // The journal contains only digests. Its image identifies the exact atomic
      // replacement, distinguishing our completed removal from an old binary's
      // revocation after a failed write. Old binaries accept the JSON whitespace.
      const digest = (value: string) =>
        createHash("sha256").update(value).digest("hex")
      try {
        const journal = z
          .object({
            image: z.string().regex(/^[a-f0-9]{64}$/),
            removed: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
          })
          .strict()
          .parse(JSON.parse(await readFile(journalPath, "utf8")))
        if (digest(await readFile(shareFilePath(), "utf8")) === journal.image) {
          afterRemoving(present, [], journal.removed)
        }
        await rm(journalPath, { force: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      const decisions = present.map(moved)
      if (decisions.includes(null)) return false
      const kept = file.shares.filter((_, index) => decisions[index] === false)
      if (kept.length < file.shares.length) {
        const nonce = [...randomBytes(32)]
          .map((byte) =>
            byte
              .toString(2)
              .padStart(8, "0")
              .replaceAll("0", " ")
              .replaceAll("1", "\t")
          )
          .join("")
        const content = `${JSON.stringify({ ...emptyFile(), shares: kept }, null, 2)}\n${nonce}\n`
        await saveShareState(
          journalPath,
          JSON.stringify({
            image: digest(content),
            removed: present
              .filter((_, index) => decisions[index] === true)
              .map((share) => digest(share.token)),
          })
        )
        await saveShareState(shareFilePath(), content)
      }
      afterRemoving(
        present,
        present.filter((_, index) => decisions[index] === true),
        []
      )
      await rm(journalPath, { force: true })
      return true
    })
  )
}

/**
 * Workspace replacement and unlinking invalidate every capability of this
 * Worktable. Other Worktables on the machine keep theirs.
 */
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
