import {
  copyFileSync,
  existsSync,
  fstatSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
} from "node:fs"
import { join } from "node:path"
import { getAppDir } from "@worktable/server/runtime"

/** Rotate a service log once it reaches this size, keeping this many copies. */
export const SERVICE_LOG_MAX_BYTES = 10 * 1024 * 1024
export const SERVICE_LOG_KEEP = 3
const CHECK_INTERVAL_MS = 5 * 60_000

/** Where the background service's stdout and stderr go, on every backend. */
export function getServiceLogPaths(): { stdout: string; stderr: string } {
  const logDir = join(getAppDir(), "logs")
  return {
    stdout: join(logDir, "service.out.log"),
    stderr: join(logDir, "service.err.log"),
  }
}

/**
 * Rotate a log held open for appending: copy it aside, truncate it in place,
 * then shift `log.1`..`log.{keep-1}` up one and make the copy `log.1`.
 * systemd (`append:`), launchd and the process backend all open the file with
 * O_APPEND, so the next write lands at the start of the emptied file. The
 * copy and the truncate run back to back without yielding, so this process,
 * the log's writer, cannot log in between; a failed copy changes nothing.
 */
export function rotateLogIfLarge(
  path: string,
  maxBytes = SERVICE_LOG_MAX_BYTES,
  keep = SERVICE_LOG_KEEP
): boolean {
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    return false
  }
  if (size < maxBytes) return false
  const copy = `${path}.rotating`
  // A copy left by an interrupted rotation is the only copy of its lines.
  if (existsSync(copy)) keepCopy(path, copy, keep)
  copyFileSync(path, copy)
  truncateSync(path, 0)
  keepCopy(path, copy, keep)
  return true
}

/** Shift `log.1`..`log.{keep-1}` up one and make the copy `log.1`. */
function keepCopy(path: string, copy: string, keep: number): void {
  rmSync(`${path}.${keep}`, { force: true })
  for (let index = keep - 1; index >= 1; index -= 1) {
    try {
      renameSync(`${path}.${index}`, `${path}.${index + 1}`)
    } catch (error) {
      // Fewer copies exist yet; any other failure stops before a copy is lost.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  renameSync(copy, `${path}.1`)
}

/** Whether a file descriptor writes to the file at this path. */
function writesTo(fd: number, path: string): boolean {
  try {
    const open = fstatSync(fd)
    const file = statSync(path)
    return open.isFile() && open.dev === file.dev && open.ino === file.ino
  } catch {
    return false
  }
}

/**
 * When this process is the background service, its stdout and stderr are the
 * service logs, which no service manager rotates. Check their size now and
 * every few minutes, off the request path. Elsewhere this does nothing.
 */
export function startServiceLogRotation(): () => void {
  const logs = getServiceLogPaths()
  const paths = [
    ...(writesTo(1, logs.stdout) ? [logs.stdout] : []),
    ...(writesTo(2, logs.stderr) ? [logs.stderr] : []),
  ]
  if (paths.length === 0) return () => {}
  const check = () => {
    for (const path of paths) {
      try {
        rotateLogIfLarge(path)
      } catch {
        // Try again at the next check.
      }
    }
  }
  check()
  const timer = setInterval(check, CHECK_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
