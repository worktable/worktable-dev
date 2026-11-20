// ============================================================
// Storage limit: what a Worktable may take on disk
// ============================================================
//
// Every Worktable has a limit, on every surface: 2 GiB by default
// (DEFAULT_STORAGE_LIMIT_BYTES), the size export and import are proven to
// carry (worktable-size.ts). `WORKTABLE_STORAGE_LIMIT_BYTES` sets another: on
// Cloud, the plan's storage, which the control plane passes in the tenant
// environment (hosted-contract ENV.STORAGE_LIMIT_BYTES); elsewhere an
// operator may set any value up to STORAGE_LIMIT_CEILING_BYTES.
//
// The limit counts people's files: the workspace folder outside history,
// their Docs, files, Records and threads (filesBytes), as Settings shows it.
// Version history, deleted items and indexes don't count toward it; they
// live under a total limit of STORAGE_CEILING_RATIO times the limit
// (storageTotalLimitBytes), which holds the files, the history copy of each
// file's current version, and an allowance for older history that pruning
// keeps it within. Transfers in progress count toward neither (see
// countedBytes).
//
// Writes through Worktable can't pass either. Each write that adds bytes
// asks for room first, saying how many of them are people's files, from the
// running totals in memory plus the writes admitted and not yet counted, with
// no I/O unless it is near a limit, where it reads the size of what it
// replaces. Writes that add nothing always pass: deletes, moves, archives,
// and replacing something with something smaller. A write the editor saves
// while someone types is counted, not refused.
//
// A write past the limit for files is refused at once: removing history
// can't make room for files. At the total limit the oldest history goes
// first (storage-pruning.ts): a write that would pass it waits a few seconds
// while pruning frees room, down to PRUNE_TARGET_RATIO of the total limit so
// it doesn't prune on every write. A write that couldn't fit even if all
// removable history went is refused with StorageLimitError and nothing is
// removed for it; so is one that pruning can't make room for in time.
//
// Writes on disk can't be refused. They are counted as the watcher sees
// them: past the total limit pruning starts, and past either limit Worktable
// writes that add to it are refused until it is back under.
//
// The first count runs a few seconds after the server starts. A write that
// needs room before then starts it at once and waits for it, a few seconds
// at most; only if it takes longer than that is the write let through
// uncounted.

import { ENV } from "@worktable/hosted-contract"
import { logError } from "./debug-log.ts"
import { isHosted } from "./hosted.ts"
import {
  keptRecordSaved,
  loadKeptRecord,
  loadPrunedRecord,
  prunedSummary,
  saveKeptRecord,
  type KeptRecord,
  type PrunedSummary,
} from "./storage-pruned.ts"
import {
  onStorageApplied,
  storageCounted,
  storageNoteSequences,
  storageUsage,
  type StorageUsage,
} from "./storage-usage.ts"
import { prunableHistoryEpoch } from "./prunable-history.ts"
import {
  PROVEN_WORKTABLE_BYTES,
  STORAGE_CEILING_RATIO,
} from "./worktable-size.ts"


/** The limit for every Worktable that sets none. */
export const DEFAULT_STORAGE_LIMIT_BYTES = PROVEN_WORKTABLE_BYTES
/** The most an operator may set outside Cloud. */
export const STORAGE_LIMIT_CEILING_BYTES = DEFAULT_STORAGE_LIMIT_BYTES
/** How far past the limit a person's drawing saves may go: this share of it... */
const GRACE_RATIO = 0.05
/** ...and at most this much. */
const GRACE_MAX_BYTES = 64 * 1024 * 1024
/** Settings warns once usage passes this share of the limit. */
export const STORAGE_WARNING_RATIO = 0.8
/** Pruning frees room down to this share of the limit. */
const PRUNE_TARGET_RATIO = 0.95
/** How long a write waits for pruning before it is refused. */
const PROMPT_PRUNE_MS = 5_000

// ── The limit ───────────────────────────────────────────────

let configured: number | null = null
let override: number | null = null
let totalOverride: number | null = null

/** This Worktable's storage limit in bytes: what people's files may take. */
export function storageLimitBytes(): number {
  if (override !== null) return override
  configured ??= configuredLimit()
  return configured
}

/**
 * The most everything may take: files, the history copy of each file's
 * current version, and older history, deleted items and indexes within
 * their allowance (worktable-size.ts STORAGE_CEILING_RATIO). Pruning keeps
 * a Worktable under it; people never see it.
 */
export function storageTotalLimitBytes(limit = storageLimitBytes()): number {
  return totalOverride ?? Math.round(limit * STORAGE_CEILING_RATIO)
}

// ── A lower limit ───────────────────────────────────────────
//
// When the limit goes down (a smaller plan, one that lapsed, a wrong
// setting), nothing is pruned because of it (Plan 22a rule 13). The
// Worktable may keep what it held: `kept`, what it held in all when the
// limit went down, stays its total limit until it fits the lower one again.
// Pruning keeps it within `kept` as at any limit, oldest first, but with no
// headroom, so nothing goes for the lower limit itself. `kept` doesn't
// follow use down: pruning frees whole versions, a little more than a write
// needs, and following that down would shed history write by write. Its
// files meet the lower limit at once, so writes that add files are refused
// until they fit.
//
// The total limit in force is remembered in app data (storage-pruned.ts),
// so a limit lowered while the server was stopped is noticed at start.

/** The most everything may take while a lower limit is in force; null otherwise. */
let kept: number | null = null
/** The total limit last remembered, or what was kept; null until read. */
let remembered: KeptRecord | null = null
/** Reading what was remembered, at start. */
let keptLoaded: Promise<void> = Promise.resolve()

/** The most everything may take now: the total limit, or what is kept past it. */
function totalCeiling(): number {
  return Math.max(storageTotalLimitBytes(), kept ?? 0)
}

/**
 * After each count: notice a lower limit, notice when the Worktable fits it
 * again, and remember the result.
 */
function followLimit(usage: StorageUsage): void {
  const total = storageTotalLimitBytes()
  const used = usedBytes(usage)
  if (kept === null && remembered && total < remembered.totalBytes && used > total) {
    // What was kept before a restart stays as it was; a limit that went
    // down keeps what is held under it.
    kept = remembered.kept ? remembered.totalBytes : Math.min(remembered.totalBytes, used)
    console.warn(
      `[storage-limit] the limit went down to ${formatStorageBytes(storageLimitBytes())}; keeping what this Worktable holds, and pruning nothing for it`
    )
  }
  if (kept !== null && used <= total) kept = null
  const next = { totalBytes: kept ?? total, kept: kept !== null }
  if (next.totalBytes !== remembered?.totalBytes || next.kept !== remembered?.kept) {
    remembered = next
    void saveKeptRecord(next)
  }
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
  /** The most the write may take the Worktable to: the limit, or past it by an allowance. */
  readonly ceilingBytes: number

  constructor(
    limitBytes: number,
    usedBytes: number,
    message?: string,
    requestedBytes = 0,
    ceilingBytes = limitBytes
  ) {
    super(message ?? storageLimitMessage(limitBytes))
    this.name = "StorageLimitError"
    this.details = { limitBytes, usedBytes }
    this.requestedBytes = requestedBytes
    this.ceilingBytes = ceilingBytes
  }
}

export function storageLimitMessage(
  limitBytes = storageLimitBytes(),
  where: "at" | "over" | "close to" = "at"
): string {
  const limit = formatStorageBytes(limitBytes)
  return isHosted()
    ? `This Worktable is ${where} its ${limit} limit. Delete something, or ask the owner to raise the limit.`
    : `This Worktable is ${where} its ${limit} limit. Delete something to make room.`
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

/** Bytes admitted by writes still running: all of them, and people's files among them. */
const inflight = { bytes: 0, files: 0 }
/** Bytes written or freed that the count includes once it reaches `sequence`. */
let settling: { bytes: number; files: number; sequence: number }[] = []

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

/** People's files: the workspace folder outside history, what the limit counts. */
export function filesBytes(usage: StorageUsage): number {
  return usage.parts.live.bytes
}

/** What is used now, counted and admitted: everything, and people's files. */
function used(usage: StorageUsage): { bytes: number; files: number } {
  const { applied } = storageNoteSequences()
  settling = settling.filter((entry) => entry.sequence > applied)
  let bytes = inflight.bytes
  let files = inflight.files
  for (const entry of settling) {
    bytes += entry.bytes
    files += entry.files
  }
  return {
    bytes: Math.max(0, countedBytes(usage) + bytes),
    files: Math.max(0, filesBytes(usage) + files),
  }
}

function usedBytes(usage: StorageUsage): number {
  return used(usage).bytes
}

function reserve(bytes: number, files: number): StorageReservation {
  inflight.bytes += bytes
  inflight.files += files
  let released = false
  return {
    release() {
      if (released) return
      released = true
      inflight.bytes -= bytes
      inflight.files -= files
      // A write notes its paths before it returns, so the count includes it
      // once it has applied every note taken by now.
      settling.push({ bytes, files, sequence: storageNoteSequences().noted })
    },
  }
}

/**
 * How far past its limit a person's drawing saves may take a Worktable: 5%
 * of the limit, at most 64 MiB. Enough that nobody loses what they were
 * drawing when the Worktable fills; bounded, so saves can't fill the disk.
 */
export function storageGraceBytes(limit = storageLimitBytes()): number {
  return Math.min(GRACE_MAX_BYTES, Math.round(limit * GRACE_RATIO))
}

/**
 * What a write admits beyond its bytes. `files`: how many of them are
 * people's files, which the limit counts; the rest is history, which only
 * the ceiling counts. All of them unless given. `grace`: it may pass the
 * limit and the ceiling by storageGraceBytes.
 */
export interface StorageAdmission {
  grace?: boolean
  files?: number
}

/**
 * Admit a write that adds `bytes` in all, at the moment it publishes. It
 * never waits, so a caller holding locks may use it. Throws
 * StorageLimitError when there is no room: past the limit for people's
 * files, which pruning history can't help, or past the ceiling, where
 * `retryAfterPruning` makes room and tries again.
 */
export function admitStorageWrite(
  bytes: number,
  options: StorageAdmission = {}
): StorageReservation {
  const files = options.files ?? bytes
  if (!(bytes > 0) && !(files > 0)) return NO_RESERVATION
  const usage = storageUsage()
  if (!usage) return NO_RESERVATION
  const limit = storageLimitBytes()
  const grace = options.grace ? storageGraceBytes(limit) : 0
  const now = used(usage)
  if (files > 0 && now.files + files > limit + grace) {
    throw new StorageLimitError(
      limit,
      now.files,
      storageLimitMessage(limit, now.files > limit ? "over" : "at")
    )
  }
  const ceiling = totalCeiling() + grace
  if (bytes > 0 && now.bytes + bytes > ceiling) {
    // The files fit, but what Worktable keeps with them doesn't, even after
    // pruning: the versions replaces must keep fill the history allowance.
    // That happens only with the files past about 83% of the limit (three
    // times the files, with their current and replaced versions, passes 2.5
    // times the limit), where Settings already says the Worktable is close.
    throw new StorageLimitError(
      limit,
      now.files,
      storageLimitMessage(limit, "close to"),
      bytes,
      ceiling
    )
  }
  return reserve(Math.max(0, bytes), Math.max(0, files))
}

/** Whether `bytes` more, `files` of them people's files, fit now. Reserves nothing. */
export function storageFits(bytes: number, files = bytes): boolean {
  const usage = storageUsage()
  if (!usage) return true
  const now = used(usage)
  return (
    (files <= 0 || now.files + files <= storageLimitBytes()) &&
    (bytes <= 0 || now.bytes + bytes <= totalCeiling())
  )
}

/**
 * Room for a write that adds `adds` bytes and takes away what `replaces`
 * reports, which is read only near the limit. Call it before taking locks:
 * it may wait for pruning. Throws StorageLimitError when there is no room.
 */
export interface StorageRoom {
  /** Bytes the write adds in all. */
  adds: number
  /** Of them, people's files; all of them unless given. */
  files?: number
  /** Bytes it takes away in all, read only near the limit. */
  replaces?: () => Promise<number>
  /** Of them, people's files; `replaces` unless `files` is given. */
  replacesFiles?: () => Promise<number>
}

export async function reserveStorage(room: StorageRoom): Promise<StorageReservation> {
  const files = room.files ?? room.adds
  if (!(room.adds > 0) && !(files > 0)) return NO_RESERVATION
  if (!storageUsage()) await storageCounted()
  const usage = storageUsage()
  if (!usage) return NO_RESERVATION
  if (storageFits(room.adds, files)) {
    return reserve(Math.max(0, room.adds), Math.max(0, files))
  }
  let bytes = room.adds
  let filesBytes = files
  if (room.replaces) bytes -= await room.replaces().catch(() => 0)
  const replacesFiles =
    room.replacesFiles ?? (room.files === undefined ? room.replaces : undefined)
  if (replacesFiles) filesBytes -= await replacesFiles().catch(() => 0)
  if (bytes <= 0 && filesBytes <= 0) return NO_RESERVATION
  return retryAfterPruning(async () =>
    admitStorageWrite(bytes, { files: filesBytes })
  )
}

/** Run `write` with room reserved for it; see `reserveStorage`. */
export async function withStorageRoom<T>(
  room: StorageRoom,
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
  write: (admit: (bytes: number, options?: StorageAdmission) => void) => Promise<T>
): Promise<T> {
  return retryAfterPruning(async () => {
    // Before the first count, start it and wait, rather than admit uncounted.
    if (!storageUsage()) await storageCounted()
    const room: { reservation: StorageReservation | null } = { reservation: null }
    try {
      return await write((bytes, options) => {
        room.reservation?.release()
        room.reservation = admitStorageWrite(bytes, options)
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
    await waitForRoom(error.requestedBytes, error.ceilingBytes)
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
const waiting = new Set<{ bytes: number; ceiling: number }>()
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
  const limit = totalCeiling()
  // Under a lower limit, no headroom: it would be history removed for the
  // lower limit itself.
  const target = kept === null ? Math.round(limit * PRUNE_TARGET_RATIO) : limit
  const used = usedBytes(usage)
  let due = used >= limit ? Math.min(used - target, reclaimable) : 0
  let fitting = 0
  for (const write of waiting) {
    // One that can't fit even if all of it went isn't pruned for.
    if (used + fitting + write.bytes - reclaimable > write.ceiling) continue
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
        // Nothing is pruned before a lower limit is noticed, whether or not
        // a count has looked yet.
        await keptLoaded
        const counted = storageUsage()
        if (counted) followLimit(counted)
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
            settling.push({ bytes: -freed, files: 0, sequence: storageNoteSequences().noted })
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

/**
 * A write of `bytes` waits, a few seconds at most, while pruning makes room
 * for it under `ceiling`: the limit, or past it by the write's allowance.
 */
async function waitForRoom(bytes: number, ceiling: number): Promise<void> {
  if (stopped) return
  const write = { bytes, ceiling }
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

/**
 * After each count: past the limit, from writes on disk too, prune. Under a
 * lower limit, only past what is kept, which use meets as it follows it.
 */
function pruneWhenOver(): void {
  const usage = storageUsage()
  if (!usage) return
  followLimit(usage)
  const used = usedBytes(usage)
  if (kept === null ? used >= storageTotalLimitBytes() : used > kept) void runPruning()
}

/** Start enforcing for the served workspace. Returns its stop. */
export function startStorageLimits(): () => Promise<void> {
  stopped = false
  inflight.bytes = 0
  inflight.files = 0
  settling = []
  waiting.clear()
  known = null
  kept = null
  remembered = null
  void loadPrunedRecord().catch(() => undefined)
  keptLoaded = loadKeptRecord()
    .then((record) => {
      remembered ??= record
    })
    .catch(() => undefined)
  const unsubscribe = onStorageApplied(() => {
    // The first count waits for what was remembered, so a limit lowered
    // while the server was stopped is noticed before anything is pruned.
    if (remembered === null) void keptLoaded.then(pruneWhenOver)
    else pruneWhenOver()
  })
  return async () => {
    unsubscribe()
    stopped = true
    await pruning
    await keptRecordSaved()
  }
}

// ── What Settings shows ─────────────────────────────────────

export interface StorageSummary extends StorageUsage {
  /**
   * `countedBytes`: what counts toward the limit, people's files. `totalBytes`
   * and `totalLimitBytes`: everything but transfers, and the most it may take.
   */
  limit: {
    bytes: number
    warnAt: number
    countedBytes: number
    totalBytes: number
    totalLimitBytes: number
  }
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
      countedBytes: filesBytes(usage),
      totalBytes: countedBytes(usage),
      totalLimitBytes: totalCeiling(),
    },
    pruned: prunedSummary(),
  }
}

// ── Tests ───────────────────────────────────────────────────

/**
 * Set the limit as if it had always been this, so nothing counts as a lower
 * limit; `lowered` keeps what was remembered, so a lower one does.
 */
export function setStorageLimitForTests(
  bytes: number | null,
  options: { promptPruneMs?: number; totalBytes?: number; lowered?: boolean } = {}
): void {
  override = bytes
  totalOverride = options.totalBytes ?? null
  configured = null
  promptPruneMs = options.promptPruneMs ?? PROMPT_PRUNE_MS
  known = null
  if (!options.lowered) {
    kept = null
    remembered = null
  }
}

/** Resolves once pruning started so far has finished. */
export async function storagePruningSettled(): Promise<void> {
  while (pruning) await pruning
}
