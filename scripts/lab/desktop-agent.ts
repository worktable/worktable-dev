import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from "node:fs"
import { createInterface } from "node:readline/promises"
import { join } from "node:path"
import { readCodexUrl, readJsonUrl, runConnector } from "@worktable/mcp-connect"
import type { AgentOptions, DesktopLabAgent } from "./types.ts"
import {
  assertDesktopRunPathsSafe,
  desktopAgentSessionIsActive,
  desktopPidIsActive,
  listOwnedDesktopLabRuns,
  readDesktopLabPort,
  removeOwnedDesktopLabs,
  type DesktopAgentSessionMarker,
  type DesktopLabManifest,
} from "./desktop.ts"
import { writeAtomicJson } from "./desktop-build.ts"

const CLIENT_COMMANDS: Record<DesktopLabAgent, string> = {
  codex: "codex",
  "claude-code": "claude",
  opencode: "opencode",
}

const CONFIG_OVERRIDE_KEYS = [
  "WORKTABLE_DESKTOP_WORKSPACE",
  "WORKTABLE_DESKTOP_PORT",
  "WORKTABLE_DESKTOP_PICKER_DIRECTORY",
  "WORKTABLE_DESKTOP_PREVIEW_PROVIDERS",
  "WORKTABLE_WORKSPACE",
  "WORKTABLE_APP_DIR",
  "WORKTABLE_DESKTOP_APP_DIR",
  "WORKTABLE_DESKTOP_LOCAL_APP_DIR",
  "WORKTABLE_CODEX_CONFIG",
  "WORKTABLE_CURSOR_MCP_CONFIG",
  "WORKTABLE_OPENCODE_CONFIG",
  "WORKTABLE_VSCODE_MCP_CONFIG",
  "WORKTABLE_MCP_TOKEN",
  "WORKTABLE_OWNER_PASSWORD",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
] as const

export function desktopAgentEnvironment(
  manifest: DesktopLabManifest,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const home = manifest.paths.home
  const environment: NodeJS.ProcessEnv = { ...inherited }
  for (const key of CONFIG_OVERRIDE_KEYS) delete environment[key]
  environment.HOME = home
  environment.XDG_CONFIG_HOME = join(home, ".config")
  environment.XDG_DATA_HOME = join(home, ".local", "share")
  environment.CLAUDE_CONFIG_DIR = join(home, ".claude")
  environment.CODEX_HOME = join(home, ".codex")
  environment.WORKTABLE_CODEX_CONFIG = join(home, ".codex", "config.toml")
  environment.WORKTABLE_OPENCODE_CONFIG = join(
    home,
    ".config",
    "opencode",
    "opencode.json"
  )
  return environment
}

function configuredEndpoint(
  client: DesktopLabAgent,
  manifest: DesktopLabManifest
): string | undefined {
  const home = manifest.paths.home
  switch (client) {
    case "codex":
      return readCodexUrl(join(home, ".codex", "config.toml"))
    case "claude-code":
      return readJsonUrl(join(home, ".claude", ".claude.json"), "mcpServers")
    case "opencode":
      return readJsonUrl(
        join(home, ".config", "opencode", "opencode.json"),
        "mcp"
      )
  }
}

export async function withDesktopAgentEnvironment<T>(
  environment: NodeJS.ProcessEnv,
  operation: () => Promise<T>
): Promise<T> {
  const isolatedKeys = new Set<string>([
    ...CONFIG_OVERRIDE_KEYS,
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
  ])
  const previous = new Map<string, string | undefined>()
  for (const key of isolatedKeys) {
    previous.set(key, process.env[key])
    const value = environment[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await operation()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function processExecutable(pid: number): string | undefined {
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-o", "comm="], {
    stdout: "pipe",
    stderr: "ignore",
  })
  if (!result.success) return undefined
  return result.stdout.toString().trim() || undefined
}

export function desktopAgentSessionMarker(
  runName: string,
  client: DesktopLabAgent,
  pid: number,
  executable: string
): DesktopAgentSessionMarker {
  return {
    schemaVersion: 1,
    kind: "worktable.desktop-lab-agent",
    runName,
    client,
    pid,
    executable,
    startedAt: new Date().toISOString(),
  }
}

async function healthIsWorktable(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) return false
    const body = (await response.json()) as { service?: unknown }
    return body.service === "worktable"
  } catch {
    return false
  }
}

export function selectDesktopAgentRun(
  name: string | undefined,
  runs = listOwnedDesktopLabRuns(),
  pidIsActive: (pid: number) => boolean = desktopPidIsActive
): DesktopLabManifest {
  const candidates = runs.filter(
    (run) =>
      run.schemaVersion === 2 &&
      run.status === "running" &&
      run.pid !== null &&
      pidIsActive(run.pid)
  )
  if (name) {
    const run = candidates.find((candidate) => candidate.name === name)
    if (!run)
      throw new Error(
        `Desktop lab ${name} is not an active owned run. Start it with \`bun run lab -- desktop --name ${name}\`, then retry.`
      )
    return run
  }
  if (candidates.length === 0)
    throw new Error(
      "No active Desktop lab was found. Start one with `bun run lab -- desktop`, then retry."
    )
  if (candidates.length > 1)
    throw new Error(
      `More than one Desktop lab is active (${candidates.map((run) => run.name).join(", ")}). Rerun with --name <desktop-run>.`
    )
  return candidates[0]!
}

async function pairingCode(options: AgentOptions): Promise<string> {
  if (options.code) return options.code
  if (!process.stdin.isTTY)
    throw new Error(
      "A pairing code is required in a non-interactive shell. Rerun with --code <pairing-code>."
    )
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    const code = (await terminal.question("Pairing code: ")).trim()
    if (!code)
      throw new Error("Pairing was canceled. Generate a code and retry.")
    return code
  } finally {
    terminal.close()
  }
}

async function pairAgent(
  options: AgentOptions,
  manifest: DesktopLabManifest,
  origin: string,
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const expected = `${origin}/mcp`
  const current = configuredEndpoint(options.client, manifest)
  if (current === expected && !options.replace && !options.code) return
  if (current && current !== expected && !options.replace)
    throw new Error(
      `The isolated ${options.client} profile points to another Worktable endpoint. Generate a fresh code and rerun with --replace.`
    )
  if (current === expected && options.code && !options.replace)
    throw new Error(
      `The isolated ${options.client} profile is already paired. Rerun without --code, or use --replace with a fresh code.`
    )

  console.log(
    `In Worktable, open Settings → Agents, choose ${options.client}, and generate a pairing code.`
  )
  const code = await pairingCode(options)
  const args = [code, "--server", origin, "--client", options.client]
  if (options.replace) args.push("--replace")
  const exitCode = await withDesktopAgentEnvironment(environment, () =>
    runConnector(args, {
      log: (line) => console.log(line),
      error: (line) => console.error(line),
    })
  )
  if (exitCode !== 0)
    throw new Error(
      "Worktable pairing did not complete. Generate a new code after fixing the reported issue, then retry."
    )
  const configured = configuredEndpoint(options.client, manifest)
  if (configured !== expected)
    throw new Error(
      `Pairing completed but the isolated ${options.client} configuration does not target this Desktop lab. Rerun with --replace and a fresh code.`
    )
}

function assertAgentPaths(manifest: DesktopLabManifest): {
  workdir: string
  sessions: string
} {
  const workdir = manifest.paths.agentWorkdir
  const sessions = manifest.paths.agentSessions
  if (!workdir || !sessions)
    throw new Error(
      "This run predates isolated agent launching. Start a new Desktop lab and retry."
    )
  const root = realpathSync(manifest.paths.root)
  for (const path of [workdir, sessions]) {
    if (!existsSync(path)) mkdirSync(path, { recursive: false, mode: 0o700 })
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Unsafe Desktop agent directory: ${path}`)
    const canonical = realpathSync(path)
    if (!canonical.startsWith(`${root}/`))
      throw new Error(`Desktop agent directory escapes its run: ${path}`)
  }
  return { workdir, sessions }
}

async function waitForDesktopOrAgent(
  child: ReturnType<typeof Bun.spawn>,
  manifest: DesktopLabManifest,
  port: number
): Promise<{ exitCode: number; desktopStopped: boolean }> {
  let childExited = false
  const exited = child.exited.then((exitCode) => {
    childExited = true
    return exitCode
  })
  const desktopStopped = (async () => {
    while (!childExited) {
      await Bun.sleep(1_000)
      if (
        !manifest.pid ||
        !desktopPidIsActive(manifest.pid) ||
        !(await healthIsWorktable(port))
      ) {
        if (!childExited) {
          console.warn(
            "\n[lab] Worktable Desktop stopped; closing the isolated agent."
          )
          child.kill("SIGTERM")
          const graceful = await Promise.race([
            exited.then(() => true),
            Bun.sleep(10_000).then(() => false),
          ])
          if (!graceful) child.kill("SIGKILL")
        }
        return true
      }
    }
    return false
  })()
  const exitCode = await exited
  return { exitCode, desktopStopped: await desktopStopped }
}

async function cleanupStoppedRun(manifest: DesktopLabManifest): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const cleanup = removeOwnedDesktopLabs({ only: manifest.paths.root })
    if (cleanup.removed.includes(manifest.paths.root)) {
      console.log(`[lab] removed ${manifest.paths.root}`)
      return
    }
    if (!cleanup.running.includes(manifest.paths.root)) return
    await Bun.sleep(150)
  }
  console.log(
    `[lab] retained ${manifest.paths.root}; another verified process is still using it`
  )
}

export async function runDesktopAgent(options: AgentOptions): Promise<void> {
  if (process.platform !== "darwin")
    throw new Error("The Desktop lab agent launcher requires macOS.")
  const executableName = CLIENT_COMMANDS[options.client]
  const executable = Bun.which(executableName)
  if (!executable)
    throw new Error(
      `${executableName} is not installed on this Mac. Install it before generating a Worktable pairing code.`
    )

  const manifest = selectDesktopAgentRun(options.name)
  assertDesktopRunPathsSafe(manifest.paths)
  const port = readDesktopLabPort(manifest.paths)
  if (!port || !(await healthIsWorktable(port)))
    throw new Error(
      `Desktop lab ${manifest.name} is running but its Worktable sidecar is unavailable. Return to the app or restart the lab, then retry.`
    )
  const origin = `http://127.0.0.1:${port}`
  const environment = desktopAgentEnvironment(manifest)
  const { workdir, sessions } = assertAgentPaths(manifest)
  const launcherExecutable = processExecutable(process.pid)
  if (!launcherExecutable)
    throw new Error(
      "Could not verify the lab agent launcher process. Return to the active Desktop lab and retry."
    )
  const reservation = desktopAgentSessionMarker(
    manifest.name,
    options.client,
    process.pid,
    launcherExecutable
  )
  const reservationPath = join(sessions, `launcher-${process.pid}.json`)
  writeAtomicJson(reservationPath, reservation)
  chmodSync(reservationPath, 0o600)
  if (!desktopAgentSessionIsActive(reservation)) {
    rmSync(reservationPath, { force: true })
    throw new Error(
      "Could not reserve the active Desktop lab for agent pairing. Return to the app and retry."
    )
  }

  let markerPath: string | undefined
  let result: { exitCode: number; desktopStopped: boolean } | undefined
  try {
    await pairAgent(options, manifest, origin, environment)

    console.log(`\n[lab] launching isolated ${options.client}`)
    console.log(`[lab] working directory: ${workdir}`)
    console.log(
      "[lab] First prompt: Read MCP_REVIEW.md. Start with Discovery, use Worktable tools only, and pause before mutations."
    )
    console.log(
      "[lab] Provider login is separate from Worktable pairing; this isolated profile may ask you to sign in.\n"
    )

    const child = Bun.spawn([executable], {
      cwd: workdir,
      env: environment,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    await Bun.sleep(50)
    const executableIdentity = processExecutable(child.pid)
    if (!executableIdentity) {
      child.kill("SIGTERM")
      await child.exited
      throw new Error(
        `Could not verify the launched ${options.client} process. The isolated pairing remains available; retry the command.`
      )
    }
    const marker = desktopAgentSessionMarker(
      manifest.name,
      options.client,
      child.pid,
      executableIdentity
    )
    markerPath = join(sessions, `${child.pid}.json`)
    writeAtomicJson(markerPath, marker)
    chmodSync(markerPath, 0o600)
    if (!desktopAgentSessionIsActive(marker)) {
      rmSync(markerPath, { force: true })
      markerPath = undefined
      child.kill("SIGTERM")
      await child.exited
      throw new Error(
        `Could not verify the launched ${options.client} identity. The isolated pairing remains available; retry the command.`
      )
    }
    rmSync(reservationPath, { force: true })

    const forwardInterrupt = (): void => child.kill("SIGINT")
    const forwardTermination = (): void => child.kill("SIGTERM")
    process.once("SIGINT", forwardInterrupt)
    process.once("SIGTERM", forwardTermination)
    try {
      result = await waitForDesktopOrAgent(child, manifest, port)
    } finally {
      process.off("SIGINT", forwardInterrupt)
      process.off("SIGTERM", forwardTermination)
    }
  } finally {
    rmSync(reservationPath, { force: true })
    if (markerPath) rmSync(markerPath, { force: true })
    if (
      !manifest.keep &&
      (result?.desktopStopped ||
        !manifest.pid ||
        !desktopPidIsActive(manifest.pid))
    )
      await cleanupStoppedRun(manifest)
  }

  if (!result) return
  if (result.exitCode !== 0 && !result.desktopStopped)
    throw new Error(
      `${options.client} exited with status ${result.exitCode}. Its isolated configuration was retained; retry the same command without a new code.`
    )
}
