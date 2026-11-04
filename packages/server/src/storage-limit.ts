// ============================================================
// Storage limit: what a Worktable may take on disk
// ============================================================
//
// Every Worktable has a limit, on every surface: 2 GiB by default
// (DEFAULT_STORAGE_LIMIT_BYTES), the most today's export can carry, so every
// Worktable stays exportable. `WORKTABLE_STORAGE_LIMIT_BYTES` sets another:
// on Cloud, the plan's storage, which the control plane passes in the tenant
// environment (hosted-contract ENV.STORAGE_LIMIT_BYTES); elsewhere an
// operator may set any value up to STORAGE_LIMIT_CEILING_BYTES. It counts
// everything storage-usage.ts counts: live files, history, deleted items,
// transfers in progress and derived output.
//
// Writes through Worktable can't pass it. Each write that adds bytes asks
// for room first, from the running total in memory plus the writes admitted
// and not yet counted, with no I/O unless it is near the limit, where it
// reads the size of what it replaces. Writes that add nothing always pass:
// deletes, moves, archives, and replacing something with something smaller.
// A write the editor saves while someone types is counted, not refused.
//
// At the limit the oldest history goes first (storage-pruning.ts): a write
// that would pass it waits a few seconds while pruning frees room, down to
// PRUNE_TARGET_RATIO of the limit so it doesn't prune on every write. If
// that isn't enough, or nothing prunable is left, the write is refused with
// StorageLimitError, and pruning carries on in the background.
//
// Writes on disk can't be refused. They are counted as the watcher sees
// them, and once the total passes the limit the Worktable behaves as at its
// limit: pruning starts and Worktable writes that add bytes are refused
// until it is back under.
//
// Until the first count, a few seconds after the server starts, nothing is
// refused.

import { ENV } from "@worktable/hosted-contract"
import { logError } from "./debug-log.ts"
import { isHosted } from "./hosted.ts"
import {
  loadPrunedRecord,
  prunedSummary,
  type PrunedSummary,
} from "./storage-pruned.ts"
import {
  onStorageApplied,
  storageNoteSequences,
  storageUsage,
  type StorageUsage,
} from "./storage-usage.ts"

const GIB = 1024 * 1024 * 1024

/** The limit for every Worktable that sets none. */
export const DEFAULT_STORAGE_LIMIT_BYTES = 2 * GIB
/** The most an operator may set outside Cloud. */
export const STORAGE_LIMIT_CEILING_BYTES = DEFAULT_STORAGE_LIMIT_BYTES
/** Settings warns once usage passes this share of the limit. */
export const STORAGE_WARNING_RATIO = 0.8
/** Pruning frees room down to this share of the limit. */
const PRUNE_TARGET_RATIO = 0.95
/** How long a write waits for pruning before it is refused. */
const PROMPT_PRUNE_MS = 5_000

// ── The limit ───────────────────────────────────────────────

let configured: number | null = null
let override: number | null = null

/** This Worktable's storage limit in bytes. */
export function storageLimitBytes(): number {
  if (override !== null) return override
  configured ??= configuredLimit()
  return configured
}

function configuredLimit(): number {
  const raw = process.env[ENV.STORAGE_LIMIT_BYTES]?.trim()
  if (!raw) return DEFAULT_STORAGE_LIMIT_BYTES
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    console.warn(
      `[storage-limit] ${ENV.STORAGE_LIMIT_BYTES} is not a positive whole number of bytes; using the default`
    )
    return DEFAULT_STORAGE_LIMIT_BYTES
  }
  if (!isHosted() && value > STORAGE_LIMIT_CEILING_BYTES) {
    console.warn(
      `[storage-limit] ${ENV.STORAGE_LIMIT_BYTES} is above the ${formatStorageBytes(STORAGE_LIMIT_CEILING_BYTES)} most a Worktable outside Cloud may take; using that`
    )
    return STORAGE_LIMIT_CEILING_BYTES
  }
  return value
}

/** 512 B, 1.5 KB, 12 MB, 2 GB: as Settings shows bytes, without a trailing .0. */
export function formatStorageBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (unit < units.length - 1 && value >= 1024) {
    value /= 1024
    unit += 1
  }
  const text = value >= 10 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "")
  return `${text} ${units[unit]}`
}

// ── The refusal ─────────────────────────────────────────────

/** A write that would pass the storage limit. REST answers 507; MCP shows the message. */
export class StorageLimitError extends Error {
  readonly code = "STORAGE_LIMIT"
  readonly status = 507
  readonly details: { limitBytes: number; usedBytes: number }

  constructor(limitBytes: number, usedBytes: number, message?: string) {
    super(message ?? storageLimitMessage(limitBytes))
    this.name = "StorageLimitError"
    this.details = { limitBytes, usedBytes }
  }
}

export function storageLimitMessage(limitBytes = storageLimitBytes()): string {
  const limit = formatStorageBytes(limitBytes)
  return isHosted()
    ? `This Worktable is at its ${limit} limit. Delete something, or ask the owner to raise the limit.`
    : `This Worktable is at its ${limit} limit. Delete something to make room.`
}

/** The REST body for a refusal. */
export function storageLimitBody(error: StorageLimitError) {
  return { error: error.message, code: error.code, ...error.details }
}

// ── Room for writes ─────────────────────────────────────────

export interface StorageReservation {
  /** The write finished or failed; its bytes now wait to be counted. */
  release(): void
}

const NO_RESERVATION: StorageReservation = { release() {} }

/** Bytes admitted by writes still running. */
let inflight = 0
/** Bytes written or freed that the count includes once it reaches `sequence`. */
let settling: { bytes: number; sequence: number }[] = []

function usedBytes(usage: StorageUsage): number {
  const { applied } = storageNoteSequences()
  settling = settling.filter((entry) => entry.sequence > applied)
  let pending = inflight
  for (const entry of settling) pending += entry.bytes
  return Math.max(0, usage.total.bytes + pending)
}

function reserve(bytes: number): StorageReservation {
  inflight += bytes
  let released = false
  return {
    release() {
      if (released) return
      released = true
      inflight -= bytes
      // A write notes its paths before it returns, so the count includes it
      // once it has applied every note taken by now.
      settling.push({ bytes, sequence: storageNoteSequences().noted })
    },
  }
}

/**
 * Admit a write that adds `bytes`, at the moment it publishes. It never
 * waits, so a caller holding locks may use it; pruning, if needed, starts in
 * the background. Throws StorageLimitError when there is no room.
 */
export function admitStorageWrite(bytes: number): StorageReservation {
  if (!(bytes > 0)) return NO_RESERVATION
  const usage = storageUsage()
  if (!usage) return NO_RESERVATION
  const limit = storageLimitBytes()
  const used = usedBytes(usage)
  if (used + bytes <= limit) return reserve(bytes)
  void requestPruning(used + bytes - limit)
  throw new StorageLimitError(limit, used)
}

/**
 * Before taking locks: if `bytes` more would pass the limit, prune the
 * oldest history and wait a few seconds for it. Never throws.
 */
export async function makeStorageRoom(bytes: number): Promise<void> {
  if (!(bytes > 0)) return
  const usage = storageUsage()
  if (!usage) return
  const over = usedBytes(usage) + bytes - storageLimitBytes()
  if (over <= 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    requestPruning(over),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, promptPruneMs)
    }),
  ])
  clearTimeout(timer)
}

/**
 * Room for a write that adds `adds` bytes and takes away what `replaces`
 * reports, which is read only near the limit. Call it before taking locks:
 * it may prune first. Throws StorageLimitError when there is no room.
 */
export async function reserveStorage(room: {
  adds: number
  replaces?: () => Promise<number>
}): Promise<StorageReservation> {
  if (!(room.adds > 0)) return NO_RESERVATION
  const usage = storageUsage()
  if (!usage) return NO_RESERVATION
  if (usedBytes(usage) + room.adds <= storageLimitBytes()) {
    return reserve(room.adds)
  }
  let bytes = room.adds
  if (room.replaces) {
    bytes -= await room.replaces().catch(() => 0)
    if (bytes <= 0) return NO_RESERVATION
  }
  await makeStorageRoom(bytes)
  return admitStorageWrite(bytes)
}

/** Run `write` with room reserved for it; see `reserveStorage`. */
export async function withStorageRoom<T>(
  room: { adds: number; replaces?: () => Promise<number> },
  write: () => Promise<T>
): Promise<T> {
  const reservation = await reserveStorage(room)
  try {
    return await write()
  } finally {
    reservation.release()
  }
}

/**
 * Run `write`, which admits its room under its own locks. When it is
 * refused, wait a few seconds for the pruning the refusal started, then try
 * once more; a second refusal is final.
 */
export async function retryAfterPruning<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (!(error instanceof StorageLimitError) || !pruning) throw error
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      pruning,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, promptPruneMs)
      }),
    ])
    clearTimeout(timer)
    return write()
  }
}

// ── Pruning at the limit ────────────────────────────────────

let pruning: Promise<void> | null = null
let pruningWant = 0
let stopped = true
let promptPruneMs = PROMPT_PRUNE_MS
/** History and trash when a run found nothing to prune; skip until they change. */
let exhausted: { history: number; trash: number } | null = null

function requestPruning(overBytes: number): Promise<void> {
  if (stopped) return Promise.resolve()
  const want =
    overBytes + Math.round(storageLimitBytes() * (1 - PRUNE_TARGET_RATIO))
  if (pruning) {
    pruningWant = Math.max(pruningWant, want)
    return pruning
  }
  const usage = storageUsage()
  if (
    exhausted &&
    usage &&
    usage.parts.history.bytes === exhausted.history &&
    usage.parts.trash.bytes === exhausted.trash
  ) {
    return Promise.resolve()
  }
  pruningWant = want
  pruning = (async () => {
    try {
      const { pruneOldestHistory } = await import("./storage-pruning.ts")
      while (pruningWant > 0 && !stopped) {
        const target = pruningWant
        pruningWant = 0
        const result = await pruneOldestHistory(target, () => stopped)
        if (result.bytes > 0) {
          settling.push({
            bytes: -result.bytes,
            sequence: storageNoteSequences().noted,
          })
        }
        const after = storageUsage()
        exhausted =
          result.bytes === 0 && !result.deferred && after
            ? { history: after.parts.history.bytes, trash: after.parts.trash.bytes }
            : null
        if (result.bytes === 0) break
      }
    } catch (error) {
      console.error("[storage-limit] pruning failed:", logError(error))
    } finally {
      pruning = null
      pruningWant = 0
    }
  })()
  return pruning
}

/** After each count: past the limit, from writes on disk too, prune. */
function pruneWhenOver(): void {
  const usage = storageUsage()
  if (!usage) return
  const over = usedBytes(usage) - storageLimitBytes()
  if (over >= 0) void requestPruning(over)
}

/** Start enforcing for the served workspace. Returns its stop. */
export function startStorageLimits(): () => Promise<void> {
  stopped = false
  inflight = 0
  settling = []
  exhausted = null
  void loadPrunedRecord().catch(() => undefined)
  const unsubscribe = onStorageApplied(pruneWhenOver)
  return async () => {
    unsubscribe()
    stopped = true
    await pruning
  }
}

// ── What Settings shows ─────────────────────────────────────

export interface StorageSummary extends StorageUsage {
  limit: { bytes: number; warnAt: number }
  pruned: PrunedSummary | null
}

/** The count, the limit and what pruning removed, from memory; null until counted. */
export function storageSummary(): StorageSummary | null {
  const usage = storageUsage()
  if (!usage) return null
  return {
    ...usage,
    limit: { bytes: storageLimitBytes(), warnAt: STORAGE_WARNING_RATIO },
    pruned: prunedSummary(),
  }
}

// ── Tests ───────────────────────────────────────────────────

export function setStorageLimitForTests(
  bytes: number | null,
  options: { promptPruneMs?: number } = {}
): void {
  override = bytes
  configured = null
  promptPruneMs = options.promptPruneMs ?? PROMPT_PRUNE_MS
  exhausted = null
}

/** Resolves once pruning started so far has finished. */
export async function storagePruningSettled(): Promise<void> {
  while (pruning) await pruning
}
