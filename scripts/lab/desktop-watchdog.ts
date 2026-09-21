#!/usr/bin/env bun
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs"

interface WatchdogManifest {
  kind?: unknown
  pid?: unknown
  port?: unknown
  [key: string]: unknown
}

function argument(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function manifestStillOwnsPid(path: string, pid: number): boolean {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as WatchdogManifest
    return value.kind === "worktable.desktop-lab" && value.pid === pid
  } catch {
    return false
  }
}

export function readDesktopPortFile(path: string): number | undefined {
  try {
    const value = Number.parseInt(readFileSync(path, "utf8").trim(), 10)
    return Number.isInteger(value) && value > 0 && value <= 65535
      ? value
      : undefined
  } catch {
    return undefined
  }
}

export function recordDesktopPort(
  manifestPath: string,
  portFile: string,
  pid: number
): number | undefined {
  const port = readDesktopPortFile(portFile)
  if (!port) return undefined
  try {
    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf8")
    ) as WatchdogManifest
    if (manifest.kind !== "worktable.desktop-lab" || manifest.pid !== pid)
      return undefined
    if (manifest.port === port) return port
    const temporary = `${manifestPath}.${process.pid}.tmp`
    writeFileSync(
      temporary,
      `${JSON.stringify({ ...manifest, port }, null, 2)}\n`,
      { mode: 0o600 }
    )
    renameSync(temporary, manifestPath)
    chmodSync(manifestPath, 0o600)
    return port
  } catch {
    return undefined
  }
}

export function commandMatchesExecutable(
  command: string,
  executable: string
): boolean {
  return command.trim() === executable
}

export function desktopPidMatchesExecutable(
  pid: number,
  executable: string
): boolean {
  const result = Bun.spawnSync(
    ["ps", "-ww", "-p", String(pid), "-o", "command="],
    { stdout: "pipe", stderr: "ignore" }
  )
  return (
    result.success &&
    commandMatchesExecutable(result.stdout.toString(), executable)
  )
}

export function processGroupMatchesPid(pid: number, value: string): boolean {
  return Number(value.trim()) === pid
}

function desktopOwnsProcessGroup(pid: number, executable: string): boolean {
  if (!desktopPidMatchesExecutable(pid, executable)) return false
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "pgid="], {
    stdout: "pipe",
    stderr: "ignore",
  })
  return result.success && processGroupMatchesPid(pid, result.stdout.toString())
}

function processGroupIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function main(): Promise<void> {
  const manifest = argument("--manifest")
  const executable = argument("--executable")
  const portFile = argument("--port-file")
  const pid = Number(argument("--pid"))
  const deadline = Number(argument("--deadline"))
  if (
    !manifest ||
    !executable ||
    !portFile ||
    !Number.isSafeInteger(pid) ||
    pid <= 1 ||
    !Number.isSafeInteger(deadline) ||
    deadline <= Date.now()
  )
    throw new Error("Invalid Desktop lab watchdog arguments")

  while (Date.now() < deadline) {
    if (!manifestStillOwnsPid(manifest, pid)) return
    if (!desktopPidMatchesExecutable(pid, executable)) return
    await Bun.sleep(Math.min(1_000, deadline - Date.now()))
  }
  if (!manifestStillOwnsPid(manifest, pid)) return
  if (!desktopOwnsProcessGroup(pid, executable)) return
  recordDesktopPort(manifest, portFile, pid)
  process.kill(-pid, "SIGTERM")

  const forceDeadline = Date.now() + 10_000
  while (Date.now() < forceDeadline) {
    await Bun.sleep(250)
    if (!manifestStillOwnsPid(manifest, pid)) return
    if (!processGroupIsAlive(pid)) return
  }
  if (manifestStillOwnsPid(manifest, pid) && processGroupIsAlive(pid)) {
    recordDesktopPort(manifest, portFile, pid)
    process.kill(-pid, "SIGKILL")
  }
}

if (import.meta.main)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
