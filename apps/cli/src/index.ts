import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { Option } from "@clack/prompts"
import {
  Command,
  InvalidArgumentError,
  Option as CommanderOption,
} from "@commander-js/extra-typings"
import {
  applyRuntimeConfig,
  clientHostFor,
  clientOriginFor,
  ConfigCorruptError,
  createDefaultConfig,
  endpointFor,
  ensureConfig,
  getConfigPath,
  getConfigBackupPath,
  isLoopbackHost,
  loadConfigForRecreate,
  CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS,
  type ConnectorInstallableMcpClientId,
  readConfig,
  updateConfig,
  type WorktableConfig,
  writeConfig,
} from "./config.ts"
import {
  detectInstalledClients,
  getMcpStatuses,
  listClients,
  parseClientSelection,
  printClientConfig,
  printMcpStatuses,
  removeClient,
  repairClients,
  setupClients,
  setupManagedClients,
} from "./mcp.ts"
import {
  getServiceStatus,
  getInstalledServicePublicUrl,
  installService,
  prepareServiceInstall,
  prepareServiceUninstall,
  restartService,
  SERVICE_LABEL,
  serviceManagerOwnsRuntimePid,
  ServiceLifecycleError,
  startService,
  stopService,
  type ServiceStatus,
  uninstallService,
} from "./service.ts"
import {
  classifyRuntimeReadiness,
  describeRuntimeReadinessFailure,
  localHostServiceStartMode,
  planLocalAuthority,
  resolveReachability,
  runtimeProvesWorkspaceEndpoint,
  type ExactRuntimeReadinessFailure,
  type ReachabilityOpts,
} from "./local-authority-plan.ts"
export {
  getSetupServiceAction,
  localHostServiceStartMode,
  planLocalAuthority,
  resolveReachability,
  runtimeProvesWorkspaceEndpoint,
  shouldRestartServiceAfterSetup,
  unknownServiceReconfigureRefusal,
} from "./local-authority-plan.ts"
import {
  getDoctorPaths,
  getReleaseDir,
  getRuntimePaths,
  VERSION,
} from "./paths.ts"
import {
  readUpdateStatus,
  writeUpdateStatus,
  type UpdateStatus,
} from "@worktable/server/runtime"
import {
  asHttpOrigin,
  assertLocalWorkspaceReservationAvailable,
  clearLocalRuntime,
  createLocalRuntimeRecord,
  createPairingSession,
  findLocalWorkspace,
  findLocalWorkspaceByPath,
  getLocalWorkspaceRegistryPath,
  getLocalRuntimePath,
  getServerSettings,
  inspectLocalRuntime,
  inspectLocalRuntimeDetailed,
  localHostsSharePortSpace,
  localProcessAlive,
  localProcessIdentity,
  PAIRING_TTL_MS,
  readLocalWorkspaceRegistry,
  rememberLocalWorkspace,
  remoteMcpUrl,
  rotateAgentToken,
  starterWorkspaceReady,
  UnsupportedLocalRuntimeSchemaError,
  UnsupportedLocalWorkspaceRegistrySchemaError,
  writeLocalRuntime,
  writeLocalWorkspaceRegistry,
  type LocalRuntimeOwner,
  type LocalRuntimeInspection,
  type LocalRuntimeRecord,
} from "@worktable/server/runtime"
import {
  formatMcpBridgeError,
  runConnector,
  runMcpBridge,
} from "@worktable/mcp-connect"
import {
  DEFAULT_AGENT_TOKEN_SCOPES,
  MCP_SNIPPET_CLIENT_IDS,
  mcpClientSnippet,
  type McpSnippetClientId,
} from "@worktable/types"
import {
  checkForUpdate,
  getCachedUpdateCheck,
  isNewerVersion,
  normalizeVersion,
  resolveLatestVersion,
  updateCheckDisabled,
  updateCheckSupported,
} from "@worktable/server/runtime"
import {
  classifyWorkspaceTarget,
  ensureInstallIdentity,
  ensureAppDir,
  getAppDir,
  inspectWorkspaceTarget,
  ensureWorkspaceManifest,
  getStaticAssetsInfo,
  hasOwnerPassword,
  importWorkspaceExport,
  importWorkspaceExportV2,
  isWorkspaceExportV2,
  prepareWorkspaceTarget,
  REACHABLE_NETWORK_NOTICE,
  setOwnerPassword,
  writeWorkspaceExport,
  writeWorkspaceExportV2,
  WorkspaceAdoptionError,
  WorkspacePreparationError,
  type WorkspaceExportHistoryPolicy,
  type WorkspaceClassification,
  type WorkspacePreparationIntent,
} from "@worktable/server/runtime"
import { ensureManagedToken } from "./mcp.ts"
import { completionPaths, registerCompletion } from "./completion.ts"
import {
  commandSkillOperation,
  commandSkillStatus,
  withPreparedSkillProjectionsDuringUninstall,
} from "./skills.ts"
import { fail, style, UsageError } from "./style.ts"

export const SETUP_INTERACTIVE_TERMINAL_REQUIRED_MESSAGE =
  "Setup needs an interactive terminal. Re-run with --yes to accept defaults or use a fully interactive terminal."

// ---------------------------------------------------------------------------
// Option types (shared between the Commander declarations and the handlers).
// ---------------------------------------------------------------------------

interface LaunchOptions {
  background?: boolean
  foreground?: boolean
  browser?: boolean
  open?: boolean
  port?: number
  host?: string
  workspace?: string
  ephemeralWorkspace?: string
  reachable?: boolean
  bind?: boolean
  ownerPassword?: string
  behindTls?: boolean
}

interface SetupOptions {
  yes?: boolean
  background?: boolean
  foreground?: boolean
  skipMcp?: boolean
  launch?: boolean
  mcp?: string
  workspace?: string
  host?: string
  port?: number
  reachable?: boolean
  bind?: boolean
  ownerPassword?: string
  behindTls?: boolean
}

/**
 * Options shape consumed by resolveReachability. `--bind` is a hidden alias of
 * `--reachable`.
 */
const REACHABLE_ACK_FAILURE =
  "Refusing to bind to all interfaces without an owner password. Run `worktable setup --reachable` to set one (or pass --owner-password <pw>)."

// The reachability reminder (REACHABLE_NETWORK_NOTICE) is shared with the server
// boot banner via @worktable/server/runtime so the copy can't drift across
// surfaces. Both `launch` and `setup` print it, suppressed when the operator has
// declared HTTPS is handled upstream (config.service.httpsUpstream).

const OWNER_PASSWORD_REQUIRED_FAILURE =
  "Refusing to bind to all interfaces without an owner password. Re-run with --owner-password <pw> (or set WORKTABLE_OWNER_PASSWORD), or use an interactive terminal to set one."

const OWNER_PASSWORD_TOO_SHORT_FAILURE =
  "Owner password must be at least 8 characters."

const OWNER_PASSWORD_MIN_LENGTH = 8

const WORKSPACE_SWITCH_AGENTS_WARNING =
  "Workspace changed on a reachable install: the managed MCP token is workspace-bound, so connected agents must be re-pointed. Run `worktable mcp setup` (or `worktable mcp repair`) to update them, or they will get 401s."

/**
 * Resolve the owner password supplied non-interactively: an explicit
 * --owner-password flag wins, else the WORKTABLE_OWNER_PASSWORD env var. Returns
 * undefined when neither is present.
 */
export function resolveOwnerPasswordOption(flag?: string): string | undefined {
  const fromFlag = flag?.trim() ? flag : undefined
  if (fromFlag !== undefined) return fromFlag
  const env = process.env["WORKTABLE_OWNER_PASSWORD"]
  return env && env.length > 0 ? env : undefined
}

function publicOriginConfiguredFromEnv(): boolean {
  const raw = process.env["WORKTABLE_PUBLIC_URL"]?.trim()
  if (!raw) return false
  try {
    const url = new URL(raw)
    return url.protocol === "http:" || url.protocol === "https:"
  } catch {
    return false
  }
}

type SetupRunMode = "background" | "foreground"

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

function parsePortOption(value: string): number {
  if (!/^\d+$/.test(value))
    throw new InvalidArgumentError("Port must be an integer from 1 to 65535.")
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidArgumentError("Port must be an integer from 1 to 65535.")
  }
  return port
}

function parsePositiveIntegerOption(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("Value must be a positive integer.")
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Value must be a positive integer.")
  }
  return parsed
}

export function assertExclusiveRunMode(opts: {
  background?: boolean
  foreground?: boolean
}): void {
  if (opts.background && opts.foreground) {
    throw new UsageError(
      "Choose either --background or --foreground, not both."
    )
  }
}

export function normalizeWorkspaceAnswer(value: string): string {
  return value.trim()
}

/**
 * Pure description of a workspace classification for the CLI: whether setup may
 * proceed, the message to show, and whether the user should confirm adoption.
 * missing/empty proceed silently; valid proceeds but asks for confirmation;
 * reject blocks with the classifier's human message.
 */
export function describeWorkspaceClassification(c: WorkspaceClassification): {
  ok: boolean
  message: string
  confirm?: boolean
} {
  switch (c.outcome) {
    case "missing":
    case "empty":
      return { ok: true, message: "" }
    case "valid":
      return {
        ok: true,
        message: `Adopting existing workspace "${c.name}".`,
        confirm: true,
      }
    case "reject":
      return { ok: false, message: c.message }
  }
}

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform
  const cmd =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", url]
        : ["xdg-open", url]
  try {
    Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
  } catch {
    // Browser opening is best-effort.
  }
}

async function healthCheck(
  host: string,
  port: number,
  timeoutMs = 750
): Promise<boolean> {
  try {
    // Probe a connectable address: a reachable install persists host as 0.0.0.0
    // (a listen wildcard), which is not a valid client target — use loopback.
    const response = await fetch(`${clientOriginFor(host, port)}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = (await response.json()) as { ok?: boolean; service?: string }
    // Require the Worktable marker so a foreign process answering /health with
    // {"ok":true} on this port is not mistaken for a running Worktable instance.
    return response.ok && body.ok === true && body.service === "worktable"
  } catch {
    return false
  }
}

function resolvedLocalRuntimeOwner(): LocalRuntimeOwner {
  const owner = process.env["WORKTABLE_LOCAL_OWNER"]?.trim()
  if (owner === "desktop" || owner === "service" || owner === "cli") {
    return owner
  }
  if (process.env["WORKTABLE_MANAGED_PID_FILE"]?.trim()) return "service"
  if (process.env["XPC_SERVICE_NAME"]?.trim() === SERVICE_LABEL)
    return "service"
  if (
    process.env["INVOCATION_ID"]?.trim() &&
    process.env["JOURNAL_STREAM"]?.trim()
  )
    return "service"
  return "cli"
}

function rememberConfiguredLocalWorkspace(
  config: WorktableConfig,
  workspace: { id: string; name: string }
): void {
  rememberLocalWorkspace({
    workspaceId: workspace.id,
    name: workspace.name,
    path: config.workspace,
    host: config.service.host,
    port: config.service.port,
  })
}

function installLocalRuntimeCleanup(runtime: LocalRuntimeRecord): void {
  const cleanup = () => {
    try {
      clearLocalRuntime(runtime.nonce)
    } catch {
      // The runtime record may already have been replaced by a newer owner.
    }
  }
  process.on("exit", cleanup)
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      cleanup()
      process.exit(0)
    })
  }
}

/** True if something is already listening on the port (any protocol). */
async function isPortOccupied(host: string, port: number): Promise<boolean> {
  const { connect } = await import("node:net")
  return new Promise<boolean>((res) => {
    const socket = connect({ host: clientHostFor(host), port })
    const settle = (occupied: boolean): void => {
      socket.destroy()
      res(occupied)
    }
    socket.setTimeout(500)
    socket.once("connect", () => settle(true))
    socket.once("timeout", () => settle(false))
    // ECONNREFUSED (and friends) means nothing is listening → port is free.
    socket.once("error", () => res(false))
  })
}

type PortState = "worktable" | "occupied" | "free"

/**
 * Classify a port BEFORE setup writes any config: our own running Worktable
 * (reuse — not a collision), a foreign listener, or free.
 * healthCheck already requires the Worktable identity
 * marker, so a foreign HTTP server answering /health is reported "occupied".
 */
async function classifyPort(host: string, port: number): Promise<PortState> {
  if (await healthCheck(host, port)) return "worktable"
  if (await isPortOccupied(host, port)) return "occupied"
  return "free"
}

/** First free port at or above `start` (skips our-Worktable and foreign listeners). */
async function findFreePort(host: string, start: number): Promise<number> {
  for (let candidate = start; candidate <= 65535; candidate += 1) {
    if ((await classifyPort(host, candidate)) === "free") return candidate
  }
  return start // exhausted — let the downstream bind fail loudly
}

async function stablePortForWorkspace(
  workspacePath: string,
  host: string,
  start: number
): Promise<number> {
  const existing = registeredLocalWorkspaceForPath(workspacePath)
  if (existing) return existing.port
  const reserved = new Set(
    readLocalWorkspaceRegistry()
      .workspaces.filter((entry) => localHostsSharePortSpace(entry.host, host))
      .map((entry) => entry.port)
  )
  for (let candidate = start; candidate <= 65535; candidate += 1) {
    if (reserved.has(candidate)) continue
    if ((await classifyPort(host, candidate)) === "free") return candidate
  }
  throw new UsageError("No free local port is available for this workspace.")
}

async function stableEndpointForWorkspace(
  workspacePath: string,
  fallback: { host: string; port: number },
  explicit: { host: boolean; port: boolean }
): Promise<{ host: string; port: number }> {
  const existing = registeredLocalWorkspaceForPath(workspacePath)
  const host = existing && !explicit.host ? existing.host : fallback.host
  if (existing && !explicit.port) return { host, port: existing.port }
  if (explicit.port) return { host, port: fallback.port }
  return {
    host,
    port: await stablePortForWorkspace(workspacePath, host, fallback.port),
  }
}

function registeredLocalWorkspaceForPath(workspacePath: string) {
  const byPath = findLocalWorkspaceByPath(workspacePath)
  if (byPath) return byPath
  const classification = classifyWorkspaceTarget(workspacePath)
  return classification.outcome === "valid"
    ? findLocalWorkspace(classification.manifest.id)
    : null
}

function hasExplicitHostSelection(opts: ReachabilityOpts): boolean {
  return (
    opts.host !== undefined ||
    opts.reachable !== undefined ||
    opts.bind !== undefined
  )
}

function printBanner(): void {
  const c = (value: string) => style.cyan(style.bold(value))
  console.log()
  console.log(c("  ┌─────────────────────────────────────────┐"))
  console.log(c("  │                                         │"))
  console.log(
    c("  │  ") +
      style.magenta("▲ ") +
      style.yellow("Work") +
      style.green("table") +
      c("                              │")
  )
  console.log(
    c("  │  ") + style.dim("Local workspace for AI agents") + c("        │")
  )
  console.log(c("  │                                         │"))
  console.log(c("  └─────────────────────────────────────────┘"))
  console.log()
}

/**
 * Point the user at the pairing flow for remote agents. Replaces the old
 * paste-ready snippet dump: the pairing installer writes the correct
 * client-specific config on the agent machine and verifies it, instead of
 * asking the user to translate a snippet into each agent's config format.
 */
function printRemoteConnectHint(): void {
  console.log()
  console.log(style.bold("Connect a remote agent:"))
  console.log()
  console.log(
    "  worktable agent invite            " +
      style.dim("# prints a one-line command to run on the agent machine")
  )
  console.log(
    `  ${style.dim("or open Settings -> Agents in the web app for the same flow with live status.")}`
  )
  console.log()
}

/**
 * The public origin a REMOTE machine should use to reach this install:
 * env override, then the configured Workspace URL, then a loopback guess
 * that only works when the "remote" agent is actually on this machine.
 */
function resolveInviteOrigin(config: WorktableConfig): {
  origin: string
  configured: boolean
} {
  const env = process.env["WORKTABLE_PUBLIC_URL"]?.trim()
  if (env) {
    const origin = asHttpOrigin(env)
    if (origin) return { origin, configured: true }
  }
  const stored = getServerSettings().network.publicUrl
  if (stored) {
    const origin = asHttpOrigin(stored)
    if (origin) return { origin, configured: true }
  }
  return {
    origin: clientOriginFor(config.service.host, config.service.port),
    configured: false,
  }
}

const INVITE_CLIENTS = CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS

async function agentInvite(opts: { client?: string }): Promise<void> {
  const config = readConfigOrFail()
  if (!config) return
  // Pairing tokens are workspace-bound (minted at redemption): bind the
  // runtime to the config's workspace like repairClients does.
  applyRuntimeConfig(config)

  let client: ConnectorInstallableMcpClientId | null = null
  if (opts.client) {
    if (!(INVITE_CLIENTS as readonly string[]).includes(opts.client)) {
      throw new UsageError(
        `Unsupported client for remote connect: ${opts.client}. ` +
          `Supported: ${INVITE_CLIENTS.join(", ")}. ` +
          "(Goose is manual: `worktable mcp print-config goose`.)"
      )
    }
    client = opts.client as ConnectorInstallableMcpClientId
  }

  const { origin, configured } = resolveInviteOrigin(config)
  const { code } = await createPairingSession({
    client,
    scopes: [...DEFAULT_AGENT_TOKEN_SCOPES],
    mcpUrl: remoteMcpUrl(origin),
  })

  console.log()
  console.log(style.bold("Run this on the machine where the agent lives:"))
  console.log()
  console.log(
    `  curl -fsSL ${origin}/connect.sh | sh -s -- ${code}${client ? ` --client ${client}` : ""}`
  )
  console.log()
  console.log(
    style.dim(
      `  The code works once and expires in ${Math.round(PAIRING_TTL_MS / 60_000)} minutes. Needs Node 18+ or Bun on that machine.`
    )
  )
  console.log(
    style.dim(
      `  It installs ${client ? `the ${client} config` : "the detected agents' configs"} with a scoped token and verifies MCP end to end.`
    )
  )
  console.log(
    style.dim(
      "  Once it connects, it appears in Settings -> Agents, where it can also be revoked."
    )
  )
  if (!configured) {
    console.log()
    console.log(
      style.yellow(
        `No Workspace URL is configured, so the command points at ${origin}, which other machines may not reach. Set one in Settings -> General (or WORKTABLE_PUBLIC_URL).`
      )
    )
  }
  console.log()
}

async function runStdioMcp(): Promise<void> {
  // Stdio is an installed CLI surface, so it must use the same workspace and
  // service endpoint as `launch` and the connection UI. Read without writing:
  // agent startup must not mutate or recreate config.
  const config = readConfigOrFail()
  if (!config) return
  applyRuntimeConfig(config)

  const [{ createWorktableMcpServer }, { StdioServerTransport }] =
    await Promise.all([
      import("@worktable/server/mcp"),
      import("@modelcontextprotocol/sdk/server/stdio.js"),
    ])
  const server = createWorktableMcpServer({ version: VERSION })
  await server.connect(new StdioServerTransport())
  console.error("[Worktable MCP] server started on stdio")
}

// ---------------------------------------------------------------------------
// doctor / paths
// ---------------------------------------------------------------------------

/**
 * Read config for a read-only command WITHOUT the write-back that ensureConfig
 * does — a diagnostic or status command must never persist config, least of all
 * the loopback defaults a corrupt read used to yield (the silent reachable
 * downgrade). An unrecoverable corrupt config becomes a clean CLI failure
 * (exit 1) with an actionable message; the caller bails on null.
 */
function readConfigOrFail(): WorktableConfig | null {
  try {
    return readConfig()
  } catch (err) {
    if (err instanceof ConfigCorruptError) {
      fail(err.message)
      return null
    }
    throw err
  }
}

async function printDoctor(check = false): Promise<void> {
  const config = readConfigOrFail()
  if (!config) return
  applyRuntimeConfig(config)
  const paths = getDoctorPaths()
  const service = getServiceStatus()
  let localRuntime: Awaited<ReturnType<typeof inspectLocalRuntime>> = null
  let localRuntimeError: string | null = null
  let localRuntimeUnsupported = false
  try {
    localRuntime = await inspectLocalRuntime()
  } catch (error) {
    localRuntimeError = error instanceof Error ? error.message : String(error)
    localRuntimeUnsupported =
      error instanceof UnsupportedLocalRuntimeSchemaError
  }
  const mcp = getMcpStatuses(config)
  console.log(style.bold("Worktable doctor"))
  console.log()
  console.log(`Version:              ${paths.version}`)
  console.log(`Platform:             ${paths.platform}`)
  console.log(`Executable:           ${paths.executable}`)
  console.log(`Release directory:    ${paths.releaseDir ?? "(none)"}`)
  console.log(`Release manifest:     ${paths.releaseManifest ?? "(none)"}`)
  console.log(`Static assets:        ${paths.staticDir ?? "(missing)"}`)
  console.log(`Static source:        ${paths.staticSource}`)
  console.log(`Workspace:            ${paths.workspace}`)
  console.log(`Workspace manifest:   ${paths.workspaceManifest}`)
  console.log(`Workspace id:         ${paths.workspaceId ?? "(unavailable)"}`)
  if (paths.workspaceError) {
    console.log(
      `${style.yellow("Workspace error:")}      ${paths.workspaceError}`
    )
    if (check) process.exitCode = 1
  }
  console.log(`App-private dir:      ${paths.appDir}`)
  console.log(`Canonical config:     ${getConfigPath()}`)
  console.log(`Install identity:     ${paths.installIdentity}`)
  console.log(`Install id:           ${paths.installId}`)
  console.log(`Service file:         ${service.serviceFile ?? "(unsupported)"}`)
  console.log(`Service state:        ${service.state}`)
  console.log(`Service logs:         ${service.logs.stdout}`)
  console.log(
    `Local host owner:      ${localRuntime?.endpointVerified ? `${localRuntime.owner} (pid ${localRuntime.pid})` : "none"}`
  )
  console.log(`Local runtime record: ${getLocalRuntimePath()}`)
  if (localRuntimeError) {
    console.log(
      `${style.yellow("Runtime warning:")}    ${localRuntimeError}.${localRuntimeUnsupported ? " Upgrade Worktable before modifying this newer runtime lease." : " Run `worktable local-host recover --json` to quarantine the invalid lease."}`
    )
    if (check) process.exitCode = 1
  }
  if (localRuntime?.processAlive && !localRuntime.endpointVerified) {
    console.log(
      `${style.yellow("Authority warning:")}  A live ${localRuntime.owner} process holds the runtime lease but did not prove ownership of ${clientOriginFor(localRuntime.host, localRuntime.port)}.`
    )
    if (check) process.exitCode = 1
  }
  if (
    localRuntime?.endpointVerified &&
    resolve(localRuntime.workspacePath) !== resolve(config.workspace)
  ) {
    console.log(
      `${style.yellow("Authority warning:")}  Running ${localRuntime.owner} host serves ${localRuntime.workspacePath}, but config points at ${config.workspace}.`
    )
    if (check) process.exitCode = 1
  }
  if (existsSync(localActivationPath())) {
    console.log(
      `${style.yellow("Activation warning:")} An interrupted workspace activation journal remains at ${localActivationPath()}.`
    )
    if (check) process.exitCode = 1
  }
  for (const warning of service.warnings ?? []) {
    console.log(`${style.yellow("Service warning:")}      ${warning}`)
    if (check) process.exitCode = 1
  }
  console.log(`MCP endpoint:         ${config.mcp.endpoint}`)
  for (const status of mcp) {
    console.log(`MCP ${status.label}:`.padEnd(22) + status.state)
  }
  if (!paths.staticDir) {
    console.log()
    console.log(
      `${style.yellow("Degraded:")} web static assets were not found.`
    )
    console.log("Checked:")
    for (const path of paths.staticChecked as string[])
      console.log(`  - ${path}`)
    if (check) process.exitCode = 1
  }
}

function commandPaths(opts: { json?: boolean }): void {
  const config = readConfigOrFail()
  if (!config) return
  applyRuntimeConfig(config)
  ensureInstallIdentity()
  try {
    ensureWorkspaceManifest()
  } catch (err) {
    if (err instanceof WorkspaceAdoptionError) {
      fail(err.message)
      return
    }
    throw err
  }
  const paths = getRuntimePaths()
  if (opts.json) {
    console.log(JSON.stringify(paths, null, 2))
    return
  }
  const labels: Record<string, string> = {
    version: "Version",
    executable: "Executable",
    releaseDir: "Release directory",
    staticDir: "Static assets",
    workspaceDir: "Workspace",
    appDir: "App-private dir",
  }
  for (const [key, label] of Object.entries(labels)) {
    console.log(`${`${label}:`.padEnd(20)}${paths[key] ?? "(none)"}`)
  }
  console.log()
  console.log(
    style.dim("Run `worktable paths --json` for machine-readable output.")
  )
}

async function commandLocalHostInspect(): Promise<void> {
  try {
    const config = readConfig()
    let registry: ReturnType<typeof readLocalWorkspaceRegistry>
    let registryError: string | null = null
    let registryErrorCode: string | null = null
    try {
      registry = readLocalWorkspaceRegistry()
    } catch (error) {
      registryError = error instanceof Error ? error.message : String(error)
      registryErrorCode =
        error instanceof UnsupportedLocalWorkspaceRegistrySchemaError
          ? "LOCAL_REGISTRY_SCHEMA_UNSUPPORTED"
          : null
      registry = {
        schemaVersion: 1,
        activeWorkspaceId: null,
        workspaces: [],
      }
    }
    let runtime: Awaited<ReturnType<typeof inspectLocalRuntime>> = null
    let runtimeError: string | null = null
    let runtimeErrorCode: string | null = null
    try {
      runtime = await inspectLocalRuntime()
    } catch (error) {
      runtimeError = error instanceof Error ? error.message : String(error)
      runtimeErrorCode =
        error instanceof UnsupportedLocalRuntimeSchemaError
          ? "LOCAL_RUNTIME_SCHEMA_UNSUPPORTED"
          : null
    }
    const service = getServiceStatus()
    const configured = existsSync(getConfigPath())
    const active = registry.activeWorkspaceId
      ? (registry.workspaces.find(
          (entry) => entry.workspaceId === registry.activeWorkspaceId
        ) ?? null)
      : null
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        ok: true,
        configured,
        config: {
          workspace: config.workspace,
          host: config.service.host,
          port: config.service.port,
          origin: clientOriginFor(config.service.host, config.service.port),
          endpoint: config.mcp.endpoint,
          reachable: config.service.reachable,
          requiresOwnerLogin:
            !isLoopbackHost(config.service.host) ||
            publicOriginConfiguredFromEnv(),
        },
        activeWorkspace: active,
        workspaces: registry.workspaces,
        registryError,
        registryErrorCode,
        runtime,
        runtimeError,
        runtimeErrorCode,
        service,
        activation: {
          pending: existsSync(localActivationPath()),
          path: localActivationPath(),
        },
        logs: {
          desktop: join(getAppDir(), "logs", "desktop-host.log"),
          serviceStdout: service.logs.stdout,
          serviceStderr: service.logs.stderr,
        },
      })
    )
  } catch (error) {
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        ok: false,
        error: {
          code:
            error instanceof ConfigCorruptError
              ? "CONFIG_CORRUPT"
              : "LOCAL_AUTHORITY_UNAVAILABLE",
          message: error instanceof Error ? error.message : String(error),
        },
      })
    )
    process.exitCode = 1
  }
}

const LOCAL_ACTIVATION_FILE = "local-activation.json"
const LOCAL_AUTHORITY_LOCK_FILE = "local-authority.lock"
const LOCAL_AUTHORITY_RECOVERY_FILE = "local-authority.recovery"

interface LocalActivationJournal {
  schemaVersion: 1
  operationId: string
  startedAt: string
  targetWorkspace: string
  configExisted: boolean
  registryExisted: boolean
  beforeConfig: WorktableConfig
  beforeRegistry: ReturnType<typeof readLocalWorkspaceRegistry>
  serviceInstalled: boolean
  serviceWasRunning: boolean
  servicePublicUrl: string | null
}

interface LocalAuthorityLock {
  handoff: string
  nonce: string
  ownerIdentity: string | null
  release: () => void
}

interface LocalAuthorityLockRecord {
  schemaVersion?: unknown
  pid?: unknown
  nonce?: unknown
  ownerIdentity?: unknown
}

interface LocalAuthorityStateSnapshot {
  config: string | null
  registry: string | null
  service: string
}

function localActivationPath(): string {
  return resolve(ensureAppDir(), LOCAL_ACTIVATION_FILE)
}

function assertNoPendingLocalActivation(action: string): void {
  if (!existsSync(localActivationPath())) return
  throw new UsageError(
    `A previous local workspace activation did not finish. Run \`worktable local-host recover --json\` before ${action}.`
  )
}

function localAuthorityLockPath(): string {
  return resolve(ensureAppDir(), LOCAL_AUTHORITY_LOCK_FILE)
}

function localAuthorityRecoveryPath(): string {
  return resolve(ensureAppDir(), LOCAL_AUTHORITY_RECOVERY_FILE)
}

function readOptionalAuthorityFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

function snapshotLocalAuthorityState(
  service = getServiceStatus()
): LocalAuthorityStateSnapshot {
  return {
    config: readOptionalAuthorityFile(getConfigPath()),
    registry: readOptionalAuthorityFile(getLocalWorkspaceRegistryPath()),
    service: JSON.stringify(service),
  }
}

function assertLocalAuthorityStateUnchanged(
  before: LocalAuthorityStateSnapshot,
  currentService: ServiceStatus
): void {
  const after = snapshotLocalAuthorityState(currentService)
  if (
    before.config !== after.config ||
    before.registry !== after.registry ||
    before.service !== after.service
  ) {
    throw new UsageError(
      "The local Worktable installation changed while this command was waiting for input. Run the command again to continue from the current state."
    )
  }
}

function isVerifiedManagedServiceRuntime(
  runtime: Awaited<ReturnType<typeof inspectLocalRuntime>>,
  service: Pick<ServiceStatus, "installed" | "state">
): boolean {
  return Boolean(
    runtime?.endpointVerified &&
    service.installed &&
    service.state === "running" &&
    serviceManagerOwnsRuntimePid(runtime.pid)
  )
}

function loadStableConfigForSetup(): {
  config: WorktableConfig
  recreated: boolean
  configFile: string | null
} {
  const path = getConfigPath()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = readOptionalAuthorityFile(path)
    const loaded = loadConfigForRecreate()
    const after = readOptionalAuthorityFile(path)
    if (before === after) return { ...loaded, configFile: after }
    // readConfig may legitimately restore a valid backup on the first pass.
    // Repeat so the values used for prompts are tied to one stable file image.
  }
  throw new UsageError(
    "The local Worktable configuration kept changing while setup started. Run setup again after the other Worktable operation finishes."
  )
}

function publishCompleteExclusiveJson(
  target: string,
  value: unknown,
  nonce: string
): boolean {
  const candidate = `${target}.${process.pid}.${nonce}.candidate`
  let fd: number | null = openSync(candidate, "wx", 0o600)
  try {
    writeFileSync(fd, JSON.stringify(value) + "\n")
    try {
      fsyncSync(fd)
    } catch {
      // Best effort on filesystems without fsync support. The hard link below
      // still makes the fully written inode visible in one atomic operation.
    }
    closeSync(fd)
    fd = null
    linkSync(candidate, target)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  } finally {
    if (fd !== null) closeSync(fd)
    rmSync(candidate, { force: true })
  }
}

function readLocalAuthorityRecord(
  path: string
): LocalAuthorityLockRecord | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LocalAuthorityLockRecord
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new UsageError(
      "Worktable found an incomplete local transition lock. Wait a moment and try again; if it remains, run `worktable doctor`."
    )
  }
}

function removeOwnedAuthorityRecord(
  path: string,
  pid: number,
  nonce: string
): void {
  try {
    const current = JSON.parse(readFileSync(path, "utf8")) as {
      pid?: unknown
      nonce?: unknown
    }
    if (current.pid === pid && current.nonce === nonce) {
      rmSync(path, { force: true })
    }
  } catch {
    // A replaced or already-removed record belongs to another transition.
  }
}

function localAuthorityLockOwnerIsLive(
  lock: LocalAuthorityLockRecord
): boolean {
  if (
    typeof lock.pid !== "number" ||
    !Number.isInteger(lock.pid) ||
    lock.pid <= 0 ||
    !localProcessAlive(lock.pid)
  ) {
    return false
  }
  // Version 1 locks predate process-start identities. Keep them conservative:
  // never evict a PID that might still own an in-flight older transition.
  if (lock.schemaVersion !== 2 || typeof lock.ownerIdentity !== "string") {
    return true
  }
  const currentIdentity = localProcessIdentity(lock.pid)
  // If the OS refuses the identity query, preserve the live lock. A positive
  // mismatch is the only safe proof that the PID has been recycled.
  return currentIdentity === null || currentIdentity === lock.ownerIdentity
}

/**
 * Serialize workspace/config/service transitions across the CLI and Desktop
 * sidecar. The lock is intentionally a small pid-bearing file rather than an
 * in-process mutex: every local surface runs the same binary in a different
 * process. Dead-owner locks are recovered automatically; a live owner is never
 * displaced.
 */
function acquireLocalAuthorityLock(): LocalAuthorityLock {
  const path = localAuthorityLockPath()
  const recoveryPath = localAuthorityRecoveryPath()
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const ownerIdentity = localProcessIdentity(process.pid)
  const record = {
    schemaVersion: 2,
    pid: process.pid,
    nonce,
    ownerIdentity,
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (existsSync(recoveryPath)) {
      const recovery = readLocalAuthorityRecord(recoveryPath)
      if (!recovery) continue
      if (localAuthorityLockOwnerIsLive(recovery)) {
        throw new UsageError(
          "Another Worktable workspace or service transition is already recovering local authority. Wait for it to finish and try again."
        )
      }
      if (
        typeof recovery.pid === "number" &&
        typeof recovery.nonce === "string"
      ) {
        removeOwnedAuthorityRecord(recoveryPath, recovery.pid, recovery.nonce)
        if (!existsSync(recoveryPath)) continue
      }
      throw new UsageError(
        "A previous Worktable authority recovery was interrupted and its ownership record is invalid. Run `worktable doctor` before changing workspaces again."
      )
    }

    if (publishCompleteExclusiveJson(path, record, nonce)) {
      // A stale-lock recovery may have started after our first check. Such a
      // contender must not become an owner while recovery is in flight.
      if (existsSync(recoveryPath)) {
        removeOwnedAuthorityRecord(path, process.pid, nonce)
        continue
      }
      return {
        handoff: JSON.stringify({ pid: process.pid, nonce }),
        nonce,
        ownerIdentity,
        release: () => removeOwnedAuthorityRecord(path, process.pid, nonce),
      }
    }

    const current = readLocalAuthorityRecord(path)
    if (!current) continue
    if (localAuthorityLockOwnerIsLive(current)) {
      throw new UsageError(
        "Another Worktable workspace or service transition is already running. Wait for it to finish and try again."
      )
    }

    const recoveryNonce = `${nonce}-recovery-${attempt}`
    const recoveryRecord = { ...record, nonce: recoveryNonce }
    if (
      !publishCompleteExclusiveJson(recoveryPath, recoveryRecord, recoveryNonce)
    ) {
      continue
    }
    try {
      // Re-read under the recovery claim. If the old owner released and a new
      // process published in the meantime, its complete record proves that it
      // must be preserved. New contenders also check the recovery claim before
      // treating their publication as ownership.
      if (existsSync(path)) {
        const guardedCurrent = readLocalAuthorityRecord(path)
        if (!guardedCurrent) continue
        if (localAuthorityLockOwnerIsLive(guardedCurrent)) {
          throw new UsageError(
            "Another Worktable workspace or service transition is already running. Wait for it to finish and try again."
          )
        }
        rmSync(path, { force: true })
      }
    } finally {
      removeOwnedAuthorityRecord(recoveryPath, process.pid, recoveryNonce)
    }
  }
  throw new UsageError(
    "Worktable could not acquire the local workspace transition lock. Run `worktable doctor` and try again."
  )
}

function inheritedLocalAuthorityHandoffIsValid(): boolean {
  const raw = process.env["WORKTABLE_LOCAL_AUTHORITY_HANDOFF"]?.trim()
  if (raw) {
    try {
      const handoff = JSON.parse(raw) as { pid?: unknown; nonce?: unknown }
      if (
        typeof handoff.pid === "number" &&
        Number.isInteger(handoff.pid) &&
        handoff.pid > 0 &&
        typeof handoff.nonce === "string" &&
        handoff.nonce.length >= 16 &&
        localProcessAlive(handoff.pid)
      ) {
        const lock = JSON.parse(
          readFileSync(localAuthorityLockPath(), "utf8")
        ) as LocalAuthorityLockRecord
        if (
          lock.pid === handoff.pid &&
          lock.nonce === handoff.nonce &&
          localAuthorityLockOwnerIsLive(lock)
        ) {
          return true
        }
      }
    } catch {
      // A stale installed handoff may remain in a service artifact. The
      // background-update marker below can still provide the current handoff.
    }
  }
  return activeBackgroundUpdateAuthorityHandoffIsValid()
}

function activeBackgroundUpdateAuthorityHandoffIsValid(): boolean {
  if (process.env["WORKTABLE_LOCAL_OWNER"]?.trim() !== "service") return false
  const update = readUpdateStatus()
  if (
    update.state !== "restarting" ||
    typeof update.pid !== "number" ||
    !Number.isInteger(update.pid) ||
    update.pid <= 0 ||
    typeof update.authorityNonce !== "string" ||
    update.authorityNonce.length < 16
  ) {
    return false
  }
  try {
    const lock = JSON.parse(
      readFileSync(localAuthorityLockPath(), "utf8")
    ) as LocalAuthorityLockRecord
    return (
      lock.pid === update.pid &&
      lock.nonce === update.authorityNonce &&
      (update.authorityOwnerIdentity === undefined ||
        lock.ownerIdentity === update.authorityOwnerIdentity) &&
      localAuthorityLockOwnerIsLive(lock)
    )
  } catch {
    return false
  }
}

async function acquireBackgroundUpdateAuthorityLock(
  timeoutMs = 60_000
): Promise<LocalAuthorityLock> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      return acquireLocalAuthorityLock()
    } catch (error) {
      const retryable =
        error instanceof UsageError &&
        (error.message.includes("transition is already running") ||
          error.message.includes("already recovering local authority"))
      if (!retryable || Date.now() >= deadline) throw error
      await Bun.sleep(100)
    }
  }
}

function withLocalAuthorityLock<T>(
  operation: (authorityLock: LocalAuthorityLock) => T
): T {
  const authorityLock = acquireLocalAuthorityLock()
  try {
    return operation(authorityLock)
  } finally {
    authorityLock.release()
  }
}

const LOCAL_RUNTIME_READINESS_TIMEOUT_MS = 12_000
const LOCAL_RUNTIME_READINESS_BACKOFF_MS = 250
const LOCAL_RUNTIME_PROBE_TIMEOUT_MS = 1_500

type ExactRuntimeReadiness =
  | { ok: true; runtime: LocalRuntimeInspection }
  | {
      ok: false
      reason: ExactRuntimeReadinessFailure
    }

export async function waitForExactLocalRuntime(
  expected: {
    workspaceId?: string
    workspacePath: string
    host: string
    port: number
  },
  options: {
    owner?: LocalRuntimeOwner
    requireManagedService?: boolean
    waitForLease?: boolean
    readinessTimeoutMs?: number
    probeTimeoutMs?: number
    backoffMs?: number
  } = {}
): Promise<ExactRuntimeReadiness> {
  const deadline =
    Date.now() +
    (options.readinessTimeoutMs ?? LOCAL_RUNTIME_READINESS_TIMEOUT_MS)
  let lastRetry: "pending" | "unreachable" = "pending"

  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      return {
        ok: false,
        reason:
          lastRetry === "unreachable"
            ? "unreachable-deadline"
            : "pending-deadline",
      }
    }

    let runtime = await inspectLocalRuntimeDetailed(
      Math.max(
        1,
        Math.min(
          options.probeTimeoutMs ?? LOCAL_RUNTIME_PROBE_TIMEOUT_MS,
          remaining
        )
      )
    )
    let worktableWithoutLiveLease = false
    if (
      !runtime?.processAlive &&
      (await healthCheck(
        expected.host,
        expected.port,
        Math.max(1, Math.min(750, deadline - Date.now()))
      ))
    ) {
      // A valid service may publish while the ordinary health request is in
      // flight. Refresh authenticated state before declaring a responsive
      // Worktable endpoint unleased and stopping it as a wrong child.
      runtime = await inspectLocalRuntimeDetailed(
        Math.max(
          1,
          Math.min(
            options.probeTimeoutMs ?? LOCAL_RUNTIME_PROBE_TIMEOUT_MS,
            deadline - Date.now()
          )
        )
      )
      worktableWithoutLiveLease = !runtime?.processAlive
    }
    if (
      runtime?.processAlive &&
      options.owner &&
      runtime.owner !== options.owner
    ) {
      return { ok: false, reason: "owner-conflict" }
    }
    const decision = classifyRuntimeReadiness(
      {
        runtime,
        endpointState: runtime?.endpointState ?? "unreachable",
        worktableWithoutLiveLease,
      },
      expected
    )

    if (decision.action === "ready") {
      // Manager inspection can spawn launchctl/systemctl. Run it once, only
      // after the candidate has supplied exact authenticated endpoint proof.
      if (
        options.requireManagedService &&
        !serviceManagerOwnsRuntimePid(runtime!.pid)
      ) {
        return { ok: false, reason: "manager-conflict" }
      }
      return { ok: true, runtime: runtime! }
    }
    if (decision.action === "reject") {
      return { ok: false, reason: decision.reason }
    }
    if (options.waitForLease === false && !runtime?.processAlive) {
      return { ok: false, reason: "absent" }
    }

    lastRetry = decision.reason
    const backoff = Math.min(
      options.backoffMs ?? LOCAL_RUNTIME_READINESS_BACKOFF_MS,
      deadline - Date.now()
    )
    if (backoff <= 0) continue
    await Bun.sleep(backoff)
  }
}

async function verifyManagedServiceReady(
  config: WorktableConfig,
  status: ServiceStatus,
  workspaceId?: string
): Promise<void> {
  if (status.state !== "running") {
    throw new ServiceLifecycleError(serviceStartError(status))
  }
  const readiness = await waitForExactLocalRuntime(
    {
      ...(workspaceId ? { workspaceId } : {}),
      workspacePath: config.workspace,
      host: config.service.host,
      port: config.service.port,
    },
    { owner: "service", requireManagedService: true }
  )
  if (readiness.ok) return
  const failure = describeRuntimeReadinessFailure(
    readiness.reason,
    clientOriginFor(config.service.host, config.service.port)
  )
  const failureWithLogs = `${failure} Service logs: ${status.logs.stderr}`

  // A start that cannot prove the exact destination must not leave an ambiguous
  // managed child alive after the authority lock is released. Stop it while the
  // transition is still serialized; if that also fails, report both facts.
  try {
    stopService()
  } catch (error) {
    if (error instanceof ServiceLifecycleError) {
      throw new ServiceLifecycleError(
        `${failureWithLogs} Worktable also could not stop the unverified service: ${error.message}`
      )
    }
    throw error
  }
  throw new ServiceLifecycleError(failureWithLogs)
}

async function startInstalledServiceWithAuthority(
  restart: boolean
): Promise<ServiceStatus> {
  const authorityLock = acquireLocalAuthorityLock()
  try {
    assertNoPendingLocalActivation("starting Worktable")
    const service = getServiceStatus()
    if (!service.installed) return startService()
    const config = readConfig()
    const publicUrl = getInstalledServicePublicUrl()
    if (restart && service.state === "running") stopService()
    installService(config, {
      ...(publicUrl ? { publicUrl } : {}),
      authorityHandoff: authorityLock.handoff,
    })
    const status = startService()
    await verifyManagedServiceReady(config, status)
    return status
  } finally {
    authorityLock.release()
  }
}

function writeLocalActivationJournal(journal: LocalActivationJournal): void {
  const path = localActivationPath()
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  const fd = openSync(temporary, "wx", 0o600)
  try {
    writeFileSync(fd, JSON.stringify(journal, null, 2) + "\n")
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temporary, path)
    let directory: number | null = null
    try {
      directory = openSync(dirname(path), "r")
      fsyncSync(directory)
    } catch {
      // Some filesystems do not support directory fsync. Atomic rename still
      // prevents readers from observing a partial journal.
    } finally {
      if (directory !== null) closeSync(directory)
    }
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

function removeLocalActivationJournal(): void {
  rmSync(localActivationPath(), { force: true })
}

function rollbackLocalActivation(journal: LocalActivationJournal): void {
  if (journal.configExisted) {
    writeConfig(journal.beforeConfig)
  } else {
    rmSync(getConfigPath(), { force: true })
    rmSync(getConfigBackupPath(), { force: true })
  }
  if (journal.registryExisted) {
    writeLocalWorkspaceRegistry(journal.beforeRegistry)
  } else {
    rmSync(getLocalWorkspaceRegistryPath(), { force: true })
  }
  applyRuntimeConfig(journal.beforeConfig)
}

async function provenCurrentActivationTarget(
  journal: LocalActivationJournal
): Promise<{
  config: WorktableConfig
  manifest: { id: string; name: string }
} | null> {
  try {
    const classification = classifyWorkspaceTarget(journal.targetWorkspace)
    if (classification.outcome !== "valid") return null
    const config = readConfig()
    if (resolve(config.workspace) !== resolve(journal.targetWorkspace))
      return null
    // The attach may have been interrupted between writing config and updating
    // the registry. A stale entry for this same identity is repairable; a real
    // path/endpoint reservation by another workspace is not.
    assertLocalWorkspaceReservationAvailable({
      workspaceId: classification.manifest.id,
      path: journal.targetWorkspace,
      host: config.service.host,
      port: config.service.port,
    })
    const readiness = await waitForExactLocalRuntime(
      {
        workspaceId: classification.manifest.id,
        workspacePath: journal.targetWorkspace,
        host: config.service.host,
        port: config.service.port,
      },
      { waitForLease: false }
    )
    if (!readiness.ok) return null
    return { config, manifest: classification.manifest }
  } catch {
    // Recovery can still use the journal's known-good before-state when the
    // partially committed current state is corrupt or otherwise unreadable.
    return null
  }
}

function printLocalHostMachineError(code: string, error: unknown): void {
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      ok: false,
      error: {
        code,
        message: error instanceof Error ? error.message : String(error),
      },
    })
  )
  process.exitCode = 1
}

async function commandLocalHostActivate(
  directory: string,
  opts: { port?: number; waitForWelcome?: boolean }
): Promise<void> {
  const targetPath = resolve(directory)
  let journal: LocalActivationJournal | null = null
  let previousService: ServiceStatus | null = null
  let serviceMutationStarted = false
  let authorityLock: LocalAuthorityLock | null = null
  try {
    authorityLock = acquireLocalAuthorityLock()
    if (existsSync(localActivationPath())) {
      throw new UsageError(
        "A previous local workspace activation did not finish. Run `worktable doctor` before changing workspaces again."
      )
    }
    const classification = classifyWorkspaceTarget(targetPath)
    if (classification.outcome !== "valid") {
      const described = describeWorkspaceClassification(classification)
      throw new UsageError(
        described.message ||
          `Workspace ${targetPath} must be prepared before activation.`
      )
    }
    const beforeConfig = readConfig()
    const beforeRegistry = readLocalWorkspaceRegistry()
    let observedRuntime = await inspectLocalRuntimeDetailed()
    if (
      observedRuntime?.processAlive &&
      observedRuntime.endpointState === "unreachable"
    ) {
      const readiness = await waitForExactLocalRuntime(
        {
          workspaceId: observedRuntime.workspaceId,
          workspacePath: observedRuntime.workspacePath,
          host: observedRuntime.host,
          port: observedRuntime.port,
        },
        { owner: observedRuntime.owner, waitForLease: false }
      )
      if (readiness.ok) {
        observedRuntime = readiness.runtime
      } else if (readiness.reason === "absent") {
        observedRuntime = await inspectLocalRuntimeDetailed()
      }
    }
    const runtime = observedRuntime
    const currentService = getServiceStatus()
    previousService = currentService
    if (runtime?.processAlive && !runtime.endpointVerified) {
      throw new UsageError(
        `A live ${runtime.owner} process still holds the local Worktable runtime lease but did not answer its ownership proof. Stop or repair that host before changing the shared local workspace.`
      )
    }
    const runningWorkspaceMatches =
      runtime?.endpointVerified &&
      runtime.workspaceId === classification.manifest.id &&
      resolve(runtime.workspacePath) === targetPath
    if (
      runtime?.endpointVerified &&
      !runningWorkspaceMatches &&
      !isVerifiedManagedServiceRuntime(runtime, currentService)
    ) {
      throw new UsageError(
        `${runtime.owner === "desktop" ? "Worktable Desktop" : runtime.owner === "service" ? "An unmanaged service process" : "A foreground Worktable command"} is currently serving ${runtime.workspacePath}. Stop it before switching the shared local workspace.`
      )
    }
    if (currentService.installed && currentService.state === "unknown") {
      throw new UsageError(
        "The background service is installed but its manager is unavailable, so Worktable cannot switch its workspace safely from this session."
      )
    }

    const known = registeredLocalWorkspaceForPath(targetPath)
    const sameConfiguredWorkspace =
      resolve(beforeConfig.workspace) === targetPath
    const sameRunningWorkspace = runningWorkspaceMatches
    const host = sameRunningWorkspace
      ? runtime.host
      : (known?.host ?? beforeConfig.service.host)
    const port =
      (sameRunningWorkspace ? runtime.port : known?.port) ??
      (sameConfiguredWorkspace
        ? beforeConfig.service.port
        : (opts.port ??
          (await stablePortForWorkspace(
            targetPath,
            host,
            beforeConfig.service.port
          ))))
    const nextConfig: WorktableConfig = {
      ...beforeConfig,
      workspace: targetPath,
      service: {
        ...beforeConfig.service,
        host,
        port,
        reachable:
          host === beforeConfig.service.host
            ? beforeConfig.service.reachable
            : !isLoopbackHost(host),
        exposureAcknowledged:
          sameConfiguredWorkspace &&
          host.toLowerCase() === beforeConfig.service.host.toLowerCase()
            ? beforeConfig.service.exposureAcknowledged
            : false,
      },
      mcp: {
        ...beforeConfig.mcp,
        endpoint: endpointFor(host, port),
      },
    }
    const createJournal = (): LocalActivationJournal => ({
      schemaVersion: 1,
      operationId: `activate-${process.pid}-${Date.now()}`,
      startedAt: new Date().toISOString(),
      targetWorkspace: targetPath,
      configExisted: existsSync(getConfigPath()),
      registryExisted: existsSync(getLocalWorkspaceRegistryPath()),
      beforeConfig,
      beforeRegistry,
      serviceInstalled: currentService.installed,
      serviceWasRunning: currentService.state === "running",
      servicePublicUrl: getInstalledServicePublicUrl() ?? null,
    })

    if (
      sameRunningWorkspace &&
      runtime.port === port &&
      runtime.host === nextConfig.service.host
    ) {
      journal = createJournal()
      writeLocalActivationJournal(journal)
      writeConfig(nextConfig)
      applyRuntimeConfig(nextConfig)
      rememberConfiguredLocalWorkspace(nextConfig, classification.manifest)
      if (opts.waitForWelcome) {
        const deadline = Date.now() + 30_000
        while (!(await starterWorkspaceReady())) {
          if (Date.now() >= deadline) {
            throw new UsageError(
              "The local host is running, but the Welcome space was not ready in time."
            )
          }
          await Bun.sleep(100)
        }
      }
      removeLocalActivationJournal()
      journal = null
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          ok: true,
          action: "attach",
          owner: runtime.owner,
          workspace: {
            id: classification.manifest.id,
            name: classification.manifest.name,
            path: targetPath,
          },
          host: nextConfig.service.host,
          port,
          origin: clientOriginFor(nextConfig.service.host, port),
          requiresOwnerLogin:
            !isLoopbackHost(nextConfig.service.host) ||
            publicOriginConfiguredFromEnv(),
          logsPath: join(getAppDir(), "logs", "desktop-host.log"),
        })
      )
      return
    }

    const portState = await classifyPort(nextConfig.service.host, port)
    if (portState !== "free" && !currentService.installed) {
      throw new UsageError(
        portState === "worktable"
          ? `Another Worktable process is using ${clientOriginFor(nextConfig.service.host, port)}, but it does not carry the shared ownership proof. Restart that process before attaching Desktop.`
          : `Port ${port} is already in use by another process.`
      )
    }

    if (currentService.installed) prepareServiceInstall()
    journal = createJournal()
    writeLocalActivationJournal(journal)

    serviceMutationStarted = currentService.installed
    if (currentService.installed && currentService.state === "running") {
      stopService()
    }
    writeConfig(nextConfig)
    applyRuntimeConfig(nextConfig)
    ensureInstallIdentity()
    rememberConfiguredLocalWorkspace(nextConfig, classification.manifest)

    if (currentService.installed) {
      installService(nextConfig, {
        ...(journal.servicePublicUrl
          ? { publicUrl: journal.servicePublicUrl }
          : {}),
        authorityHandoff: authorityLock.handoff,
      })
      const started = startService()
      await verifyManagedServiceReady(
        nextConfig,
        started,
        classification.manifest.id
      )
      if (opts.waitForWelcome) {
        const deadline = Date.now() + 30_000
        while (!(await starterWorkspaceReady())) {
          if (Date.now() >= deadline) {
            throw new ServiceLifecycleError(
              "The Worktable service started, but the Welcome space was not ready in time."
            )
          }
          await Bun.sleep(100)
        }
      }
    }

    removeLocalActivationJournal()
    journal = null
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        ok: true,
        action: currentService.installed ? "attach" : "start-owned",
        owner: currentService.installed ? "service" : null,
        workspace: {
          id: classification.manifest.id,
          name: classification.manifest.name,
          path: targetPath,
        },
        host: nextConfig.service.host,
        port,
        origin: clientOriginFor(nextConfig.service.host, port),
        requiresOwnerLogin:
          !isLoopbackHost(nextConfig.service.host) ||
          publicOriginConfiguredFromEnv(),
        logsPath: join(getAppDir(), "logs", "desktop-host.log"),
      })
    )
  } catch (error) {
    let rollbackError: unknown = null
    if (journal) {
      try {
        if (!serviceMutationStarted) {
          const provenTarget = await provenCurrentActivationTarget(journal)
          if (provenTarget) {
            // The reconciliation completed and only a later readiness check
            // failed. Preserve metadata that matches the still-proven host.
            applyRuntimeConfig(provenTarget.config)
            rememberConfiguredLocalWorkspace(
              provenTarget.config,
              provenTarget.manifest
            )
            removeLocalActivationJournal()
            journal = null
          }
        }
        if (journal) {
          const rollbackJournal = journal
          if (
            serviceMutationStarted &&
            previousService?.installed &&
            getServiceStatus().state === "running"
          ) {
            stopService()
          }
          rollbackLocalActivation(rollbackJournal)
          if (serviceMutationStarted && previousService?.installed) {
            installService(rollbackJournal.beforeConfig, {
              ...(rollbackJournal.servicePublicUrl
                ? { publicUrl: rollbackJournal.servicePublicUrl }
                : {}),
              authorityHandoff: authorityLock?.handoff,
            })
            if (previousService.state === "running") {
              await startAndVerifyRestoredLocalService(
                rollbackJournal.beforeConfig
              )
            }
          }
          removeLocalActivationJournal()
        }
      } catch (caught) {
        rollbackError = caught
      }
    }
    printLocalHostMachineError(
      rollbackError ? "ACTIVATION_ROLLBACK_FAILED" : "ACTIVATION_FAILED",
      rollbackError
        ? `${error instanceof Error ? error.message : String(error)} Rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        : error
    )
  } finally {
    authorityLock?.release()
  }
}

async function commandLocalHostRestart(): Promise<void> {
  let authorityLock: LocalAuthorityLock | null = null
  try {
    authorityLock = acquireLocalAuthorityLock()
    assertNoPendingLocalActivation("restarting Worktable")
    const config = readConfig()
    const runtime = await inspectLocalRuntime()
    const service = getServiceStatus()
    if (
      runtime?.endpointVerified &&
      runtime.owner === "cli" &&
      !serviceManagerOwnsRuntimePid(runtime.pid)
    ) {
      throw new UsageError(
        "A foreground Worktable command owns this endpoint. Stop it in that terminal before restarting from Desktop."
      )
    }
    if (!service.installed) {
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          ok: true,
          action: "restart-owned",
        })
      )
      return
    }
    const servicePublicUrl = getInstalledServicePublicUrl()
    installService(config, {
      ...(servicePublicUrl ? { publicUrl: servicePublicUrl } : {}),
      authorityHandoff: authorityLock.handoff,
    })
    // installService rewrites the artifact but does not load a stopped launchd
    // job. Bootstrap a stopped service; use the manager's real restart operation
    // for a running service so systemd also reloads the new process environment.
    const restarted =
      localHostServiceStartMode(service) === "restart"
        ? restartService()
        : startService()
    await verifyManagedServiceReady(config, restarted)
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        ok: true,
        action: "attach",
        owner: "service",
      })
    )
  } catch (error) {
    printLocalHostMachineError("RESTART_FAILED", error)
  } finally {
    authorityLock?.release()
  }
}

async function startAndVerifyRestoredLocalService(
  config: WorktableConfig
): Promise<void> {
  const started = startService()
  await verifyManagedServiceReady(config, started)
}

async function commandLocalHostRecover(): Promise<void> {
  let authorityLock: LocalAuthorityLock | null = null
  try {
    authorityLock = acquireLocalAuthorityLock()
    const path = localActivationPath()
    if (!existsSync(path)) {
      const runtimeRepair = await repairUnusableLocalRuntime()
      const registryRepair = repairInvalidLocalWorkspaceRegistry()
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          ok: true,
          action: runtimeRepair || registryRepair ? "repaired" : "none",
          runtimeRepair,
          registryRepair,
        })
      )
      return
    }
    const journal = JSON.parse(
      readFileSync(path, "utf8")
    ) as LocalActivationJournal
    if (
      journal.schemaVersion !== 1 ||
      !journal.beforeConfig ||
      !journal.beforeRegistry ||
      typeof journal.serviceInstalled !== "boolean" ||
      typeof journal.serviceWasRunning !== "boolean" ||
      !(
        journal.servicePublicUrl === undefined ||
        journal.servicePublicUrl === null ||
        typeof journal.servicePublicUrl === "string"
      )
    ) {
      throw new UsageError(
        `The activation journal at ${path} is invalid. Preserve it and repair config.json manually.`
      )
    }

    // A prior activation may have reached (or merely attached to) the target
    // runtime and then been interrupted before deleting its journal. When the
    // current config plus the live server prove the exact target tuple, roll the
    // registry forward to that authority instead of tearing it down and restoring
    // stale metadata beneath it.
    const provenTarget = await provenCurrentActivationTarget(journal)
    if (provenTarget) {
      applyRuntimeConfig(provenTarget.config)
      rememberConfiguredLocalWorkspace(
        provenTarget.config,
        provenTarget.manifest
      )
      removeLocalActivationJournal()
      console.log(
        JSON.stringify({
          schemaVersion: 1,
          ok: true,
          action: "repaired",
          workspace: provenTarget.config.workspace,
          runtimeRepair: "reconciled-proven-runtime",
        })
      )
      return
    }
    if (journal.serviceInstalled && getServiceStatus().state === "running") {
      stopService()
    }
    await repairUnusableLocalRuntime()
    rollbackLocalActivation(journal)
    if (journal.serviceInstalled) {
      installService(journal.beforeConfig, {
        ...(journal.servicePublicUrl
          ? { publicUrl: journal.servicePublicUrl }
          : {}),
        authorityHandoff: authorityLock.handoff,
      })
      if (journal.serviceWasRunning) {
        await startAndVerifyRestoredLocalService(journal.beforeConfig)
      }
    }
    removeLocalActivationJournal()
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        ok: true,
        action: "rolled-back",
        workspace: journal.beforeConfig.workspace,
      })
    )
  } catch (error) {
    printLocalHostMachineError("RECOVERY_FAILED", error)
  } finally {
    authorityLock?.release()
  }
}

function repairInvalidLocalWorkspaceRegistry():
  | "quarantined-corrupt-registry"
  | "rebuilt-corrupt-registry"
  | null {
  const path = getLocalWorkspaceRegistryPath()
  if (!existsSync(path)) return null
  try {
    readLocalWorkspaceRegistry()
    return null
  } catch (error) {
    if (error instanceof UnsupportedLocalWorkspaceRegistrySchemaError) {
      throw new UsageError(
        `${error.message}. Upgrade Worktable before repairing local workspace state; this registry was left untouched.`
      )
    }
    const quarantine = join(
      dirname(path),
      `local-workspaces.corrupt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.json`
    )
    renameSync(path, quarantine)
    const config = readConfig()
    const classification = classifyWorkspaceTarget(config.workspace)
    if (classification.outcome !== "valid") {
      return "quarantined-corrupt-registry"
    }
    rememberConfiguredLocalWorkspace(config, classification.manifest)
    return "rebuilt-corrupt-registry"
  }
}

async function repairUnusableLocalRuntime(): Promise<
  "cleared-stale-runtime" | "quarantined-corrupt-runtime" | null
> {
  const path = getLocalRuntimePath()
  if (!existsSync(path)) return null
  let runtime: Awaited<ReturnType<typeof inspectLocalRuntime>>
  try {
    runtime = await inspectLocalRuntime()
  } catch (error) {
    if (error instanceof UnsupportedLocalRuntimeSchemaError) {
      throw new UsageError(
        `${error.message}. Upgrade Worktable before repairing local host state; this lease was left untouched.`
      )
    }
    const quarantine = join(
      dirname(path),
      `local-runtime.corrupt-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2)}.json`
    )
    renameSync(path, quarantine)
    return "quarantined-corrupt-runtime"
  }
  if (!runtime) return null
  if (runtime.processAlive) {
    if (!runtime.endpointVerified) {
      throw new UsageError(
        `A live ${runtime.owner} process still holds the local Worktable runtime lease but did not answer its ownership proof. Stop that process before repairing local host state.`
      )
    }
    return null
  }
  rmSync(path, { force: true })
  return "cleared-stale-runtime"
}

async function commandWorkspaceExport(
  file: string,
  opts: {
    force?: boolean
    format: "wtb" | "legacy-json"
    history: "all" | "age" | "count" | "none"
    historyDays: number
    historyCount: number
  }
): Promise<void> {
  const config = readConfigOrFail()
  if (!config) return
  applyRuntimeConfig(config)
  if (opts.format === "legacy-json") {
    const bundle = await writeWorkspaceExport(file, { force: opts.force })
    console.log(`Exported ${bundle.files.length} files to ${resolve(file)}`)
    console.log(`Source workspace: ${bundle.sourceWorkspaceId}`)
    console.log(`Checkpoint: ${bundle.sourceCheckpoint}`)
    return
  }
  const history: WorkspaceExportHistoryPolicy =
    opts.history === "age"
      ? { mode: "age", maxAgeDays: opts.historyDays }
      : opts.history === "count"
        ? { mode: "count", maxPerItem: opts.historyCount }
        : { mode: opts.history }
  const result = await writeWorkspaceExportV2(file, {
    force: opts.force,
    history,
  })
  console.log(
    `Exported ${result.manifest.integrity.files.length} files to ${result.destination}`
  )
  console.log(`Source workspace: ${result.manifest.source.workspaceId}`)
  console.log(`Checkpoint: ${result.manifest.integrity.sourceCheckpoint}`)
  console.log(
    `History: ${result.manifest.history.includedFiles} included, ${result.manifest.history.omittedFiles} omitted`
  )
}

async function commandWorkspaceImport(
  file: string,
  directory: string
): Promise<void> {
  const manifest = (await isWorkspaceExportV2(file))
    ? await importWorkspaceExportV2(file, directory)
    : await importWorkspaceExport(file, directory)
  console.log(`Imported an independent workspace to ${resolve(directory)}`)
  console.log(`New workspace id: ${manifest.id}`)
  console.log(
    `Source workspace id: ${manifest.provenance?.source?.workspaceId}`
  )
}

const DESKTOP_WORKSPACE_CONTRACT_VERSION = 1

function commandWorkspaceInspect(directory?: string): void {
  const inspection = inspectWorkspaceTarget(directory)
  console.log(
    JSON.stringify({
      schemaVersion: DESKTOP_WORKSPACE_CONTRACT_VERSION,
      ok: true,
      inspection,
    })
  )
}

function commandWorkspacePrepare(
  directory: string,
  intent: WorkspacePreparationIntent
): void {
  try {
    const prepared = prepareWorkspaceTarget(directory, intent)
    console.log(
      JSON.stringify({
        schemaVersion: DESKTOP_WORKSPACE_CONTRACT_VERSION,
        ok: true,
        prepared: {
          path: prepared.path,
          created: prepared.created,
          workspace: {
            id: prepared.manifest.id,
            name: prepared.manifest.name,
            createdAt: prepared.manifest.createdAt,
          },
        },
      })
    )
  } catch (error) {
    if (error instanceof WorkspacePreparationError) {
      console.log(
        JSON.stringify({
          schemaVersion: DESKTOP_WORKSPACE_CONTRACT_VERSION,
          ok: false,
          error: { code: error.code, path: error.path, message: error.message },
        })
      )
      process.exitCode = 1
      return
    }
    if (error instanceof WorkspaceAdoptionError) {
      console.log(
        JSON.stringify({
          schemaVersion: DESKTOP_WORKSPACE_CONTRACT_VERSION,
          ok: false,
          error: {
            code: "WORKSPACE_REJECTED",
            reason: error.reason,
            message: error.message,
          },
        })
      )
      process.exitCode = 1
      return
    }
    console.log(
      JSON.stringify({
        schemaVersion: DESKTOP_WORKSPACE_CONTRACT_VERSION,
        ok: false,
        error: {
          code: "WORKSPACE_PREPARATION_FAILED",
          path: resolve(directory),
          message:
            error instanceof Error
              ? error.message
              : `Workspace preparation failed: ${String(error)}`,
        },
      })
    )
    process.exitCode = 1
  }
}

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

async function commandLaunch(opts: LaunchOptions): Promise<void> {
  assertExclusiveRunMode(opts)
  if (opts.workspace && opts.ephemeralWorkspace) {
    throw new UsageError(
      "--workspace and --ephemeral-workspace cannot be used together"
    )
  }
  if (opts.ephemeralWorkspace && opts.foreground !== true) {
    throw new UsageError("--ephemeral-workspace requires --foreground")
  }
  // The hidden Desktop mode is process-local in every dimension: workspace,
  // host, and port. Starting from defaults avoids even reading CLI config
  // because readConfig may repair/refresh its durable backup as a side effect.
  const supervised = opts.ephemeralWorkspace !== undefined
  let authorityLock: LocalAuthorityLock | null = null
  try {
    const inheritedAuthority =
      !supervised && inheritedLocalAuthorityHandoffIsValid()
    if (!supervised && !inheritedAuthority) {
      authorityLock = acquireLocalAuthorityLock()
      if (existsSync(localActivationPath())) {
        throw new UsageError(
          "A previous local workspace activation did not finish. Run `worktable local-host recover --json` before launching Worktable."
        )
      }
    }
    await commandLaunchUnderAuthority(opts, supervised, authorityLock)
  } finally {
    authorityLock?.release()
  }
}

async function commandLaunchUnderAuthority(
  opts: LaunchOptions,
  supervised: boolean,
  authorityLock: LocalAuthorityLock | null
): Promise<void> {
  let config = supervised ? createDefaultConfig() : ensureConfig()
  const temporary = { ...config, service: { ...config.service } }
  let runtime: Awaited<ReturnType<typeof inspectLocalRuntime>> = null
  if (opts.port !== undefined) temporary.service.port = opts.port
  // Resolve reachability the same way setup does (flag/host/current intent).
  // The owner-password gate below is what actually guards an exposed bind; the
  // persisted exposureAcknowledged is carried through so a plain launch of an
  // already-reachable install proceeds without re-prompting.
  const reachability = resolveReachability(
    opts,
    config.service.reachable,
    config.service.exposureAcknowledged,
    config.service.host
  )
  temporary.service.host = reachability.host
  temporary.service.reachable = reachability.reachable
  // Resolve the destination before any ownership or authentication checks. A
  // known workspace owns its registered host and port as one stable endpoint;
  // command-line host/port flags override only the fields explicitly supplied.
  // The hidden ephemeral form is process-local and never consults or mutates the
  // durable workspace registry.
  const requestedWorkspace = opts.workspace ?? opts.ephemeralWorkspace
  if (requestedWorkspace) {
    const workspace = normalizeWorkspaceAnswer(requestedWorkspace)
    const adoption = describeWorkspaceClassification(
      classifyWorkspaceTarget(workspace)
    )
    if (!adoption.ok) {
      fail(adoption.message)
      return
    }
    if (adoption.confirm) console.log(adoption.message)
    temporary.workspace = workspace
  }
  if (
    !supervised &&
    opts.workspace !== undefined &&
    resolve(temporary.workspace) !== resolve(config.workspace)
  ) {
    const endpoint = await stableEndpointForWorkspace(
      temporary.workspace,
      {
        host: temporary.service.host,
        port: temporary.service.port,
      },
      {
        host: hasExplicitHostSelection(opts),
        port: opts.port !== undefined,
      }
    )
    temporary.service.host = endpoint.host
    temporary.service.port = endpoint.port
    temporary.service.reachable = !isLoopbackHost(endpoint.host)
  }
  if (opts.ephemeralWorkspace && !isLoopbackHost(temporary.service.host)) {
    throw new UsageError(
      "--ephemeral-workspace is limited to loopback foreground hosts"
    )
  }
  const service: ServiceStatus = supervised
    ? {
        platform: "unsupported",
        state: "not-installed",
        installed: false,
        startsAtLogin: false,
        serviceFile: null,
        logs: { stdout: "", stderr: "" },
      }
    : getServiceStatus()
  if (!supervised) {
    runtime = await inspectLocalRuntime()
    if (runtime?.processAlive && runtime.pid !== process.pid) {
      const requestsAnotherWorkspace =
        opts.workspace !== undefined &&
        resolve(opts.workspace) !== resolve(runtime.workspacePath)
      const requestsAnotherEndpoint =
        temporary.service.port !== runtime.port ||
        temporary.service.host.toLowerCase() !== runtime.host.toLowerCase()
      const requestsAnotherPosture =
        temporary.service.reachable !== config.service.reachable ||
        publicOriginConfiguredFromEnv() ||
        (opts.behindTls === true && !config.service.httpsUpstream)
      const runtimeIsManagedService = isVerifiedManagedServiceRuntime(
        runtime,
        service
      )
      if (
        !runtime.endpointVerified ||
        opts.foreground === true ||
        (!runtimeIsManagedService &&
          (requestsAnotherWorkspace ||
            requestsAnotherEndpoint ||
            requestsAnotherPosture))
      ) {
        throw new UsageError(
          runtime.endpointVerified
            ? `${runtime.owner === "desktop" ? "Worktable Desktop" : runtime.owner === "service" ? (runtimeIsManagedService ? "The Worktable background service" : "An unmanaged Worktable service process") : "Another foreground Worktable command"} already owns ${runtime.workspacePath} at ${clientOriginFor(runtime.host, runtime.port)}. Stop or reuse it before starting a different local host.`
            : `A live ${runtime.owner} process still holds the local Worktable runtime lease but did not answer its ownership proof. Stop or repair that host before changing local host state.`
        )
      }
    }
  }
  // Owner password is the exposure gate: a non-loopback bind or public URL
  // requires an owner password to exist, since the server refuses to serve an
  // exposed surface without one. Validate/set it HERE — BEFORE any config
  // persist below — so a failed check never leaves exposed state without a
  // password.
  // A flag/env password may be supplied for unattended bring-up; otherwise fail
  // clean and point at `setup --reachable`. The credential is machine-local.
  const publicOriginFromEnv = publicOriginConfiguredFromEnv()
  const launchExposed =
    !isLoopbackHost(temporary.service.host) || publicOriginFromEnv
  if (!supervised && launchExposed && !(await hasOwnerPassword())) {
    const supplied = resolveOwnerPasswordOption(opts.ownerPassword)
    if (supplied === undefined) {
      fail(OWNER_PASSWORD_REQUIRED_FAILURE)
      return
    }
    if (supplied.length < OWNER_PASSWORD_MIN_LENGTH) {
      fail(OWNER_PASSWORD_TOO_SHORT_FAILURE)
      return
    }
    await setOwnerPassword(supplied)
  }
  // Exposed surface with an owner password present = the exposure is acknowledged.
  temporary.service.exposureAcknowledged = !supervised && launchExposed
  // HTTPS-upstream ack (reminder suppression only, not auth). --behind-tls sets
  // it; otherwise the persisted value carries. Forced false when not exposed so
  // a later reachable run starts from an explicit choice.
  temporary.service.httpsUpstream =
    !supervised && launchExposed
      ? opts.behindTls === true || config.service.httpsUpstream
      : false
  temporary.mcp.endpoint = endpointFor(
    temporary.service.host,
    temporary.service.port
  )
  const foreground = opts.foreground === true
  const background = opts.background === true

  // Detect a durable service-config change vs what's persisted. Drives both the
  // up-front persist here and the running-service reinstall decision below.
  const serviceConfigChanged =
    !supervised &&
    (config.service.reachable !== temporary.service.reachable ||
      config.service.host !== temporary.service.host ||
      config.service.port !== temporary.service.port ||
      config.service.exposureAcknowledged !==
        temporary.service.exposureAcknowledged ||
      publicOriginFromEnv ||
      config.service.httpsUpstream !== temporary.service.httpsUpstream)
  const workspaceChanged =
    !supervised &&
    opts.workspace !== undefined &&
    config.workspace !== temporary.workspace

  // If a background service is installed but its state can't be determined
  // (systemctl --user unreachable in this session) and this launch would change its
  // durable config/workspace, refuse BEFORE persisting or rewriting the unit —
  // otherwise config.json would point at a new URL while the old, now-unmanageable
  // service may still be the process serving traffic. Fetched once and reused for
  // the reinstall decision below.
  const startAtLoginChanges = background && !config.service.startAtLogin
  const launchPlan = supervised
    ? null
    : planLocalAuthority({
        operation: "launch",
        desired: {
          workspacePath: temporary.workspace,
          host: temporary.service.host,
          port: temporary.service.port,
          background,
          noLaunch: false,
          changesDurableState:
            serviceConfigChanged || workspaceChanged || startAtLoginChanges,
        },
        runtime,
        service,
        // A non-supervised call reaches this function only with either the
        // locally acquired lock or a validated service handoff.
        lock: { state: "owned", exactOwnership: true },
        journal: { state: "none" },
      })
  if (launchPlan?.action === "refuse") {
    fail(launchPlan.message)
    return
  }
  const requestedEndpointIsProven =
    launchPlan?.endpointProven ??
    runtimeProvesWorkspaceEndpoint(runtime, {
      workspacePath: temporary.workspace,
      host: temporary.service.host,
      port: temporary.service.port,
    })
  const installedServiceCanBeReconfigured = isVerifiedManagedServiceRuntime(
    runtime,
    service
  )
  if (
    !foreground &&
    !requestedEndpointIsProven &&
    !installedServiceCanBeReconfigured &&
    (await healthCheck(temporary.service.host, temporary.service.port))
  ) {
    fail(
      `Another Worktable process is using ${clientOriginFor(temporary.service.host, temporary.service.port)}, but it has not proven the requested workspace and endpoint ownership. Stop or repair that host before launching Worktable.`
    )
    return
  }
  // `--background` turns on start-at-login; that's a durable service change too, even
  // when host/port/workspace are unchanged, so fold it into the guard.
  // NOT gated on !foreground: a FOREGROUND launch with --port/--host/--reachable/
  // --workspace also persists config.json up front, so it would diverge from an
  // installed-but-unmanageable background service just the same. Refuse whenever
  // durable state changes and an installed service's state is unknown.
  // When this launch will (re)install the background service, PREFLIGHT that the
  // install can complete — manager reachable, current process stoppable, competing
  // backends removable — BEFORE the config persist and token mint below. Otherwise
  // a doomed install would abort after durable state already points at the new
  // host/port/workspace while the old service keeps serving the previous one.
  const willReinstallService =
    background ||
    (!foreground &&
      service.installed &&
      (serviceConfigChanged || workspaceChanged || startAtLoginChanges))
  if (
    willReinstallService &&
    runServiceOp(() => prepareServiceInstall()) === null
  ) {
    return
  }

  const durableConfigBeforeLaunch = config
  const durableRegistryExistedBeforeLaunch =
    !supervised && existsSync(getLocalWorkspaceRegistryPath())
  const durableRegistryBeforeLaunch = supervised
    ? null
    : readLocalWorkspaceRegistry()
  let localReservationCommitted = false
  const rollbackLaunchReservation = (): void => {
    if (supervised) return
    if (serviceConfigChanged || workspaceChanged) {
      writeConfig(durableConfigBeforeLaunch)
    }
    if (durableRegistryExistedBeforeLaunch && durableRegistryBeforeLaunch) {
      writeLocalWorkspaceRegistry(durableRegistryBeforeLaunch)
    } else {
      rmSync(getLocalWorkspaceRegistryPath(), { force: true })
    }
    applyRuntimeConfig(durableConfigBeforeLaunch)
    localReservationCommitted = false
  }

  // Persist the resolved durable config up front so EVERY launch path —
  // foreground, background, and reuse-running — agrees with config.json. Without
  // this a foreground `launch --reachable` would bind 0.0.0.0 and mint a managed
  // token while config.json still claimed loopback. Gated on an actual change so
  // a plain `launch` stays a no-op write; startAtLogin is preserved here (only
  // --background flips it on).
  if (serviceConfigChanged || workspaceChanged) {
    config = updateConfig((current) => {
      if (workspaceChanged) current.workspace = temporary.workspace
      current.service = {
        ...current.service,
        host: temporary.service.host,
        port: temporary.service.port,
        reachable: temporary.service.reachable,
        exposureAcknowledged: temporary.service.exposureAcknowledged,
        httpsUpstream: temporary.service.httpsUpstream,
      }
      current.mcp.endpoint = endpointFor(
        current.service.host,
        current.service.port
      )
    })
  }

  applyRuntimeConfig(temporary)

  if (!supervised) {
    try {
      const workspace = ensureWorkspaceManifest()
      ensureInstallIdentity()
      rememberConfiguredLocalWorkspace(temporary, workspace)
      localReservationCommitted = true
    } catch (error) {
      try {
        rollbackLaunchReservation()
      } catch (rollbackError) {
        throw new UsageError(
          `${error instanceof Error ? error.message : String(error)} Restoring the previous local config and workspace registry also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        )
      }
      throw error
    }
  }

  // On any resolved non-loopback launch, ensure a managed credential exists for
  // clients that must authenticate to the exposed MCP surface. Mint AFTER
  // applyRuntimeConfig so
  // the workspace-bound token is bound to the resolved workspace. The raw token
  // is hashed on disk and cannot be reprinted, so the reachable banner below
  // points the user at `setup` for the paste-ready snippet rather than fabricating
  // one.
  if (!supervised && launchExposed) {
    // Ensure (do not rotate) — a token freshly minted + injected by `setup` must
    // survive the follow-up foreground launch setup performs, so we only mint
    // when no active managed token exists.
    await ensureManagedToken()
    if (workspaceChanged) {
      // The token is workspace-bound and launch does not re-inject agent configs,
      // so a workspace switch leaves their old-workspace bearers 401ing. Surface it
      // instead of silently breaking MCP.
      console.log(style.yellow(WORKSPACE_SWITCH_AGENTS_WARNING))
    }
  }

  // `--no-open` is a back-compat alias for `--no-browser`.
  const noBrowser = opts.browser === false || opts.open === false
  // Display/browse targets must be connectable, not the 0.0.0.0 bind wildcard.
  const url = clientOriginFor(temporary.service.host, temporary.service.port)
  const configuredUrl = clientOriginFor(
    config.service.host,
    config.service.port
  )

  if (background) {
    config = updateConfig((current) => {
      current.workspace = temporary.workspace
      current.service = { ...temporary.service, startAtLogin: true }
      current.mcp.endpoint = endpointFor(
        current.service.host,
        current.service.port
      )
    })
    const servicePublicUrl =
      process.env["WORKTABLE_PUBLIC_URL"]?.trim() ||
      getInstalledServicePublicUrl()
    const installed = runServiceOp(() =>
      installService(config, {
        ...(servicePublicUrl ? { publicUrl: servicePublicUrl } : {}),
        authorityHandoff: authorityLock?.handoff,
      })
    )
    if (!installed) return
    const status =
      service.state === "running" ? restartService() : startService()
    if (
      (await runServiceOpAsync(() =>
        verifyManagedServiceReady(config, status)
      )) === null
    )
      return
    console.log(`Worktable service running at ${url}`)
    // Surface install-time notices (e.g. the linger fallback) the user would
    // otherwise never see on this background path.
    printServiceNotices(installed, status)
    if (!noBrowser) await openBrowser(url)
    return
  }

  // serviceConfigChanged / workspaceChanged (computed above, before the up-front
  // persist) tell us whether the running service was installed with a stale bind
  // OR a stale workspace. Reusing it would silently keep the old socket/workspace
  // and report the old URL, ignoring --reachable/--host/--port/--workspace; when
  // either changed we reinstall+restart. (service status was fetched above.)
  if (!foreground && service.installed) {
    if (serviceConfigChanged || workspaceChanged) {
      // The request changes reachability/host/port/workspace relative to the
      // running service. Persist the resolved config and reinstall+restart so the
      // new bind/workspace actually takes effect — consistent with how
      // --background persists and installs — rather than reporting the stale URL.
      config = updateConfig((current) => {
        current.workspace = temporary.workspace
        current.service = {
          ...temporary.service,
          startAtLogin: current.service.startAtLogin,
        }
        current.mcp.endpoint = endpointFor(
          current.service.host,
          current.service.port
        )
      })
      // Stop BEFORE rewriting the install: if the running service can't be stopped
      // (unverifiable managed process), abort while unit/marker still describe the
      // process that is actually serving. prepareServiceInstall above makes a
      // failure here unlikely, but ordering keeps even a surprise failure honest.
      const installed = runServiceOp(() => {
        if (service.state === "running") stopService()
        const servicePublicUrl =
          process.env["WORKTABLE_PUBLIC_URL"]?.trim() ||
          getInstalledServicePublicUrl()
        return installService(config, {
          ...(servicePublicUrl ? { publicUrl: servicePublicUrl } : {}),
          authorityHandoff: authorityLock?.handoff,
        })
      })
      if (!installed) return
      const status = startService()
      if (
        (await runServiceOpAsync(() =>
          verifyManagedServiceReady(config, status)
        )) === null
      )
        return
      console.log(`Worktable service running at ${url}`)
      printServiceNotices(installed, status)
      if (!noBrowser) await openBrowser(url)
      return
    }
    let status = service
    if (service.state !== "running") {
      const servicePublicUrl = getInstalledServicePublicUrl()
      const installed = runServiceOp(() =>
        installService(config, {
          ...(servicePublicUrl ? { publicUrl: servicePublicUrl } : {}),
          authorityHandoff: authorityLock?.handoff,
        })
      )
      if (!installed) return
      status = startService()
    }
    if (status.state === "running") {
      if (
        (await runServiceOpAsync(() =>
          verifyManagedServiceReady(config, status)
        )) === null
      )
        return
      console.log(`Worktable running at ${configuredUrl}`)
      if (!noBrowser) await openBrowser(configuredUrl)
      return
    }
    // The installed service is present but won't start — surface why (instead of
    // swallowing the launchctl/systemctl error), then fall back to a foreground
    // server so `worktable launch` still opens the app.
    process.stderr.write(
      `${serviceStartError(status)} Falling back to foreground.\n`
    )
  }

  // A healthy server already on this port (started elsewhere or by the background
  // service) — reuse it for the convenience launch path instead of crashing on
  // EADDRINUSE. Never for --foreground: that mode (used by the background service
  // itself) must bind its own server, or a keep-alive supervisor would respawn
  // this no-op exit in a loop. Also never when this invocation CHANGES the bind
  // (serviceConfigChanged): the probe targets a connectable local origin (the
  // 0.0.0.0 wildcard), so a leftover loopback-only process would satisfy it and we
  // would exit "already running" while config.json now says reachable but nothing
  // is actually bound to all interfaces. Fall through to (re)bind instead.
  if (
    !foreground &&
    !serviceConfigChanged &&
    requestedEndpointIsProven &&
    (await healthCheck(temporary.service.host, temporary.service.port))
  ) {
    console.log(`Worktable is already running at ${url}`)
    if (!noBrowser) await openBrowser(url)
    return
  }

  if (!foreground && process.stdin.isTTY && !service.installed) {
    console.log(
      style.dim(
        "Tip: run `worktable setup` to enable background mode and agent connections."
      )
    )
  }

  const staticInfo = getStaticAssetsInfo()
  printBanner()
  if (staticInfo.staticDir) {
    console.log(
      `  ${style.white("Open in browser:")}    ${style.cyan(style.bold(url))}`
    )
  } else {
    console.log(
      `  ${style.yellow("Web UI unavailable:")} packaged static assets were not found.`
    )
    console.log(`  ${style.dim("Run `worktable doctor` for checked paths.")}`)
  }
  console.log()
  console.log(`  ${style.dim(`MCP endpoint: ${temporary.mcp.endpoint}`)}`)
  if (reachability.reachable && !isLoopbackHost(temporary.service.host)) {
    console.log()
    if (!temporary.service.httpsUpstream) {
      console.log(`  ${style.yellow(REACHABLE_NETWORK_NOTICE)}`)
    }
    console.log(
      `  ${style.dim("Connect a remote agent with `worktable agent invite` (or Settings -> Agents in the web app).")}`
    )
  }
  console.log(`  ${style.dim("Press Ctrl+C to stop")}`)
  console.log()

  const { startServer } = await import("@worktable/server")
  const priorProofToken = process.env["WORKTABLE_LOCAL_PROOF_TOKEN"]
  let localRuntime: LocalRuntimeRecord | null = null
  let startedServer: { stop: () => Promise<void> } | null = null
  try {
    if (!supervised) {
      const runtimeOwner = resolvedLocalRuntimeOwner()
      const workspace = ensureWorkspaceManifest()
      const existingRuntime = await inspectLocalRuntime()
      if (
        existingRuntime?.processAlive &&
        existingRuntime.pid !== process.pid
      ) {
        const sameDestination =
          resolve(existingRuntime.workspacePath) ===
            resolve(temporary.workspace) &&
          existingRuntime.host.toLowerCase() ===
            temporary.service.host.toLowerCase() &&
          existingRuntime.port === temporary.service.port
        throw new UsageError(
          existingRuntime.endpointVerified
            ? `${existingRuntime.owner === "desktop" ? "Worktable Desktop" : existingRuntime.owner === "service" ? "The Worktable background service" : "Another foreground Worktable command"} already owns ${sameDestination ? url : `${existingRuntime.workspacePath} at ${clientOriginFor(existingRuntime.host, existingRuntime.port)}`}. Stop or reuse it instead of starting a second local host.`
            : `A live ${existingRuntime.owner} process still holds the local Worktable runtime lease but did not answer its ownership proof. Stop or repair that host before starting another one.`
        )
      }
      const install = ensureInstallIdentity()
      const suppliedProof = priorProofToken?.trim()
      localRuntime = createLocalRuntimeRecord({
        owner: runtimeOwner,
        installId: install.id,
        workspaceId: workspace.id,
        workspacePath: temporary.workspace,
        host: temporary.service.host,
        port: temporary.service.port,
        proofToken:
          suppliedProof && suppliedProof.length >= 32
            ? suppliedProof
            : undefined,
      })
      process.env["WORKTABLE_LOCAL_PROOF_TOKEN"] = localRuntime.proofToken
    }
    // startServer binds synchronously and throws on failure (e.g. port in use).
    // Only record the runtime after a successful bind, while still holding the
    // cross-process authority lock, so a second surface cannot race this lease.
    startedServer = startServer(temporary.service.port, temporary.service.host)
    if (localRuntime) {
      writeLocalRuntime(localRuntime)
      installLocalRuntimeCleanup(localRuntime)
    }
  } catch (error) {
    if (startedServer) {
      try {
        await startedServer.stop()
      } catch {
        // Preserve the startup failure below; the server lifecycle already
        // attempted every registered cleanup before rejecting.
      }
    }
    if (priorProofToken === undefined) {
      delete process.env["WORKTABLE_LOCAL_PROOF_TOKEN"]
    } else {
      process.env["WORKTABLE_LOCAL_PROOF_TOKEN"] = priorProofToken
    }
    if (localReservationCommitted) {
      try {
        rollbackLaunchReservation()
      } catch (rollbackError) {
        throw new UsageError(
          `${error instanceof Error ? error.message : String(error)} Restoring the previous local config and workspace registry also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        )
      }
    }
    if (error instanceof UsageError) throw error
    throw new UsageError(
      `Could not start Worktable on ${url} — the port may already be in use. (${error instanceof Error ? error.message : String(error)})`
    )
  }
  recordManagedPid()
  if (!noBrowser && staticInfo.staticDir) await openBrowser(url)
}

// When started by the managed-process service backend, record our real PID so
// the launcher can track and stop us regardless of any setsid re-fork. Cleaned
// up on exit so a stale PID file never reports a dead service as running.
function recordManagedPid(): void {
  const pidFile = process.env["WORKTABLE_MANAGED_PID_FILE"]?.trim()
  if (!pidFile) return
  try {
    writeFileSync(pidFile, `${process.pid}\n`)
  } catch {
    return
  }
  const cleanup = () => {
    try {
      rmSync(pidFile)
    } catch {
      // Best-effort.
    }
  }
  process.on("exit", cleanup)
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      cleanup()
      process.exit(0)
    })
  }
  // Survive terminal hangup: without setsid the managed server can share the
  // launcher's session, so ignore SIGHUP (like nohup) rather than dying with
  // the terminal that started it. stopService uses SIGTERM/SIGKILL to stop it.
  process.on("SIGHUP", () => {})
}

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

function selectedSetupMode(background: boolean): SetupRunMode {
  return background ? "background" : "foreground"
}

// Agents the user previously connected but left out of an explicit selection
// (interactive multiselect or --mcp). These are removed so config matches the
// chosen set instead of leaving stale clients marked desired.
export function clientsToDeselect(
  config: { mcp: Pick<WorktableConfig["mcp"], "clients"> },
  selectedClients: ConnectorInstallableMcpClientId[]
): ConnectorInstallableMcpClientId[] {
  const selected = new Set<ConnectorInstallableMcpClientId>(selectedClients)
  return CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.filter(
    (clientId) =>
      config.mcp.clients[clientId]?.desired && !selected.has(clientId)
  )
}

function isConnectorInstallableClientId(
  value: string
): value is ConnectorInstallableMcpClientId {
  return CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.includes(
    value as ConnectorInstallableMcpClientId
  )
}

async function runInteractiveSetupPrompts(options: {
  workspace: string
  background: boolean
  serviceUnsupported: boolean
  skipMcp: boolean
  selectedClients: ConnectorInstallableMcpClientId[]
}): Promise<
  | {
      workspace: string
      background: boolean
      selectedClients: ConnectorInstallableMcpClientId[]
    }
  | undefined
> {
  const prompts = await import("@clack/prompts")
  prompts.intro("Worktable setup")

  let workspace = options.workspace
  prompts.note(
    [
      "Where Worktable keeps your docs, HTML docs and records.",
      "An empty folder starts fresh; an existing Worktable folder is reused as-is.",
    ].join("\n"),
    "Workspace folder"
  )
  // Loop so a rejected adoption (the user declines to adopt a valid workspace)
  // re-prompts rather than silently proceeding.
  for (;;) {
    const workspaceAnswer = await prompts.text({
      message: "Workspace folder",
      placeholder: workspace,
      // Empty input falls back to defaultValue (clack applies it after validate
      // runs), so pressing Enter accepts the shown path. Only reject input the
      // user actually typed that is blank, or a folder we cannot safely adopt
      // (foreign files, corrupt/unsupported manifest, symlink) — surfacing the
      // classifier's message inline before any mutation.
      defaultValue: workspace,
      validate: (value) => {
        const candidate = value && value.trim() ? value.trim() : workspace
        if (!candidate) return "Enter a workspace folder."
        const described = describeWorkspaceClassification(
          classifyWorkspaceTarget(candidate)
        )
        return described.ok ? undefined : described.message
      },
    })
    if (prompts.isCancel(workspaceAnswer)) {
      prompts.cancel("Setup canceled.")
      process.exitCode = 1
      return undefined
    }
    workspace = normalizeWorkspaceAnswer(workspaceAnswer)

    const classification = classifyWorkspaceTarget(workspace)
    if (classification.outcome === "valid") {
      const adopt = await prompts.confirm({
        message: `Adopt existing workspace "${classification.name}"? Reuse this folder and everything already in it (keeps its workspace identity).`,
      })
      if (prompts.isCancel(adopt)) {
        prompts.cancel("Setup canceled.")
        process.exitCode = 1
        return undefined
      }
      if (!adopt) {
        // Decline: re-prompt for a different folder.
        continue
      }
    }
    break
  }

  const runModeAnswer = await prompts.select<SetupRunMode>({
    message: "How should Worktable run?",
    initialValue: selectedSetupMode(options.background),
    options: [
      {
        value: "background",
        label: "Background service",
        hint: options.serviceUnsupported
          ? "Not supported on this platform"
          : "Starts at login so agents can connect anytime",
        disabled: options.serviceUnsupported,
      },
      {
        value: "foreground",
        label: "Manual foreground launch",
        hint: "Run worktable when you want the local app open",
      },
    ],
  })
  if (prompts.isCancel(runModeAnswer)) {
    prompts.cancel("Setup canceled.")
    process.exitCode = 1
    return undefined
  }

  let selectedClients = options.selectedClients
  if (!options.skipMcp) {
    const detectedClients = new Set(detectInstalledClients())
    const clientOptions: Option<ConnectorInstallableMcpClientId>[] =
      listClients(false)
        .filter(
          (
            client
          ): client is typeof client & {
            id: ConnectorInstallableMcpClientId
          } => isConnectorInstallableClientId(client.id)
        )
        .map((client) => {
          const detected = detectedClients.has(client.id)
          return {
            value: client.id,
            label: client.label,
            hint: detected ? "Detected" : undefined,
          }
        })
    const clientsAnswer =
      await prompts.multiselect<ConnectorInstallableMcpClientId>({
        message: "Connect agents",
        options: clientOptions,
        initialValues: selectedClients,
        required: false,
        maxItems: 8,
      })
    if (prompts.isCancel(clientsAnswer)) {
      prompts.cancel("Setup canceled.")
      process.exitCode = 1
      return undefined
    }
    selectedClients = clientsAnswer
  }

  return {
    workspace,
    background: runModeAnswer === "background",
    selectedClients,
  }
}

async function commandSetup(opts: SetupOptions): Promise<void> {
  const yes = opts.yes === true || !process.stdin.isTTY
  const interactive =
    !yes && Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const skipMcp = opts.skipMcp === true
  const noLaunch = opts.launch === false
  // setup is the recreate path: tolerate an unrecoverable corrupt config by
  // starting from in-memory defaults (readConfig already preserved the bad bytes)
  // rather than refusing to run. This does NOT persist — setup commits once at the
  // end via writeConfig, so an abort during validation can't overwrite a
  // corrupt-but-present install with loopback defaults. Reachability is re-collected
  // from flags/prompts below.
  const {
    config: defaultConfig,
    recreated: configRecreated,
    configFile: initialConfigFile,
  } = loadStableConfigForSetup()
  let workspace = opts.workspace ?? defaultConfig.workspace
  let port = opts.port ?? defaultConfig.service.port
  assertExclusiveRunMode(opts)
  // Resolve the reachability decision (flag/host/current intent) up front so the
  // effective bind host is known before any prompt or mutation. The owner-password
  // gate below is what guards an exposed bind; the persisted exposureAcknowledged
  // is carried through so re-running `setup --yes` on an already-reachable install
  // isn't blocked.
  let reachability = resolveReachability(
    opts,
    defaultConfig.service.reachable,
    defaultConfig.service.exposureAcknowledged,
    defaultConfig.service.host
  )
  let explicitHostSelection = hasExplicitHostSelection(opts)
  let background = opts.foreground
    ? false
    : opts.background
      ? true
      : defaultConfig.service.startAtLogin
  const serviceSupport = getServiceStatus()
  const initialAuthorityState = snapshotLocalAuthorityState(serviceSupport)
  if (initialAuthorityState.config !== initialConfigFile) {
    throw new UsageError(
      "The local Worktable configuration changed while setup started. Run setup again to continue from the current state."
    )
  }
  let serviceUnsupportedNotice = false
  if (background && serviceSupport.platform === "unsupported") {
    background = false
    serviceUnsupportedNotice = true
  }

  console.log(style.bold("Welcome to Worktable"))
  console.log()
  console.log(
    "Worktable is a local workspace shared by you and your AI agents."
  )
  console.log(
    "It gives agents a durable place to create docs, HTML docs, records, and notes that you can inspect and keep."
  )
  console.log()

  if (!yes && !interactive) {
    fail(SETUP_INTERACTIVE_TERMINAL_REQUIRED_MESSAGE)
    return
  }

  const selectedFromFlag = opts.mcp
  let selectedClients: ConnectorInstallableMcpClientId[] = selectedFromFlag
    ? parseClientSelection([selectedFromFlag])
    : detectInstalledClients()
  if (!yes) {
    const answers = await runInteractiveSetupPrompts({
      workspace,
      background,
      serviceUnsupported: serviceSupport.platform === "unsupported",
      skipMcp,
      selectedClients,
    })
    if (!answers) return
    workspace = answers.workspace
    background = answers.background
    selectedClients = answers.selectedClients

    // Reachability prompt (interactive). Default OFF. Only ask when no explicit
    // --reachable/--host already decided it. A "yes" then collects an owner
    // password (the password is the acknowledgement).
    if (opts.reachable === undefined && opts.bind !== true && !opts.host) {
      const prompts = await import("@clack/prompts")
      prompts.note(
        [
          "No   Bind to localhost only (127.0.0.1). Only this computer can connect. (default)",
          "Yes  Bind to all interfaces (0.0.0.0) so other machines and remote agents",
          "     can connect. Requires an owner password, mints an MCP token, and you",
          "     supply the HTTPS tunnel.",
        ].join("\n"),
        "Reachability"
      )
      const wantReachable = await prompts.confirm({
        message: "Make Worktable reachable from other machines?",
        initialValue: defaultConfig.service.reachable,
      })
      if (prompts.isCancel(wantReachable)) {
        prompts.cancel("Setup canceled.")
        process.exitCode = 1
        return
      }
      explicitHostSelection = true
      if (wantReachable) {
        // Setting an owner password gates reachability and is the
        // acknowledgement, so resolve reachability as already-acknowledged.
        reachability = resolveReachability(
          { reachable: true },
          defaultConfig.service.reachable,
          /* alreadyAcknowledged */ true,
          defaultConfig.service.host
        )
      } else {
        reachability = resolveReachability(
          { reachable: false },
          defaultConfig.service.reachable
        )
      }
    }
  }

  workspace = normalizeWorkspaceAnswer(workspace)
  if (resolve(workspace) !== resolve(defaultConfig.workspace)) {
    const endpoint = await stableEndpointForWorkspace(
      workspace,
      { host: reachability.host, port },
      {
        host: explicitHostSelection,
        port: opts.port !== undefined,
      }
    )
    port = endpoint.port
    reachability = {
      host: endpoint.host,
      reachable: !isLoopbackHost(endpoint.host),
      needsAck:
        !isLoopbackHost(endpoint.host) &&
        (explicitHostSelection ? reachability.needsAck : true),
    }
  }

  const host = reachability.host
  const exposedBind = !isLoopbackHost(host)
  const publicOriginFromEnv = publicOriginConfiguredFromEnv()
  const exposingNow = exposedBind || publicOriginFromEnv

  // PORT PROMPT (reachable). A reachable bind implies a tunnel / DNS / proxy, so
  // surface the port explicitly rather than hiding it behind a default — for ANY
  // interactive reachable install (the reachability prompt, --reachable, or a
  // non-loopback -H), unless --port already pinned it. Suggest the resolved port
  // (or the next free one); the collision gate below re-checks the choice.
  if (interactive && exposedBind && opts.port === undefined) {
    const prompts = await import("@clack/prompts")
    const suggested =
      (await classifyPort(host, port)) === "free"
        ? port
        : await findFreePort(host, port)
    const portAnswer = await prompts.text({
      message: "Port to listen on",
      placeholder: String(suggested),
      defaultValue: String(suggested),
      validate: (value) => {
        const v = (value ?? "").trim()
        if (v && (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535))
          return "Port must be an integer from 1 to 65535."
        return undefined
      },
    })
    if (prompts.isCancel(portAnswer)) {
      prompts.cancel("Setup canceled.")
      process.exitCode = 1
      return
    }
    const entered = (portAnswer ?? "").toString().trim()
    port = entered ? Number(entered) : suggested
  }

  // PORT COLLISION GATE. Probe the resolved port BEFORE writing any config, so MCP
  // client configs can never be pointed at a foreign process
  // or at a port that will not bind. Our own already-running
  // Worktable on this port is a reuse, not a collision, so leave it. Resolved here
  // — before the owner-password prompt — so a collision is settled first.
  if ((await classifyPort(host, port)) === "occupied") {
    if (interactive) {
      const prompts = await import("@clack/prompts")
      for (;;) {
        const suggested = await findFreePort(host, port)
        const answer = await prompts.text({
          message: `Port ${port} is already in use by another process. Choose another port:`,
          placeholder: String(suggested),
          defaultValue: String(suggested),
          validate: (value) => {
            const v = (value ?? "").trim()
            if (v && (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 65535))
              return "Port must be an integer from 1 to 65535."
            return undefined
          },
        })
        if (prompts.isCancel(answer)) {
          prompts.cancel("Setup canceled.")
          process.exitCode = 1
          return
        }
        const chosen = (answer ?? "").toString().trim()
        port = chosen ? Number(chosen) : suggested
        if ((await classifyPort(host, port)) !== "occupied") break
        console.log(style.yellow(`Port ${port} is also in use.`))
      }
    } else {
      // --yes / non-interactive: auto-pick the next free port (user's choice).
      const free = await findFreePort(host, port)
      console.log(`Port ${port} is already in use; using ${free} instead.`)
      port = free
    }
  }

  // OWNER PASSWORD GATE. When the resolved bind is non-loopback or a public URL
  // fronts this loopback install, the web app is protected by an owner-password
  // session cookie — and the server refuses to serve an exposed surface with no
  // owner password set. So setting the owner password is the exposure gate.
  // Resolve the password to set
  // (prompt / flag / env) BEFORE any mutation so a --yes run with no password
  // and none already set fails clean.
  //
  // A password already on disk (a re-run of an exposed install) satisfies the
  // gate without re-prompting. The owner credential is machine-local
  // (app-storage), so hasOwnerPassword() is meaningful before applyRuntimeConfig.
  let pendingOwnerPassword: string | undefined
  if (exposingNow) {
    const alreadyHasPassword = await hasOwnerPassword()
    if (!alreadyHasPassword) {
      if (interactive) {
        const prompts = await import("@clack/prompts")
        const entered = await prompts.password({
          message:
            "Set an owner password to protect the web app (min 8 chars):",
          validate: (value) =>
            (value ?? "").length < OWNER_PASSWORD_MIN_LENGTH
              ? `Must be at least ${OWNER_PASSWORD_MIN_LENGTH} characters.`
              : undefined,
        })
        if (prompts.isCancel(entered)) {
          prompts.cancel("Setup canceled.")
          process.exitCode = 1
          return
        }
        pendingOwnerPassword = entered
      } else {
        const supplied = resolveOwnerPasswordOption(opts.ownerPassword)
        if (supplied === undefined) {
          fail(OWNER_PASSWORD_REQUIRED_FAILURE)
          return
        }
        if (supplied.length < OWNER_PASSWORD_MIN_LENGTH) {
          fail(OWNER_PASSWORD_TOO_SHORT_FAILURE)
          return
        }
        pendingOwnerPassword = supplied
      }
    }
    // The owner password (existing or pending) IS the acknowledgement. The
    // resolved reachability/host are already correct here; we do NOT consult
    // reachability.needsAck on the exposed path (the password is the gate), so a
    // bare `setup --reachable --owner-password ...` proceeds.
  } else if (reachability.needsAck) {
    // A loopback-resolved path should never need acknowledgement; this guards a
    // non-loopback bind that somehow reached here without the password gate.
    fail(REACHABLE_ACK_FAILURE)
    return
  }

  // HTTPS-UPSTREAM ACK. Operator declares they front Worktable with HTTPS (a
  // tunnel/proxy), which suppresses the reachability reminder — the reminder
  // only, never auth (see exposure-notice.ts). Only meaningful when exposed;
  // forced false otherwise so a later reachable run starts from an explicit
  // choice. --behind-tls wins; an interactive exposed setup is asked.
  let httpsUpstream = exposingNow
    ? opts.behindTls === true || defaultConfig.service.httpsUpstream
    : false
  if (interactive && exposingNow && opts.behindTls === undefined) {
    const prompts = await import("@clack/prompts")
    const answer = await prompts.confirm({
      message: "Do you front Worktable with HTTPS (a tunnel or reverse proxy)?",
      initialValue: defaultConfig.service.httpsUpstream,
    })
    if (prompts.isCancel(answer)) {
      prompts.cancel("Setup canceled.")
      process.exitCode = 1
      return
    }
    httpsUpstream = answer === true
  }

  // Normalize once so the adoption gate classifies exactly the path that
  // writeConfig will persist (the --workspace flag is otherwise untrimmed,
  // letting whitespace point the gate at a different folder than config).
  workspace = normalizeWorkspaceAnswer(workspace)

  // Authoritative adoption gate covering both interactive and --yes paths:
  // classify the resolved workspace before any mutation. A foreign/broken
  // folder aborts with a clear message and no config write; a valid workspace
  // is adopted with its name echoed.
  const workspaceClassification = classifyWorkspaceTarget(workspace)
  const adoption = describeWorkspaceClassification(workspaceClassification)
  if (!adoption.ok) {
    fail(adoption.message)
    return
  }
  if (adoption.confirm) {
    console.log(adoption.message)
  }

  // Same guard as launch, recomputed with the FINAL resolved values (interactive
  // prompts and the port-collision auto-pick can change workspace/reachability/
  // port/background after the initial defaults): if an installed service's state is
  // unknown (systemctl --user unreachable) and this setup would change durable
  // service/workspace state, refuse HERE — the mutation boundary, before the owner
  // password, config write, token mint, or unit reinstall — so nothing diverges from
  // the old service that may still be serving.
  const setupChangesDurableState =
    // A recreated (unrecoverably corrupt) config gives us no trustworthy baseline of
    // the running service, so any reconfigure must count as a change.
    configRecreated ||
    reachability.host !== defaultConfig.service.host ||
    reachability.reachable !== defaultConfig.service.reachable ||
    port !== defaultConfig.service.port ||
    workspace !== defaultConfig.workspace ||
    background !== defaultConfig.service.startAtLogin ||
    defaultConfig.service.exposureAcknowledged !== exposingNow ||
    // httpsUpstream is written into the unit env (WORKTABLE_TLS_UPSTREAM), so a
    // --behind-tls toggle is a durable service change too, exactly like launch.
    httpsUpstream !== defaultConfig.service.httpsUpstream ||
    // WORKTABLE_PUBLIC_URL is also written into the service env, so treat setup
    // with a public origin as a durable service rewrite even though config.json
    // keeps the bind loopback.
    publicOriginFromEnv
  const authorityLock = acquireLocalAuthorityLock()
  try {
    if (existsSync(localActivationPath())) {
      throw new UsageError(
        "A previous local workspace activation did not finish. Run `worktable local-host recover --json` before changing setup."
      )
    }
    const lockedServiceSupport = getServiceStatus()
    assertLocalAuthorityStateUnchanged(
      initialAuthorityState,
      lockedServiceSupport
    )
    assertLocalWorkspaceReservationAvailable({
      ...(workspaceClassification.outcome === "valid"
        ? { workspaceId: workspaceClassification.manifest.id }
        : {}),
      path: workspace,
      host,
      port,
    })
    const activeRuntime = await inspectLocalRuntime()
    const setupPlan = planLocalAuthority({
      operation: "setup",
      desired: {
        ...(workspaceClassification.outcome === "valid"
          ? { workspaceId: workspaceClassification.manifest.id }
          : {}),
        workspacePath: workspace,
        host,
        port,
        background,
        noLaunch,
        changesDurableState: setupChangesDurableState,
      },
      runtime: activeRuntime,
      service: lockedServiceSupport,
      lock: { state: "owned", exactOwnership: true },
      journal: { state: "none" },
    })
    if (setupPlan.action === "refuse") {
      fail(setupPlan.message)
      return
    }
    if (
      activeRuntime?.processAlive &&
      !isVerifiedManagedServiceRuntime(activeRuntime, lockedServiceSupport)
    ) {
      throw new UsageError(
        activeRuntime.endpointVerified
          ? `${activeRuntime.owner === "desktop" ? "Worktable Desktop" : activeRuntime.owner === "service" ? "An unmanaged Worktable service process" : "A foreground Worktable command"} currently owns ${activeRuntime.workspacePath}. Stop it before reconfiguring the shared local installation.`
          : `A live ${activeRuntime.owner} process still holds the local Worktable runtime lease but did not answer its ownership proof. Stop or repair that host before reconfiguring local state.`
      )
    }
    const selectedEndpointProven = Boolean(
      activeRuntime?.processAlive && setupPlan.endpointProven
    )
    const lockedPortState = await classifyPort(host, port)
    if (lockedPortState !== "free" && !selectedEndpointProven) {
      throw new UsageError(
        lockedPortState === "worktable"
          ? `A Worktable server is already answering at ${clientOriginFor(host, port)}, but it did not prove ownership of the shared local runtime lease. Stop or repair that host before continuing setup.`
          : `Port ${port} became occupied while setup was in progress. Run setup again and choose another port.`
      )
    }
    // When this setup will (re)install OR remove the background service, PREFLIGHT
    // that transition here — the mutation boundary — so a doomed install/teardown
    // (unreachable manager, unremovable competitor, unstoppable process) aborts
    // before the owner password, config write, or token mint, never after.
    if (lockedServiceSupport.platform !== "unsupported") {
      if (background) {
        if (runServiceOp(() => prepareServiceInstall()) === null) return
      } else if (lockedServiceSupport.installed) {
        // Toggling background OFF uninstalls the service after the config commit —
        // verify that teardown can complete before persisting "disabled".
        if (runServiceOp(() => prepareServiceUninstall()) === null) return
      }
    }

    // Set the owner password BEFORE persisting exposed config/service state, so a
    // failure can never leave an exposed surface without the required password.
    // The credential is machine-local (app-storage), independent of the workspace
    // bind.
    if (pendingOwnerPassword !== undefined) {
      await setOwnerPassword(pendingOwnerPassword)
    }

    const nextConfig = createDefaultConfig({
      workspace,
      service: {
        host,
        port,
        startAtLogin: background,
        reachable: reachability.reachable,
        // Past the gate with an exposed surface = the risk is acknowledged now;
        // persist it so a hand-edited host can't later fake an acknowledgement.
        exposureAcknowledged: exposingNow,
        httpsUpstream,
      },
      mcp: {
        endpoint: endpointFor(host, port),
        clients: defaultConfig.mcp.clients,
      },
    })
    const configExistedBeforeCommit = existsSync(getConfigPath())
    let config: WorktableConfig
    let workspaceManifest: ReturnType<typeof ensureWorkspaceManifest>
    try {
      config = writeConfig(nextConfig)
      // applyRuntimeConfig points WORKTABLE_WORKSPACE at the final workspace BEFORE
      // any mint — tokens are workspace-bound, so the order matters.
      applyRuntimeConfig(config)
      workspaceManifest = ensureWorkspaceManifest()
      ensureInstallIdentity()
      rememberConfiguredLocalWorkspace(config, workspaceManifest)
    } catch (error) {
      try {
        if (configExistedBeforeCommit) {
          writeConfig(defaultConfig)
        } else {
          rmSync(getConfigPath(), { force: true })
          rmSync(getConfigBackupPath(), { force: true })
        }
        applyRuntimeConfig(defaultConfig)
      } catch (rollbackError) {
        throw new UsageError(
          `${error instanceof Error ? error.message : String(error)} Restoring the previous local config also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        )
      }
      if (error instanceof WorkspaceAdoptionError) {
        fail(error.message)
        return
      }
      throw error
    }

    // (Owner password was set above, before the reachable config was persisted.)

    // Ensure authentication is active before a reachable service can start. Client
    // injection performs a two-phase rotation later, keeping this token valid until
    // every affected client config has been written successfully.
    const exposed = exposingNow
    const willConfigureClients = !skipMcp && selectedClients.length > 0
    if (exposed) {
      await ensureManagedToken()
    }

    const serviceAction = setupPlan.serviceAction
    if (serviceAction === "install") {
      // A failed install (ServiceLifecycleError) aborts setup here — before agent
      // config injection and the final "ready" messaging — instead of proceeding as
      // though the background service exists.
      const servicePublicUrl =
        process.env["WORKTABLE_PUBLIC_URL"]?.trim() ||
        getInstalledServicePublicUrl()
      const service = runServiceOp(() =>
        installService(config, {
          ...(servicePublicUrl ? { publicUrl: servicePublicUrl } : {}),
          authorityHandoff: authorityLock.handoff,
        })
      )
      if (!service) return
      console.log(
        service.platform === "unsupported"
          ? "Background service is not supported on this platform yet."
          : (service.message ?? "Background service configured.")
      )
    } else if (serviceAction === "uninstall") {
      if (!runServiceOp(() => uninstallService())) return
      console.log("Background service disabled.")
    } else if (serviceAction === "unsupported" || serviceUnsupportedNotice) {
      console.log("Background service is not supported on this platform yet.")
    }

    // Configure MCP clients before starting the service. Reachable installs use a
    // two-phase token transaction; loopback installs remain tokenless.
    if (!skipMcp) {
      // An explicit selection (interactive multiselect or --mcp) is authoritative:
      // drop agents the user toggled off so config matches the chosen set. A
      // selection auto-derived from detection (plain --yes) is left untouched.
      const explicitSelection = !yes || Boolean(selectedFromFlag)
      if (explicitSelection) {
        for (const clientId of clientsToDeselect(config, selectedClients)) {
          removeClient(clientId)
        }
      }
      if (selectedClients.length > 0) {
        const results = exposed
          ? await setupManagedClients(selectedClients, true)
          : setupClients(selectedClients, true)
        const configured = results.filter(
          (status) => status.state === "configured"
        ).length
        const needsAttention = results.length - configured
        if (needsAttention === 0) {
          console.log("Agent connections configured.")
        } else {
          console.log(
            `Agent connections: ${configured} configured, ${needsAttention} need attention.`
          )
          printMcpStatuses(results)
        }
      } else {
        console.log(
          style.dim(
            "No agents connected. Run `worktable mcp setup <ids>` later, e.g. `worktable mcp setup codex cursor`."
          )
        )
      }
    }

    if (exposed) {
      console.log()
      if (!httpsUpstream) console.log(style.yellow(REACHABLE_NETWORK_NOTICE))
      printRemoteConnectHint()
      // A setup that moved the workspace but did NOT inject clients this run (either
      // --skip-mcp, or no clients were selected/detected) mints a token for the new
      // workspace without re-pointing agents, so previously-connected agents keep an
      // old-workspace bearer that 401s. Warn whenever we didn't re-inject (the
      // inject path already updates them).
      if (
        !willConfigureClients &&
        resolve(workspace) !== defaultConfig.workspace
      ) {
        console.log(style.yellow(WORKSPACE_SWITCH_AGENTS_WARNING))
      }
    }

    if (!noLaunch) {
      if (background) {
        if (setupPlan.restartRunningService) {
          if (runServiceOp(() => stopService()) === null) return
        }
        const status = startService()
        if (
          (await runServiceOpAsync(() =>
            verifyManagedServiceReady(config, status)
          )) === null
        )
          return
      } else {
        await commandLaunchUnderAuthority(
          { foreground: true, browser: false },
          false,
          authorityLock
        )
        return
      }
      console.log(`Worktable is ready at ${clientOriginFor(host, port)}`)
    }
  } finally {
    authorityLock.release()
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

async function commandStatus(opts: { json?: boolean }): Promise<void> {
  const config = readConfigOrFail()
  if (!config) return
  const service = getServiceStatus()
  const serverRunning = await healthCheck(
    config.service.host,
    config.service.port
  )
  let localRuntime: Awaited<ReturnType<typeof inspectLocalRuntime>> = null
  let localRuntimeError: string | null = null
  try {
    localRuntime = await inspectLocalRuntime()
  } catch (error) {
    localRuntimeError = error instanceof Error ? error.message : String(error)
  }
  // Live-but-bounded: cached within the TTL, otherwise one short fetch. status
  // is the command people run to ask "how is this install doing?", so it is a
  // refresh point for the update-check cache the passive nudge reads.
  const update = await checkForUpdate({ timeoutMs: 2000 })
  const mcp = getMcpStatuses(config)
  const connected = mcp.filter((status) => status.state === "configured").length
  const pending = mcp.filter((status) => status.state === "pending").length

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          version: VERSION,
          latestVersion: update.latest,
          updateAvailable: update.updateAvailable,
          server: {
            running: serverRunning,
            url: clientOriginFor(config.service.host, config.service.port),
          },
          service,
          localRuntime,
          localRuntimeError,
          workspace: config.workspace,
          mcp,
        },
        null,
        2
      )
    )
    return
  }

  console.log(style.bold("Worktable"))
  console.log()
  console.log(
    `Server:     ${serverRunning ? "running at" : "not running at"} ${clientOriginFor(config.service.host, config.service.port)}`
  )
  console.log(
    `Service:    ${service.installed ? `${service.state}${service.startsAtLogin ? ", starts at login" : ""}` : service.state}`
  )
  if (localRuntimeError) {
    console.log(`Local host:  invalid runtime lease (${localRuntimeError})`)
  } else if (localRuntime?.endpointVerified) {
    console.log(
      `Local host:  ${localRuntime.owner} owns ${localRuntime.workspacePath} (pid ${localRuntime.pid})`
    )
  }
  console.log(`Workspace:  ${config.workspace}`)
  console.log(
    `Owner:      ${localRuntime?.endpointVerified ? `${localRuntime.owner} (pid ${localRuntime.pid})` : serverRunning ? "unverified Worktable process" : "none"}`
  )
  console.log(`Version:    ${VERSION}${describeUpdateForStatus(update)}`)
  console.log(`MCP:        ${connected} connected, ${pending} need setup`)
  // Surface service warnings (split-brain, systemd linger, unknown state) here
  // too — `status` is the main "how is this doing?" command, and hiding them
  // behind --json would let it look healthy while a real problem is present.
  for (const warning of service.warnings ?? [])
    console.log(style.yellow(`Warning:    ${warning}`))
  if (
    localRuntime?.endpointVerified &&
    resolve(localRuntime.workspacePath) !== resolve(config.workspace)
  ) {
    console.log(
      style.yellow(
        `Warning:    The running ${localRuntime.owner} host serves ${localRuntime.workspacePath}, but config points at ${config.workspace}. Stop it before changing local workspace state.`
      )
    )
  }
}

/**
 * Version-line annotation for `status`. Silent when the latest version is
 * unknown (offline, source build, or checks disabled) — a bare version then
 * reads exactly as before.
 */
function describeUpdateForStatus(update: {
  latest: string | null
  updateAvailable: boolean
}): string {
  if (!update.latest) return ""
  return update.updateAvailable
    ? ` ${style.yellow(`— update available: ${update.latest} (run \`worktable update\`)`)}`
    : ` ${style.dim("(up to date)")}`
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

function serviceStartError(status: ServiceStatus): string {
  const detail = status.message ? ` ${status.message}` : ""
  return `Could not start Worktable service (${status.state}).${detail} Run \`worktable service status\` for details.`
}

/**
 * Run a service lifecycle operation, converting an expected operational failure
 * (ServiceLifecycleError — install refused, uninstall incomplete, unverifiable
 * stop) into a clean CLI failure (exit 1, message on stderr) instead of a Fatal
 * stack. Returns null on failure so callers bail with `if (!x) return`.
 */
function runServiceOp<T>(op: () => T): T | null {
  try {
    return op()
  } catch (err) {
    if (err instanceof ServiceLifecycleError) {
      fail(err.message)
      return null
    }
    throw err
  }
}

async function runServiceOpAsync<T>(op: () => Promise<T>): Promise<T | null> {
  try {
    return await op()
  } catch (err) {
    if (err instanceof ServiceLifecycleError) {
      fail(err.message)
      return null
    }
    throw err
  }
}

/**
 * When an installed background service's state can't be determined (systemctl
 * --user unreachable) and a command would change its durable config/workspace,
 * both `launch` and `setup` must refuse BEFORE mutating — otherwise config, tokens,
 * and the unit diverge from the old service that may still be serving traffic.
 * Returns an error message to fail with, or null when it's safe to proceed.
 */
function printServiceStatus(status: ServiceStatus, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(status, null, 2))
    return
  }
  console.log(`Service: ${status.state}`)
  console.log(`File:    ${status.serviceFile ?? "(unsupported)"}`)
  console.log(`Logs:    ${status.logs.stdout}`)
  if (status.message) console.log(`Note:    ${status.message}`)
  for (const warning of status.warnings ?? [])
    console.log(style.yellow(`Warning: ${warning}`))
}

/**
 * Print any install/start notices (the linger-fallback message and split-brain /
 * linger warnings) from one or more ServiceStatus results, de-duplicated. Used on
 * the `launch --background` paths, which otherwise report only "running" and would
 * drop installService's linger instructions — leaving the user to discover after a
 * reboot that the service never came back.
 */
function printServiceNotices(...statuses: ServiceStatus[]): void {
  const seen = new Set<string>()
  for (const status of statuses) {
    if (status.message && !seen.has(status.message)) {
      seen.add(status.message)
      console.log(style.yellow(status.message))
    }
    for (const warning of status.warnings ?? []) {
      if (seen.has(warning)) continue
      seen.add(warning)
      console.log(style.yellow(`Warning: ${warning}`))
    }
  }
}

function reportServiceAction(
  status: ServiceStatus,
  json?: boolean,
  expectRunning = false
): void {
  printServiceStatus(status, json)
  // A start/restart that did not end up running is a failure even when the
  // underlying launchctl/systemctl command exited 0 with no stderr.
  if (expectRunning && status.state !== "running") process.exitCode = 1
}

async function commandServiceLogs(opts: {
  follow?: boolean
  lines?: number
}): Promise<void> {
  const status = getServiceStatus()
  const files = [status.logs.stdout, status.logs.stderr].filter((path) =>
    existsSync(path)
  )
  if (files.length === 0) {
    console.log("No service logs yet.")
    return
  }
  const lines = opts.lines ?? 200
  if (opts.follow) {
    const child = Bun.spawn(["tail", "-n", String(lines), "-F", ...files], {
      stdout: "inherit",
      stderr: "inherit",
    })
    await child.exited
    return
  }
  for (const file of files) {
    const allLines = readFileSync(file, "utf8").split("\n")
    // Drop the empty trailing element from a newline-terminated file so the tail
    // count is exact regardless of whether the log ends in a newline.
    if (allLines.length > 0 && allLines[allLines.length - 1] === "")
      allLines.pop()
    const tail = allLines.slice(Math.max(0, allLines.length - lines))
    console.log(style.dim(`# ${file}`))
    console.log(tail.join("\n"))
    console.log()
  }
}

// ---------------------------------------------------------------------------
// mcp
// ---------------------------------------------------------------------------

function assertConnectorInstallableClient(
  clientId: string
): ConnectorInstallableMcpClientId {
  if (
    !CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.includes(
      clientId as ConnectorInstallableMcpClientId
    )
  ) {
    throw new UsageError(
      `Unsupported MCP client: ${clientId}. This command can configure: ${CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.join(", ")}. Use print-config for manual clients or Settings for desktop extensions.`
    )
  }
  return clientId as ConnectorInstallableMcpClientId
}

function mcpClients(opts: { all?: boolean; json?: boolean }): void {
  const clients = listClients(opts.all === true)
  if (opts.json) {
    console.log(JSON.stringify(clients, null, 2))
    return
  }
  for (const client of clients) {
    console.log(`${client.id.padEnd(16)} ${client.label} (${client.maturity})`)
  }
}

async function mcpSetup(selection: string[]): Promise<void> {
  const clients =
    selection.length > 0
      ? parseClientSelection(selection)
      : detectInstalledClients()
  if (clients.length === 0) {
    console.log(
      "No supported agent CLIs or config files were detected. Pass client ids explicitly, for example:"
    )
    console.log("  worktable mcp setup codex cursor")
    return
  }
  // Reachable installs update every desired client in one two-phase transaction.
  // The existing token remains active until all config writes have succeeded.
  const config = ensureConfig()
  applyRuntimeConfig(config)
  if (!isLoopbackHost(config.service.host)) {
    const results = await setupManagedClients(clients, false)
    console.log()
    console.log(
      style.yellow(
        `Committed the managed MCP credential rotation after updating ${results.length} local agent${results.length === 1 ? "" : "s"}. Remote agents connected with \`worktable agent connect\` keep working; if a remote agent still used the legacy shared credential, reconnect it with \`worktable agent invite\`.`
      )
    )
  } else {
    setupClients(clients, false)
  }
}

function mcpStatus(opts: { json?: boolean }): void {
  const config = readConfigOrFail()
  if (!config) return
  const statuses = getMcpStatuses(config)
  if (opts.json) {
    console.log(JSON.stringify(statuses, null, 2))
    return
  }
  printMcpStatuses(statuses)
}

function mcpRemove(clientId: string): void {
  const result = removeClient(assertConnectorInstallableClient(clientId))
  console.log(`${result.label}: removed`)
}

async function mcpPrintConfig(
  clientId: string,
  opts: { withToken?: boolean } = {}
): Promise<void> {
  const config = readConfigOrFail()
  if (!config) return
  const known = new Set(MCP_SNIPPET_CLIENT_IDS)
  if (!known.has(clientId as McpSnippetClientId)) {
    throw new UsageError(
      `No config snippet is available for ${clientId}. Available: ${[...known].join(", ")}. Claude Desktop uses the extension in Settings -> Agents.`
    )
  }
  if (opts.withToken) {
    // The explicit manual path for clients the connector can't write (goose)
    // or locked-down machines: mint a fresh content-scoped bearer and embed
    // it. Same-label rotation bounds re-runs; the raw value is shown once.
    applyRuntimeConfig(config)
    // A manual config is usually destined for ANOTHER machine: use the
    // public endpoint whenever one applies (reachable bind or configured
    // Workspace URL); a pure-loopback install keeps the local endpoint.
    const { origin, configured } = resolveInviteOrigin(config)
    const useRemote = config.service.reachable || configured
    const effective = useRemote
      ? { ...config, mcp: { ...config.mcp, endpoint: remoteMcpUrl(origin) } }
      : config
    // Refuse clients whose snippet cannot carry a bearer: minting one would
    // strand an active credential nothing references.
    const probe = mcpClientSnippet(clientId as McpSnippetClientId, {
      endpoint: effective.mcp.endpoint,
      token: "WT_TOKEN_PROBE",
      reachable: config.service.reachable,
    }).body
    if (!probe.includes("WT_TOKEN_PROBE")) {
      throw new UsageError(
        `The ${clientId} snippet can't embed a bearer token, so --with-token would mint a credential nothing carries.`
      )
    }
    const { token } = await rotateAgentToken({
      agent: `manual-${clientId}`,
      scopes: [...DEFAULT_AGENT_TOKEN_SCOPES],
    })
    printClientConfig(clientId as McpSnippetClientId, effective, token)
    console.log()
    console.log(
      style.yellow(
        "The bearer above is shown once and revokes any prior --with-token bearer for this client. Revoke it any time in Settings -> Agents."
      )
    )
    if (useRemote && !configured) {
      console.log(
        style.yellow(
          `No Workspace URL is configured, so the endpoint above is ${effective.mcp.endpoint}, which other machines may not reach. Set one in Settings -> General (or WORKTABLE_PUBLIC_URL).`
        )
      )
    }
    return
  }
  printClientConfig(clientId as McpSnippetClientId, config)
  // Reachable binds and configured public origins need an explicit bearer.
  // Minted credentials can coexist with bare same-machine loopback clients.
  if (config.service.reachable || resolveInviteOrigin(config).configured) {
    // The managed token's raw value is hashed on disk and can't be reprinted, so
    // print-config emits a tokenless snippet that would 401 on a reachable server.
    // Tell the user how to obtain a working, token-bearing config (the goose
    // adapter already inlines this guidance; this covers every other client).
    console.log()
    console.log(
      style.yellow(
        `This install requires a bearer token on MCP, which the snippet above omits (the managed token can't be reprinted). Re-run with --with-token to mint and embed a scoped bearer, use \`worktable mcp setup ${clientId}\` on this machine, or \`worktable agent invite\` for a remote machine.`
      )
    )
  }
}

async function mcpTest(): Promise<void> {
  const config = readConfigOrFail()
  if (!config) return
  const ok = await healthCheck(config.service.host, config.service.port)
  console.log(
    `MCP endpoint: ${ok ? "reachable" : "unreachable"} (${config.mcp.endpoint})`
  )
  if (!ok) process.exitCode = 1
}

async function mcpBridge(opts: {
  url?: string
  tokenEnv?: string
}): Promise<void> {
  const endpoint = opts.url?.trim() || process.env["WORKTABLE_MCP_URL"]?.trim()
  if (!endpoint) {
    throw new UsageError(
      "Missing MCP URL. Pass --url <mcp-url> or set WORKTABLE_MCP_URL."
    )
  }
  const tokenEnv = opts.tokenEnv?.trim() || "WORKTABLE_MCP_TOKEN"
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    throw new UsageError("--token-env must be an environment variable name.")
  }
  try {
    await runMcpBridge({
      endpoint,
      token: process.env[tokenEnv]?.trim() || undefined,
      clientName: "worktable-cli-bridge",
      clientVersion: VERSION,
    })
  } catch (error) {
    throw new UsageError(formatMcpBridgeError(error))
  }
}

// ---------------------------------------------------------------------------
// update / uninstall
// ---------------------------------------------------------------------------

/**
 * Release URLs are addressed by tag (`releases/v0.0.18/...`), while manifests
 * and the running build carry the plain `0.0.18`. Map a resolved/pinned semver
 * to the tag form install.sh needs; non-semver input passes through untouched.
 */
export function updateTargetForInstall(target: string): string {
  const plain = normalizeVersion(target)
  return plain ? `v${plain}` : target
}

/** True when both are plain semver triples naming the same version. */
export function sameVersion(a: string, b: string): boolean {
  const left = normalizeVersion(a)
  return Boolean(left && left === normalizeVersion(b))
}

async function commandUpdateCheck(): Promise<void> {
  console.log(`Current version: ${VERSION}`)
  if (!updateCheckSupported()) {
    console.log(
      "Update checks aren't available for this build (not an installed release)."
    )
    return
  }
  if (updateCheckDisabled()) {
    console.log(
      "Update checks are disabled (WORKTABLE_NO_UPDATE_CHECK is set)."
    )
    return
  }
  const check = await checkForUpdate({ force: true })
  if (!check.latest) {
    fail("Could not reach the release server to check for the latest version.")
    return
  }
  console.log(`Latest version:  ${check.latest}`)
  console.log(
    check.updateAvailable
      ? `Update available. Run \`worktable update\` to install ${check.latest}.`
      : "You're up to date."
  )
}

async function commandUpdate(opts: {
  check?: boolean
  version?: string
  background?: boolean
  statusFile?: string
}): Promise<void> {
  if (opts.check) {
    await commandUpdateCheck()
    return
  }
  const version = opts.version?.trim() || "latest"

  // The in-app Settings drawer drives updates through this detached worker
  // (spawned by the server). It records its progress to the update-status
  // marker the server polls, and — unlike the interactive path below — it does
  // NOT stop the service before downloading: install.sh stages each version in
  // its own releases/<version> dir and only rewrites the launcher, so the
  // running server is untouched until the final restart. A failed download
  // therefore leaves the old server serving, uninterrupted.
  if (opts.background) {
    await commandUpdateBackground(version, opts.statusFile)
    return
  }

  const releaseDir = getReleaseDir()
  if (!releaseDir)
    throw new UsageError("Cannot locate current release directory.")
  const installer = `${releaseDir}/install.sh`
  if (!existsSync(installer)) {
    console.log(`Current version: ${VERSION}`)
    console.log(
      "This build does not include an embedded installer. Re-run the public install command to update."
    )
    return
  }

  // Resolve "latest" to the concrete published version up front so the update
  // can say what it's doing (from → to) and skip the whole stop/install/restart
  // cycle when already current. Resolution is best-effort: offline, we install
  // "latest" blind exactly as before. A pinned version is honored even when it
  // equals the current one — that's a deliberate reinstall.
  const target =
    version === "latest"
      ? ((await resolveLatestVersion()) ?? "latest")
      : (normalizeVersion(version) ?? version)
  if (
    version === "latest" &&
    target !== "latest" &&
    sameVersion(target, VERSION)
  ) {
    console.log(`Already up to date (${VERSION}).`)
    return
  }
  console.log(
    target === "latest"
      ? `Updating Worktable ${VERSION} → latest…`
      : `Updating Worktable ${VERSION} → ${target}…`
  )

  const authorityLock = acquireLocalAuthorityLock()
  try {
    assertNoPendingLocalActivation("updating Worktable")
    const service = getServiceStatus()
    // Refuse before touching anything when the service is installed but its state is
    // unknown (systemctl --user unreachable this session): stop/start would call the
    // same unavailable manager, so the installer would swap the binary while the old
    // service keeps serving and then falsely report "Updated". Ask for a full login
    // session instead of claiming an update that never restarted the running service.
    if (service.installed && service.state === "unknown") {
      fail(
        "Can't update from here: the service state is unknown because the service manager (systemctl --user) isn't reachable in this session. Re-run the update from a full login session."
      )
      return
    }
    // Load the config the reinstall will need BEFORE stopping the service, so an
    // unrecoverably corrupt config fails the update without first taking the running
    // install down (the reinstall would otherwise throw AFTER stopService, mid-update).
    let reinstallConfig: WorktableConfig | null = null
    if (service.installed) {
      try {
        reinstallConfig = readConfig()
      } catch (err) {
        if (err instanceof ConfigCorruptError) {
          fail(`${err.message} The update was not applied.`)
          return
        }
        throw err
      }
    }
    const wasRunning = service.state === "running"
    const servicePublicUrl = getInstalledServicePublicUrl()
    const installForUpdate = () => {
      if (!reinstallConfig) return
      installService(reinstallConfig, {
        ...(servicePublicUrl ? { publicUrl: servicePublicUrl } : {}),
        authorityHandoff: authorityLock.handoff,
      })
    }
    const restoreRunningService = async (): Promise<boolean> => {
      if (!wasRunning || !reinstallConfig) return true
      const restored = startService()
      return (
        (await runServiceOpAsync(() =>
          verifyManagedServiceReady(reinstallConfig!, restored)
        )) !== null
      )
    }

    // Rewrite the existing service artifact with this transition's handoff before
    // stopping it. That lets a failed installer restore the old executable while
    // the authority lock remains held, rather than making the child contend for the
    // same lock or releasing the transition between stop and recovery.
    if (reinstallConfig && runServiceOp(installForUpdate) === null) return
    // A throwing stop before the installer runs is a clean abort — nothing changed.
    if (wasRunning && runServiceOp(() => stopService()) === null) return
    const result = Bun.spawnSync(
      [
        "sh",
        installer,
        "--version",
        target === "latest" ? "latest" : updateTargetForInstall(target),
        "--no-setup",
      ],
      { stdout: "inherit", stderr: "inherit" }
    )
    if (result.exitCode !== 0) {
      if (!(await restoreRunningService())) return
      process.exitCode = result.exitCode
      return
    }
    if (reinstallConfig) {
      // The installer already ran: on a failed reinstall, RESTORE (start the service
      // back up on the old unit) before failing, so the update never strands a
      // previously-running install stopped.
      try {
        installForUpdate()
      } catch (err) {
        if (err instanceof ServiceLifecycleError) {
          if (!(await restoreRunningService())) return
          fail(`${err.message} The service unit was not rewritten.`)
          return
        }
        throw err
      }
    }
    if (!(await restoreRunningService())) return
    // Confirm from the rewritten launcher — the actual artifact of the update —
    // falling back to the resolved target when no launcher is available.
    const installed =
      launcherVersion() ??
      (target !== "latest" ? normalizeVersion(target) : null)
    if (installed && !sameVersion(installed, VERSION)) {
      console.log(`Updated Worktable ${VERSION} → ${installed}.`)
    } else if (installed) {
      console.log(`Reinstalled Worktable ${installed}.`)
    }
  } finally {
    authorityLock.release()
  }
}

/**
 * The version the (post-install, rewritten) launcher reports. Null outside an
 * installed release or when the probe fails — confirmation then falls back to
 * the resolved target instead of blocking the update result on this probe.
 */
function launcherVersion(): string | null {
  const launcher = process.env["WORKTABLE_LAUNCHER"]?.trim()
  if (!launcher || !existsSync(launcher)) return null
  const result = Bun.spawnSync([launcher, "--version"], {
    stdout: "pipe",
    stderr: "ignore",
  })
  if (result.exitCode !== 0) return null
  return normalizeVersion(result.stdout.toString().trim())
}

/**
 * The detached, server-driven update worker. Writes the update-status marker
 * the server polls and reconciles on its next boot. Ordering matters: download
 * first (service still up), then hand the restart to the service manager last.
 */
async function commandUpdateBackground(
  version: string,
  statusFile?: string
): Promise<void> {
  const now = () => new Date().toISOString()
  // Honor the path the server handed us so the marker the worker writes and the
  // one the server polls are guaranteed to be the same file, rather than relying
  // on both processes deriving an identical default.
  const write = (status: UpdateStatus) => writeUpdateStatus(status, statusFile)
  const releaseDir = getReleaseDir()
  const installer = releaseDir ? `${releaseDir}/install.sh` : null
  // Resolve "latest" to the concrete published version (best-effort) so the
  // marker's `to` — which the Settings drawer shows and boot reconcile checks
  // against the freshly booted VERSION — is a real version whenever the
  // release server is reachable, not the literal string "latest".
  const target =
    version === "latest"
      ? ((await resolveLatestVersion()) ?? "latest")
      : (normalizeVersion(version) ?? version)
  // Carry our own PID on every write so the server can tell a slow-but-alive
  // download apart from a dead worker by liveness, not elapsed time.
  const base: UpdateStatus = {
    state: "running",
    from: VERSION,
    to: target,
    pid: process.pid,
  }
  // Claim the marker with our PID up front (the server's pre-spawn write has
  // none), so a long download is never mistaken for a stalled one.
  write({ ...base, startedAt: now() })

  if (!installer || !existsSync(installer)) {
    write({
      ...base,
      state: "failed",
      finishedAt: now(),
      error:
        "This build has no embedded installer; update via the install script.",
    })
    return
  }

  // "Update to latest" while already on the latest release: nothing to
  // download and no reason to bounce the service — record the success verdict
  // directly, flagged `noop` so the UI reports "already up to date" instead of
  // celebrating (and reloading onto) an update that never happened. (A pinned
  // same-version request still reinstalls, as on the interactive path.)
  if (
    version === "latest" &&
    target !== "latest" &&
    sameVersion(target, VERSION)
  ) {
    write({ ...base, state: "succeeded", noop: true, finishedAt: now() })
    return
  }

  // Refuse BEFORE staging the installer when the service is installed but its state
  // is unknown (systemctl --user unreachable in this worker's session): the restart
  // handoff below can't manage the service, so we'd swap the launcher and leave the
  // old server serving. Fail the update marker instead of staging a broken restart.
  const preService = getServiceStatus()
  if (preService.installed && preService.state === "unknown") {
    write({
      ...base,
      state: "failed",
      finishedAt: now(),
      error:
        "Service state is unknown (the service manager isn't reachable in this session), so the update was not applied. Run the update from a full login session.",
    })
    return
  }
  // Mirror the interactive update: validate the config BEFORE staging/restarting.
  // The process-backend restart re-reads config at start; discovering an
  // unrecoverably corrupt config only then would stop the service, throw, and
  // leave it down with no failure recorded on the marker.
  if (preService.installed) {
    try {
      readConfig()
    } catch (err) {
      if (err instanceof ConfigCorruptError) {
        write({
          ...base,
          state: "failed",
          finishedAt: now(),
          error: `${err.message} The update was not applied.`,
        })
        return
      }
      throw err
    }
  }

  const result = Bun.spawnSync(
    [
      "sh",
      installer,
      "--version",
      target === "latest" ? "latest" : updateTargetForInstall(target),
      "--no-setup",
    ],
    { stdout: "inherit", stderr: "inherit" }
  )
  if (result.exitCode !== 0) {
    write({
      ...base,
      state: "failed",
      finishedAt: now(),
      error: `Installer exited with code ${result.exitCode}. Worktable is still running the previous version.`,
    })
    return
  }

  let authorityLock: LocalAuthorityLock
  try {
    authorityLock = await acquireBackgroundUpdateAuthorityLock()
  } catch (error) {
    write({
      ...base,
      state: "failed",
      finishedAt: now(),
      error: `Update downloaded, but Worktable could not safely restart while another workspace transition was active: ${error instanceof Error ? error.message : String(error)}`,
    })
    return
  }
  try {
    try {
      assertNoPendingLocalActivation("restarting Worktable after the update")
    } catch (error) {
      write({
        ...base,
        state: "failed",
        finishedAt: now(),
        error: `Update downloaded, but Worktable could not safely restart: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }
    const service = getServiceStatus()
    if (!service.installed) {
      // Nothing to restart: a foreground/manual install can't be relaunched from
      // here. The new launcher is staged, so the next manual start is up to date.
      write({
        ...base,
        state: "failed",
        finishedAt: now(),
        error:
          "Update downloaded. Worktable isn't running as a managed service, so quit and relaunch it to finish updating.",
      })
      return
    }
    let restartConfig: WorktableConfig
    try {
      restartConfig = readConfig()
    } catch (error) {
      if (error instanceof ConfigCorruptError) {
        write({
          ...base,
          state: "failed",
          finishedAt: now(),
          error: `${error.message} The update was downloaded but the service was not restarted.`,
        })
        return
      }
      throw error
    }

    // Hand off the restart without rewriting the service unit: its ExecStart is
    // the stable launcher that install.sh has already repointed. The restarting
    // marker carries this worker's PID so the new service child can validate the
    // exact live authority lock even when the manager still has an older unit
    // environment loaded. If the manager kills this worker, the child recovers
    // the now-stale lock itself before serving.
    write({
      ...base,
      state: "restarting",
      startedAt: now(),
      authorityNonce: authorityLock.nonce,
      ...(authorityLock.ownerIdentity
        ? { authorityOwnerIdentity: authorityLock.ownerIdentity }
        : {}),
    })
    let restart: ServiceStatus
    try {
      restart = restartService()
      // If we're still alive here, the restart did not replace us. Don't judge it
      // instantly: launchd `kickstart -k` and systemd restart are asynchronous.
      for (let i = 0; i < 10 && restart.state !== "running"; i++) {
        Bun.sleepSync(1000)
        restart = getServiceStatus()
      }
      if (restart.state !== "running") {
        write({
          ...base,
          state: "failed",
          finishedAt: now(),
          error: restart.message
            ? `Update installed but the service did not restart: ${restart.message}`
            : "Update installed but the service did not restart. Quit and relaunch Worktable to finish.",
        })
        return
      }
      await verifyManagedServiceReady(restartConfig, restart)
    } catch (error) {
      if (error instanceof ServiceLifecycleError) {
        write({
          ...base,
          state: "failed",
          finishedAt: now(),
          error: `Update installed but the service did not restart: ${error.message}`,
        })
        return
      }
      throw error
    }
  } finally {
    authorityLock.release()
  }
}

/** Print the human-readable removal plan shown before the confirmation prompt. */
function printUninstallPlan(
  config: WorktableConfig,
  configuredClients: ConnectorInstallableMcpClientId[],
  appDir: string,
  purge: boolean
): void {
  const labels = new Map(
    listClients(true).map((client) => [client.id, client.label])
  )
  console.log("Uninstalling Worktable will remove:")
  console.log("  • Background service (stop + deregister)")
  console.log("  • Installed releases and the app binary")
  console.log("  • CLI launchers: worktable, wtb")
  if (configuredClients.length > 0) {
    const names = configuredClients.map((id) => labels.get(id) ?? id).join(", ")
    console.log(`  • Agent (MCP) registrations: ${names}`)
  }
  console.log("  • Shell completions (bash, zsh, fish)")
  console.log("  • Worktable agent skills installed on this computer")
  console.log(`  • App data — config, tokens, owner password, logs: ${appDir}`)
  if (purge) {
    console.log("")
    console.log(
      "And will PERMANENTLY DELETE your workspace and all its contents:"
    )
    console.log(`  • ${config.workspace}`)
  } else {
    console.log("")
    console.log("Preserved:")
    console.log(
      `  • Workspace: ${config.workspace}  (pass --purge to delete this too)`
    )
  }
  console.log("")
}

function loadStableConfigForUninstall(): {
  config: WorktableConfig
  corrupt: boolean
  configFile: string | null
} {
  const path = getConfigPath()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = readOptionalAuthorityFile(path)
    let config: WorktableConfig
    let corrupt = false
    try {
      config = readConfig()
    } catch (error) {
      if (!(error instanceof ConfigCorruptError)) throw error
      corrupt = true
      config = createDefaultConfig()
    }
    const after = readOptionalAuthorityFile(path)
    if (before === after) return { config, corrupt, configFile: after }
  }
  throw new UsageError(
    "The local Worktable configuration kept changing while uninstall started. Run uninstall again after the other Worktable operation finishes."
  )
}

async function commandUninstall(opts: {
  yes?: boolean
  purge?: boolean
}): Promise<void> {
  // Uninstall must be able to clean up even a BROKEN install: a corrupt config
  // must not block teardown of machine-local state. Fall back to defaults (empty
  // client list, resolved-default workspace) and remember it was corrupt so purge
  // won't trust an unknown workspace path below.
  const {
    config,
    corrupt: configCorrupt,
    configFile: initialConfigFile,
  } = loadStableConfigForUninstall()
  const purge = opts.purge === true
  const appDir = getAppDir()
  const initialAuthorityState = snapshotLocalAuthorityState()
  if (initialAuthorityState.config !== initialConfigFile) {
    throw new UsageError(
      "The local Worktable configuration changed while uninstall started. Run uninstall again to continue from the current state."
    )
  }
  // Agents whose config we injected — captured before teardown so the plan can
  // name them and so removal still has a config to read.
  const configuredClients = configCorrupt
    ? []
    : CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.filter(
        (id) => config.mcp.clients[id]?.desired
      )

  // Confirm unless --yes. A destructive teardown must never run unattended on a
  // guess: with no interactive terminal and no --yes there's no way to confirm,
  // so refuse rather than assume consent.
  if (opts.yes !== true) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new UsageError(
        "Refusing to uninstall without confirmation. Re-run `worktable uninstall --yes` (add --purge to also delete the workspace)."
      )
    }
    printUninstallPlan(config, configuredClients, appDir, purge)
    const prompts = await import("@clack/prompts")
    const proceed = await prompts.confirm({
      message: purge
        ? "Remove Worktable AND permanently delete the workspace?"
        : "Remove Worktable from this machine?",
      initialValue: false,
    })
    if (prompts.isCancel(proceed) || !proceed) {
      prompts.cancel("Uninstall canceled. Nothing was removed.")
      return
    }
  }

  const authorityLock = acquireLocalAuthorityLock()
  try {
    const currentService = getServiceStatus()
    assertLocalAuthorityStateUnchanged(initialAuthorityState, currentService)
    let activeRuntime: Awaited<ReturnType<typeof inspectLocalRuntime>>
    try {
      activeRuntime = await inspectLocalRuntime()
    } catch (error) {
      throw new UsageError(
        `Worktable cannot safely identify the current local host (${error instanceof Error ? error.message : String(error)}). Repair or upgrade Worktable before uninstalling.`
      )
    }
    if (activeRuntime?.processAlive) {
      if (!activeRuntime.endpointVerified) {
        throw new UsageError(
          `A live ${activeRuntime.owner} process still holds the local Worktable runtime lease but did not answer its ownership proof. Stop or repair that host before uninstalling.`
        )
      }
      if (!isVerifiedManagedServiceRuntime(activeRuntime, currentService)) {
        throw new UsageError(
          activeRuntime.owner === "desktop"
            ? "Quit Worktable Desktop before uninstalling the shared local installation."
            : activeRuntime.owner === "cli"
              ? "Stop the foreground Worktable command before uninstalling the shared local installation."
              : "An unmanaged Worktable service process is running. Stop it before uninstalling the shared local installation."
        )
      }
    }

    // Validate and recover every skill projection before the first destructive
    // uninstall step, then retain the shared lifecycle lock through all cleanup.
    const uninstallCompleted = withPreparedSkillProjectionsDuringUninstall(
      (skillLifecycle) => {
        // 1. Disconnect MCP clients first — this runs external CLIs (`claude mcp
        //    remove`) and rewrites agent config files, and needs config still on disk.
        //    Best-effort per client: a missing/locked agent config must not abort the
        //    rest of teardown.
        for (const id of configuredClients) {
          try {
            removeClient(id)
          } catch {
            // ignore — leave a stale agent entry rather than halt the uninstall.
          }
        }

        // 2. Stop + deregister the background service. The launchd plist / systemd
        //    unit live outside the app dir, and the process-backend marker lives
        //    inside it, so this must run before the app dir is removed. If a service
        //    could NOT be stopped/removed (degraded session), uninstallService throws —
        //    ABORT before deleting launchers/app dir, otherwise a still-bootable unit
        //    would point at deleted files.
        if (runServiceOp(() => uninstallService()) === null) return false

        // 3. Remove byte-exact owned skill projections while their manifests still
        //    exist. Changed paths are preserved and reported, missing paths are
        //    reported, and exact siblings are still removed transactionally.
        const skillCleanup = skillLifecycle.removeOwned()
        for (const projection of skillCleanup.preserved) {
          console.log(`Changed skills preserved at ${projection.targetRoot}`)
          if (projection.modifiedSkillPaths.length > 0) {
            console.log(
              `  Locally modified: ${projection.modifiedSkillPaths.join(", ")}`
            )
            console.log(
              "  Move or remove locally changed Worktable skill folders before reinstalling."
            )
          }
          if (projection.missingSkillPaths.length > 0) {
            console.log(
              `  Already missing: ${projection.missingSkillPaths.join(", ")}`
            )
          }
        }

        // 4. Remove the release tree ONLY when WORKTABLE_RELEASE_DIR pins it outside
        //    the app dir. In a normal install the release lives at <appDir>/releases,
        //    which the app-dir wipe (step 8) already removes. Gating on the env var is
        //    also a safety belt: a source checkout has no WORKTABLE_RELEASE_DIR, and
        //    its derived release dir resolves to the repo's own tree — removing
        //    dirname(releaseDir) there would delete source, not a release.
        const releaseOverride = process.env["WORKTABLE_RELEASE_DIR"]?.trim()
        if (releaseOverride) {
          const releaseDir = getReleaseDir()
          if (releaseDir && existsSync(dirname(releaseDir)))
            rmSync(dirname(releaseDir), { recursive: true, force: true })
        }

        // 5. Remove BOTH launchers install.sh writes — the canonical `worktable` and
        //    the `wtb` alias — or `wtb` lingers on PATH and execs a deleted release
        //    tree. WORKTABLE_LAUNCHER is always the canonical `worktable` path, so the
        //    install dir derives from it (or from WORKTABLE_INSTALL_DIR).
        const installDir =
          process.env["WORKTABLE_INSTALL_DIR"]?.trim() ||
          (process.env["WORKTABLE_LAUNCHER"]?.trim()
            ? dirname(process.env["WORKTABLE_LAUNCHER"]!.trim())
            : undefined)
        const launchers = [
          process.env["WORKTABLE_LAUNCHER"]?.trim(),
          installDir ? `${installDir}/worktable` : undefined,
          installDir ? `${installDir}/wtb` : undefined,
        ].filter((path): path is string => Boolean(path))
        for (const path of launchers) {
          if (existsSync(path)) rmSync(path, { force: true })
        }

        // 6. Remove shell completions for both command names across all shells.
        for (const path of completionPaths()) {
          if (existsSync(path)) rmSync(path, { force: true })
        }

        // 7. Workspace is preserved by default; deleted only on explicit --purge. When
        //    the config was corrupt we can't trust the workspace path (deleting the wrong
        //    directory is unrecoverable), so machine-local state is still removed but the
        //    workspace is left in place regardless of --purge. Purge happens while the
        //    authority lock still exists in app data so another launch cannot attach to
        //    the workspace while its contents are being deleted.
        const canPurge = purge && !configCorrupt
        if (canPurge && existsSync(config.workspace))
          rmSync(config.workspace, { recursive: true, force: true })

        // 8. Remove machine-local app data LAST: config, install identity, tokens,
        //    owner-password hash, service logs, caches, and the default release
        //    tree. The shared projection boundary preserves its in-root lifecycle
        //    lock through this deletion, releases it after the continuation, then
        //    removes only empty ancestors. A concurrent post-release install can
        //    therefore recreate state without uninstall deleting it.
        skillLifecycle.removeAppData()
        return true
      }
    )
    if (!uninstallCompleted) return

    console.log("Worktable removed.")
    if (configCorrupt) {
      console.log(
        "Note: the config was unreadable, so machine-local state was removed but the workspace was left untouched. Delete it manually if you intended --purge."
      )
    } else if (purge) {
      console.log(`Workspace deleted: ${config.workspace}`)
    } else {
      console.log(`Workspace preserved: ${config.workspace}`)
    }
  } finally {
    authorityLock.release()
  }
}

// ---------------------------------------------------------------------------
// update nudge
// ---------------------------------------------------------------------------

// Commands that never get the passive update nudge appended: surfaces whose
// stdout is a protocol or config snippet (mcp stdio would corrupt the MCP
// stream; print-config and completion output get pasted/sourced), logs, and
// commands that manage their own update messaging.
const UPDATE_NUDGE_EXCLUDED_COMMANDS = new Set([
  "status",
  "update",
  "uninstall",
  "mcp stdio",
  "mcp bridge",
  "mcp print-config",
  "service logs",
  // The hidden completion engine command (registerCompletion) — its stdout is
  // parsed by shells, like the visible `completion` group excluded below.
  "__completion_internal",
])

/**
 * Pure gate for the passive update nudge printed after human-facing commands.
 * Cache-only data (never network): TTY stdout, no --json, the command
 * succeeded, the command isn't an excluded surface, and a strictly newer
 * release is known.
 */
export function shouldShowUpdateNudge(opts: {
  commandPath: string
  json: boolean
  isTTY: boolean
  failed: boolean
  current: string
  latest: string | null
}): boolean {
  if (!opts.isTTY || opts.json || opts.failed) return false
  if (UPDATE_NUDGE_EXCLUDED_COMMANDS.has(opts.commandPath)) return false
  if (opts.commandPath.startsWith("completion")) return false
  if (opts.commandPath.startsWith("local-host")) return false
  return Boolean(opts.latest && isNewerVersion(opts.latest, opts.current))
}

/** Space-joined command path ("mcp setup"), excluding the root program name. */
function commandPathOf(command: {
  name: () => string
  parent: unknown
}): string {
  const names: string[] = []
  let cursor: { name: () => string; parent: unknown } | null = command
  while (cursor && cursor.parent) {
    names.unshift(cursor.name())
    cursor = cursor.parent as { name: () => string; parent: unknown } | null
  }
  return names.join(" ")
}

// ---------------------------------------------------------------------------
// program construction
// ---------------------------------------------------------------------------

export function buildProgram(): Command {
  const program = new Command()
  program
    .name("worktable")
    .description("A local workspace for you and your AI agents.")
    .version(VERSION, "-V, --version", "output the Worktable version")
    .showHelpAfterError("(run `worktable --help` for usage)")
    .configureHelp({ showGlobalOptions: false })

  // Passive update nudge after human-facing commands. Reads only the cached
  // update check (written by `status`, `update --check`, and the running
  // server), so it costs zero network and zero latency on every command.
  program.hook("postAction", (_thisCommand, actionCommand) => {
    const cached = getCachedUpdateCheck()
    const opts = actionCommand.opts() as { json?: boolean }
    if (
      shouldShowUpdateNudge({
        commandPath: commandPathOf(actionCommand),
        json: opts.json === true,
        isTTY: Boolean(process.stdout.isTTY),
        failed: Boolean(process.exitCode),
        current: cached.current,
        latest: cached.latest,
      })
    ) {
      console.log()
      console.log(
        style.dim(
          `Update available: ${cached.current} → ${cached.latest}. Run \`worktable update\` to install.`
        )
      )
    }
  })

  program
    .command("launch")
    .description("Start or reuse Worktable and open it")
    .option("-b, --background", "run as a managed background service")
    .option("-f, --foreground", "run in the foreground (Ctrl+C to stop)")
    .option("--no-browser", "do not open the browser")
    .addOption(
      new CommanderOption("--no-open", "alias for --no-browser").hideHelp()
    )
    .option("-p, --port <port>", "port to listen on", parsePortOption)
    .option("-H, --host <host>", "host interface to bind")
    .option("-w, --workspace <dir>", "workspace directory")
    .addOption(
      new CommanderOption(
        "--ephemeral-workspace <dir>",
        "use process-local workspace and bind settings without reading or persisting CLI config"
      ).hideHelp()
    )
    .option(
      "--reachable",
      "bind all interfaces so other machines can connect (web app behind owner password, MCP behind a token)"
    )
    .addOption(
      new CommanderOption("--bind", "alias for --reachable").hideHelp()
    )
    .option(
      "--owner-password <pw>",
      "owner password to protect the web app when reachable (or set WORKTABLE_OWNER_PASSWORD)"
    )
    .option(
      "--behind-tls",
      "you front Worktable with HTTPS (a tunnel/proxy); suppresses the reachability reminder"
    )
    .action((opts) => commandLaunch(opts))

  program
    .command("setup")
    .description(
      "Configure workspace, background service, and agent connections"
    )
    .option("-y, --yes", "accept defaults without prompting")
    .option("-b, --background", "run as a managed background service")
    .option("-f, --foreground", "run in the foreground")
    .option("--skip-mcp", "skip agent connection setup")
    .option("--no-launch", "do not launch after setup")
    .option("--mcp <ids>", "comma-separated agent client ids to connect")
    .option("-w, --workspace <dir>", "workspace directory")
    .option("-H, --host <host>", "host interface to bind")
    .option("-p, --port <port>", "port to listen on", parsePortOption)
    .option(
      "--reachable",
      "bind all interfaces so other machines can connect (web app behind owner password, MCP behind a token)"
    )
    .addOption(
      new CommanderOption("--bind", "alias for --reachable").hideHelp()
    )
    .option(
      "--owner-password <pw>",
      "owner password to protect the web app when reachable (or set WORKTABLE_OWNER_PASSWORD)"
    )
    .option(
      "--behind-tls",
      "you front Worktable with HTTPS (a tunnel/proxy); suppresses the reachability reminder"
    )
    .action((opts) => commandSetup(opts))

  program
    .command("status")
    .description("Show server, workspace, service, and agent state")
    .option("--json", "machine-readable output")
    .action((opts) => commandStatus(opts))

  program
    .command("doctor")
    .description("Diagnose installation problems")
    .option("--check", "exit non-zero if the install is degraded")
    .action((opts) => printDoctor(opts.check === true))

  program
    .command("paths")
    .description("Print resolved runtime paths")
    .option("--json", "machine-readable output")
    .action((opts) => commandPaths(opts))

  const localHost = program
    .command("local-host", { hidden: true })
    .description("Machine-facing local host authority")
  localHost
    .command("inspect", { isDefault: true })
    .description("Inspect canonical local workspace and runtime ownership")
    .option("--json", "machine-readable output")
    .action(() => commandLocalHostInspect())
  localHost
    .command("activate")
    .description("Activate one prepared workspace for local Worktable surfaces")
    .argument("<directory>", "prepared Worktable workspace directory")
    .option("--port <port>", "preferred stable local port", parsePortOption)
    .addOption(
      new CommanderOption(
        "--wait-for-welcome",
        "wait for first-run starter content before attaching"
      ).hideHelp()
    )
    .option("--json", "machine-readable output")
    .action((directory, opts) => commandLocalHostActivate(directory, opts))
  localHost
    .command("restart")
    .description("Restart the canonical local host without changing workspaces")
    .option("--json", "machine-readable output")
    .action(() => commandLocalHostRestart())
  localHost
    .command("recover")
    .description("Roll back an interrupted local workspace activation")
    .option("--json", "machine-readable output")
    .action(() => commandLocalHostRecover())

  const workspace = program
    .command("workspace")
    .description("Export or import portable workspace snapshots")

  workspace
    .command("export")
    .description("Export the configured workspace to a versioned snapshot")
    .argument("<file>", "destination .wtb file")
    .option("--force", "replace an existing export file")
    .addOption(
      new CommanderOption(
        "--format <format>",
        "package format (wtb or legacy-json)"
      )
        .choices(["wtb", "legacy-json"] as const)
        .default("wtb" as const)
    )
    .addOption(
      new CommanderOption(
        "--history <mode>",
        "history to include (all, age, count, or none)"
      )
        .choices(["all", "age", "count", "none"] as const)
        .default("all" as const)
    )
    .option(
      "--history-days <days>",
      "days retained with --history age",
      parsePositiveIntegerOption,
      30
    )
    .option(
      "--history-count <count>",
      "versions per item with --history count",
      parsePositiveIntegerOption,
      50
    )
    .action((file, opts) => commandWorkspaceExport(file, opts))

  workspace
    .command("import")
    .description("Import a snapshot as a new independent workspace")
    .argument("<file>", "source .wtb or legacy .wtb.json file")
    .argument("<directory>", "missing or empty destination directory")
    .action((file, directory) => commandWorkspaceImport(file, directory))

  workspace
    .command("inspect", { hidden: true })
    .description("Inspect a workspace folder for a supervised desktop host")
    .argument(
      "[directory]",
      "workspace directory; defaults to the provider root"
    )
    .option("--json", "machine-readable output")
    .action((directory) => commandWorkspaceInspect(directory))

  workspace
    .command("prepare", { hidden: true })
    .description("Prepare a workspace folder for a supervised desktop host")
    .argument("<directory>", "workspace directory")
    .requiredOption("--intent <intent>", "create, open, or create-or-open")
    .option("--json", "machine-readable output")
    .action((directory, opts) => {
      if (
        opts.intent !== "create" &&
        opts.intent !== "open" &&
        opts.intent !== "create-or-open"
      ) {
        console.log(
          JSON.stringify({
            schemaVersion: DESKTOP_WORKSPACE_CONTRACT_VERSION,
            ok: false,
            error: {
              code: "INVALID_INTENT",
              message: "--intent must be create, open, or create-or-open",
            },
          })
        )
        process.exitCode = 1
        return
      }
      commandWorkspacePrepare(directory, opts.intent)
    })

  const service = program
    .command("service")
    .description("Manage the background service")
  const serviceActions: Array<{
    name: string
    description: string
    expectRunning?: boolean
    run: () => ServiceStatus | Promise<ServiceStatus>
  }> = [
    {
      name: "install",
      description: "Install the service",
      // readConfig (not ensureConfig): install must never REWRITE config — the old
      // read-then-write could persist loopback defaults from a corrupt read, the
      // silent reachable downgrade. readConfig recovers reachable intent from the
      // backup or throws, so install can only ever act on the real config.
      run: () =>
        withLocalAuthorityLock(() => {
          const publicUrl =
            process.env["WORKTABLE_PUBLIC_URL"]?.trim() ||
            getInstalledServicePublicUrl()
          return installService(readConfig(), {
            ...(publicUrl ? { publicUrl } : {}),
          })
        }),
    },
    {
      name: "start",
      description: "Start the service",
      expectRunning: true,
      run: () => startInstalledServiceWithAuthority(false),
    },
    {
      name: "stop",
      description: "Stop the service",
      run: () => withLocalAuthorityLock(() => stopService()),
    },
    {
      name: "restart",
      description: "Restart the service",
      expectRunning: true,
      run: () => startInstalledServiceWithAuthority(true),
    },
    {
      name: "status",
      description: "Show service status",
      run: () => getServiceStatus(),
    },
    {
      name: "uninstall",
      description: "Remove the service",
      run: () => withLocalAuthorityLock(() => uninstallService()),
    },
  ]
  for (const action of serviceActions) {
    service
      .command(action.name, { isDefault: action.name === "status" })
      .description(action.description)
      .option("--json", "machine-readable output")
      .action(async (opts) => {
        // ServiceLifecycleError → clean failure (exit 1, message on stderr), so
        // e.g. a refused `service install` can never print a status and exit 0.
        const status = await runServiceOpAsync(async () => await action.run())
        if (!status) return
        reportServiceAction(status, opts.json, action.expectRunning)
      })
  }
  service
    .command("logs")
    .description("Print service logs")
    .option("-f, --follow", "stream new log lines")
    .option("-n, --lines <n>", "number of lines to show", parseLinesOption)
    .action((opts) => commandServiceLogs(opts))

  const agent = program
    .command("agent")
    .description("Connect coding agents on other machines")
  agent
    .command("invite")
    .description("Create a pairing code and print the one-line connect command")
    .option(
      "--client <id>",
      `agent client on the remote machine (${INVITE_CLIENTS.join(", ")}); omit to auto-detect there`
    )
    .action(async (opts) => {
      await agentInvite(opts)
    })
  agent
    .command("connect")
    .description(
      "Redeem a pairing code on THIS machine and configure its agents"
    )
    .argument(
      "<code-or-url>",
      "pairing code from `worktable agent invite` or Settings -> Agents"
    )
    .option(
      "--client <id>",
      "configure one specific client instead of the pairing's choice"
    )
    .option("--all", "configure every detected client")
    .option(
      "--replace",
      "intentionally replace an existing Worktable client entry"
    )
    .option(
      "--server <origin>",
      "Worktable origin (needed when passing a bare code)"
    )
    .action(async (code, opts) => {
      if (opts.client && opts.all) {
        throw new UsageError(
          "--client and --all are mutually exclusive: --all installs every detected client, while --client labels the minted token for exactly one."
        )
      }
      const argv = [
        code,
        ...(opts.client ? ["--client", opts.client] : []),
        ...(opts.all ? ["--all"] : []),
        ...(opts.replace ? ["--replace"] : []),
        ...(opts.server ? ["--server", opts.server] : []),
      ]
      process.exitCode = await runConnector(argv)
    })

  const mcp = program
    .command("mcp")
    .description("Configure agent connections on this machine")
  mcp
    .command("setup", { isDefault: false })
    .description("Connect agents (auto-detects when no ids are given)")
    .argument("[clients...]", "client ids, e.g. codex cursor (or `all`)")
    .action(async (clients) => {
      await mcpSetup(clients)
    })
  mcp
    .command("remove")
    .description("Disconnect an agent")
    .argument("<client>", "client id")
    .action((client) => mcpRemove(client))
  mcp
    .command("clients")
    .description("List supported agent clients")
    .option("--all", "include planned/experimental clients")
    .option("--json", "machine-readable output")
    .action((opts) => mcpClients(opts))
  mcp
    .command("status", { isDefault: true })
    .description("Show agent connection status")
    .option("--json", "machine-readable output")
    .action((opts) => mcpStatus(opts))

  const skills = program
    .command("skills")
    .description("Manage Worktable agent skills on this machine")
  skills
    .command("status", { isDefault: true })
    .description("Show Worktable skill installation status")
    .argument("[targets...]", "targets: claude, agents, or all")
    .option("--json", "machine-readable output")
    .action((targets, opts) => commandSkillStatus(targets, opts))

  for (const operation of ["install", "update", "repair", "remove"] as const) {
    skills
      .command(operation)
      .description(`${operation} Worktable skills in a target folder`)
      .argument("<target>", "target: claude or agents")
      .option("--preview", "calculate the exact plan without changing files")
      .option("--plan-id <id>", "apply one previously reviewed exact plan")
      .option("-y, --yes", "apply without an additional prompt")
      .option("--json", "machine-readable output")
      .action((target, opts) => commandSkillOperation(operation, target, opts))
  }
  mcp
    .command("repair")
    .description("Re-apply config for connected agents")
    .action(async () => {
      await repairClients()
    })
  mcp
    .command("test")
    .description("Check whether the MCP endpoint is reachable")
    .action(() => mcpTest())
  mcp
    .command("print-config")
    .description("Print the MCP config snippet for a client")
    .argument("<client>", "client id")
    .option("--with-token", "mint a scoped bearer and embed it (shown once)")
    .action(async (client, opts) => {
      await mcpPrintConfig(client, opts)
    })
  mcp
    .command("bridge", { hidden: true })
    .description("Bridge a Worktable HTTP MCP server to stdio")
    .option("--url <mcp-url>", "MCP URL (defaults to WORKTABLE_MCP_URL)")
    .option(
      "--token-env <name>",
      "environment variable containing the bearer token",
      "WORKTABLE_MCP_TOKEN"
    )
    .action(async (opts) => {
      await mcpBridge(opts)
    })
  mcp
    .command("stdio", { hidden: true })
    .description("Run the MCP server over stdio (for agent hosts)")
    .action(() => runStdioMcp())

  program
    .command("update")
    // Version is a positional, not --version: the global `.version()` option
    // shadows a subcommand `--version`, so `update --version <tag>` would print
    // the CLI version and exit instead of updating.
    .argument("[version]", "release version to install (default: latest)")
    .description("Update Worktable to the latest release")
    .option("--check", "check for a newer release without installing anything")
    // Internal: the in-app updater spawns `update --background` detached and
    // tracks progress via the update-status marker the server polls.
    .option(
      "--background",
      "run as a detached worker that reports status to the server"
    )
    .option(
      "--status-file <path>",
      "path to the update-status marker (with --background)"
    )
    .action((version, opts) =>
      commandUpdate({
        check: opts.check,
        version,
        background: opts.background,
        statusFile: opts.statusFile,
      })
    )

  program
    .command("uninstall")
    .description(
      "Remove Worktable from this machine (workspace preserved unless --purge)"
    )
    .option("-y, --yes", "skip the confirmation prompt")
    .option(
      "--purge",
      "also permanently delete the workspace folder and all its contents"
    )
    .action((opts) => commandUninstall(opts))

  program.addHelpText(
    "after",
    `
Examples:
  worktable                       Launch Worktable
  worktable launch --background   Run as a background service
  worktable setup                 Configure workspace, service, and agents
  worktable mcp setup codex       Connect an agent
  worktable status --json         Machine-readable status`
  )

  registerCompletion(program)
  return program
}

function parseLinesOption(value: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1)
    throw new InvalidArgumentError("--lines must be a positive integer.")
  return Number(value)
}

/**
 * Normalize argv before Commander sees it:
 *  - bare `worktable --mcp` is the published MCP stdio spawn contract → `mcp stdio`.
 *  - a bare invocation or one that starts with an option (other than the global
 *    --help/--version) defaults to `launch`, preserving `worktable` and
 *    `worktable --port 7000` while keeping clean "unknown command" errors.
 */
export function preprocessArgv(argv: string[]): string[] {
  if (argv.length === 1 && argv[0] === "--mcp") return ["mcp", "stdio"]
  const globalPassthrough = new Set(["--help", "-h", "--version", "-V"])
  const first = argv[0]
  if (
    argv.length === 0 ||
    (first!.startsWith("-") && !globalPassthrough.has(first!))
  ) {
    return ["launch", ...argv]
  }
  return argv
}

export async function main(): Promise<void> {
  const argv = preprocessArgv(process.argv.slice(2))
  const program = buildProgram()
  await program.parseAsync(argv, { from: "user" })
}

/**
 * Write to stderr without assuming the stream initialized. A failed stdio
 * setup (e.g. Bun's TTY WriteStream crashing on a reopened /dev/tty) can leave
 * process.stderr undefined; falling back to fd 2 keeps the real error visible
 * instead of masking it with a TypeError from the handler itself.
 */
function reportFatal(message: string): void {
  try {
    if (process.stderr?.write) {
      process.stderr.write(message)
      return
    }
  } catch {
    // fall through to the raw fd write below
  }
  try {
    writeSync(2, message)
  } catch {
    // nothing left to do if even the raw write fails
  }
}

/** Entry point shared by bin/worktable.ts and direct `bun run src/index.ts`. */
export async function runMain(): Promise<void> {
  try {
    await main()
  } catch (error) {
    if (error instanceof UsageError) {
      reportFatal(`${error.message}\n`)
    } else {
      reportFatal(
        `Fatal: ${error instanceof Error ? error.message : String(error)}\n`
      )
    }
    process.exit(1)
  }
}

if (import.meta.main) {
  void runMain()
}
