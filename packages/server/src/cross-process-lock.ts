import { randomBytes } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"

export interface CrossProcessLockOptions {
  label: string
  staleMs?: number
  retryMs?: number
  timeoutMs?: number
}

const DEFAULT_STALE_MS = 5_000
const DEFAULT_RETRY_MS = 25
const DEFAULT_TIMEOUT_MS = 3_000
const OWNER_FILE = "owner.json"

interface LockOwner {
  pid: number
  nonce: string
  incarnation?: string
}

function operatingSystemProcessIncarnation(
  pid: number
): string | undefined {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      const commandEnd = stat.lastIndexOf(")")
      if (commandEnd < 0) return undefined
      // /proc/<pid>/stat fields after the command start at field 3. Field 22
      // is the process start time in clock ticks since boot.
      const startTicks = stat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/)[19]
      if (!startTicks) return undefined
      let bootId = "current-boot"
      try {
        bootId = readFileSync(
          "/proc/sys/kernel/random/boot_id",
          "utf8"
        ).trim()
      } catch {
        // Start ticks are still an incarnation marker within the current boot.
      }
      return `linux:${bootId}:${startTicks}`
    } catch {
      return undefined
    }
  }
  if (
    process.platform !== "win32" &&
    process.platform !== "android"
  ) {
    try {
      const started = execFileSync(
        "ps",
        ["-p", String(pid), "-o", "lstart="],
        {
          encoding: "utf8",
          timeout: 1_000,
          stdio: ["ignore", "pipe", "ignore"],
        }
      ).trim()
      return started ? `ps:${started}` : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

const PROCESS_INCARNATION =
  operatingSystemProcessIncarnation(process.pid) ??
  `started:${Math.round(Date.now() - process.uptime() * 1_000)}:${randomBytes(12).toString("hex")}`

function readOwner(lockDir: string): LockOwner | undefined {
  try {
    let serialized: string
    try {
      serialized = readFileSync(lockDir, "utf8")
    } catch {
      // Locks created before the atomic-file format stored ownership inside a
      // directory. Keep reading them so upgrades can recover stale locks.
      serialized = readFileSync(join(lockDir, OWNER_FILE), "utf8")
    }
    const value = JSON.parse(
      serialized
    ) as Partial<LockOwner>
    return Number.isSafeInteger(value.pid) &&
      value.pid! > 0 &&
      typeof value.nonce === "string" &&
      value.nonce.length > 0 &&
      (value.incarnation === undefined ||
        (typeof value.incarnation === "string" &&
          value.incarnation.length > 0))
      ? {
          pid: value.pid!,
          nonce: value.nonce,
          ...(value.incarnation
            ? { incarnation: value.incarnation }
            : {}),
        }
      : undefined
  } catch {
    return undefined
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

function sameOwner(
  left: LockOwner | undefined,
  right: LockOwner | undefined
): boolean {
  if (!left || !right) return left === right
  return (
    left.pid === right.pid &&
    left.nonce === right.nonce &&
    left.incarnation === right.incarnation
  )
}

function ownerProcessIsCurrent(owner: LockOwner): boolean {
  if (owner.pid === process.pid) {
    return owner.incarnation === PROCESS_INCARNATION
  }
  if (!owner.incarnation) return processIsAlive(owner.pid)
  const currentIncarnation = operatingSystemProcessIncarnation(owner.pid)
  if (currentIncarnation) {
    return currentIncarnation === owner.incarnation
  }
  // Non-Linux platforms do not expose a portable process birth token. The
  // current process is still protected above, which covers PID-stable service
  // restarts, while other live PIDs retain the conservative legacy behavior.
  return processIsAlive(owner.pid)
}

function quarantineStaleLock(
  lockDir: string,
  observed: LockOwner | undefined
): boolean {
  // Recheck the generation immediately before the atomic rename. Another
  // contender may already have replaced the stale directory.
  if (!sameOwner(readOwner(lockDir), observed)) return false
  const quarantine = `${lockDir}.stale-${process.pid}-${randomBytes(12).toString("hex")}`
  try {
    renameSync(lockDir, quarantine)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }

  const moved = readOwner(quarantine)
  if (!sameOwner(moved, observed)) {
    // We observed a different generation after the rename. Restore it rather
    // than deleting a lock that another process may currently own.
    try {
      renameSync(quarantine, lockDir)
    } catch (restoreError) {
      throw new Error(
        "Cross-process lock ownership changed during stale recovery",
        { cause: restoreError }
      )
    }
    return false
  }
  rmSync(quarantine, { recursive: true, force: true })
  return true
}

function targetAlreadyExists(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === "EEXIST" || code === "ENOTEMPTY"
}

/**
 * Publish a fully initialized ownership file with one atomic hard link. Unlike
 * rename, link refuses to replace an existing path, so acquisition is both
 * complete and exclusive.
 */
export async function acquireCrossProcessLock(
  lockDir: string,
  options: CrossProcessLockOptions
): Promise<() => void> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const retryMs = options.retryMs ?? DEFAULT_RETRY_MS
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const owner: LockOwner = {
    pid: process.pid,
    nonce: randomBytes(16).toString("hex"),
    incarnation: PROCESS_INCARNATION,
  }
  mkdirSync(dirname(lockDir), { recursive: true, mode: 0o700 })
  const candidate = `${lockDir}.candidate-${process.pid}-${owner.nonce}`
  writeFileSync(candidate, JSON.stringify(owner), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  })
  try {
    for (;;) {
      try {
        // A contender may have held the candidate past staleMs. Refresh the
        // inode immediately before publishing it as a new lock generation.
        const now = new Date()
        utimesSync(candidate, now, now)
        linkSync(candidate, lockDir)
        return () => {
          const current = readOwner(lockDir)
          if (sameOwner(current, owner)) {
            rmSync(lockDir, { recursive: true, force: true })
          }
        }
      } catch (error) {
        if (!targetAlreadyExists(error)) throw error
      }

      try {
        if (Date.now() - statSync(lockDir).mtimeMs > staleMs) {
          const current = readOwner(lockDir)
          if (
            (!current || !ownerProcessIsCurrent(current)) &&
            quarantineStaleLock(lockDir, current)
          ) {
            continue
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
      if (Date.now() > deadline) {
        throw new Error(
          `${options.label} is locked by another Worktable process; try again.`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs))
    }
  } finally {
    rmSync(candidate, { force: true })
  }
}

export async function withCrossProcessLock<T>(
  lockDir: string,
  options: CrossProcessLockOptions,
  operation: () => Promise<T>
): Promise<T> {
  const release = await acquireCrossProcessLock(lockDir, options)
  try {
    return await operation()
  } finally {
    release()
  }
}
