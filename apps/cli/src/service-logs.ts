import { fstatSync, statSync } from "node:fs"
import { copyFile, rename, rm, stat, truncate } from "node:fs/promises"
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
 * Rotate a log that another party holds open for appending: shift
 * `log.1`..`log.{keep-1}` up one, copy the log to `log.1`, then truncate it in
 * place. systemd (`append:`), launchd and the process backend all open the
 * file with O_APPEND, so the next write lands at the start of the emptied
 * file. Lines written between the copy and the truncate are lost.
 */
export async function rotateLogIfLarge(
  path: string,
  maxBytes = SERVICE_LOG_MAX_BYTES,
  keep = SERVICE_LOG_KEEP
): Promise<boolean> {
  const size = await stat(path).then(
    (info) => info.size,
    () => 0
  )
  if (size < maxBytes) return false
  await rm(`${path}.${keep}`, { force: true })
  for (let index = keep - 1; index >= 1; index -= 1) {
    await rename(`${path}.${index}`, `${path}.${index + 1}`).catch(() => {})
  }
  await copyFile(path, `${path}.1`)
  await truncate(path, 0)
  return true
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
  let running = false
  const check = () => {
    if (running) return
    running = true
    void Promise.all(
      paths.map((path) => rotateLogIfLarge(path).catch(() => false))
    ).finally(() => {
      running = false
    })
  }
  check()
  const timer = setInterval(check, CHECK_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
