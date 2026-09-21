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

// ============================================================
// Latest-release check
// ============================================================
//
// Single source of truth for "is a newer Worktable published?". The release
// pipeline uploads a platform-neutral manifest.json next to the tarballs, so
// <releases>/latest/manifest.json answers with the newest published version
// without downloading an artifact. Every surface that mentions updates — the
// CLI's `status` / `update --check` / passive nudge, and the server's
// /api/system/version behind the Settings drawer — reads THIS module, so they
// can never disagree about what "latest" means.
//
// The result is cached in app-private storage (update-check.json) with a TTL.
// Blocking surfaces (status, update --check) refresh it; passive surfaces (the
// CLI nudge printed after ordinary commands) only ever read the cache, so they
// cost zero network and zero latency. The running server keeps the cache warm.

/**
 * Default release base URL. Paired with the same default in scripts/install.sh
 * (`base_url=${WORKTABLE_RELEASE_BASE_URL:-...}`) — change both together.
 */
export const DEFAULT_RELEASE_BASE_URL = "https://worktable.dev/releases"

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

/**
 * Normalize a version string to plain `X.Y.Z` (release tags carry a leading
 * `v`, manifests don't). Null when the input isn't a plain semver triple.
 */
export function normalizeVersion(input: string): string | null {
  const trimmed = input.trim().replace(/^v/i, "")
  return /^\d+\.\d+\.\d+$/.test(trimmed) ? trimmed : null
}

/** Numeric segment comparison of two normalized-able versions. 0 when either is invalid. */
export function compareVersions(a: string, b: string): number {
  const left = normalizeVersion(a)
  const right = normalizeVersion(b)
  if (!left || !right) return 0
  const ls = left.split(".").map(Number)
  const rs = right.split(".").map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (ls[i]! !== rs[i]!) return ls[i]! < rs[i]! ? -1 : 1
  }
  return 0
}

/** True when `candidate` is a strictly newer version than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

export interface UpdateCheckResult {
  /** The running build's version. */
  current: string
  /** Newest published release version (plain X.Y.Z), or null when unknown. */
  latest: string | null
  /** True when `latest` is known and strictly newer than `current`. */
  updateAvailable: boolean
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
  latest?: string
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

    const latest =
      typeof parsed["latest"] === "string"
        ? normalizeVersion(parsed["latest"])
        : null
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

    // A successful answer is useful only as a version/timestamp pair. Failure
    // metadata is independently useful for a first check that never succeeded.
    if ((latest && checkedAt) || lastAttemptAt || lastFailure) {
      return {
        ...(latest && checkedAt ? { latest, checkedAt } : {}),
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
  if (cache.latest && cache.checkedAt) {
    return isFresh(cache, UPDATE_CHECK_TTL_MS) ? "fresh" : "stale"
  }
  return cache.lastFailure ? "failed" : "unchecked"
}

function toResult(
  cache: UpdateCheckCacheFile | null,
  status: UpdateCheckStatus = cacheStatus(cache)
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
 * Fetch the newest published version from <releases>/latest/manifest.json.
 * Best-effort: any network/parse failure returns null, never throws.
 */
type FetchLatestVersionResult =
  | { ok: true; latest: string }
  | { ok: false; failure: UpdateCheckFailure }

async function fetchLatestVersionResult(
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<FetchLatestVersionResult> {
  let response: Response
  try {
    response = await fetch(`${releaseBaseUrl()}/latest/manifest.json`, {
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
    const body = (await response.json()) as { version?: unknown }
    const latest =
      typeof body.version === "string" ? normalizeVersion(body.version) : null
    return latest
      ? { ok: true, latest }
      : { ok: false, failure: "invalid-manifest" }
  } catch {
    return { ok: false, failure: "invalid-manifest" }
  }
}

export async function fetchLatestVersion(
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<string | null> {
  const result = await fetchLatestVersionResult(timeoutMs)
  return result.ok ? result.latest : null
}

interface RefreshOutcome {
  fetch: FetchLatestVersionResult
  result: UpdateCheckResult
  persisted: boolean
}

let inFlightRefresh: Promise<RefreshOutcome> | null = null

async function refreshUpdateCheck(timeoutMs?: number): Promise<RefreshOutcome> {
  if (inFlightRefresh) return inFlightRefresh
  const run = (async (): Promise<RefreshOutcome> => {
    const lastKnown = readCacheFile()
    const lastAttemptAt = new Date().toISOString()
    const fetched = await fetchLatestVersionResult(timeoutMs)
    if (fetched.ok) {
      const fresh: UpdateCheckCacheFile = {
        latest: fetched.latest,
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
            latest: string
            checkedAt: string
          } => Boolean(cache?.latest && cache.checkedAt)
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
        ...(freshestKnown
          ? { latest: freshestKnown.latest, checkedAt: freshestKnown.checkedAt }
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
 * Fetch the newest published version fresh (no TTL) and persist it to the
 * cache on success. For surfaces that are about to act on the answer — the
 * `update` command resolving "latest" — where a stale cached value must never
 * be mistaken for the current truth. Honors the same opt-out and
 * installed-build gates as checkForUpdate; null when gated or when the release
 * server is unreachable, and callers then fall back to installing "latest"
 * blind (the installer contacts the release host either way — this gate is
 * about the metadata check, not the download the user explicitly asked for).
 */
export async function resolveLatestVersion(
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<string | null> {
  if (updateCheckDisabled() || !updateCheckSupported()) return null
  const outcome = await refreshUpdateCheck(timeoutMs)
  return outcome.fetch.ok ? outcome.fetch.latest : null
}

/**
 * The cached answer only — zero network, zero latency. For passive surfaces.
 * Honors the same opt-out/support gates as live checks so stale cache data does
 * not leak into `status` or the passive CLI nudge.
 */
export function getCachedUpdateCheck(): UpdateCheckResult {
  if (updateCheckDisabled()) return toResult(null, "disabled")
  if (!updateCheckSupported()) return toResult(null, "unsupported")
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
    return { result: toResult(null, "unsupported"), persisted: true }
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
