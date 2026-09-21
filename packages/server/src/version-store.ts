// ============================================================
// Shared version store — kind-parameterized snapshot primitives.
//
// Doc and widget (HTML doc) version history share one mechanism: full
// before/after snapshots on disk under <workspace>/versions/<space-id>/<kind>/,
// hash dedup, and meaningful-checkpoint marking at source-category
// transitions. This module owns the content-type-agnostic primitives; the
// doc-specific flow (provenance in docs.meta.json) stays in store.ts and the
// widget flow lives in widget-version-store.ts — both delegate here so the
// subtle ordering/dedup/no-demote rules cannot drift apart.
//
// Deliberately imports nothing from store.ts (store.ts imports this module).
// All version-snapshot writes flow through this module's lock map, so
// per-file write ordering is preserved across both kinds.
// ============================================================

import crypto from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { type DocSourceCategory } from "@worktable/types"
import { getVersionsDir } from "./workspace.ts"
import { assertWorkspaceAvailable } from "./workspace-safety.ts"

export type VersionKind = "docs" | "widgets"

export const VERSION_SNAPSHOT_TYPES: Record<VersionKind, string> = {
  docs: "worktable.doc-version",
  widgets: "worktable.widget-version",
}

export type VersionCheckpointKind =
  | "manual"
  | "source-transition"
  | "restore"
  | "system"
  | "review"

export interface VersionCheckpoint {
  meaningful: boolean
  kind: VersionCheckpointKind
  label?: string
  sourceCategory: DocSourceCategory
  transition?: { from: DocSourceCategory; to: DocSourceCategory }
}

export interface VersionEntry {
  id: string
  createdAt: string
  createdBy: string
  source: string
  reason?: string
  operation: "create" | "update" | "checkpoint"
  before?: {
    format: string | null
    storedAs: string | null
    contentHash: string | null
  } | null
  after: {
    format: string | null
    storedAs: string | null
    contentHash: string
    content?: unknown
  }
  checkpoint?: VersionCheckpoint
}

/** The minimum shape this module needs from a stored snapshot. */
export interface VersionSnapshotBase extends VersionEntry {
  type: string
  version: 1
  spaceId: string
  before: {
    format: string | null
    storedAs: string | null
    contentHash: string | null
    content: unknown
  } | null
  after: {
    format: string | null
    storedAs: string | null
    contentHash: string
    content: unknown
  }
}

export function stableVersionHash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

let lastMintStamp = ""
let lastMintSequence = 0

export function mintVersionId(nowIso: string): string {
  const stamp = nowIso.replace(/[:.]/g, "-")
  if (stamp === lastMintStamp) {
    lastMintSequence += 1
  } else {
    lastMintStamp = stamp
    lastMintSequence = 0
  }
  const sequence = lastMintSequence.toString(36).padStart(6, "0")
  return `${stamp}-${sequence}-${crypto.randomUUID().slice(0, 8)}`
}

/** Recover the authoritative timestamp encoded by current and legacy version ids. */
export function versionIdTimestamp(versionId: string): number | null {
  const match = versionId.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/
  )
  if (!match) return null
  const iso = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
  const timestamp = Date.parse(iso)
  return Number.isNaN(timestamp) ? null : timestamp
}

/**
 * Order version entries newest-first.
 *
 * Current ids are lexically ordered by timestamp and then by their padded
 * same-millisecond sequence. The id is authoritative because `createdAt` has
 * only millisecond precision, while filesystem enumeration and mtime are not
 * trustworthy ordering signals (checkpoint rewrites can change mtime). Older
 * ids have the same timestamp prefix but no sequence; their random suffix
 * cannot recover creation order, so the lexical fallback at least keeps their
 * order deterministic. Hand-written/legacy ids without a timestamp fall back
 * to the snapshot's `createdAt`.
 */
export function compareVersionEntriesNewestFirst(
  a: Pick<VersionEntry, "id" | "createdAt">,
  b: Pick<VersionEntry, "id" | "createdAt">
): number {
  const aIdTimestamp = versionIdTimestamp(a.id)
  const bIdTimestamp = versionIdTimestamp(b.id)
  if (aIdTimestamp !== null && bIdTimestamp !== null) {
    const byIdTimestamp = bIdTimestamp - aIdTimestamp
    if (byIdTimestamp !== 0) return byIdTimestamp
    return b.id.localeCompare(a.id)
  }

  const byCreatedAt = Date.parse(b.createdAt) - Date.parse(a.createdAt)
  if (!Number.isNaN(byCreatedAt) && byCreatedAt !== 0) return byCreatedAt
  return b.id.localeCompare(a.id)
}

/** Same traversal hygiene as doc paths: strip `..` and leading slashes. */
export function sanitizeVersionKey(key: string): string {
  return key.replace(/\.\./g, "").replace(/^\/+/, "")
}

export function versionKeyDir(
  spaceId: string,
  kind: VersionKind,
  key: string
): string {
  return join(getVersionsDir(), spaceId, kind, sanitizeVersionKey(key))
}

export function retiredVersionGenerationDir(
  spaceId: string,
  kind: VersionKind,
  key: string,
  generationId: string
): string {
  if (!/^dlc_[A-Za-z0-9_-]{22}$/.test(generationId)) {
    throw new Error("Invalid retired version generation id")
  }
  const digest = crypto
    .createHash("sha256")
    .update(sanitizeVersionKey(key))
    .digest("hex")
  return join(getVersionsDir(), spaceId, ".retired", kind, digest, generationId)
}

/** Move active history out of the namespace for one retired generation. */
export async function retireVersionHistoryLocked(
  spaceId: string,
  kind: VersionKind,
  key: string,
  generationId: string
): Promise<string | null> {
  const active = versionKeyDir(spaceId, kind, key)
  if (!existsSync(active)) return null
  const retired = retiredVersionGenerationDir(spaceId, kind, key, generationId)
  await mkdir(dirname(retired), { recursive: true })
  await rename(active, retired)
  return retired
}

function versionFilePath(
  spaceId: string,
  kind: VersionKind,
  key: string,
  versionId: string
): string {
  return join(versionKeyDir(spaceId, kind, key), `${versionId}.json`)
}

// Per-file write serialization (same discipline as the store's write locks;
// scoped here because every version-snapshot writer goes through this module).
const versionWriteLocks = new Map<string, Promise<void>>()

async function withVersionWriteLock<T>(
  filePath: string,
  fn: () => Promise<T>
): Promise<T> {
  const current = versionWriteLocks.get(filePath) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((res) => {
    release = res
  })
  versionWriteLocks.set(filePath, next)
  await current
  try {
    return await fn()
  } finally {
    release()
    if (versionWriteLocks.get(filePath) === next) {
      versionWriteLocks.delete(filePath)
    }
  }
}

// Per-doc-key write serialization. The per-FILE lock above orders writes to a
// single snapshot file, but every snapshot gets a unique versionId (unique path),
// so two writes to the SAME doc never contend on it. Retention pruning, however,
// must not interleave with an in-flight snapshot write for the same doc (it lists
// then deletes a doc's versions). This key-level lock — shared by the pruner and
// `recordDocVersion`'s snapshot write — gives that mutual exclusion, scoped to a
// single doc so unrelated docs still write concurrently.
const versionKeyLocks = new Map<string, Promise<void>>()
const versionKeyLockDepths = new Map<string, number>()
const versionKeyLockDepthWaiters = new Map<
  string,
  Array<{ minimum: number; resolve: () => void }>
>()

function noteVersionKeyLockDepth(lockKey: string, depth: number): void {
  if (depth > 0) versionKeyLockDepths.set(lockKey, depth)
  else versionKeyLockDepths.delete(lockKey)
  const waiters = versionKeyLockDepthWaiters.get(lockKey)
  if (!waiters) return
  const pending = waiters.filter(({ minimum, resolve }) => {
    if (depth < minimum) return true
    resolve()
    return false
  })
  if (pending.length > 0) versionKeyLockDepthWaiters.set(lockKey, pending)
  else versionKeyLockDepthWaiters.delete(lockKey)
}

/**
 * Exact queue barrier for lock-ordering tests. Production callers should await
 * their operation instead; this exposes no mutation or release capability.
 */
export function whenVersionKeyLockDepthForTests(
  spaceId: string,
  kind: VersionKind,
  key: string,
  minimum: number
): Promise<void> {
  const lockKey = versionKeyDir(spaceId, kind, key)
  if ((versionKeyLockDepths.get(lockKey) ?? 0) >= minimum) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    versionKeyLockDepthWaiters.set(lockKey, [
      ...(versionKeyLockDepthWaiters.get(lockKey) ?? []),
      { minimum, resolve },
    ])
  })
}

export function whenAnyVersionKeyLockDepthForTests(
  keys: Array<{
    spaceId: string
    kind: VersionKind
    key: string
    minimum: number
  }>
): Promise<void> {
  const candidates = keys.map((candidate) => ({
    lockKey: versionKeyDir(candidate.spaceId, candidate.kind, candidate.key),
    minimum: candidate.minimum,
  }))
  if (
    candidates.some(
      ({ lockKey, minimum }) =>
        (versionKeyLockDepths.get(lockKey) ?? 0) >= minimum
    )
  ) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let settled = false
    const registrations: Array<{
      lockKey: string
      waiter: { minimum: number; resolve: () => void }
    }> = []
    const finish = () => {
      if (settled) return
      settled = true
      for (const { lockKey, waiter } of registrations) {
        const remaining = (
          versionKeyLockDepthWaiters.get(lockKey) ?? []
        ).filter((candidate) => candidate !== waiter)
        if (remaining.length > 0) {
          versionKeyLockDepthWaiters.set(lockKey, remaining)
        } else {
          versionKeyLockDepthWaiters.delete(lockKey)
        }
      }
      resolve()
    }
    for (const { lockKey, minimum } of candidates) {
      const waiter = { minimum, resolve: finish }
      registrations.push({ lockKey, waiter })
      versionKeyLockDepthWaiters.set(lockKey, [
        ...(versionKeyLockDepthWaiters.get(lockKey) ?? []),
        waiter,
      ])
    }
  })
}

export async function withVersionKeyLock<T>(
  spaceId: string,
  kind: VersionKind,
  key: string,
  fn: () => Promise<T>
): Promise<T> {
  // The canonical identity is the DIRECTORY the key resolves to: join()
  // collapses redundant separators ("notes//draft" and "notes/draft" are the
  // same dir), so deriving the lock key from the raw sanitized string would
  // let two aliases of one doc hold "different" locks and race after all.
  const lockKey = versionKeyDir(spaceId, kind, key)
  const current = versionKeyLocks.get(lockKey) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((res) => {
    release = res
  })
  versionKeyLocks.set(lockKey, next)
  noteVersionKeyLockDepth(lockKey, (versionKeyLockDepths.get(lockKey) ?? 0) + 1)
  await current
  try {
    assertWorkspaceAvailable()
    return await fn()
  } finally {
    release()
    if (versionKeyLocks.get(lockKey) === next) {
      versionKeyLocks.delete(lockKey)
    }
    noteVersionKeyLockDepth(
      lockKey,
      (versionKeyLockDepths.get(lockKey) ?? 1) - 1
    )
  }
}

/** Acquire several version-key locks in canonical filesystem order. */
export async function withVersionKeyLocks<T>(
  keys: Array<{ spaceId: string; kind: VersionKind; key: string }>,
  fn: () => Promise<T>
): Promise<T> {
  const ordered = [...keys]
    .sort((a, b) =>
      versionKeyDir(a.spaceId, a.kind, a.key).localeCompare(
        versionKeyDir(b.spaceId, b.kind, b.key)
      )
    )
    .filter(
      (entry, index, all) =>
        index === 0 ||
        versionKeyDir(entry.spaceId, entry.kind, entry.key) !==
          versionKeyDir(
            all[index - 1]!.spaceId,
            all[index - 1]!.kind,
            all[index - 1]!.key
          )
    )
  const acquire = (index: number): Promise<T> => {
    const entry = ordered[index]
    if (!entry) return fn()
    return withVersionKeyLock(entry.spaceId, entry.kind, entry.key, () =>
      acquire(index + 1)
    )
  }
  return acquire(0)
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  const tmpPath = `${filePath}.tmp`
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8")
  await rename(tmpPath, filePath)
}

export async function readVersionSnapshot<S extends VersionSnapshotBase>(
  spaceId: string,
  kind: VersionKind,
  key: string,
  versionId: string
): Promise<S | null> {
  const path = versionFilePath(spaceId, kind, key, versionId)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(await Bun.file(path).text()) as S
    if (
      parsed?.type !== VERSION_SNAPSHOT_TYPES[kind] ||
      parsed.id !== versionId
    )
      return null
    return parsed
  } catch {
    return null
  }
}

export async function writeVersionSnapshot(
  spaceId: string,
  kind: VersionKind,
  key: string,
  snapshot: VersionSnapshotBase
): Promise<void> {
  const path = versionFilePath(spaceId, kind, key, snapshot.id)
  await mkdir(dirname(path), { recursive: true })
  await withVersionWriteLock(path, () => atomicWriteJson(path, snapshot))
}

export async function markVersionCheckpoint(
  spaceId: string,
  kind: VersionKind,
  key: string,
  versionId: string,
  checkpoint: VersionCheckpoint
): Promise<void> {
  const snapshot = await readVersionSnapshot(spaceId, kind, key, versionId)
  if (!snapshot) return
  // A version that is already a meaningful checkpoint keeps its kind and
  // label: automatic source-transition marking must not demote a manual or
  // review checkpoint the user created deliberately.
  if (snapshot.checkpoint?.meaningful) return
  snapshot.checkpoint = checkpoint
  await writeVersionSnapshot(spaceId, kind, key, snapshot)
}

export function automaticCheckpointLabel(
  from: DocSourceCategory,
  to: DocSourceCategory
): string {
  if (from === "agent" && to === "human") return "Agent Draft"
  if (from === "human" && to === "agent") return "Before Agent Update"
  if ((from === "external" || from === "system") && to === "human")
    return "External Update"
  if (from === "human" && to === "restore") return "Before Restore"
  if (from === "restore" && to === "human") return "Restored Version"
  return "Meaningful Checkpoint"
}

/** List entries newest-first with heavy `content` fields stripped. */
export async function listVersionEntries(
  spaceId: string,
  kind: VersionKind,
  key: string,
  opts?: { checkpointsOnly?: boolean }
): Promise<VersionEntry[]> {
  const dir = versionKeyDir(spaceId, kind, key)
  if (!existsSync(dir)) return []
  const files = (await readdir(dir)).filter((file) => file.endsWith(".json"))
  const entries: VersionEntry[] = []
  for (const file of files) {
    const versionId = file.replace(/\.json$/, "")
    const snapshot = await readVersionSnapshot(spaceId, kind, key, versionId)
    if (!snapshot) continue
    if (opts?.checkpointsOnly && !snapshot.checkpoint?.meaningful) continue
    entries.push({
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      createdBy: snapshot.createdBy,
      source: snapshot.source,
      reason: snapshot.reason,
      operation: snapshot.operation,
      before: snapshot.before
        ? {
            format: snapshot.before.format,
            storedAs: snapshot.before.storedAs,
            contentHash: snapshot.before.contentHash,
          }
        : null,
      after: {
        format: snapshot.after.format,
        storedAs: snapshot.after.storedAs,
        contentHash: snapshot.after.contentHash,
      },
      checkpoint: snapshot.checkpoint,
    })
  }
  return entries.sort(compareVersionEntriesNewestFirst)
}

/**
 * Retention: meaningful checkpoints are kept forever; non-checkpoint versions
 * beyond the newest `keep` are deleted. HTML snapshots are much heavier than
 * block JSON, so widgets prune where docs historically never did.
 */
export async function pruneNonCheckpointVersions(
  spaceId: string,
  kind: VersionKind,
  key: string,
  keep: number
): Promise<number> {
  const entries = await listVersionEntries(spaceId, kind, key)
  const nonCheckpoint = entries.filter((entry) => !entry.checkpoint?.meaningful)
  const excess = nonCheckpoint.slice(keep)
  for (const entry of excess) {
    await rm(versionFilePath(spaceId, kind, key, entry.id), { force: true })
  }
  return excess.length
}
