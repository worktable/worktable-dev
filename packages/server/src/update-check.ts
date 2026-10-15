import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { getAppDir } from "./app-storage.ts"
import { VERSION } from "./release-info.ts"
import { getServerSettings } from "./settings-store.ts"
import {
  isNewerVersion,
  isUpdateChannel,
  normalizeVersion,
  resolveChannelTarget,
  type ChannelTarget,
  type UpdateChannel,
} from "./release-channels.ts"

// ============================================================
// Release-channel check
// ============================================================
//
// Single source of truth for "is a newer Worktable offered?". The team
// publishes <releases>/channels.json, a small manifest naming the current
// version of each release channel and whether that channel is held. Every
// surface that mentions updates — the CLI's `status` / `update --check` /
// passive nudge, `worktable update` itself, and the server's
// /api/system/version behind the Settings drawer — reads THIS module, so they
// can never disagree about what "latest" means, and holding a channel stops
// all of them from offering its version.
//
// The result is cached in app-private storage (update-check.json) with a TTL.
// Blocking surfaces (status, update --check) refresh it; passive surfaces (the
// CLI nudge printed after ordinary commands) only ever read the cache, so they
// cost zero network and zero latency. The running server keeps the cache warm.
// Installing always fetches the manifest again: when it is unreachable,
// Worktable keeps the version it runs.

/**
 * Default release base URL. Paired with the same default in scripts/install.sh
 * (`base_url=${WORKTABLE_RELEASE_BASE_URL:-...}`) — change both together.
 */
export const DEFAULT_RELEASE_BASE_URL = "https://worktable.dev/releases"

/** The manifest file under the release base URL. */
export const RELEASE_CHANNELS_FILE = "channels.json"

/** How long a cached answer stays fresh before the next check refetches. */
export const UPDATE_CHECK_TTL_MS = 6 * 60 * 60_000

const DEFAULT_FETCH_TIMEOUT_MS = 5_000

/** Retry cadence after consecutive background failures. */
export const UPDATE_CHECK_RETRY_DELAYS_MS = [
  15 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
] as const

export function releaseBaseUrl(): string {
  return (
    process.env["WORKTABLE_RELEASE_BASE_URL"]?.trim() ||
    DEFAULT_RELEASE_BASE_URL
  )
}

/** Opt-out: a non-empty WORKTABLE_NO_UPDATE_CHECK disables all network checks. */
export function updateCheckDisabled(): boolean {
  return Boolean(process.env["WORKTABLE_NO_UPDATE_CHECK"]?.trim())
}

/**
 * Only installed release builds check for updates. The installer's launcher
 * stamps WORKTABLE_VERSION; source checkouts and test processes don't have it,
 * so they never phone home (and their "0.0.1" fallback version would make the
 * comparison meaningless anyway).
 */
export function updateCheckSupported(): boolean {
  return Boolean(process.env["WORKTABLE_VERSION"]?.trim())
}

export {
  compareVersions,
  isNewerVersion,
  isUpdateChannel,
  normalizeVersion,
  releaseTagForVersion,
  resolveChannelTarget,
  UPDATE_CHANNELS,
  type ChannelTarget,
  type UpdateChannel,
} from "./release-channels.ts"

// ── The channel this install follows ────────────────────────────────────────

const CHANNEL_FILE = "release-channel.json"

export function getUpdateChannelPath(): string {
  return join(getAppDir(), CHANNEL_FILE)
}

/**
 * The channel this install follows. Machine-local, read fresh on every check
 * so a change from the CLI reaches a running server without a restart. Anything
 * unreadable follows stable.
 */
export function getUpdateChannel(): UpdateChannel {
  try {
    const parsed = JSON.parse(readFileSync(getUpdateChannelPath(), "utf8")) as {
      channel?: unknown
    }
    return isUpdateChannel(parsed?.channel) ? parsed.channel : "stable"
  } catch {
    return "stable"
  }
}

export function setUpdateChannel(channel: UpdateChannel): void {
  mkdirSync(getAppDir(), { recursive: true })
  const path = getUpdateChannelPath()
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify({ channel }, null, 2) + "\n", {
      mode: 0o600,
    })
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

export interface UpdateCheckResult {
  /** The running build's version. */
  current: string
  /**
   * Newest version the followed channel offers, or null when unknown or when
   * the channel offers nothing (it is held).
   */
  latest: string | null
  /** True when `latest` is known and strictly newer than `current`. */
  updateAvailable: boolean
  /** The release channel this install follows; null when it doesn't check. */
  channel: UpdateChannel | null
  /** Whether the followed channel is held, as of the last successful check. */
  held: boolean
  /** ISO timestamp of the successful check that produced `latest`. */
  checkedAt: string | null
  /** ISO timestamp of the most recent network attempt, successful or not. */
  lastAttemptAt: string | null
  /** Server-calculated time remaining before a fresh answer expires. */
  checkTtlRemainingMs: number | null
  /** Whether the last-known release answer can currently be trusted. */
  checkStatus: UpdateCheckStatus
}

export type UpdateCheckStatus =
  | "unchecked"
  | "fresh"
  | "stale"
  | "failed"
  | "disabled"
  | "unsupported"
  | "managed"

type UpdateCheckFailure = "timeout" | "network" | "http" | "invalid-manifest"

interface UpdateCheckCacheFile {
  /** The channel the answer belongs to; answers for another channel are ignored. */
  channel?: UpdateChannel
  latest?: string
  held?: boolean
  checkedAt?: string
  lastAttemptAt?: string
  lastFailure?: UpdateCheckFailure
}

const CACHE_LOCK_RETRY_MS = 25
const CACHE_LOCK_TIMEOUT_MS = 3_000
let cacheLockWaitHookForTests: (() => void) | null = null

export function setUpdateCheckCacheLockWaitHookForTests(
  hook: (() => void) | null
): void {
  cacheLockWaitHookForTests = hook
}

export function getUpdateCheckCachePath(): string {
  return join(getAppDir(), "update-check.json")
}

function sqliteLockBusy(error: unknown): boolean {
  return (
    error instanceof Error &&
    (("code" in error && error.code === "SQLITE_BUSY") ||
      error.message.toLowerCase().includes("database is locked"))
  )
}

/**
 * Serialize cache transactions with SQLite's process-safe write lock. The OS
 * releases it with the connection when a process exits, so no stale lock needs
 * to be detected, stolen, or deleted by a waiter.
 */
async function acquireCacheLock(): Promise<() => void> {
  mkdirSync(getAppDir(), { recursive: true })
  const lockDb = new Database(`${getUpdateCheckCachePath()}.lock.sqlite`, {
    create: true,
  })
  const deadline = Date.now() + CACHE_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      lockDb.exec("BEGIN IMMEDIATE")
      let released = false
      return () => {
        if (released) return
        released = true
        try {
          lockDb.exec("COMMIT")
        } finally {
          lockDb.close()
        }
      }
    } catch (error) {
      if (!sqliteLockBusy(error)) {
        lockDb.close()
        throw error
      }
      if (Date.now() > deadline) {
        lockDb.close()
        throw new Error("The update-check cache is locked by another process.")
      }
      cacheLockWaitHookForTests?.()
      await new Promise((resolve) => setTimeout(resolve, CACHE_LOCK_RETRY_MS))
    }
  }
}

async function withCacheLock<T>(operation: () => T): Promise<T> {
  const release = await acquireCacheLock()
  try {
    return operation()
  } finally {
    release()
  }
}

function readCacheFile(): UpdateCheckCacheFile | null {
  const path = getUpdateCheckCachePath()
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >
    if (!parsed || typeof parsed !== "object") return null

    // An answer for a different channel (or from before channels existed)
    // says nothing about this one: behave as if never checked.
    if (parsed["channel"] !== getUpdateChannel()) return null
    const channel = parsed["channel"] as UpdateChannel
    const latest =
      typeof parsed["latest"] === "string"
        ? normalizeVersion(parsed["latest"])
        : null
    const held = parsed["held"] === true
    const checkedAt =
      typeof parsed["checkedAt"] === "string" &&
      !Number.isNaN(Date.parse(parsed["checkedAt"]))
        ? parsed["checkedAt"]
        : undefined
    const lastAttemptAt =
      typeof parsed["lastAttemptAt"] === "string" &&
      !Number.isNaN(Date.parse(parsed["lastAttemptAt"]))
        ? parsed["lastAttemptAt"]
        : undefined
    const rawFailure = parsed["lastFailure"]
    const lastFailure =
      rawFailure === "timeout" ||
      rawFailure === "network" ||
      rawFailure === "http" ||
      rawFailure === "invalid-manifest"
        ? rawFailure
        : undefined

    // A successful answer needs its timestamp; it may offer no version (a
    // held channel). Failure metadata is independently useful for a first
    // check that never succeeded.
    if (checkedAt || lastAttemptAt || lastFailure) {
      return {
        channel,
        ...(checkedAt
          ? { ...(latest ? { latest } : {}), held, checkedAt }
          : {}),
        ...(lastAttemptAt ? { lastAttemptAt } : {}),
        ...(lastFailure ? { lastFailure } : {}),
      }
    }
  } catch {
    // A corrupt cache is not worth an error — behave as if never checked.
  }
  return null
}

function writeCacheFile(cache: UpdateCheckCacheFile): void {
  mkdirSync(getAppDir(), { recursive: true })
  const path = getUpdateCheckCachePath()
  // Write-then-rename so a concurrent reader never sees a half-written file.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(cache, null, 2), { mode: 0o600 })
    renameSync(tmp, path)
  } finally {
    // rename removes the source on success; force cleanup covers a failed write
    // or a cross-process race without masking the original error.
    rmSync(tmp, { force: true })
  }
}

function tryWriteCacheFile(cache: UpdateCheckCacheFile): boolean {
  try {
    writeCacheFile(cache)
    return true
  } catch {
    // The check result is still useful to its caller when machine-local cache
    // storage is temporarily read-only or full.
    return false
  }
}

function currentVersion(): string {
  return process.env["WORKTABLE_VERSION"]?.trim() || VERSION
}

function cacheStatus(cache: UpdateCheckCacheFile | null): UpdateCheckStatus {
  if (!cache) return "unchecked"
  const attempted = cache.lastAttemptAt
    ? Date.parse(cache.lastAttemptAt)
    : Number.NaN
  const checked = cache.checkedAt ? Date.parse(cache.checkedAt) : Number.NaN
  if (
    cache.lastFailure &&
    (Number.isNaN(checked) ||
      (!Number.isNaN(attempted) && attempted >= checked))
  ) {
    return "failed"
  }
  if (cache.checkedAt) {
    return isFresh(cache, UPDATE_CHECK_TTL_MS) ? "fresh" : "stale"
  }
  return cache.lastFailure ? "failed" : "unchecked"
}

function toResult(
  cache: UpdateCheckCacheFile | null,
  status: UpdateCheckStatus = cacheStatus(cache),
  channel: UpdateChannel | null = getUpdateChannel()
): UpdateCheckResult {
  const current = currentVersion()
  const latest = cache?.latest ? normalizeVersion(cache.latest) : null
  const checkedAt = cache?.checkedAt ?? null
  const checkedAtMs = checkedAt ? Date.parse(checkedAt) : Number.NaN
  const checkTtlRemainingMs =
    status === "fresh" && Number.isFinite(checkedAtMs)
      ? Math.max(0, UPDATE_CHECK_TTL_MS - (Date.now() - checkedAtMs))
      : null
  return {
    current,
    latest,
    updateAvailable: Boolean(latest && isNewerVersion(latest, current)),
    channel,
    held: Boolean(checkedAt && cache?.held),
    checkedAt,
    lastAttemptAt: cache?.lastAttemptAt ?? cache?.checkedAt ?? null,
    checkTtlRemainingMs,
    checkStatus: status,
  }
}

function isFresh(cache: UpdateCheckCacheFile, ttlMs: number): boolean {
  if (!cache.checkedAt) return false
  const checked = Date.parse(cache.checkedAt)
  if (Number.isNaN(checked)) return false
  const age = Date.now() - checked
  // A future timestamp (clock skew, restored backup) is treated as stale.
  return age >= 0 && age < ttlMs
}

/**
 * Fetch <releases>/channels.json and resolve the target for `channel`.
 * Best-effort: any network/parse failure is returned, never thrown.
 */
type FetchTargetResult =
  | { ok: true; target: ChannelTarget }
  | { ok: false; failure: UpdateCheckFailure }

async function fetchChannelTarget(
  channel: UpdateChannel,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<FetchTargetResult> {
  let response: Response
  try {
    response = await fetch(`${releaseBaseUrl()}/${RELEASE_CHANNELS_FILE}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ""
    return {
      ok: false,
      failure:
        name === "TimeoutError" || name === "AbortError"
          ? "timeout"
          : "network",
    }
  }
  if (!response.ok) return { ok: false, failure: "http" }
  try {
    const target = resolveChannelTarget(await response.json(), channel)
    return target
      ? { ok: true, target }
      : { ok: false, failure: "invalid-manifest" }
  } catch {
    return { ok: false, failure: "invalid-manifest" }
  }
}

interface RefreshOutcome {
  fetch: FetchTargetResult
  result: UpdateCheckResult
  persisted: boolean
}

let inFlightRefresh: Promise<RefreshOutcome> | null = null

async function refreshUpdateCheck(timeoutMs?: number): Promise<RefreshOutcome> {
  if (inFlightRefresh) return inFlightRefresh
  const run = (async (): Promise<RefreshOutcome> => {
    const channel = getUpdateChannel()
    const lastKnown = readCacheFile()
    const lastAttemptAt = new Date().toISOString()
    const fetched = await fetchChannelTarget(channel, timeoutMs)
    if (fetched.ok) {
      const fresh: UpdateCheckCacheFile = {
        channel,
        ...(fetched.target.version ? { latest: fetched.target.version } : {}),
        held: fetched.target.held,
        checkedAt: new Date().toISOString(),
        lastAttemptAt,
      }
      let persisted = false
      try {
        persisted = await withCacheLock(() => tryWriteCacheFile(fresh))
      } catch {
        // A busy/read-only cache must not hide a useful network result.
      }
      return {
        fetch: fetched,
        result: toResult(fresh, "fresh"),
        persisted,
      }
    }
    // Another Worktable process may have completed a successful check while
    // this request was in flight. Re-read immediately before the failure write
    // and preserve the newest successful answer instead of restoring the
    // pre-request snapshot over it.
    const mergeFailure = (): UpdateCheckCacheFile => {
      // This read and the following atomic rename share the cross-process lock,
      // so no successful writer can land between them and then be replaced.
      const currentCache = readCacheFile()
      const freshestKnown = [lastKnown, currentCache]
        .filter(
          (
            cache
          ): cache is UpdateCheckCacheFile & {
            checkedAt: string
          } => Boolean(cache?.checkedAt)
        )
        .sort(
          (left, right) =>
            Date.parse(right.checkedAt) - Date.parse(left.checkedAt)
        )[0]
      const newestAttempt = [lastKnown, currentCache]
        .flatMap((cache) => {
          const attemptedAt = cache?.lastAttemptAt ?? cache?.checkedAt
          return attemptedAt
            ? [{ attemptedAt, failure: cache?.lastFailure }]
            : []
        })
        .concat([{ attemptedAt: lastAttemptAt, failure: fetched.failure }])
        .sort(
          (left, right) =>
            Date.parse(right.attemptedAt) - Date.parse(left.attemptedAt)
        )[0]!
      return {
        channel,
        ...(freshestKnown
          ? {
              ...(freshestKnown.latest ? { latest: freshestKnown.latest } : {}),
              held: Boolean(freshestKnown.held),
              checkedAt: freshestKnown.checkedAt,
            }
          : {}),
        lastAttemptAt: newestAttempt.attemptedAt,
        ...(newestAttempt.failure
          ? { lastFailure: newestAttempt.failure }
          : {}),
      }
    }
    let failed: UpdateCheckCacheFile
    let persisted = false
    try {
      failed = await withCacheLock(() => {
        const merged = mergeFailure()
        persisted = tryWriteCacheFile(merged)
        return merged
      })
    } catch {
      // Preserve the caller-visible result without risking an unlocked write.
      failed = mergeFailure()
    }
    return { fetch: fetched, result: toResult(failed), persisted }
  })()
  inFlightRefresh = run
  try {
    return await run
  } finally {
    if (inFlightRefresh === run) inFlightRefresh = null
  }
}

/**
 * What an install should move to right now, from a fresh manifest (no TTL).
 * For surfaces about to act on the answer — `worktable update` and the in-app
 * updater — where a cached value must never stand in for the current truth:
 * a channel held since the last check must stop the install. The result is
 * persisted to the cache on success.
 *
 * Installing fails closed: when the manifest can't be read, callers keep the
 * running version. This is the update the user asked for, so it is not gated
 * by the passive-check opt-out; source builds have no installer to run.
 */
export type UpdateTarget =
  | { kind: "available"; version: string; channel: UpdateChannel }
  | { kind: "current"; version: string | null; channel: UpdateChannel }
  | { kind: "held"; channel: UpdateChannel }
  | { kind: "unreachable"; channel: UpdateChannel }

export async function resolveUpdateTarget(
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<UpdateTarget> {
  const outcome = await refreshUpdateCheck(timeoutMs)
  const channel = getUpdateChannel()
  if (!outcome.fetch.ok) return { kind: "unreachable", channel }
  const { version, held } = outcome.fetch.target
  if (version && isNewerVersion(version, currentVersion())) {
    return { kind: "available", version, channel }
  }
  return held
    ? { kind: "held", channel }
    : { kind: "current", version, channel }
}

/**
 * The cached answer only — zero network, zero latency. For passive surfaces.
 * Honors the same opt-out/support gates as live checks so stale cache data does
 * not leak into `status` or the passive CLI nudge.
 */
export function getCachedUpdateCheck(): UpdateCheckResult {
  // Checks may be off, but `worktable update` still follows the channel, so
  // keep showing it; source builds have no channel to follow.
  if (updateCheckDisabled()) return toResult(null, "disabled")
  if (!updateCheckSupported()) return toResult(null, "unsupported", null)
  return toResult(readCacheFile())
}

/**
 * The cached answer, refreshed over the network when stale (or on `force`).
 * Never throws. No network at all when the check is disabled or this isn't an
 * installed release build, and stale cache data is ignored while gated. On
 * fetch failure after the gates pass, the stale cache (if any) is returned
 * rather than erased.
 */
export async function checkForUpdate(opts?: {
  force?: boolean
  timeoutMs?: number
  ttlMs?: number
}): Promise<UpdateCheckResult> {
  return (await checkForUpdateOutcome(opts)).result
}

async function checkForUpdateOutcome(opts?: {
  force?: boolean
  timeoutMs?: number
  ttlMs?: number
}): Promise<{ result: UpdateCheckResult; persisted: boolean }> {
  if (updateCheckDisabled()) {
    return { result: toResult(null, "disabled"), persisted: true }
  }
  if (!updateCheckSupported()) {
    return { result: toResult(null, "unsupported", null), persisted: true }
  }
  const cached = readCacheFile()
  const ttlMs = opts?.ttlMs ?? UPDATE_CHECK_TTL_MS
  if (!opts?.force && cached && isFresh(cached, ttlMs)) {
    return { result: toResult(cached), persisted: true }
  }
  const refreshed = await refreshUpdateCheck(opts?.timeoutMs)
  return { result: refreshed.result, persisted: refreshed.persisted }
}

/**
 * The BACKGROUND/scheduled update check (server warm-cache interval). Honors two
 * opt-outs of different strengths:
 *   - WORKTABLE_NO_UPDATE_CHECK (env) → kills ALL checks, incl. manual, enforced
 *     inside checkForUpdate. Strongest.
 *   - settings.updates.autoCheck === false → disables only these background
 *     checks; the manual paths (GET /version, explicit CLI check) call
 *     checkForUpdate directly and are unaffected.
 * Reads the setting fresh on each call so a Settings toggle takes effect without
 * a restart. Never throws.
 */
export type BackgroundUpdateCheckOutcome = "succeeded" | "failed" | "skipped"

export async function backgroundUpdateCheck(opts?: {
  force?: boolean
  ttlMs?: number
}): Promise<BackgroundUpdateCheckOutcome> {
  try {
    if (!getServerSettings().updates.autoCheck) return "skipped"
    const outcome = await checkForUpdateOutcome({
      force: opts?.force,
      ttlMs: opts?.ttlMs,
    })
    return outcome.result.checkStatus === "failed" || !outcome.persisted
      ? "failed"
      : "succeeded"
  } catch {
    // A read-only or full app-data directory must not kill the scheduler.
    return "failed"
  }
}

export interface UpdateCheckSchedulerOptions {
  intervalMs?: number
  retryDelaysMs?: readonly number[]
  schedule?: (
    callback: () => void,
    delayMs: number
  ) => ReturnType<typeof setTimeout>
  cancel?: (timer: ReturnType<typeof setTimeout>) => void
  now?: () => number
}

/**
 * Start one non-overlapping background scheduler. The delay is measured from
 * completion, not startup, so a successful check really runs every six hours
 * instead of every other six-hour interval.
 */
export function startBackgroundUpdateCheckScheduler(
  opts: UpdateCheckSchedulerOptions = {}
): () => Promise<void> {
  const intervalMs = opts.intervalMs ?? UPDATE_CHECK_TTL_MS
  const retryDelays = opts.retryDelaysMs?.length
    ? opts.retryDelaysMs
    : UPDATE_CHECK_RETRY_DELAYS_MS
  const schedule: NonNullable<UpdateCheckSchedulerOptions["schedule"]> =
    opts.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancel: NonNullable<UpdateCheckSchedulerOptions["cancel"]> =
    opts.cancel ?? ((timer) => clearTimeout(timer))
  const now = opts.now ?? Date.now
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let activeRun: Promise<void> | null = null
  let failureIndex = 0
  let initialRun = true

  const run = async (): Promise<void> => {
    if (stopped) return
    const force = !initialRun
    initialRun = false
    // Startup honors a cache that is still valid for this scheduler interval.
    // Timed runs and retries force a real attempt so failures cannot be masked
    // by an older successful answer.
    const outcome = await backgroundUpdateCheck({ force, ttlMs: intervalMs })
    if (stopped) return
    let delay = intervalMs
    if (outcome === "failed") {
      delay = retryDelays[Math.min(failureIndex, retryDelays.length - 1)]!
      failureIndex += 1
    } else {
      failureIndex = 0
      if (!force && outcome === "succeeded") {
        const cached = getCachedUpdateCheck()
        const checkedAt = cached.checkedAt
          ? Date.parse(cached.checkedAt)
          : Number.NaN
        if (cached.checkStatus === "fresh" && Number.isFinite(checkedAt)) {
          const age = Math.max(0, now() - checkedAt)
          delay = Math.max(1, intervalMs - age)
        }
      }
    }
    timer = schedule(launch, delay)
  }

  const launch = (): void => {
    if (stopped || activeRun) return
    const current = run()
    activeRun = current
    void current.then(
      () => {
        if (activeRun === current) activeRun = null
      },
      () => {
        if (activeRun === current) activeRun = null
      }
    )
  }

  launch()
  return async () => {
    stopped = true
    if (timer) cancel(timer)
    timer = null
    await activeRun
  }
}
