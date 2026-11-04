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
// what storage-usage.ts counts, except transfers in progress (see
// countedBytes): live files, history, deleted items and derived output.
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
// PRUNE_TARGET_RATIO of the limit so it doesn't prune on every write. A
// write that couldn't fit even if all removable history went is refused
// with StorageLimitError and nothing is removed for it; so is one that
// pruning can't make room for in time.
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
import { prunableHistoryEpoch } from "./prunable-history.ts"

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
  /** What the refused write asked for; 0 when pruning can't help it. */
  readonly requestedBytes: number

  constructor(
    limitBytes: number,
    usedBytes: number,
    message?: string,
    requestedBytes = 0
  ) {
    super(message ?? storageLimitMessage(limitBytes))
    this.name = "StorageLimitError"
    this.details = { limitBytes, usedBytes }
    this.requestedBytes = requestedBytes
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

/**
 * What counts toward the limit: everything but transfers in progress.
 * Uploads being received, export packages and import staging are temporary,
 * made by Worktable, and expire (workspace-transfer-jobs.ts removes jobs a
 * day after they finish), and pruning history can't free them. Settings
 * still shows them as their own part.
 */
export function countedBytes(usage: StorageUsage): number {
  return usage.total.bytes - usage.parts.transfers.bytes
}

function usedBytes(usage: StorageUsage): number {
  const { applied } = storageNoteSequences()
  settling = settling.filter((entry) => entry.sequence > applied)
  let pending = inflight
  for (const entry of settling) pending += entry.bytes
  return Math.max(0, countedBytes(usage) + pending)
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
 * waits, so a caller holding locks may use it. Throws StorageLimitError when
 * there is no room; `retryAfterPruning` then makes room and tries again.
 */
export function admitStorageWrite(bytes: number): StorageReservation {
  if (!(bytes > 0)) return NO_RESERVATION
  const usage = storageUsage()
  if (!usage) return NO_RESERVATION
  const limit = storageLimitBytes()
  const used = usedBytes(usage)
  if (used + bytes <= limit) return reserve(bytes)
  throw new StorageLimitError(limit, used, undefined, bytes)
}

/** Whether `bytes` more fit now. No side effects; nothing is reserved. */
export function storageFits(bytes: number): boolean {
  const usage = storageUsage()
  return !usage || bytes <= 0 || usedBytes(usage) + bytes <= storageLimitBytes()
}

/**
 * Room for a write that adds `adds` bytes and takes away what `replaces`
 * reports, which is read only near the limit. Call it before taking locks:
 * it may wait for pruning. Throws StorageLimitError when there is no room.
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
  return retryAfterPruning(async () => admitStorageWrite(bytes))
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
 * Run `write`, which admits its room under its own locks by calling
 * `admit` (synchronously; it throws StorageLimitError when there is no
 * room) once it knows what it adds; the room is released when it ends. A
 * refusal waits for pruning and tries once more, as `retryAfterPruning`.
 */
export function withAdmittedRoom<T>(
  write: (admit: (bytes: number) => void) => Promise<T>
): Promise<T> {
  return retryAfterPruning(async () => {
    const room: { reservation: StorageReservation | null } = { reservation: null }
    try {
      return await write((bytes) => {
        room.reservation?.release()
        room.reservation = admitStorageWrite(bytes)
      })
    } finally {
      room.reservation?.release()
    }
  })
}

/**
 * The one way a refused write gets room: run `write`; when it is refused,
 * wait while pruning makes room for it (a few seconds at most), then try
 * once more. A second refusal is final. Every write that needs room comes
 * through here, whether it admits before taking locks or under them.
 */
export async function retryAfterPruning<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write()
  } catch (error) {
    if (!(error instanceof StorageLimitError) || !(error.requestedBytes > 0)) {
      throw error
    }
    await waitForRoom(error.requestedBytes)
    return write()
  }
}

// ── Pruning at the limit ────────────────────────────────────
//
// One run at a time. Each pass first plans what could go now (a walk of all
// history, storage-pruning.ts), then removes only what is due:
//   - for writes waiting for room, in the order they asked: enough for all
//     of them that can fit once everything plannable went, down to
//     PRUNE_TARGET_RATIO. A write that can't fit anyway is refused and
//     nothing is removed for it, so retrying an impossible write never
//     empties history;
//   - when usage is past the limit on its own (writes on disk, typing),
//     what can go, toward the same target.
// What a plan found is remembered, so a pass that would find the same need
// not walk history again: until something can have become removable
// (prunable-history.ts), or an unsettled lifecycle operation that kept some
// of it settles.

let pruning: Promise<void> | null = null
let again = false
let stopped = true
let promptPruneMs = PROMPT_PRUNE_MS
/** Writes waiting for room, in the order they asked. */
const waiting = new Set<{ bytes: number }>()
/** What the last plan could remove, still; null when it may be stale. */
let known: {
  epoch: number
  reclaimable: number
  blockedBy: readonly string[]
} | null = null

/** What is due from `reclaimable` bytes that could go; see above. */
function dueBytes(reclaimable: number): number {
  const usage = storageUsage()
  if (!usage || reclaimable <= 0) return 0
  const limit = storageLimitBytes()
  const target = Math.round(limit * PRUNE_TARGET_RATIO)
  const used = usedBytes(usage)
  let due = used >= limit ? Math.min(used - target, reclaimable) : 0
  let fitting = 0
  for (const write of waiting) {
    // One that can't fit even if all of it went isn't pruned for.
    if (used + fitting + write.bytes - reclaimable > limit) continue
    fitting += write.bytes
  }
  if (fitting > 0) {
    due = Math.max(due, Math.min(used + fitting - target, reclaimable))
  }
  return Math.max(0, due)
}

async function knownIsCurrent(): Promise<boolean> {
  if (!known || known.epoch !== prunableHistoryEpoch()) return false
  if (known.blockedBy.length === 0) return true
  const { lifecyclesStillUnsettled } = await import("./storage-pruning.ts")
  return lifecyclesStillUnsettled(known.blockedBy)
}

function runPruning(): Promise<void> {
  if (stopped) return Promise.resolve()
  if (pruning) {
    again = true
    return pruning
  }
  pruning = (async () => {
    try {
      const { planPruning, prunePlanned } = await import("./storage-pruning.ts")
      do {
        again = false
        if ((await knownIsCurrent()) && dueBytes(known!.reclaimable) <= 0) continue
        const epoch = prunableHistoryEpoch()
        const plan = await planPruning(() => stopped)
        const due = dueBytes(plan.bytes)
        let freed = 0
        let deferred = plan.held
        if (due > 0) {
          const result = await prunePlanned(plan, due, () => stopped)
          freed = result.bytes
          deferred ||= result.deferred
          if (freed > 0) {
            settling.push({ bytes: -freed, sequence: storageNoteSequences().noted })
          }
        }
        known = deferred
          ? null
          : { epoch, reclaimable: plan.bytes - freed, blockedBy: plan.blockedBy }
      } while (again && !stopped)
    } catch (error) {
      known = null
      console.error("[storage-limit] pruning failed:", logError(error))
    } finally {
      pruning = null
      again = false
    }
  })()
  return pruning
}

/** A write of `bytes` waits, a few seconds at most, while pruning makes room. */
async function waitForRoom(bytes: number): Promise<void> {
  if (stopped) return
  const write = { bytes }
  waiting.add(write)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      runPruning(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, promptPruneMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
    waiting.delete(write)
  }
}

/** After each count: past the limit, from writes on disk too, prune. */
function pruneWhenOver(): void {
  const usage = storageUsage()
  if (!usage) return
  if (usedBytes(usage) >= storageLimitBytes()) void runPruning()
}

/** Start enforcing for the served workspace. Returns its stop. */
export function startStorageLimits(): () => Promise<void> {
  stopped = false
  inflight = 0
  settling = []
  waiting.clear()
  known = null
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
  /** `countedBytes`: what counts toward the limit, without transfers. */
  limit: { bytes: number; warnAt: number; countedBytes: number }
  pruned: PrunedSummary | null
}

/** The count, the limit and what pruning removed, from memory; null until counted. */
export function storageSummary(): StorageSummary | null {
  const usage = storageUsage()
  if (!usage) return null
  return {
    ...usage,
    limit: {
      bytes: storageLimitBytes(),
      warnAt: STORAGE_WARNING_RATIO,
      countedBytes: countedBytes(usage),
    },
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
  known = null
}

/** Resolves once pruning started so far has finished. */
export async function storagePruningSettled(): Promise<void> {
  while (pruning) await pruning
}
