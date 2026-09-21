import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import {
  processTreeIsAlive,
  signalProcessTree,
  waitForProcessTreeExit,
} from "./process-tree.ts"

export interface Command {
  executable: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  captureStdout?: string
}

export async function runCommand(
  command: Command,
  timeoutMs: number,
  rssPath: string,
  signal?: AbortSignal,
  onFailure?: () => void
): Promise<{
  exitCode: number
  timedOut: boolean
  cancelled: boolean
  peakRssMb?: number
}> {
  if (signal?.aborted) return { exitCode: 1, timedOut: false, cancelled: true }
  const useTime = process.platform === "linux" && existsSync("/usr/bin/time")
  const executable = useTime ? "/usr/bin/time" : command.executable
  const args = useTime
    ? ["-v", "-o", rssPath, "--", command.executable, ...command.args]
    : command.args
  const stdout = command.captureStdout ? "pipe" : "inherit"
  const processHandle = Bun.spawn([executable, ...args], {
    cwd: command.cwd,
    env: { ...process.env, ...command.env },
    detached: true,
    stdin: "inherit",
    stdout,
    stderr: "inherit",
  })
  let sampledPeakRssMb = 0
  const sampleRss = () => {
    sampledPeakRssMb = Math.max(
      sampledPeakRssMb,
      processTreeRssMb(processHandle.pid) ?? 0
    )
  }
  sampleRss()
  const rssTimer = setInterval(sampleRss, 500)
  let timedOut = false
  let cancelled = false
  let failedExit = false
  const trackedProcessGroups = new Set<number>()
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined
  let forceKillSent = false
  let resolveForceKill: (() => void) | undefined
  const forceKillComplete = new Promise<void>((resolveForce) => {
    resolveForceKill = resolveForce
  })
  function terminate() {
    if (forceKillTimer !== undefined) return
    signalProcessTree(processHandle, "SIGTERM", trackedProcessGroups)
    forceKillTimer = setTimeout(() => {
      forceKillSent = true
      signalProcessTree(processHandle, "SIGKILL", trackedProcessGroups)
      resolveForceKill?.()
    }, 5_000)
  }
  const timer = setTimeout(
    () => {
      timedOut = true
      terminate()
      onFailure?.()
    },
    Math.max(1, timeoutMs)
  )
  const onAbort = () => {
    if (!timedOut && !failedExit) cancelled = true
    clearTimeout(timer)
    terminate()
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  if (signal?.aborted) onAbort()
  // Observe failure before buffered stdout or resource/evidence I/O completes.
  const exited = processHandle.exited.then((exitCode) => {
    if (exitCode !== 0 && !timedOut && !cancelled) {
      failedExit = true
      onFailure?.()
    }
    return exitCode
  })
  let captured = ""
  if (command.captureStdout && processHandle.stdout) {
    captured = await new Response(processHandle.stdout).text()
    process.stdout.write(captured)
  }
  const exitCode = await exited
  clearTimeout(timer)
  signal?.removeEventListener("abort", onAbort)
  if (forceKillTimer !== undefined) {
    if (processTreeIsAlive(processHandle.pid, trackedProcessGroups)) {
      await forceKillComplete
    } else {
      clearTimeout(forceKillTimer)
      resolveForceKill?.()
    }
  }
  const processTreeExited =
    (!timedOut && !cancelled) ||
    (!forceKillSent &&
      !processTreeIsAlive(processHandle.pid, trackedProcessGroups)) ||
    (await waitForProcessTreeExit(
      processHandle.pid,
      2_000,
      trackedProcessGroups
    ))
  clearInterval(rssTimer)
  if ((timedOut || cancelled) && !processTreeExited) {
    throw new Error(
      `Terminated suite process group ${processHandle.pid} survived SIGKILL`
    )
  }
  if (command.captureStdout) await writeFile(command.captureStdout, captured)
  let peakRssMb: number | undefined
  if (useTime && existsSync(rssPath)) {
    const text = await Bun.file(rssPath).text()
    const kib = Number(
      text.match(/Maximum resident set size \(kbytes\):\s*(\d+)/)?.[1]
    )
    if (Number.isFinite(kib)) peakRssMb = kib / 1024
  }
  peakRssMb = Math.max(peakRssMb ?? 0, sampledPeakRssMb) || undefined
  return { exitCode, timedOut, cancelled, peakRssMb }
}

export function processTreeRssMb(rootPid: number): number | undefined {
  if (process.platform !== "linux") return undefined
  try {
    const rows = execFileSync("ps", ["-eo", "pid=,ppid=,rss="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(
        (row): row is [number, number, number] =>
          row.length === 3 && row.every(Number.isFinite)
      )
    const tree = new Set([rootPid])
    let added = true
    while (added) {
      added = false
      for (const [pid, parentPid] of rows) {
        if (!tree.has(pid) && tree.has(parentPid)) {
          tree.add(pid)
          added = true
        }
      }
    }
    return (
      rows.reduce(
        (sum, [pid, , rssKib]) => sum + (tree.has(pid) ? rssKib : 0),
        0
      ) / 1024
    )
  } catch {
    return undefined
  }
}
