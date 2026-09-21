import { randomBytes } from "node:crypto"
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join, relative, resolve, sep } from "node:path"
import {
  DESKTOP_BUNDLE,
  DESKTOP_EXECUTABLE,
  desktopBuildStatus,
  prepareDesktopBundle,
  writeAtomicJson,
} from "./desktop-build.ts"
import {
  renderDesktopGuide,
  renderDesktopGuideSummary,
} from "./render-guide.ts"
import { fixtureReview, renderMcpReviewMarkdown } from "./fixture-review.ts"
import {
  desktopPidMatchesExecutable,
  readDesktopPortFile,
} from "./desktop-watchdog.ts"
import type { DesktopOptions } from "./types.ts"
import { fixturePath, stageHostWorkspace } from "./workspace-seed.ts"

export {
  desktopBundleMayBeReused,
  desktopInputFingerprint,
} from "./desktop-build.ts"

const RUN_MANIFEST = ".worktable-desktop-lab.json"
const RUN_KIND = "worktable.desktop-lab"
const WATCHDOG = join(import.meta.dirname, "desktop-watchdog.ts")

export interface DesktopLabPaths {
  root: string
  home: string
  appData: string
  workspaces: string
  defaultWorkspace: string
  fixtureWorkspace?: string
  stdoutLog: string
  stderrLog: string
  guide: string
  agentWorkdir?: string
  agentSessions?: string
  mcpReview?: string
}

export interface DesktopLabManifest {
  schemaVersion: 1 | 2
  kind: typeof RUN_KIND
  name: string
  owner: string
  createdAt: string
  expiresAt: string
  sourceCommit: string
  inputFingerprint: string
  keep?: boolean
  fixture?: string
  paths: DesktopLabPaths
  pid: number | null
  port?: number
  status: "prepared" | "running" | "stopped" | "failed" | "orphaned"
  lastExitCode?: number
}

export interface DesktopCleanupResult {
  removed: string[]
  running: string[]
  ignored: string[]
}

export interface DesktopAgentSessionMarker {
  schemaVersion: 1
  kind: "worktable.desktop-lab-agent"
  runName: string
  client: string
  pid: number
  executable: string
  startedAt: string
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return null
  }
}

export function desktopLabOwner(): string {
  return `${process.getuid?.() ?? "unknown"}:${userInfo().username}`
}

export function desktopLabBase(env: NodeJS.ProcessEnv = process.env): string {
  return (
    env.WORKTABLE_DESKTOP_LAB_ROOT?.trim() ||
    join(tmpdir(), "worktable-desktop-labs")
  )
}

export function makeDesktopLabName(requested?: string): string {
  if (requested) return requested
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14)
  return `worktable-desktop-${stamp}-${randomBytes(3).toString("hex")}`
}

function containedPath(base: string, child: string): boolean {
  const path = relative(resolve(base), resolve(child))
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`)
}

function pathsFor(
  base: string,
  name: string,
  fixture?: string
): DesktopLabPaths {
  const root = resolve(base, name)
  if (!containedPath(base, root))
    throw new Error(`Unsafe Desktop lab name: ${name}`)
  const home = join(root, "home")
  const workspaces = join(root, "workspaces")
  return {
    root,
    home,
    appData: join(root, "desktop-app-data"),
    workspaces,
    defaultWorkspace: join(home, "Worktable"),
    ...(fixture && fixture !== "empty"
      ? { fixtureWorkspace: join(workspaces, fixture) }
      : {}),
    stdoutLog: join(root, "desktop.stdout.log"),
    stderrLog: join(root, "desktop.stderr.log"),
    guide: join(root, "WORKTABLE_DESKTOP_LAB.txt"),
    agentWorkdir: join(root, "agent-workdir"),
    agentSessions: join(root, "agent-sessions"),
    mcpReview: join(root, "agent-workdir", "MCP_REVIEW.md"),
  }
}

export function ttlMilliseconds(ttl: string): number {
  const match = ttl.match(/^(\d+)(s|m|h)$/)
  if (!match) throw new Error(`Invalid lab lifetime: ${ttl}`)
  const value = Number(match[1])
  return (
    value * (match[2] === "h" ? 3_600_000 : match[2] === "m" ? 60_000 : 1_000)
  )
}

export function readDesktopLabManifest(
  root: string
): DesktopLabManifest | null {
  const path = join(root, RUN_MANIFEST)
  if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return null
  const value = readJson<DesktopLabManifest>(path)
  return (value?.schemaVersion === 1 || value?.schemaVersion === 2) &&
    value.kind === RUN_KIND
    ? value
    : null
}

function writeRunManifest(manifest: DesktopLabManifest): void {
  writeAtomicJson(join(manifest.paths.root, RUN_MANIFEST), manifest)
}

export function assertDesktopRunPathsSafe(paths: DesktopLabPaths): void {
  const rootReal = realpathSync(paths.root)
  for (const path of [
    paths.home,
    paths.appData,
    paths.workspaces,
    paths.agentWorkdir,
    paths.agentSessions,
  ]) {
    if (!path) continue
    if (!existsSync(path))
      throw new Error(`Desktop lab path is missing: ${path}`)
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Desktop lab path is not a real directory: ${path}`)
    if (!containedPath(rootReal, realpathSync(path)))
      throw new Error(`Desktop lab path escapes its run root: ${path}`)
  }
  for (const path of [
    paths.defaultWorkspace,
    paths.fixtureWorkspace,
    paths.stdoutLog,
    paths.stderrLog,
    paths.guide,
    paths.mcpReview,
  ]) {
    if (!path || !existsSync(path)) continue
    if (lstatSync(path).isSymbolicLink())
      throw new Error(`Desktop lab path must not be a symlink: ${path}`)
    if (!containedPath(rootReal, realpathSync(path)))
      throw new Error(`Desktop lab path escapes its run root: ${path}`)
  }
}

export function prepareDesktopRun(options: {
  name: string
  ttl: string
  fixture?: string
  sourceCommit: string
  inputFingerprint: string
  keep?: boolean
  base?: string
  owner?: string
  portIsActive?: (port: number) => boolean
  pidIsActive?: (pid: number) => boolean
}): DesktopLabManifest {
  const base = resolve(options.base ?? desktopLabBase())
  if (existsSync(base) && lstatSync(base).isSymbolicLink())
    throw new Error(`Refusing symlinked Desktop lab root: ${base}`)
  mkdirSync(base, { recursive: true, mode: 0o700 })
  const paths = pathsFor(base, options.name, options.fixture)
  const owner = options.owner ?? desktopLabOwner()
  if (existsSync(paths.root)) {
    if (lstatSync(paths.root).isSymbolicLink())
      throw new Error(`Refusing symlinked Desktop lab run: ${paths.root}`)
    const existing = readDesktopLabManifest(paths.root)
    if (!existing || existing.owner !== owner)
      throw new Error(
        `Desktop lab run already exists and is not owned: ${paths.root}`
      )
    if (existing.schemaVersion !== 2)
      throw new Error(
        `Desktop lab ${options.name} uses an older lab format. Run \`bun run lab -- clean\` or choose a new name.`
      )
    if (
      existing.pid &&
      (options.pidIsActive ?? desktopPidIsActive)(existing.pid)
    )
      throw new Error(
        `Desktop lab ${options.name} is already running as pid ${existing.pid}`
      )
    const existingPort = existing.port ?? readDesktopLabPort(existing.paths)
    if (existingPort && (options.portIsActive ?? portIsActive)(existingPort))
      throw new Error(
        `Desktop lab ${options.name} still has a Worktable sidecar on port ${existingPort}`
      )
    if (existing.fixture !== options.fixture)
      throw new Error(
        `Desktop lab ${options.name} was prepared with fixture ${existing.fixture ?? "none"}; use the same fixture or choose another name`
      )
    if (JSON.stringify(existing.paths) !== JSON.stringify(paths))
      throw new Error(`Desktop lab ${options.name} has unexpected stored paths`)
    assertDesktopRunPathsSafe(paths)
    const resumable = { ...existing }
    delete resumable.port
    delete resumable.lastExitCode
    return {
      ...resumable,
      expiresAt: new Date(
        Date.now() + ttlMilliseconds(options.ttl)
      ).toISOString(),
      sourceCommit: options.sourceCommit,
      inputFingerprint: options.inputFingerprint,
      keep: options.keep ?? false,
      pid: null,
      status: "prepared",
    }
  }

  mkdirSync(paths.root, { recursive: false, mode: 0o700 })
  try {
    mkdirSync(paths.home, { recursive: false, mode: 0o700 })
    mkdirSync(paths.appData, { recursive: false, mode: 0o700 })
    mkdirSync(paths.workspaces, { recursive: false, mode: 0o700 })
    mkdirSync(paths.agentWorkdir!, { recursive: false, mode: 0o700 })
    mkdirSync(paths.agentSessions!, { recursive: false, mode: 0o700 })
    if (options.fixture === "empty")
      stageHostWorkspace(paths.defaultWorkspace, "empty")
    else if (options.fixture && paths.fixtureWorkspace)
      stageHostWorkspace(paths.fixtureWorkspace, options.fixture)

    const now = new Date()
    const manifest: DesktopLabManifest = {
      schemaVersion: 2,
      kind: RUN_KIND,
      name: options.name,
      owner,
      createdAt: now.toISOString(),
      expiresAt: new Date(
        now.getTime() + ttlMilliseconds(options.ttl)
      ).toISOString(),
      sourceCommit: options.sourceCommit,
      inputFingerprint: options.inputFingerprint,
      ...(options.fixture ? { fixture: options.fixture } : {}),
      keep: options.keep ?? false,
      paths,
      pid: null,
      status: "prepared",
    }
    writeRunManifest(manifest)
    return manifest
  } catch (error) {
    rmSync(paths.root, { recursive: true, force: true })
    throw error
  }
}

export function desktopEnvironment(
  paths: DesktopLabPaths,
  inherited: NodeJS.ProcessEnv = process.env,
  pickerDirectory?: string
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...inherited,
    HOME: paths.home,
    XDG_CONFIG_HOME: join(paths.home, ".config"),
    XDG_DATA_HOME: join(paths.home, ".local", "share"),
    WORKTABLE_DESKTOP_APP_DIR: paths.appData,
    WORKTABLE_DESKTOP_LOCAL_APP_DIR: join(paths.root, "local-app-data"),
  }
  for (const key of [
    "WORKTABLE_DESKTOP_WORKSPACE",
    "WORKTABLE_DESKTOP_PORT",
    "WORKTABLE_DESKTOP_PREVIEW_PROVIDERS",
    "WORKTABLE_DESKTOP_PICKER_DIRECTORY",
    "WORKTABLE_DESKTOP_ALLOW_MULTIPLE_INSTANCES",
    "WORKTABLE_WORKSPACE",
    "WORKTABLE_APP_DIR",
    "WORKTABLE_CODEX_CONFIG",
    "WORKTABLE_CURSOR_MCP_CONFIG",
    "WORKTABLE_OPENCODE_CONFIG",
    "WORKTABLE_VSCODE_MCP_CONFIG",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "HOST",
    "PORT",
  ])
    delete environment[key]
  if (pickerDirectory)
    environment.WORKTABLE_DESKTOP_PICKER_DIRECTORY = pickerDirectory
  environment.WORKTABLE_DESKTOP_ALLOW_MULTIPLE_INSTANCES = "1"
  return environment
}

export function desktopPidIsActive(pid: number): boolean {
  return desktopPidMatchesExecutable(pid, DESKTOP_EXECUTABLE)
}

function startWatchdog(manifest: DesktopLabManifest): void {
  if (!manifest.pid) throw new Error("Cannot watch a Desktop lab without a pid")
  const deadline = Date.parse(manifest.expiresAt)
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now())
    throw new Error(`Invalid Desktop lab expiry: ${manifest.expiresAt}`)
  const watchdog = Bun.spawn(
    [
      process.execPath,
      WATCHDOG,
      "--manifest",
      join(manifest.paths.root, RUN_MANIFEST),
      "--pid",
      String(manifest.pid),
      "--deadline",
      String(deadline),
      "--executable",
      DESKTOP_EXECUTABLE,
      "--port-file",
      join(manifest.paths.appData, "desktop-port"),
    ],
    {
      cwd: manifest.paths.root,
      env: desktopEnvironment(manifest.paths),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    }
  )
  watchdog.unref()
}

function portIsActive(port: number): boolean {
  const result = Bun.spawnSync(
    ["curl", "-fsS", "--max-time", "1", `http://127.0.0.1:${port}/health`],
    { stdout: "ignore", stderr: "ignore" }
  )
  return result.success
}

export function readDesktopLabPort(paths: DesktopLabPaths): number | undefined {
  try {
    const root = realpathSync(paths.root)
    const appData = realpathSync(paths.appData)
    if (!containedPath(root, appData)) return undefined
    const portFile = join(appData, "desktop-port")
    if (!existsSync(portFile)) return undefined
    const info = lstatSync(portFile)
    if (!info.isFile() || info.isSymbolicLink()) return undefined
    return readDesktopPortFile(portFile)
  } catch {
    return undefined
  }
}

function signalDesktopProcessGroup(pid: number, signal: NodeJS.Signals): void {
  process.kill(-pid, signal)
}

export function desktopAgentSessionIsActive(
  marker: DesktopAgentSessionMarker
): boolean {
  if (!Number.isSafeInteger(marker.pid) || marker.pid <= 0) return false
  const result = Bun.spawnSync(
    ["ps", "-p", String(marker.pid), "-o", "comm="],
    { stdout: "pipe", stderr: "ignore" }
  )
  if (!result.success) return false
  return result.stdout.toString().trim() === marker.executable
}

function hasActiveAgentSession(
  manifest: DesktopLabManifest,
  isActive: (marker: DesktopAgentSessionMarker) => boolean
): boolean {
  const directory = manifest.paths.agentSessions
  if (!directory || !existsSync(directory)) return false
  try {
    const root = realpathSync(manifest.paths.root)
    const sessions = realpathSync(directory)
    if (!containedPath(root, sessions)) return false
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      const info = lstatSync(path)
      if (!info.isFile() || info.isSymbolicLink()) continue
      const marker = readJson<DesktopAgentSessionMarker>(path)
      if (
        marker?.schemaVersion === 1 &&
        marker.kind === "worktable.desktop-lab-agent" &&
        marker.runName === manifest.name &&
        isActive(marker)
      )
        return true
    }
  } catch {
    return false
  }
  return false
}

async function waitForPortShutdown(
  port: number,
  timeoutMs = 15_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!portIsActive(port)) return true
    await Bun.sleep(150)
  }
  return !portIsActive(port)
}

function safeOwnedRun(
  root: string,
  base: string,
  owner: string
): DesktopLabManifest | null {
  if (!containedPath(base, root)) return null
  const info = lstatSync(root)
  if (!info.isDirectory() || info.isSymbolicLink()) return null
  const manifest = readDesktopLabManifest(root)
  if (
    !manifest ||
    manifest.owner !== owner ||
    resolve(manifest.paths.root) !== resolve(root)
  )
    return null
  const baseReal = realpathSync(base)
  const rootReal = realpathSync(root)
  if (!containedPath(baseReal, rootReal)) return null
  return manifest
}

export function listOwnedDesktopLabRuns(
  options: { base?: string; owner?: string } = {}
): DesktopLabManifest[] {
  const base = resolve(options.base ?? desktopLabBase())
  const owner = options.owner ?? desktopLabOwner()
  if (!existsSync(base)) return []
  if (lstatSync(base).isSymbolicLink())
    throw new Error(`Refusing symlinked Desktop lab root: ${base}`)
  const runs: DesktopLabManifest[] = []
  for (const entry of readdirSync(base).sort()) {
    try {
      const manifest = safeOwnedRun(join(base, entry), base, owner)
      if (manifest) runs.push(manifest)
    } catch {
      // Foreign, malformed, and disappearing entries are not candidates.
    }
  }
  return runs
}

export function removeOwnedDesktopLabs(
  options: {
    dryRun?: boolean
    base?: string
    owner?: string
    only?: string
    pidIsActive?: (pid: number) => boolean
    portIsActive?: (port: number) => boolean
    agentSessionIsActive?: (marker: DesktopAgentSessionMarker) => boolean
  } = {}
): DesktopCleanupResult {
  const base = resolve(options.base ?? desktopLabBase())
  const owner = options.owner ?? desktopLabOwner()
  const result: DesktopCleanupResult = { removed: [], running: [], ignored: [] }
  if (!existsSync(base)) return result
  if (lstatSync(base).isSymbolicLink())
    throw new Error(`Refusing symlinked Desktop lab root: ${base}`)
  const entries = options.only
    ? [resolve(options.only)]
    : readdirSync(base)
        .map((entry) => join(base, entry))
        .sort()
  for (const root of entries) {
    let manifest: DesktopLabManifest | null = null
    try {
      manifest = safeOwnedRun(root, base, owner)
    } catch {
      // A disappearing or unreadable run is ignored instead of broadening cleanup.
    }
    if (!manifest) {
      result.ignored.push(root)
      continue
    }
    const livePid =
      manifest.pid && (options.pidIsActive ?? desktopPidIsActive)(manifest.pid)
    const recordedPort = manifest.port ?? readDesktopLabPort(manifest.paths)
    const livePort =
      recordedPort && (options.portIsActive ?? portIsActive)(recordedPort)
    const liveAgent = hasActiveAgentSession(
      manifest,
      options.agentSessionIsActive ?? desktopAgentSessionIsActive
    )
    if (livePid || livePort || liveAgent) {
      result.running.push(root)
      continue
    }
    result.removed.push(root)
    if (!options.dryRun) rmSync(root, { recursive: true, force: true })
  }
  return result
}

function describeDesktopPlan(options: DesktopOptions, name: string): void {
  const base = resolve(desktopLabBase())
  const paths = pathsFor(base, name, options.fixture)
  const build = desktopBuildStatus()
  console.log(
    JSON.stringify(
      {
        command: "desktop",
        name,
        ttl: options.ttl,
        source: "checkout",
        sourceCommit: build.sourceCommit,
        fixture: options.fixture ?? null,
        root: paths.root,
        home: paths.home,
        appData: paths.appData,
        defaultWorkspace: paths.defaultWorkspace,
        fixtureWorkspace: paths.fixtureWorkspace ?? null,
        pickerDirectory: paths.fixtureWorkspace ? paths.workspaces : null,
        bundle: DESKTOP_BUNDLE,
        bundleAction: options.rebuild || !build.reusable ? "build" : "reuse",
        keep: options.keep,
        hostAgentConfigs: "untouched",
      },
      null,
      2
    )
  )
}

export async function runDesktopLab(options: DesktopOptions): Promise<void> {
  if (process.platform !== "darwin")
    throw new Error("The Worktable Desktop lab requires macOS.")
  if (options.fixture && options.fixture !== "empty")
    fixturePath(options.fixture)
  const name = makeDesktopLabName(options.name)
  if (options.dryRun) {
    describeDesktopPlan(options, name)
    return
  }

  const build = prepareDesktopBundle(options.rebuild)
  let manifest = prepareDesktopRun({
    name,
    ttl: options.ttl,
    ...(options.fixture ? { fixture: options.fixture } : {}),
    sourceCommit: build.sourceCommit,
    inputFingerprint: build.inputFingerprint,
    keep: options.keep,
  })
  const guideOptions = {
    name,
    ttl: options.ttl,
    root: manifest.paths.root,
    home: manifest.paths.home,
    appData: manifest.paths.appData,
    defaultWorkspace: manifest.paths.defaultWorkspace,
    ...(options.fixture ? { fixture: options.fixture } : {}),
    ...(manifest.paths.fixtureWorkspace
      ? { fixtureWorkspace: manifest.paths.fixtureWorkspace }
      : {}),
    sourceCommit: build.sourceCommit,
    stdoutLog: manifest.paths.stdoutLog,
    stderrLog: manifest.paths.stderrLog,
    guide: manifest.paths.guide,
    keep: options.keep,
  }
  const guide = renderDesktopGuide(guideOptions)
  const summary = renderDesktopGuideSummary(guideOptions)
  writeFileSync(manifest.paths.guide, guide, { mode: 0o600 })
  writeFileSync(
    manifest.paths.mcpReview!,
    renderMcpReviewMarkdown(fixtureReview(options.fixture)),
    { mode: 0o600 }
  )
  console.log(`\n${summary}\n`)
  console.log(`[lab] launching ${DESKTOP_EXECUTABLE}`)

  assertDesktopRunPathsSafe(manifest.paths)
  const stdout = openSync(manifest.paths.stdoutLog, "a", 0o600)
  const stderr = openSync(manifest.paths.stderrLog, "a", 0o600)
  chmodSync(manifest.paths.stdoutLog, 0o600)
  chmodSync(manifest.paths.stderrLog, 0o600)
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    child = Bun.spawn([DESKTOP_EXECUTABLE], {
      cwd: manifest.paths.root,
      env: desktopEnvironment(
        manifest.paths,
        process.env,
        manifest.paths.fixtureWorkspace ? manifest.paths.workspaces : undefined
      ),
      stdin: "ignore",
      stdout,
      stderr,
      detached: true,
    })
    manifest = { ...manifest, pid: child.pid, status: "running" }
    writeRunManifest(manifest)
    startWatchdog(manifest)
  } catch (error) {
    if (child) {
      try {
        signalDesktopProcessGroup(child.pid, "SIGTERM")
        const exited = await Promise.race([
          child.exited.then(() => true),
          Bun.sleep(10_000).then(() => false),
        ])
        if (!exited) {
          signalDesktopProcessGroup(child.pid, "SIGKILL")
          await child.exited
        }
      } catch {
        // The child may already have exited while setup was unwinding.
      }
    }
    closeSync(stdout)
    closeSync(stderr)
    manifest = { ...manifest, pid: null, status: "failed" }
    writeRunManifest(manifest)
    throw error
  }
  if (!child) throw new Error("Desktop process did not start")

  let timedOut = false
  let interrupted = false
  let forceTimer: ReturnType<typeof setTimeout> | undefined
  const requestStop = (): void => {
    try {
      signalDesktopProcessGroup(child.pid, "SIGTERM")
    } catch {
      return
    }
    forceTimer ??= setTimeout(() => {
      try {
        signalDesktopProcessGroup(child.pid, "SIGKILL")
      } catch {
        // The process exited during the grace period.
      }
    }, 10_000)
  }
  const stop = (): void => {
    interrupted = true
    requestStop()
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  const timer = setTimeout(() => {
    timedOut = true
    console.warn(
      `[lab] ${name} reached its ${options.ttl} lifetime; stopping it`
    )
    requestStop()
  }, ttlMilliseconds(options.ttl))

  let exitCode: number
  try {
    exitCode = await child.exited
  } finally {
    clearTimeout(timer)
    if (forceTimer) clearTimeout(forceTimer)
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
    closeSync(stdout)
    closeSync(stderr)
  }

  const port = readDesktopLabPort(manifest.paths)
  const stopped = port ? await waitForPortShutdown(port) : true
  const expired = Date.now() >= Date.parse(manifest.expiresAt)
  manifest = {
    ...manifest,
    pid: null,
    ...(port ? { port } : {}),
    lastExitCode: exitCode,
    status: stopped
      ? exitCode === 0 || interrupted || timedOut || expired
        ? "stopped"
        : "failed"
      : "orphaned",
  }
  writeRunManifest(manifest)

  if (!stopped) {
    throw new Error(
      `Desktop exited but its supervised sidecar still answers on port ${port}; retained ${manifest.paths.root}`
    )
  }
  if (exitCode !== 0 && !interrupted && !timedOut && !expired) {
    throw new Error(
      `Desktop exited with code ${exitCode}; retained ${manifest.paths.root}`
    )
  }
  if (options.keep) {
    console.log(`[lab] retained ${manifest.paths.root}`)
    return
  }
  const cleanup = removeOwnedDesktopLabs({ only: manifest.paths.root })
  if (cleanup.running.includes(manifest.paths.root)) {
    console.log(
      `[lab] Desktop stopped; retained ${manifest.paths.root} until its isolated agent exits`
    )
    return
  }
  if (!cleanup.removed.includes(manifest.paths.root)) {
    throw new Error(
      `Desktop stopped, but safe cleanup did not remove ${manifest.paths.root}`
    )
  }
  console.log(`[lab] removed ${manifest.paths.root}`)
}
