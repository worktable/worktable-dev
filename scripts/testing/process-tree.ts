import { execFileSync } from "node:child_process"

export interface ProcessRow {
  pid: number
  parentPid: number
  groupId: number
  state: string
}

export interface KillableProcess {
  pid: number
  kill(signal: NodeJS.Signals): void
}

function processRows(): ProcessRow[] | undefined {
  if (process.platform === "win32") return undefined
  try {
    return execFileSync("ps", ["-eo", "pid=,ppid=,pgid=,stat="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 4)
      .map(([pid, parentPid, groupId, state]) => ({
        pid: Number(pid),
        parentPid: Number(parentPid),
        groupId: Number(groupId),
        state: state!,
      }))
      .filter(
        (row) =>
          Number.isSafeInteger(row.pid) &&
          Number.isSafeInteger(row.parentPid) &&
          Number.isSafeInteger(row.groupId)
      )
  } catch {
    return undefined
  }
}

export function descendantProcessGroups(
  rootPid: number,
  rows: ProcessRow[]
): Set<number> {
  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (!descendants.has(row.pid) && descendants.has(row.parentPid)) {
        descendants.add(row.pid)
        changed = true
      }
    }
  }
  return new Set(
    rows
      .filter((row) => descendants.has(row.pid))
      .map((row) => row.groupId)
      .filter((groupId) => groupId > 1)
  )
}

export function processGroupsContainLiveMember(
  groups: ReadonlySet<number>,
  rows: ProcessRow[]
): boolean {
  return rows.some(
    (row) => groups.has(row.groupId) && !row.state.startsWith("Z")
  )
}

export function processTreeIsAlive(
  pid: number,
  knownGroups: ReadonlySet<number> = new Set([pid])
): boolean {
  if (process.platform === "win32") {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }
  const groups = new Set([pid, ...knownGroups])
  const rows = processRows()
  if (rows) return processGroupsContainLiveMember(groups, rows)
  for (const groupId of groups) {
    try {
      process.kill(-groupId, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return true
    }
  }
  return false
}

export function signalProcessTree(
  processHandle: KillableProcess,
  signal: NodeJS.Signals,
  knownGroups: Set<number> = new Set()
): void {
  try {
    if (process.platform === "win32") {
      execFileSync(
        "taskkill",
        ["/PID", String(processHandle.pid), "/T", "/F"],
        { stdio: "ignore" }
      )
    } else {
      const rows = processRows()
      knownGroups.add(processHandle.pid)
      if (rows) {
        for (const groupId of descendantProcessGroups(
          processHandle.pid,
          rows
        )) {
          knownGroups.add(groupId)
        }
      }
      for (const groupId of knownGroups) {
        try {
          process.kill(-groupId, signal)
        } catch {
          // Another signal may have already finished this process group.
        }
      }
    }
  } catch {
    try {
      processHandle.kill(signal)
    } catch {
      // The process tree may have exited between the liveness check and signal.
    }
  }
}

export async function waitForProcessTreeExit(
  pid: number,
  timeoutMs: number,
  knownGroups: ReadonlySet<number> = new Set([pid])
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs
  while (processTreeIsAlive(pid, knownGroups)) {
    const remaining = deadline - performance.now()
    if (remaining <= 0) return false
    await Bun.sleep(Math.min(25, remaining))
  }
  return true
}
