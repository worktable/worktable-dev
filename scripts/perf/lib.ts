/**
 * Shared helpers for the perf lane: arguments, seeded randomness, percentiles,
 * fixture copies and a server process. No product code depends on this file.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { cpSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { basename, join, resolve } from "node:path"

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..")
export const PERF_ROOT = join(REPO_ROOT, ".local-dev", "perf")

/** `--name value` and `--flag` arguments; repeated names keep the last value. */
export function parseArgs(argv: string[]): Map<string, string> {
  const args = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]!
    if (!name.startsWith("--")) throw new Error(`unexpected argument: ${name}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith("--"))
      args.set(name.slice(2), "true")
    else {
      args.set(name.slice(2), value)
      index += 1
    }
  }
  return args
}

export function numberArg(
  args: Map<string, string>,
  name: string,
  fallback: number
): number {
  const raw = args.get(name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`--${name} must be a positive number`)
  return value
}

/** Small seeded generator (mulberry32): the same seed gives the same fixture. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Nearest-rank percentile, as in scripts/testing/history.ts. */
export function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]!
}

export function median(values: number[]): number | null {
  return percentile(values, 0.5)
}

export function round(value: number | null, digits = 1): number | null {
  if (value === null) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

export function markdownTable(
  header: string[],
  rows: (string | number | null)[][]
): string {
  const cell = (value: string | number | null) =>
    value === null ? "n/a" : String(value)
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n")
}

/**
 * Where a fixture is generated and where every run restores it. The server
 * keys machine-local state by workspace path (activity history, the records
 * index, Yjs state), so runs must use the path the fixture was built at to
 * start like a restart rather than a first boot.
 */
export function runDirFor(fixtureDir: string): string {
  return join(PERF_ROOT, "runs", basename(fixtureDir))
}

/** Replace `runDir` with a fresh copy of a fixture's workspace and app data. */
export function restoreFixture(
  fixtureDir: string,
  runDir = runDirFor(fixtureDir)
): { workspace: string; app: string } {
  rmSync(runDir, { recursive: true, force: true })
  const copy = (from: string, to: string) =>
    cpSync(from, to, { recursive: true, preserveTimestamps: true })
  const workspace = join(runDir, "workspace")
  const app = join(runDir, "app")
  copy(join(fixtureDir, "workspace"), workspace)
  copy(join(fixtureDir, "app"), app)
  return { workspace, app }
}

/**
 * GET with a timeout. A failure or an error status throws, naming the URL, so
 * a broken server fails the run instead of producing fast-looking numbers.
 * The default stays under the server's 120-second idle timeout, after which
 * it drops the connection anyway.
 */
export async function get(url: string, timeoutMs = 110_000): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    throw new Error(`GET ${url} failed: ${(error as Error).message}`)
  }
  if (!response.ok) throw new Error(`GET ${url} returned ${response.status}`)
  return response
}

/**
 * Request /health every `intervalMs` until stopped. Its latency is how long a
 * trivial request waits for the server's request loop.
 */
export function healthSampler(
  url: string,
  intervalMs: number
): { stop: () => Promise<number[]> } {
  const latencies: number[] = []
  let running = true
  const loop = (async () => {
    while (running) {
      const started = performance.now()
      await (await get(`${url}/health`, 30_000)).arrayBuffer()
      latencies.push(performance.now() - started)
      await Bun.sleep(Math.max(0, intervalMs - (performance.now() - started)))
    }
  })()
  // Reported by stop(); never an unhandled rejection in the meantime.
  loop.catch(() => {})
  return {
    stop: async () => {
      running = false
      await loop
      return latencies
    },
  }
}

export interface ProcessCounters {
  writeBytes: number
  diskBytes: number
  cpuMs: number
}

/** Linux only: bytes written and CPU time of a process, from /proc. */
export function processCounters(pid: number): ProcessCounters | null {
  try {
    const io = Object.fromEntries(
      readFileSync(`/proc/${pid}/io`, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(": ") as [string, string])
    )
    // Fields after the command name, which is parenthesized and may contain spaces.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
      .split(") ")[1]!
      .split(" ")
    const ticksPerSecond = 100
    return {
      writeBytes: Number(io["wchar"]),
      diskBytes: Number(io["write_bytes"]),
      cpuMs: ((Number(stat[11]) + Number(stat[12])) * 1000) / ticksPerSecond,
    }
  } catch {
    return null
  }
}

/**
 * Wait until a process stays under 5% CPU for two seconds, so steady-state
 * timings are not mixed with boot work such as index rebuilds. "unknown"
 * where /proc is unavailable; "busy" when `limitMs` passes first.
 */
export async function waitForIdle(
  pid: number,
  limitMs: number
): Promise<"idle" | "busy" | "unknown"> {
  const deadline = performance.now() + limitMs
  let last = processCounters(pid)?.cpuMs
  if (last === undefined) return "unknown"
  while (performance.now() < deadline) {
    await Bun.sleep(2_000)
    const now = processCounters(pid)?.cpuMs
    if (now === undefined) return "unknown"
    if (now - last < 100) return "idle"
    last = now
  }
  return "busy"
}

/** Linux only: the first descendant of `pid` whose command name is `name`. */
export function descendantNamed(pid: number, name: string): number | null {
  const queue = [pid]
  while (queue.length > 0) {
    const current = queue.shift()!
    let children: number[] = []
    try {
      children = readFileSync(
        `/proc/${current}/task/${current}/children`,
        "utf8"
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
    } catch {
      return null
    }
    for (const child of children) {
      try {
        if (readFileSync(`/proc/${child}/comm`, "utf8").trim() === name)
          return child
      } catch {
        // Exited.
      }
      queue.push(child)
    }
  }
  return null
}

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string")
        return reject(new Error("no port"))
      server.close(() => resolvePort(address.port))
    })
  })
}

export interface ServerProcess {
  url: string
  /** The Bun server's pid, also when it runs under a wrapper such as strace. */
  pid: number
  /** Milliseconds from spawn until the server printed its listening line. */
  listenMs: number
  startedAt: number
  output: () => string
  stop: () => Promise<void>
}

/**
 * Start `packages/server/src/index.ts` from a checkout against a workspace.
 * Resolves once the server prints its listening line.
 */
export async function startServer(options: {
  checkout: string
  workspace: string
  app: string
  /** Extra environment, such as WORKTABLE_STATIC_DIR for a web build. */
  env?: Record<string, string>
  /** Bun options before the entry point, such as `--preload <file>`. */
  bunArgs?: string[]
  /** A command that runs the server as its child, such as `strace -f -o …`. */
  wrapper?: string[]
}): Promise<ServerProcess> {
  const port = await freePort()
  // Keep the caller's Worktable settings (tokens, auth, paths) out of the run.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("WORKTABLE_") && name !== "REQUIRE_AUTH"
    )
  )
  const startedAt = performance.now()
  const command = [
    ...(options.wrapper ?? []),
    "bun",
    ...(options.bunArgs ?? []),
    "src/index.ts",
  ]
  const child: ChildProcess = spawn(command[0]!, command.slice(1), {
    cwd: join(options.checkout, "packages", "server"),
    env: {
      ...inherited,
      HOST: "127.0.0.1",
      PORT: String(port),
      WORKTABLE_WORKSPACE: options.workspace,
      WORKTABLE_APP_DIR: options.app,
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let output = ""
  let listenMs = -1
  const listening = new Promise<void>((resolveListen, reject) => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString()
      if (output.length > 200_000) output = output.slice(-100_000)
      if (listenMs < 0 && output.includes("[Worktable server] running on")) {
        listenMs = performance.now() - startedAt
        resolveListen()
      }
    }
    child.stdout!.on("data", onData)
    child.stderr!.on("data", onData)
    child.once("exit", (code, signal) =>
      reject(
        new Error(
          `server exited (${code ?? signal}) before listening:\n${output.slice(-4000)}`
        )
      )
    )
    setTimeout(
      () =>
        reject(
          new Error(
            `server did not listen within 180 s:\n${output.slice(-4000)}`
          )
        ),
      180_000
    ).unref()
  })
  // A wrapper such as strace detaches on SIGTERM and leaves the server
  // running, so signals go to the server itself once it is known.
  let serverPid: number | null = options.wrapper ? null : child.pid!
  const signal = (name: NodeJS.Signals) => {
    if (serverPid !== null && serverPid !== child.pid) {
      try {
        process.kill(serverPid, name)
      } catch {
        // Already gone.
      }
    }
    child.kill(name)
  }
  // Never leave a server behind if this process exits without stop().
  const kill = () => signal("SIGKILL")
  process.once("exit", kill)
  const stop = async () => {
    process.off("exit", kill)
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit))
    if (serverPid !== null && serverPid !== child.pid) {
      // The wrapper exits after the server; signal only the server first.
      try {
        process.kill(serverPid, "SIGTERM")
      } catch {
        child.kill("SIGTERM")
      }
    } else child.kill("SIGTERM")
    const timer = setTimeout(() => signal("SIGKILL"), 10_000)
    await exited
    clearTimeout(timer)
  }
  try {
    await listening
    if (serverPid === null) serverPid = descendantNamed(child.pid!, "bun")
  } catch (error) {
    if (serverPid === null) serverPid = descendantNamed(child.pid!, "bun")
    await stop()
    throw error
  }
  return {
    url: `http://127.0.0.1:${port}`,
    pid: serverPid ?? child.pid!,
    listenMs,
    startedAt,
    output: () => output,
    stop,
  }
}
