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
// File fingerprints are the truth; events are hints. Each snapshot records
// the fingerprint (lstat: type, device, inode, size, change and modification
// times) of every file it was built from, taken before the build. Signals
// decide when to look again:
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
// Looking again re-stats every input. When nothing changed, the snapshot is
// served again without a rebuild; any difference, or an input changed within
// the racy window of the last look, rebuilds the Space.
//
// Writers never read snapshots. They build fresh under the document path lock.
// WORKTABLE_MODEL=0 turns snapshots off.

import { isAbsolute, relative, sep } from "node:path"
import { onDocContentChanged } from "./content-events.ts"
import { withDocPathLock } from "./doc-path-lock.ts"
import {
  RACY_FINGERPRINT_WINDOW_MS,
  readFileFingerprint,
  readTreeFingerprints,
  sameTreeFingerprints,
  type TreeFingerprints,
} from "./file-fingerprint.ts"
import { timing } from "./request-timing.ts"
import { onWorkspaceChange } from "./workspace-events.ts"
import { assertWorkspaceAvailable } from "./workspace-safety.ts"

/** Longest a snapshot is served without re-checking all of its inputs. */
export const SPACE_SNAPSHOT_MAX_AGE_MS = 15_000

let clock = 0
let allSpacesChangedAt = 0
const spaceChangedAt = new Map<string, number>()
const writesInFlight = new Map<string, number>()

interface SpaceSnapshot {
  workspaceRoot: string
  generation: number
  /** When its inputs were last fingerprinted. */
  checkedAt: number
  sources: ReadonlyArray<readonly [path: string, key: string | null]>
  inputs: TreeFingerprints
  value: unknown
}

/**
 * Most recently read first out. Signals keep a snapshot for its next check,
 * so a deleted Space's snapshot is let go only by this bound.
 */
const SNAPSHOT_LIMIT = 1_024
const snapshots = new Map<string, SpaceSnapshot>()

function publish(spaceId: string, snapshot: SpaceSnapshot): void {
  snapshots.delete(spaceId)
  snapshots.set(spaceId, snapshot)
  for (const oldest of snapshots.keys()) {
    if (snapshots.size <= SNAPSHOT_LIMIT) break
    snapshots.delete(oldest)
  }
}

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

/** The Space's snapshot is kept, to be checked against its inputs. */
export function noteSpaceChanged(spaceId: string): void {
  clock += 1
  spaceChangedAt.set(spaceId, clock)
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

/** A source's fingerprint key: null when missing, undefined when unreadable. */
async function sourceKey(path: string): Promise<string | null | undefined> {
  try {
    return (await readFileFingerprint(path))?.key ?? null
  } catch {
    return undefined
  }
}

/** WORKTABLE_MODEL=0 turns off the read model and the caches built for it. */
export function readModelEnabled(): boolean {
  return process.env["WORKTABLE_MODEL"] !== "0"
}

/** Whether the snapshot may be served without re-checking all its inputs. */
async function isCurrent(
  snapshot: SpaceSnapshot,
  workspaceRoot: string,
  spaceId: string
): Promise<boolean> {
  // Inputs changed within the racy window could change again unseen, so a
  // snapshot built from them is checked again once that window has passed.
  const maxAge = snapshot.inputs.racy
    ? RACY_FINGERPRINT_WINDOW_MS
    : SPACE_SNAPSHOT_MAX_AGE_MS
  if (
    snapshot.workspaceRoot !== workspaceRoot ||
    snapshot.generation !== spaceGeneration(spaceId) ||
    Date.now() - snapshot.checkedAt >= maxAge
  ) {
    return false
  }
  const observed = await Promise.all(
    snapshot.sources.map(([path]) => sourceKey(path))
  )
  // A write may have started while the files were inspected.
  return (
    snapshot.generation === spaceGeneration(spaceId) &&
    observed.every((key, index) => key === snapshot.sources[index]![1])
  )
}

/** Fingerprints of every input, or null when one cannot be inspected. */
async function readInputs(
  sources: readonly string[],
  trees: () => Promise<readonly string[]>,
  observedAt: number
): Promise<TreeFingerprints | null> {
  try {
    return await timing.span("revalidate", async () =>
      readTreeFingerprints({ files: sources, trees: await trees() }, observedAt)
    )
  } catch {
    return null
  }
}

/**
 * Read one Space's derived data from its current snapshot, or check and
 * publish a new one. `sources` are the files whose fingerprints identify the
 * snapshot and are checked on every read. `trees` returns the directories
 * holding everything else the build reads; with `sources`, they are
 * re-checked once the snapshot is too old or a signal says the Space
 * changed. Checks and builds run under the document path lock, so
 * concurrent readers of a stale Space wait for one instead of starting their
 * own.
 */
export async function readSpaceSnapshot<T>(options: {
  workspaceRoot: string
  spaceId: string
  sources: readonly string[]
  trees: () => Promise<readonly string[]>
  build: () => Promise<T>
  /** The caller already holds this Space's document path lock. */
  lockHeld?: boolean
  /**
   * The caller found the snapshot it was served out of date: build and
   * publish a new one whatever the signals and fingerprints say.
   */
  refresh?: boolean
}): Promise<T> {
  const { workspaceRoot, spaceId } = options
  const locked = <R>(fn: () => Promise<R>) =>
    options.lockHeld ? fn() : withDocPathLock(spaceId, fn)
  if (!readModelEnabled()) return locked(options.build)
  // A snapshot hit skips the lock, which is where reads fail closed while a
  // document move awaits recovery.
  assertWorkspaceAvailable()

  const seen = snapshots.get(spaceId)
  if (
    !options.refresh &&
    seen &&
    (await isCurrent(seen, workspaceRoot, spaceId))
  ) {
    if (snapshots.get(spaceId) === seen) publish(spaceId, seen)
    return seen.value as T
  }
  return locked(async () => {
    const published = snapshots.get(spaceId)
    if (
      !options.refresh &&
      published &&
      published !== seen &&
      (await isCurrent(published, workspaceRoot, spaceId))
    ) {
      return published.value as T
    }
    const generation = spaceGeneration(spaceId)
    const publishable = !writesInFlight.has(spaceId)
    const checkedAt = Date.now()
    // Fingerprints are taken before any build, so a change made while it
    // runs leaves the snapshot already stale. An input changed within the
    // racy window could change again without a new fingerprint, so a
    // snapshot that saw one is rebuilt, not reused, at its next check.
    // An edit the watcher misses during a build is, like any missed event,
    // seen at the next check, within the maximum age.
    const keys = await Promise.all(options.sources.map(sourceKey))
    const inputs = await readInputs(options.sources, options.trees, checkedAt)
    const unchanged =
      !options.refresh &&
      published !== undefined &&
      published.workspaceRoot === workspaceRoot &&
      !published.inputs.racy &&
      inputs !== null &&
      sameTreeFingerprints(published.inputs, inputs)
    if (!unchanged && published && snapshots.get(spaceId) === published) {
      snapshots.delete(spaceId)
    }
    const value = unchanged ? (published.value as T) : await options.build()
    if (
      publishable &&
      inputs !== null &&
      spaceGeneration(spaceId) === generation &&
      !keys.includes(undefined)
    ) {
      publish(spaceId, {
        workspaceRoot,
        generation,
        checkedAt,
        sources: options.sources.map(
          (path, index) => [path, keys[index] ?? null] as const
        ),
        inputs,
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
