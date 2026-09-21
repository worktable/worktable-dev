import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { getAppDir } from "./app-storage.ts";
import { VERSION, getReleaseInfo } from "./release-info.ts";

// ============================================================
// Self-update job state machine
// ============================================================
//
// A Worktable update swaps the launcher to point at a freshly-downloaded
// release tree and restarts the background service. Because install.sh stages
// each version under its OWN releases/<version> dir and only rewrites the
// launcher, the download never touches the running server's files — so the work
// happens while the server is alive and only the final restart interrupts it.
//
// The truth about "did it work" is therefore: what version is the freshly
// booted server? That makes a status FILE (not an in-memory job) the right
// model — it survives the restart, and a boot-time reconcile finalizes it. The
// CLI worker (`worktable update --background`) advances the file through its
// phases; the server writes the initial `running` and reconciles on boot.

export type UpdateState =
  | "idle"
  | "running"
  | "restarting"
  | "succeeded"
  | "failed";

export interface UpdateStatus {
  state: UpdateState;
  /** Version the install started from. */
  from?: string;
  /** Requested target ("latest" or a pinned version). */
  to?: string;
  /** ISO timestamp the job started. */
  startedAt?: string;
  /** ISO timestamp the job reached a terminal state. */
  finishedAt?: string;
  /** Failure detail, when state === "failed". */
  error?: string;
  /**
   * True on a `succeeded` marker recorded WITHOUT installing or restarting
   * anything — an update-to-latest that found the install already current. The
   * UI must not treat it as a completed update (no reload); it's an
   * "already up to date" verdict.
   */
  noop?: boolean;
  /**
   * PID of the detached worker process, recorded by the worker itself. Liveness
   * of this PID — not elapsed time — is what tells an in-flight marker apart
   * from a dead one, so a slow download is never timed out and a second
   * installer can't start while the first is still running.
   */
  pid?: number;
  /** Non-secret nonce of the local-authority lock held for service restart. */
  authorityNonce?: string;
  /** OS process-start identity paired with the restart authority lock. */
  authorityOwnerIdentity?: string;
}

const IDLE: UpdateStatus = { state: "idle" };

export function getUpdateStatusPath(): string {
  return join(getAppDir(), "update-status.json");
}

export function readUpdateStatus(): UpdateStatus {
  const path = getUpdateStatusPath();
  if (!existsSync(path)) return IDLE;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as UpdateStatus;
    if (parsed && typeof parsed.state === "string") return parsed;
  } catch {
    // A corrupt marker is not worth crashing over — report idle.
  }
  return IDLE;
}

export function writeUpdateStatus(
  status: UpdateStatus,
  path: string = getUpdateStatusPath()
): void {
  mkdirSync(getAppDir(), { recursive: true });
  // Write-then-rename so a reader never sees a half-written marker.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(status, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

// A non-terminal marker older than this is treated as stale (the worker died
// without recording a verdict and without a restart to trigger boot reconcile),
// so it never permanently blocks a fresh update.
const STALE_AFTER_MS = 10 * 60_000;

function isStale(status: UpdateStatus): boolean {
  if (!status.startedAt) return false;
  const started = Date.parse(status.startedAt);
  if (Number.isNaN(started)) return false;
  return Date.now() - started > STALE_AFTER_MS;
}

/**
 * Reconcile a post-restart marker at server boot. Only `restarting` is
 * reconciled here: it is the one state that asked the service manager for a
 * restart, so a fresh boot carrying it means the restart happened and the
 * update is done. A `running` marker means the worker was still DOWNLOADING —
 * an unrelated restart (KeepAlive, crash, manual) must NOT abort it, and the
 * detached worker may well still be alive, so we leave `running` untouched and
 * let the worker (or staleness) resolve it.
 *
 * Verdict for `restarting`: we booted, so the restart took. The only detectable
 * failure is a build that never came up — provable solely when a PINNED target
 * doesn't match the running version. For `latest` (target unknown until
 * download) and same-version reinstalls (`from === VERSION`) we can't prove
 * failure, and the common case is success, so we record succeeded.
 */
export function reconcileUpdateStatus(): UpdateStatus {
  const status = readUpdateStatus();
  if (status.state !== "restarting") return status;

  const finishedAt = new Date().toISOString();
  const pinnedTargetMissed =
    Boolean(status.to) && status.to !== "latest" && status.to !== VERSION;
  if (pinnedTargetMissed) {
    const failed: UpdateStatus = {
      ...status,
      state: "failed",
      finishedAt,
      error: `Update did not complete; still running ${VERSION}.`,
    };
    writeUpdateStatus(failed);
    return failed;
  }
  const done: UpdateStatus = { ...status, state: "succeeded", finishedAt };
  writeUpdateStatus(done);
  return done;
}

/** Whether the recorded worker PID is still a live process. */
function workerAlive(status: UpdateStatus): boolean {
  if (typeof status.pid !== "number") return false;
  try {
    // Signal 0 probes existence without affecting the process.
    process.kill(status.pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but isn't ours to signal — still alive.
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * The status as the API should report it. A non-terminal marker is settled to
 * `failed` only once its worker is gone — established by the worker's PID no
 * longer being live (it crashed), or, for a marker with no PID recorded, by the
 * staleness window (covers the brief pre-claim race and legacy markers). A
 * worker that is still alive is left in flight no matter how long it takes, so a
 * slow download is never timed out and `startUpdate`'s guard keeps refusing a
 * second installer. Otherwise reads are pass-through.
 */
export function getEffectiveUpdateStatus(): UpdateStatus {
  const status = readUpdateStatus();

  const settleFailed = (): UpdateStatus => {
    const failed: UpdateStatus = {
      ...status,
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: "Update did not complete.",
    };
    writeUpdateStatus(failed);
    return failed;
  };

  if (status.state === "running") {
    // Download phase: a live worker means in flight (never time out); a gone PID
    // means a crash; with no PID we fall back to the time window.
    if (workerAlive(status)) return status;
    const dead = typeof status.pid === "number" || isStale(status);
    return dead ? settleFailed() : status;
  }

  if (status.state === "restarting") {
    // The restart is EXPECTED to kill the worker, so a gone PID here is the
    // SUCCESS path, not a failure — only boot reconcile on the new server (or
    // the worker's own grace-poll) gets to decide. We must not race them by
    // writing `failed` just because the worker is gone, or a good update gets
    // stuck failed. The only settle here is a last-resort timeout for a marker
    // wedged well past any plausible restart (restart never took, no reboot).
    return isStale(status) ? settleFailed() : status;
  }

  return status;
}

function commandOnPath(cmd: string): boolean {
  const path = process.env["PATH"] ?? "";
  for (const dir of path.split(delimiter)) {
    if (dir && existsSync(join(dir, cmd))) return true;
  }
  return false;
}

export interface StartUpdateResult {
  started: boolean;
  status: UpdateStatus;
  reason?: string;
}

// O_EXCL launch lock guarding the check-claim-spawn critical section against
// overlapping POSTs (a double-click, or even a second process). Held only for
// the synchronous launch and then released — the `running` marker is the
// longer-lived guard. A lock left by a crash mid-launch is stolen once stale.
const LOCK_STALE_MS = 30_000;
function launchLockPath(): string {
  return join(getAppDir(), "update.lock");
}
function acquireLaunchLock(): boolean {
  mkdirSync(getAppDir(), { recursive: true });
  const path = launchLockPath();
  const create = (): boolean => {
    const fd = openSync(path, "wx"); // O_CREAT | O_EXCL — atomic
    closeSync(fd);
    return true;
  };
  try {
    return create();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    try {
      if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) {
        rmSync(path, { force: true });
        return create();
      }
    } catch {
      // Lost a race to steal/recreate — treat as held.
    }
    return false;
  }
}
function releaseLaunchLock(): void {
  rmSync(launchLockPath(), { force: true });
}

/**
 * Kick off an update in a detached CLI worker and return immediately. The
 * server owns only the initial `running` write (so the API is consistent the
 * instant POST returns); the worker advances the marker from there.
 */
export function startUpdate(opts: { version?: string }): StartUpdateResult {
  const release = getReleaseInfo();
  if (!release.canUpdate) {
    return {
      started: false,
      status: readUpdateStatus(),
      reason: "This build cannot self-update (no embedded installer or launcher).",
    };
  }

  if (!acquireLaunchLock()) {
    return {
      started: false,
      status: getEffectiveUpdateStatus(),
      reason: "An update is already in progress.",
    };
  }
  try {
    // Effective read settles a stale in-flight marker to failed, so a dead
    // worker never permanently blocks a fresh update here.
    const existing = getEffectiveUpdateStatus();
    if (existing.state === "running" || existing.state === "restarting") {
      return { started: false, status: existing, reason: "An update is already in progress." };
    }

    return launchWorker(opts);
  } finally {
    releaseLaunchLock();
  }
}

function launchWorker(opts: { version?: string }): StartUpdateResult {
  const launcher = process.env["WORKTABLE_LAUNCHER"]!.trim();
  const target = opts.version?.trim() || "latest";
  const status: UpdateStatus = {
    state: "running",
    from: VERSION,
    to: target,
    startedAt: new Date().toISOString(),
  };
  writeUpdateStatus(status);

  const statusPath = getUpdateStatusPath();
  const logDir = join(getAppDir(), "logs");
  mkdirSync(logDir, { recursive: true });
  const logFd = openSync(join(logDir, "update.log"), "a");

  const args = [
    "update",
    ...(target !== "latest" ? [target] : []),
    "--background",
    "--status-file",
    statusPath,
  ];
  // `setsid` (Linux) puts the worker in its own session so the managed-process
  // backend's kill of the old server PID can't take the worker down before it
  // relaunches. On systemd/launchd the service manager owns the restart, so the
  // worker surviving is not required; setsid is simply harmless there.
  const cmd = commandOnPath("setsid") ? ["setsid", launcher, ...args] : [launcher, ...args];

  const child = (() => {
    try {
      return Bun.spawn(cmd, {
        stdin: "ignore",
        stdout: logFd,
        stderr: logFd,
        env: { ...process.env },
      });
    } finally {
      closeSync(logFd);
    }
  })();
  // If the worker dies before recording a verdict (a crash, bad launcher, etc.)
  // without restarting the server, nothing else would clear the `running`
  // marker until it goes stale. A non-zero, still-running exit means failure —
  // record it so the UI unsticks and a retry isn't blocked. The success/restart
  // paths either advance the marker themselves or kill this server first, so
  // this handler is a no-op there.
  child.exited
    .then((code) => {
      if (code === 0) return;
      const current = readUpdateStatus();
      if (current.state === "running") {
        writeUpdateStatus({
          ...current,
          state: "failed",
          finishedAt: new Date().toISOString(),
          error: `Update worker exited (code ${code}) before completing.`,
        });
      }
    })
    .catch(() => {});
  child.unref();

  return { started: true, status };
}
