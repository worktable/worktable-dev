import type { BigIntStats } from "node:fs"
import { lstat, readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { createConcurrencyLimit } from "./bounded-concurrency.ts"

/**
 * A file changed within this window of being observed may change again
 * without a new modification time on coarse-timestamp filesystems (the same
 * "racy" rule git applies). Derived data must not trust such a fingerprint.
 */
export const RACY_FINGERPRINT_WINDOW_MS = 2_000

const RACY_WINDOW_NS = BigInt(RACY_FINGERPRINT_WINDOW_MS) * 1_000_000n

export interface FileFingerprint {
  /** Type, device, inode, size and nanosecond change and modification times. */
  key: string
  /** Changed too recently for an equal key to prove equal content. */
  racy: boolean
}

/** The fingerprint of a bigint `stat` or `lstat` result. */
export function fingerprintOf(
  info: BigIntStats,
  observedAt = Date.now()
): FileFingerprint {
  // A copy that preserves modification times still gets a new change time.
  const changedNs = info.mtimeNs > info.ctimeNs ? info.mtimeNs : info.ctimeNs
  return {
    key: `${info.mode}:${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
    racy: BigInt(observedAt) * 1_000_000n - changedNs < RACY_WINDOW_NS,
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR"
}

/**
 * Identify a file's current content without reading it. Symbolic links are
 * followed, like the readers this guards; a replaced link target changes the
 * inode. Returns null when the file does not exist.
 */
export async function readFileFingerprint(
  path: string,
  observedAt = Date.now()
): Promise<FileFingerprint | null> {
  try {
    return fingerprintOf(await stat(path, { bigint: true }), observedAt)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
}

/**
 * Values derived from files, each kept with the fingerprint key it was read
 * at. Holds at most `limit` entries and lets the least recently used go
 * first, so entries for files no longer read, such as a deleted Space's,
 * do not accumulate.
 */
export class FingerprintCache<V> {
  readonly #entries = new Map<string, { key: string; value: V }>()
  readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  /** The value read at this fingerprint key, or undefined. */
  get(path: string, key: string): V | undefined {
    const entry = this.#entries.get(path)
    if (!entry) return undefined
    this.#entries.delete(path)
    if (entry.key !== key) return undefined
    this.#entries.set(path, entry)
    return entry.value
  }

  set(path: string, key: string, value: V): void {
    this.#entries.delete(path)
    this.#entries.set(path, { key, value })
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.limit) break
      this.#entries.delete(oldest)
    }
  }

  delete(path: string): void {
    this.#entries.delete(path)
  }
}

export interface TreeFingerprints {
  /** The fingerprint key of every file and directory found, by path. */
  keys: ReadonlyMap<string, string>
  /** Some entry changed too recently for equal keys to prove it unchanged. */
  racy: boolean
}

const TREE_MAX_ENTRIES = 100_000
const TREE_CONCURRENCY = 64

/**
 * Fingerprint files, and every entry of directory trees, with `lstat`.
 * Symbolic links are recorded, not followed. Missing paths are left out, so
 * an added or removed entry changes the result. Throws when an entry cannot
 * be inspected or the trees hold more than 100,000 entries.
 */
export async function readTreeFingerprints(
  paths: { files: readonly string[]; trees: readonly string[] },
  observedAt = Date.now()
): Promise<TreeFingerprints> {
  const keys = new Map<string, string>()
  let racy = false
  const limited = createConcurrencyLimit(TREE_CONCURRENCY)
  const visit = async (path: string, descend: boolean): Promise<void> => {
    let info: BigIntStats
    try {
      info = await limited(() => lstat(path, { bigint: true }))
    } catch (error) {
      if (isMissing(error)) return
      throw error
    }
    if (keys.size >= TREE_MAX_ENTRIES) {
      throw new Error("fingerprinted trees exceed their entry limit")
    }
    const fingerprint = fingerprintOf(info, observedAt)
    keys.set(path, fingerprint.key)
    racy ||= fingerprint.racy
    if (!descend || !info.isDirectory()) return
    let names: string[]
    try {
      names = await limited(() => readdir(path))
    } catch (error) {
      // Removed or replaced since its lstat: its key already differs.
      if (isMissing(error)) return
      throw error
    }
    await Promise.all(names.map((name) => visit(join(path, name), true)))
  }
  await Promise.all([
    ...paths.files.map((path) => visit(path, false)),
    ...paths.trees.map((path) => visit(path, true)),
  ])
  return { keys, racy }
}

/** Whether two fingerprint sets describe the same entries, unchanged. */
export function sameTreeFingerprints(
  a: TreeFingerprints,
  b: TreeFingerprints
): boolean {
  if (a.keys.size !== b.keys.size) return false
  for (const [path, key] of a.keys) {
    if (b.keys.get(path) !== key) return false
  }
  return true
}
