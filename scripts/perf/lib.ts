/**
 * Shared helpers for the perf lane: arguments, seeded randomness, percentiles,
 * fixture copies and a server process. No product code depends on this file.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { join, resolve } from "node:path"

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
 * Machine-local caches in the app directory are keyed by a hash of the
 * workspace path (`workspaceCacheKey` in packages/server/src/workspace.ts).
 */
export function workspaceKey(workspacePath: string): string {
  return createHash("sha256")
    .update(resolve(workspacePath))
    .digest("hex")
    .slice(0, 16)
}

/**
 * Copy a generated fixture to a fresh run directory. Activity history and other
 * machine-local state follow the copy by renaming the old workspace key, so a
 * run starts like a restart of the same workspace, not a newly moved one.
 */
export function copyFixture(
  fixtureDir: string,
  runDir: string
): { workspace: string; app: string } {
  rmSync(runDir, { recursive: true, force: true })
  mkdirSync(runDir, { recursive: true })
  const workspace = join(runDir, "workspace")
  const app = join(runDir, "app")
  cpSync(join(fixtureDir, "workspace"), workspace, {
    recursive: true,
    preserveTimestamps: true,
  })
  cpSync(join(fixtureDir, "app"), app, {
    recursive: true,
    preserveTimestamps: true,
  })
  const from = workspaceKey(join(fixtureDir, "workspace"))
  const to = workspaceKey(workspace)
  const rekey = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      let path = join(dir, entry.name)
      if (entry.name.includes(from)) {
        const renamed = join(dir, entry.name.replaceAll(from, to))
        renameSync(path, renamed)
        path = renamed
      }
      if (entry.isDirectory()) rekey(path)
    }
  }
  rekey(app)
  return { workspace, app }
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
}): Promise<ServerProcess> {
  const port = await freePort()
  // Keep the caller's Worktable settings (tokens, auth, paths) out of the run.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("WORKTABLE_") && name !== "REQUIRE_AUTH"
    )
  )
  const startedAt = performance.now()
  const child: ChildProcess = spawn("bun", ["src/index.ts"], {
    cwd: join(options.checkout, "packages", "server"),
    env: {
      ...inherited,
      HOST: "127.0.0.1",
      PORT: String(port),
      WORKTABLE_WORKSPACE: options.workspace,
      WORKTABLE_APP_DIR: options.app,
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
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit))
    child.kill("SIGTERM")
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
    await exited
    clearTimeout(timer)
  }
  try {
    await listening
  } catch (error) {
    await stop()
    throw error
  }
  return {
    url: `http://127.0.0.1:${port}`,
    pid: child.pid!,
    listenMs,
    startedAt,
    output: () => output,
    stop,
  }
}
