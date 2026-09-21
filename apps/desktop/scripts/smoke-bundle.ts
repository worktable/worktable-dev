import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appRoot, resolveDesktopBundlePath } from "./release-paths"

const bundle = resolveDesktopBundlePath()
const executable = join(bundle, "Contents", "MacOS", "worktable-desktop")
const sidecarExecutable = join(bundle, "Contents", "MacOS", "worktable")
const runtimeRoot = join(bundle, "Contents", "Resources", "worktable-runtime")
const keep = process.env.WORKTABLE_DESKTOP_SMOKE_KEEP === "1"
const root = mkdtempSync(join(tmpdir(), "worktable-desktop-smoke-"))
const home = join(root, "home")
const workspace = join(root, "workspace")
const appData = join(root, "app-data")
const localAppData = join(root, "local-app-data")
const portPath = join(appData, "desktop-port")
const connectionsPath = join(appData, "desktop-connections.json")
const cliConfigPath = join(localAppData, "config.json")
const localRegistryPath = join(localAppData, "local-workspaces.json")
const localRuntimePath = join(localAppData, "local-runtime.json")
const remoteWorkspace = join(root, "remote-workspace")
const remoteServerAppData = join(root, "remote-server-app-data")
const remoteDesktopAppData = join(root, "remote-desktop-app-data")
const remoteDesktopLocalAppData = join(root, "remote-desktop-local-app-data")

interface WorkspaceIdentity {
  id: string
  name: string
}

interface RunningDesktop {
  process: ReturnType<typeof Bun.spawn>
  appPid: number
  stdout: Promise<string>
  stderr: Promise<string>
  appStdoutPath?: string
  appStderrPath?: string
}

interface RunningCliHost {
  process: ReturnType<typeof Bun.spawn>
  stdout: Promise<string>
  stderr: Promise<string>
}

let launchNumber = 0

function fail(message: string): never {
  throw new Error(message)
}

async function waitFor<T>(
  description: string,
  probe: () => T | null | Promise<T | null>,
  timeoutMs = 45_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== null) return value
    await Bun.sleep(150)
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function health(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_000),
    })
    if (!response.ok) return false
    const body = (await response.json()) as { service?: unknown }
    return body.service === "worktable"
  } catch {
    return false
  }
}

function bundleProcessIds(): number[] {
  const result = Bun.spawnSync(["pgrep", "-f", executable])
  if (!result.success) return []
  return result.stdout
    .toString()
    .trim()
    .split("\n")
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0)
}

function desktopOwnsLocalSidecar(pid: number): boolean {
  const children = Bun.spawnSync(["pgrep", "-P", String(pid)])
  if (!children.success) return false
  return children.stdout
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .some((childPid) => {
      const command = Bun.spawnSync(["ps", "-p", childPid, "-o", "command="])
      return (
        command.success && command.stdout.toString().includes(sidecarExecutable)
      )
    })
}

async function startDesktop(
  workspaceOverride: boolean,
  desktopAppData = appData,
  desktopLocalAppData = localAppData
): Promise<RunningDesktop> {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    WORKTABLE_DESKTOP_APP_DIR: desktopAppData,
    WORKTABLE_DESKTOP_LOCAL_APP_DIR: desktopLocalAppData,
  }
  delete environment.WORKTABLE_DESKTOP_WORKSPACE
  if (workspaceOverride) {
    environment.WORKTABLE_DESKTOP_WORKSPACE = workspace
  }
  const existingPids = new Set(bundleProcessIds())
  launchNumber += 1
  const appStdoutPath = join(root, `launch-${launchNumber}.stdout.log`)
  const appStderrPath = join(root, `launch-${launchNumber}.stderr.log`)
  writeFileSync(appStdoutPath, "")
  writeFileSync(appStderrPath, "")
  const openArgs = [
    "open",
    "-n",
    "-W",
    "-F",
    "--stdout",
    appStdoutPath,
    "--stderr",
    appStderrPath,
    "--env",
    `HOME=${home}`,
    "--env",
    `WORKTABLE_DESKTOP_APP_DIR=${desktopAppData}`,
    "--env",
    `WORKTABLE_DESKTOP_LOCAL_APP_DIR=${desktopLocalAppData}`,
  ]
  if (workspaceOverride) {
    openArgs.push("--env", `WORKTABLE_DESKTOP_WORKSPACE=${workspace}`)
  }
  openArgs.push(bundle)
  const child = Bun.spawn(openArgs, {
    cwd: appRoot,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  })
  const appPid = await waitFor("packaged Worktable process", () => {
    const pid = bundleProcessIds().find(
      (candidate) => !existingPids.has(candidate)
    )
    return pid ?? null
  })
  if (process.env.WORKTABLE_DESKTOP_SMOKE_LOGS === "1") {
    console.log(`Launch Services started Worktable Desktop pid ${appPid}.`)
  }
  return {
    process: child,
    appPid,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
    appStdoutPath,
    appStderrPath,
  }
}

function startDuplicateDesktop(): RunningDesktop {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    WORKTABLE_DESKTOP_APP_DIR: appData,
    WORKTABLE_DESKTOP_LOCAL_APP_DIR: localAppData,
  }
  delete environment.WORKTABLE_DESKTOP_WORKSPACE
  const child = Bun.spawn([executable], {
    cwd: appRoot,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    process: child,
    appPid: child.pid,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  }
}

function startCliOwner(): RunningCliHost {
  const child = Bun.spawn(
    [sidecarExecutable, "launch", "--foreground", "--no-browser"],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        HOME: home,
        WORKTABLE_APP_DIR: localAppData,
        WORKTABLE_RELEASE_DIR: runtimeRoot,
        WORKTABLE_STATIC_DIR: join(runtimeRoot, "web"),
        WORKTABLE_NO_UPDATE_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  return {
    process: child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  }
}

function availableLoopbackPort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  })
  const port = listener.port
  listener.stop(true)
  return port
}

function startRemoteServer(port: number): RunningCliHost {
  mkdirSync(remoteWorkspace, { recursive: true })
  mkdirSync(remoteServerAppData, { recursive: true })
  const prepared = Bun.spawnSync(
    [
      sidecarExecutable,
      "workspace",
      "prepare",
      remoteWorkspace,
      "--intent",
      "create-or-open",
      "--json",
    ],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        HOME: home,
        WORKTABLE_APP_DIR: remoteServerAppData,
        WORKTABLE_RELEASE_DIR: runtimeRoot,
        WORKTABLE_STATIC_DIR: join(runtimeRoot, "web"),
        WORKTABLE_NO_UPDATE_CHECK: "1",
      },
    }
  )
  if (!prepared.success) {
    fail(
      `Could not prepare remote smoke workspace: ${prepared.stderr.toString().trim()}`
    )
  }
  const child = Bun.spawn(
    [
      sidecarExecutable,
      "launch",
      "--foreground",
      "--no-browser",
      "--workspace",
      remoteWorkspace,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        HOME: home,
        WORKTABLE_APP_DIR: remoteServerAppData,
        WORKTABLE_RELEASE_DIR: runtimeRoot,
        WORKTABLE_STATIC_DIR: join(runtimeRoot, "web"),
        WORKTABLE_NO_UPDATE_CHECK: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  )
  return {
    process: child,
    stdout: new Response(child.stdout).text(),
    stderr: new Response(child.stderr).text(),
  }
}

async function workspaceIdentity(
  port: number
): Promise<WorkspaceIdentity | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/workspace`, {
      signal: AbortSignal.timeout(1_000),
    })
    if (!response.ok) return null
    const workspace = (await response.json()) as Partial<WorkspaceIdentity>
    return typeof workspace.id === "string" &&
      typeof workspace.name === "string"
      ? { id: workspace.id, name: workspace.name }
      : null
  } catch {
    return null
  }
}

async function welcomeReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/spaces`, {
      signal: AbortSignal.timeout(1_000),
    })
    if (!response.ok) return false
    const body = (await response.json()) as { spaces?: Array<{ id?: unknown }> }
    return body.spaces?.some((space) => space.id === "welcome") ?? false
  } catch {
    return false
  }
}

function saveProfile(workspaceIdentity: WorkspaceIdentity, port: number): void {
  mkdirSync(appData, { recursive: true })
  mkdirSync(localAppData, { recursive: true })
  writeFileSync(
    connectionsPath,
    `${JSON.stringify(
      {
        schemaVersion: 2,
        activeProfileId: `local:${workspaceIdentity.id}`,
        profiles: [
          {
            id: `local:${workspaceIdentity.id}`,
            kind: "local",
            displayName: workspaceIdentity.name,
            workspaceId: workspaceIdentity.id,
            workspacePath: workspace,
            port,
          },
        ],
      },
      null,
      2
    )}\n`
  )
  chmodSync(connectionsPath, 0o600)
}

function saveRemoteProfile(
  workspaceIdentity: WorkspaceIdentity,
  origin: string
): string {
  const profileId = "self-hosted:0123456789abcdef0123456789abcdef"
  mkdirSync(remoteDesktopAppData, { recursive: true })
  mkdirSync(remoteDesktopLocalAppData, { recursive: true })
  writeFileSync(
    join(remoteDesktopAppData, "desktop-connections.json"),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        activeProfileId: profileId,
        profiles: [
          {
            id: profileId,
            kind: "selfHosted",
            displayName: "Stale remote name",
            origin,
            workspaceId: workspaceIdentity.id,
            allowInsecureHttp: true,
          },
        ],
      },
      null,
      2
    )}\n`
  )
  chmodSync(join(remoteDesktopAppData, "desktop-connections.json"), 0o600)
  writeFileSync(join(remoteDesktopLocalAppData, "config.json"), "{broken")
  return profileId
}

async function waitForHealthyDesktop(): Promise<number> {
  const port = await waitFor("desktop port selection", () => {
    if (!existsSync(portPath)) return null
    const candidate = Number.parseInt(readFileSync(portPath, "utf8").trim(), 10)
    return Number.isInteger(candidate) && candidate > 0 ? candidate : null
  })
  await waitFor("packaged Worktable health", async () =>
    (await health(port)) ? true : null
  )
  return port
}

function quitBundle(): void {
  runBundleScript("quit")
}

function runBundleScript(command: string): string {
  const escapedBundle = bundle.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
  const result = Bun.spawnSync([
    "osascript",
    "-e",
    `tell application "${escapedBundle}" to ${command}`,
  ])
  if (!result.success) {
    throw new Error(
      `Packaged desktop AppleScript failed (${command}): ${result.stderr.toString().trim()}`
    )
  }
  return result.stdout.toString().trim()
}

function runSystemEventsScript(command: string): string {
  const result = Bun.spawnSync(["osascript", "-e", command])
  if (!result.success) {
    throw new Error(
      `Packaged desktop UI automation failed: ${result.stderr.toString().trim()}`
    )
  }
  return result.stdout.toString().trim()
}

function closeBundleWindow(pid: number): void {
  runSystemEventsScript(
    `tell application "System Events" to tell (first application process whose unix id is ${pid}) to click (first button of window 1 whose subrole is "AXCloseButton")`
  )
}

function activateBundle(): void {
  runSystemEventsScript('tell application "Finder" to activate')
  Bun.sleepSync(500)
  runSystemEventsScript(
    'tell application "System Events" to tell process "Dock" to click UI element "Worktable" of list 1'
  )
}

function bundleWindowVisible(pid: number): boolean {
  return (
    runSystemEventsScript(
      `tell application "System Events" to tell (first application process whose unix id is ${pid}) to return (visible is true) and ((count of windows) > 0)`
    ) === "true"
  )
}

async function verifySecondLaunchDelegates(): Promise<void> {
  const duplicate = startDuplicateDesktop()
  const exitCode = await Promise.race([
    duplicate.process.exited,
    Bun.sleep(10_000).then(() => null),
  ])
  if (exitCode === null) {
    duplicate.process.kill()
    await duplicate.process.exited
    throw new Error("A second Desktop launch created another running instance")
  }
  if (exitCode !== 0) {
    throw new Error(`Second Desktop launch exited with code ${exitCode}`)
  }
  await finishLogs("Delegated second launch", duplicate)
}

async function stopDesktop(running: RunningDesktop): Promise<void> {
  quitBundle()
  const exitCode = await Promise.race([
    running.process.exited,
    Bun.sleep(15_000).then(() => null),
  ])
  if (exitCode === null) {
    forceStopDesktop(running)
    await running.process.exited
    throw new Error("Packaged desktop app did not exit after a quit request")
  }
}

function forceStopDesktop(running: RunningDesktop): void {
  try {
    process.kill(running.appPid, "SIGKILL")
  } catch {
    // The app may have exited between the timeout and forced cleanup.
  }
  running.process.kill()
}

function desktopLaunchOutput(running: RunningDesktop): string {
  return [running.appStdoutPath, running.appStderrPath]
    .filter((path): path is string => Boolean(path))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
}

async function finishLogs(
  label: string,
  running: RunningDesktop,
  print = process.env.WORKTABLE_DESKTOP_SMOKE_LOGS === "1"
): Promise<void> {
  const [launcherStdout, launcherStderr] = await Promise.all([
    running.stdout,
    running.stderr,
  ])
  const stdout = `${running.appStdoutPath ? readFileSync(running.appStdoutPath, "utf8") : ""}${launcherStdout}`
  const stderr = `${running.appStderrPath ? readFileSync(running.appStderrPath, "utf8") : ""}${launcherStderr}`
  if (print && stdout.trim()) console.log(`${label} stdout:\n${stdout.trim()}`)
  if (print && stderr.trim())
    console.error(`${label} stderr:\n${stderr.trim()}`)
}

async function finishCliLogs(
  label: string,
  running: RunningCliHost,
  print = process.env.WORKTABLE_DESKTOP_SMOKE_LOGS === "1"
): Promise<void> {
  const [stdout, stderr] = await Promise.all([running.stdout, running.stderr])
  if (print && stdout.trim()) console.log(`${label} stdout:\n${stdout.trim()}`)
  if (print && stderr.trim())
    console.error(`${label} stderr:\n${stderr.trim()}`)
}

if (process.platform !== "darwin") {
  fail("The packaged Worktable Desktop smoke test requires macOS.")
}
if (!existsSync(executable)) {
  fail(`Desktop bundle executable is missing: ${executable}`)
}

let running: RunningDesktop | null = null
let cliOwner: RunningCliHost | null = null
let remoteOwner: RunningCliHost | null = null
let succeeded = false
try {
  mkdirSync(appData, { recursive: true })
  mkdirSync(localAppData, { recursive: true })
  running = await startDesktop(true)
  const firstPort = await waitForHealthyDesktop()
  const shell = await fetch(`http://127.0.0.1:${firstPort}/`).then((response) =>
    response.text()
  )
  if (!shell.includes("<title>Worktable</title>")) {
    fail("Packaged Worktable host did not serve the expected web shell")
  }
  await waitFor("workspace initialization", () =>
    existsSync(join(workspace, "worktable.workspace.json")) ? true : null
  )
  await waitFor("shared local config", () =>
    existsSync(cliConfigPath) && existsSync(localRegistryPath) ? true : null
  )
  const firstWorkspace = await waitFor("verified workspace identity", () =>
    workspaceIdentity(firstPort)
  )
  const firstRuntime = JSON.parse(readFileSync(localRuntimePath, "utf8")) as {
    owner?: unknown
    workspaceId?: unknown
    workspacePath?: unknown
    port?: unknown
    proofToken?: unknown
  }
  if (
    firstRuntime.owner !== "desktop" ||
    firstRuntime.workspaceId !== firstWorkspace.id ||
    firstRuntime.workspacePath !== workspace ||
    firstRuntime.port !== firstPort ||
    typeof firstRuntime.proofToken !== "string" ||
    firstRuntime.proofToken.length < 32
  ) {
    fail(
      "Desktop-owned host did not publish the canonical private runtime lease"
    )
  }
  await waitFor("seeded Welcome space", async () =>
    (await welcomeReady(firstPort)) ? true : null
  )
  if (existsSync(connectionsPath)) {
    fail(
      "Ephemeral desktop override unexpectedly persisted a connection profile"
    )
  }
  await stopDesktop(running)
  await finishLogs("First launch", running)
  await waitFor("supervised sidecar shutdown", async () =>
    (await health(firstPort)) ? null : true
  )
  if (existsSync(localRuntimePath)) {
    fail("Desktop-owned runtime lease survived application quit")
  }
  running = null
  // Let Launch Services unregister the first test instance before requesting a
  // fresh process with the same bundle identifier.
  await Bun.sleep(1_000)

  saveProfile(firstWorkspace, firstPort)
  running = await startDesktop(false)
  const secondPort = await waitForHealthyDesktop()
  if (secondPort !== firstPort) {
    fail(`Desktop origin changed across restart: ${firstPort} -> ${secondPort}`)
  }
  const secondWorkspace = await waitFor(
    "saved-profile workspace identity",
    () => workspaceIdentity(secondPort)
  )
  if (secondWorkspace.id !== firstWorkspace.id) {
    fail(
      `Desktop workspace identity changed across restart: ${firstWorkspace.id} -> ${secondWorkspace.id}`
    )
  }
  if (!bundleWindowVisible(running.appPid)) activateBundle()
  await waitFor("Dock-activated restarted Desktop window", () =>
    bundleWindowVisible(running!.appPid) ? true : null
  )
  closeBundleWindow(running.appPid)
  await waitFor("hidden Desktop window", () =>
    bundleWindowVisible(running!.appPid) ? null : true
  )
  if (!(await health(secondPort))) {
    fail("Closing the Desktop window stopped its supervised sidecar")
  }
  await verifySecondLaunchDelegates()
  await waitFor("relaunch-reopened Desktop window", () =>
    bundleWindowVisible(running!.appPid) ? true : null
  )
  if (!(await health(secondPort))) {
    fail("Delegating a second launch interrupted the running sidecar")
  }
  closeBundleWindow(running.appPid)
  await waitFor("second hidden Desktop window", () =>
    bundleWindowVisible(running!.appPid) ? null : true
  )
  activateBundle()
  await waitFor("Dock-reopened Desktop window", () =>
    bundleWindowVisible(running!.appPid) ? true : null
  )
  await stopDesktop(running)
  await finishLogs("Second launch", running)
  await waitFor("restarted sidecar shutdown", async () =>
    (await health(secondPort)) ? null : true
  )
  if (existsSync(localRuntimePath)) {
    fail("Restarted Desktop-owned runtime lease survived application quit")
  }
  running = null

  cliOwner = startCliOwner()
  await waitFor("foreground CLI ownership", () => {
    if (!existsSync(localRuntimePath)) return null
    const runtime = JSON.parse(readFileSync(localRuntimePath, "utf8")) as {
      owner?: unknown
      port?: unknown
    }
    return runtime.owner === "cli" && runtime.port === firstPort ? true : null
  })
  await waitFor("foreground CLI health", async () =>
    (await health(firstPort)) ? true : null
  )
  await Bun.sleep(1_000)
  running = await startDesktop(false)
  await waitFor("Desktop attachment to foreground CLI", () => {
    try {
      if (!bundleWindowVisible(running!.appPid)) return null
      const runtime = JSON.parse(readFileSync(localRuntimePath, "utf8")) as {
        owner?: unknown
        pid?: unknown
      }
      return runtime.owner === "cli" && runtime.pid === cliOwner!.process.pid
        ? true
        : null
    } catch {
      return null
    }
  })
  await stopDesktop(running)
  await finishLogs("Attached CLI-owner launch", running)
  running = null
  if (!(await health(firstPort))) {
    fail("Quitting Desktop stopped the foreground CLI host it had attached to")
  }
  const attachedRuntime = JSON.parse(
    readFileSync(localRuntimePath, "utf8")
  ) as {
    owner?: unknown
    pid?: unknown
  }
  if (
    attachedRuntime.owner !== "cli" ||
    attachedRuntime.pid !== cliOwner.process.pid
  ) {
    fail("Desktop replaced or removed the foreground CLI ownership lease")
  }
  cliOwner.process.kill("SIGTERM")
  await cliOwner.process.exited
  await finishCliLogs("Foreground CLI owner", cliOwner)
  cliOwner = null
  await waitFor("foreground CLI shutdown", async () =>
    (await health(firstPort)) ? null : true
  )
  if (existsSync(localRuntimePath)) {
    fail("Foreground CLI runtime lease survived its process shutdown")
  }

  const remotePort = availableLoopbackPort()
  const remoteOrigin = `http://127.0.0.1:${remotePort}`
  remoteOwner = startRemoteServer(remotePort)
  await waitFor("independently owned remote Worktable", async () =>
    (await health(remotePort)) ? true : null
  )
  const remoteIdentity = await waitFor("remote workspace identity", () =>
    workspaceIdentity(remotePort)
  )
  saveRemoteProfile(remoteIdentity, remoteOrigin)

  running = await startDesktop(
    false,
    remoteDesktopAppData,
    remoteDesktopLocalAppData
  )
  const remoteConnectionsPath = join(
    remoteDesktopAppData,
    "desktop-connections.json"
  )
  await waitFor("remote profile identity refresh", () => {
    const saved = JSON.parse(readFileSync(remoteConnectionsPath, "utf8")) as {
      schemaVersion?: unknown
      connections?: Array<{ label?: unknown }>
    }
    return saved.schemaVersion === 3 &&
      saved.connections?.[0]?.label === remoteIdentity.name
      ? true
      : null
  })
  await waitFor("remote native-command denial probe", () => {
    if (!running) return null
    return desktopLaunchOutput(running).includes(
      "workspace native command boundary: denied"
    )
      ? true
      : null
  })
  if (
    desktopOwnsLocalSidecar(running.appPid) ||
    existsSync(join(remoteDesktopLocalAppData, "local-runtime.json"))
  ) {
    fail("A self-hosted Desktop connection started a local sidecar or lease")
  }
  await stopDesktop(running)
  await finishLogs("Remote profile launch", running)
  running = null
  if (!(await health(remotePort))) {
    fail("Quitting Desktop stopped the independently owned remote server")
  }
  await Bun.sleep(1_000)

  running = await startDesktop(
    false,
    remoteDesktopAppData,
    remoteDesktopLocalAppData
  )
  await waitFor("remote profile reconnect after restart", () => {
    if (!running) return null
    return desktopLaunchOutput(running).includes(
      "workspace native command boundary: denied"
    )
      ? true
      : null
  })
  if (
    desktopOwnsLocalSidecar(running.appPid) ||
    existsSync(join(remoteDesktopLocalAppData, "local-runtime.json"))
  ) {
    fail("Restarting a self-hosted profile started local authority")
  }
  await stopDesktop(running)
  await finishLogs("Remote profile restart", running)
  running = null
  if (!(await health(remotePort))) {
    fail("Remote server stopped when the reconnecting Desktop quit")
  }
  remoteOwner.process.kill("SIGTERM")
  await remoteOwner.process.exited
  await finishCliLogs("Independent remote server", remoteOwner)
  remoteOwner = null

  if (existsSync(join(home, "Worktable"))) {
    fail(
      "Desktop smoke launch wrote to the default workspace instead of its override"
    )
  }
  const sharedConfig = JSON.parse(readFileSync(cliConfigPath, "utf8")) as {
    workspace?: unknown
    service?: { port?: unknown }
  }
  if (
    sharedConfig.workspace !== workspace ||
    sharedConfig.service?.port !== firstPort
  ) {
    fail("Desktop and CLI did not retain one canonical workspace endpoint")
  }
  const registry = JSON.parse(readFileSync(localRegistryPath, "utf8")) as {
    activeWorkspaceId?: unknown
    workspaces?: Array<{
      workspaceId?: unknown
      path?: unknown
      port?: unknown
    }>
  }
  const registered = registry.workspaces?.find(
    (entry) => entry.workspaceId === firstWorkspace.id
  )
  if (
    registry.activeWorkspaceId !== firstWorkspace.id ||
    registered?.path !== workspace ||
    registered?.port !== firstPort
  ) {
    fail(
      "Desktop and CLI did not retain one canonical workspace registry entry"
    )
  }
  console.log(
    `Verified packaged Worktable Desktop creation, Welcome seed, shared local authority, profile restart, CLI-owner attachment, self-hosted reconnect, corrupt-local-config isolation, native-command denial, close/reopen, single-instance delegation, stable local port ${firstPort}, and owned-host shutdown.`
  )
  succeeded = true
} catch (error) {
  if (running) {
    try {
      await stopDesktop(running)
    } catch {
      forceStopDesktop(running)
      await running.process.exited
    }
    await finishLogs("Failed launch", running, true)
  }
  if (cliOwner) {
    cliOwner.process.kill("SIGTERM")
    await cliOwner.process.exited
    await finishCliLogs("Failed CLI owner", cliOwner, true)
  }
  if (remoteOwner) {
    remoteOwner.process.kill("SIGTERM")
    await remoteOwner.process.exited
    await finishCliLogs("Failed remote owner", remoteOwner, true)
  }
  console.error(`Desktop smoke root: ${root}`)
  throw error
} finally {
  if (!keep && succeeded) rmSync(root, { recursive: true, force: true })
}
