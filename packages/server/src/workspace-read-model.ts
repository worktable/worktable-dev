// ============================================================
// Workspace read model (Plan 15, first slice)
// ============================================================
//
// Files in the workspace stay canonical. Read callers get an immutable,
// in-memory snapshot of data derived from one Space (today: its document
// catalog with the docs.meta.json facts that lists need) instead of rebuilding
// it from files on every request. Snapshots are published by pointer swap and
// are safe to drop at any time.
//
// Correctness does not rest on any single signal:
// - in-process writes advance the Space's generation through workspace
//   events, document content events and watcher suppression, which brackets
//   every internal write;
// - the watcher advances it for any file activity in the Space, including
//   writes from other processes (stdio MCP, the CLI, git, sync clients);
// - every read re-checks the fingerprints of the files that define the
//   Space's identity (space.json, documents.meta.json, docs.meta.json and the
//   alias file);
// - a short maximum age bounds the effect of a missed watcher event.
//
// Writers never read snapshots. They build fresh under the document path lock.
// WORKTABLE_MODEL=0 turns snapshots off.

import { isAbsolute, relative, sep } from "node:path"
import { onDocContentChanged } from "./content-events.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import { readFileFingerprint } from "./file-fingerprint.ts"
import { onWorkspaceChange } from "./workspace-events.ts"
import { assertWorkspaceAvailable } from "./workspace-safety.ts"

/** Longest a snapshot is served without a rebuild, whatever the signals say. */
export const SPACE_SNAPSHOT_MAX_AGE_MS = 15_000

let clock = 0
let allSpacesChangedAt = 0
const spaceChangedAt = new Map<string, number>()
const writesInFlight = new Map<string, number>()

interface SpaceSnapshot {
  workspaceRoot: string
  generation: number
  builtAt: number
  sources: ReadonlyArray<readonly [path: string, key: string | null]>
  value: unknown
}

const snapshots = new Map<string, SpaceSnapshot>()

/**
 * Advances whenever anything in the workspace may have changed. A read that
 * captured an older value must not be shared with a request that started
 * after the change.
 */
export function workspaceGeneration(): number {
  return clock
}

/** Advances whenever derived data for this Space may have changed. */
export function spaceGeneration(spaceId: string): number {
  return Math.max(allSpacesChangedAt, spaceChangedAt.get(spaceId) ?? 0)
}

export function noteWorkspaceActivity(): void {
  clock += 1
}

export function noteSpaceChanged(spaceId: string): void {
  clock += 1
  spaceChangedAt.set(spaceId, clock)
  snapshots.delete(spaceId)
}

export function noteAllSpacesChanged(): void {
  clock += 1
  allSpacesChangedAt = clock
  spaceChangedAt.clear()
  snapshots.clear()
}

/**
 * An internal write to a Space's files has started. No snapshot is published
 * until every started write has ended, so a build cannot capture a
 * half-written state and keep it after the write lands.
 */
export function beginSpaceWrite(spaceId: string): void {
  writesInFlight.set(spaceId, (writesInFlight.get(spaceId) ?? 0) + 1)
  noteSpaceChanged(spaceId)
}

export function endSpaceWrite(spaceId: string): void {
  const remaining = (writesInFlight.get(spaceId) ?? 0) - 1
  if (remaining > 0) writesInFlight.set(spaceId, remaining)
  else writesInFlight.delete(spaceId)
  noteSpaceChanged(spaceId)
}

/**
 * The Space whose document data contains this absolute path, or null when
 * the path is outside every Space or belongs to data the document catalog
 * does not read (threads, records, annotations).
 */
export function documentSpaceForPath(
  spacesRoot: string,
  absolutePath: string
): string | null {
  const rel = relative(spacesRoot, absolutePath)
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null
  const [spaceId, area, , documentArea] = rel.split(sep)
  // Legacy Space ids may start with a dot. Staging and trash directories
  // map to ids no reader asks for, which costs nothing.
  if (!spaceId) return null
  if (area === "threads" || area === "records") return null
  if (area === "document-data" && documentArea && documentArea !== "state") {
    return null
  }
  return spaceId
}

function snapshotsEnabled(): boolean {
  return process.env["WORKTABLE_MODEL"] !== "0"
}

async function isCurrent(
  snapshot: SpaceSnapshot,
  workspaceRoot: string,
  spaceId: string
): Promise<boolean> {
  if (
    snapshot.workspaceRoot !== workspaceRoot ||
    snapshot.generation !== spaceGeneration(spaceId) ||
    Date.now() - snapshot.builtAt >= SPACE_SNAPSHOT_MAX_AGE_MS
  ) {
    return false
  }
  const observed = await Promise.all(
    snapshot.sources.map(([path]) => readFileFingerprint(path))
  )
  return observed.every(
    (fingerprint, index) =>
      (fingerprint?.key ?? null) === snapshot.sources[index]![1]
  )
}

/**
 * Read one Space's derived data from its current snapshot, or build and
 * publish a new one. `sources` are the files whose fingerprints identify the
 * snapshot. Builds run under the document path lock, so concurrent readers
 * of a stale Space wait for one build instead of starting their own.
 */
export async function readSpaceSnapshot<T>(options: {
  workspaceRoot: string
  spaceId: string
  sources: readonly string[]
  build: () => Promise<T>
  /** The caller already holds this Space's document path lock. */
  lockHeld?: boolean
}): Promise<T> {
  const { workspaceRoot, spaceId } = options
  const locked = <R>(fn: () => Promise<R>) =>
    options.lockHeld ? fn() : withDocPathLock(spaceId, fn)
  if (!snapshotsEnabled()) return locked(options.build)
  // A snapshot hit skips the lock, which is where reads fail closed while a
  // document move awaits recovery.
  assertWorkspaceAvailable()

  const seen = snapshots.get(spaceId)
  if (seen && (await isCurrent(seen, workspaceRoot, spaceId))) {
    return seen.value as T
  }
  return locked(async () => {
    const published = snapshots.get(spaceId)
    if (
      published &&
      published !== seen &&
      (await isCurrent(published, workspaceRoot, spaceId))
    ) {
      return published.value as T
    }
    if (published && snapshots.get(spaceId) === published) {
      snapshots.delete(spaceId)
    }
    const generation = spaceGeneration(spaceId)
    const publishable = !writesInFlight.has(spaceId)
    const builtAt = Date.now()
    // Fingerprints are taken before the build, so a change made while it
    // runs leaves the snapshot already stale. A same-size rewrite within one
    // timestamp tick would not change them; the watcher and maximum age cover
    // that case for these small identity files.
    const fingerprints = await Promise.all(
      options.sources.map((path) => readFileFingerprint(path))
    )
    const value = await options.build()
    if (publishable && spaceGeneration(spaceId) === generation) {
      snapshots.set(spaceId, {
        workspaceRoot,
        generation,
        builtAt,
        sources: options.sources.map(
          (path, index) => [path, fingerprints[index]?.key ?? null] as const
        ),
        value,
      })
    }
    return value
  })
}

onWorkspaceChange((event) => {
  switch (event.type) {
    case "workspaceReset":
      noteAllSpacesChanged()
      return
    case "space":
    case "docAliases":
    case "doc":
    case "documentCorpus":
    case "widget":
      noteSpaceChanged(event.spaceId)
      return
    default:
      noteWorkspaceActivity()
  }
})

onDocContentChanged((spaceId) => noteSpaceChanged(spaceId))
