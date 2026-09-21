import { existsSync } from "node:fs"
import {
  captureClientConfigMutation,
  type ClientConfigSnapshot,
  claudeCodeAdd,
  claudeCodeRemove,
  codexCliAdd,
  codexPath,
  commandExists,
  cursorEntry,
  cursorPath,
  defaultVscodePath,
  installClient,
  opencodeEntry,
  opencodePath,
  preflightClient,
  readCodexAuth,
  readCodexConfigError,
  readCodexUrl,
  readJsonAuth,
  readJsonUrl,
  removeCodex,
  removeJsonUrl,
  restoreClientConfig,
  setupJsonUrl,
  vscodeEntry,
  vscodePath,
  validateClientConfigSnapshot,
  writeCodexUrl,
} from "@worktable/mcp-connect"
import {
  applyRuntimeConfig,
  isLoopbackHost,
  type McpClientId,
  type McpClientState,
  PLANNED_MCP_CLIENT_IDS,
  readConfig,
  setClientState,
  SUPPORTED_MCP_CLIENT_IDS,
  type WorktableConfig,
  updateConfig,
} from "./config.ts"
import { UsageError } from "./style.ts"
import {
  createToken,
  finalizeAgentTokenRotations,
  getWorkspaceRoot,
  listTokens,
  revokeToken,
} from "@worktable/server/runtime"
import {
  DEFAULT_AGENT_TOKEN_SCOPES,
  CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS,
  MCP_CLIENTS,
  mcpClientSnippet,
  type ConnectorInstallableMcpClientId,
  type McpSnippetClientId,
} from "@worktable/types"

// The agent label stamped on tokens auto-minted for same-machine managed
// configs. Used to find and revoke prior managed tokens before minting a
// fresh one, bounding credential accumulation across repeated setup/repair.
export const MANAGED_AGENT_LABEL = "managed"

function managedClientAgentLabel(
  clientId: ConnectorInstallableMcpClientId
): string {
  return `${MANAGED_AGENT_LABEL}:${clientId}`
}

function isManagedAgentLabel(agent: string | null): boolean {
  return (
    agent === MANAGED_AGENT_LABEL ||
    agent?.startsWith(`${MANAGED_AGENT_LABEL}:`) === true
  )
}

// Least-privilege resource scopes for managed-config credentials: the shared
// agent-token scope set (see DEFAULT_AGENT_TOKEN_SCOPES). Each credential
// intentionally retains full content read/write: its least-privilege boundary
// is "no token minting / no owner-only ops", not "no content writes" (an
// agent must be able to do the work).
const MANAGED_TOKEN_SCOPES = [...DEFAULT_AGENT_TOKEN_SCOPES]

/**
 * Revoke every prior managed token, then mint one fresh scoped managed token.
 * The raw token is only recoverable at mint, so re-injection always re-mints.
 * Returns the raw token string to inject into agent configs.
 */
export async function rotateManagedToken(): Promise<string> {
  const existing = await listTokens()
  for (const meta of existing) {
    if (meta.agent === MANAGED_AGENT_LABEL && !meta.revokedAt) {
      await revokeToken(meta.id)
    }
  }
  const { token } = await createToken({
    scopes: MANAGED_TOKEN_SCOPES,
    agent: MANAGED_AGENT_LABEL,
  })
  return token
}

/**
 * Ensure a managed token exists for clients of a reachable bearer-required bind.
 * Unlike rotateManagedToken, this does NOT revoke or replace an
 * existing active managed token — so a token already minted (and injected into
 * agent configs / printed in the remote snippet) by `setup` keeps working when a
 * follow-up launch runs. Mints only when no active managed token is present. The
 * raw token cannot be recovered, so this returns nothing: callers that need the
 * raw token (to inject) must use rotateManagedToken instead.
 */
export async function ensureManagedToken(): Promise<void> {
  const existing = await listTokens()
  // The token must be valid for the CURRENT workspace: tokens are workspace-bound
  // (verifyToken rejects a token whose workspace != getWorkspaceRoot()). A managed
  // token left over from a different workspace would 401 every MCP client, so only
  // an active managed token bound to this workspace counts as "present".
  const workspace = getWorkspaceRoot()
  const hasActiveManaged = existing.some(
    (meta) =>
      isManagedAgentLabel(meta.agent) &&
      !meta.revokedAt &&
      meta.workspace === workspace
  )
  if (hasActiveManaged) return
  await createToken({
    scopes: MANAGED_TOKEN_SCOPES,
    agent: MANAGED_AGENT_LABEL,
  })
}

export interface McpClientInfo<T extends McpClientId = McpClientId> {
  id: T
  label: string
  maturity: "supported" | "planned" | "experimental"
}

export interface McpClientStatus {
  id: ConnectorInstallableMcpClientId
  label: string
  desired: boolean
  state: McpClientState
  configuredUrl?: string
  expectedUrl: string
  configPath?: string
  message?: string
}

interface Adapter extends McpClientInfo<ConnectorInstallableMcpClientId> {
  configPath(): string | null
  detect(): boolean
  status(config: WorktableConfig): McpClientStatus
  setup(config: WorktableConfig, token?: string): McpClientStatus
  repair(config: WorktableConfig, token?: string): McpClientStatus
  remove(config: WorktableConfig): McpClientStatus
  printConfig(config: WorktableConfig, token?: string): string
}

// Label + maturity come from the shared MCP_CLIENTS registry in @worktable/types
// (single source of truth). The CLI's McpClientInfo keeps only id/label/maturity;
// config-file path resolution stays local to the adapters below.
const CLIENTS = Object.fromEntries(
  (Object.keys(MCP_CLIENTS) as McpClientId[]).map((id) => {
    const meta = MCP_CLIENTS[id]
    return [id, { id: meta.id, label: meta.label, maturity: meta.maturity }]
  })
) as { [K in McpClientId]: McpClientInfo<K> }

// Config-file manipulation (JSON/TOML read/write, claude/codex CLI shells)
// lives in @worktable/mcp-connect — the SAME code the remote-agent connector
// bundle runs on agent machines, so the two paths can never drift. This file
// keeps the CLI-only orchestration: WorktableConfig state, desired flags,
// managed tokens, and status derivation.

function baseStatus(
  adapter: McpClientInfo<ConnectorInstallableMcpClientId>,
  config: WorktableConfig,
  configuredUrl?: string,
  configPath?: string,
  message?: string,
  hasBearer?: boolean
): McpClientStatus {
  const desired = Boolean(config.mcp.clients[adapter.id]?.desired)
  let state: McpClientState = "missing"
  if (!desired) state = "removed"
  else if (configuredUrl === config.mcp.endpoint) state = "configured"
  else if (configuredUrl) state = "drift"
  else state = "pending"
  // On a reachable install /mcp requires a bearer, so a client whose URL matches
  // but lacks the Authorization header (never injected, or stale) would 401 — report
  // drift, not configured. hasBearer===undefined means the adapter can't introspect
  // the header (e.g. CLI-managed claude-code); leave the URL-based state as-is.
  if (
    state === "configured" &&
    config.service.reachable &&
    hasBearer === false
  ) {
    state = "drift"
    message =
      message ??
      "Reachable install requires a bearer token, but this config has none — run `worktable mcp setup` to inject it."
  }
  return {
    id: adapter.id,
    label: adapter.label,
    desired,
    state,
    configuredUrl,
    expectedUrl: config.mcp.endpoint,
    configPath: configPath ?? undefined,
    message,
  }
}

function makeJsonAdapter(
  info: McpClientInfo<ConnectorInstallableMcpClientId>,
  path: () => string,
  parentKey: string,
  entry: (endpoint: string, token?: string) => Record<string, unknown>
): Adapter {
  return {
    ...info,
    configPath: path,
    detect: () => existsSync(path()),
    status: (config) =>
      baseStatus(
        info,
        config,
        readJsonUrl(path(), parentKey),
        path(),
        undefined,
        readJsonAuth(path(), parentKey)
      ),
    setup: (config, token) => {
      setupJsonUrl(path(), parentKey, entry(config.mcp.endpoint, token))
      return baseStatus(info, config, config.mcp.endpoint, path())
    },
    repair: (config, token) => {
      setupJsonUrl(path(), parentKey, entry(config.mcp.endpoint, token))
      return baseStatus(info, config, config.mcp.endpoint, path())
    },
    remove: (config) => {
      removeJsonUrl(path(), parentKey)
      return baseStatus(info, config, undefined, path())
    },
    printConfig: (config, token) =>
      mcpClientSnippet(info.id, {
        endpoint: config.mcp.endpoint,
        token,
        reachable: config.service.reachable,
      }).body,
  }
}

const codexAdapter: Adapter = {
  ...CLIENTS.codex,
  configPath: codexPath,
  detect: () => commandExists("codex") || existsSync(codexPath()),
  status: (config) => {
    const configError = readCodexConfigError()
    return baseStatus(
      CLIENTS.codex,
      config,
      readCodexUrl(),
      codexPath(),
      configError ? `Invalid Codex config: ${configError}` : undefined,
      readCodexAuth()
    )
  },
  setup: (config, token) => {
    // The `codex mcp add` CLI path can't inject an Authorization header, so a
    // tokened setup must write the file directly (the header lands in TOML).
    if (!token && codexCliAdd(config.mcp.endpoint)) {
      return baseStatus(CLIENTS.codex, config, config.mcp.endpoint, codexPath())
    }
    writeCodexUrl(config.mcp.endpoint, token)
    return baseStatus(CLIENTS.codex, config, config.mcp.endpoint, codexPath())
  },
  repair: (config, token) => {
    writeCodexUrl(config.mcp.endpoint, token)
    return baseStatus(CLIENTS.codex, config, config.mcp.endpoint, codexPath())
  },
  remove: (config) => {
    removeCodex()
    return baseStatus(CLIENTS.codex, config, undefined, codexPath())
  },
  printConfig: (config, token) =>
    mcpClientSnippet("codex", {
      endpoint: config.mcp.endpoint,
      token,
      reachable: config.service.reachable,
    }).body,
}

const claudeCodeAdapter: Adapter = {
  ...CLIENTS["claude-code"],
  configPath: () => null,
  detect: () => commandExists("claude"),
  status: (config) => {
    const stored = config.mcp.clients["claude-code"]
    const configuredUrl =
      stored?.desired && stored.state === "configured"
        ? config.mcp.endpoint
        : undefined
    return baseStatus(
      CLIENTS["claude-code"],
      config,
      configuredUrl,
      undefined,
      commandExists("claude")
        ? "Use setup/repair to verify via Claude Code CLI."
        : "Claude Code CLI not found."
    )
  },
  setup: (config, token) => {
    // Command shape (URL before --header) lives in the shared claudeCodeAdd.
    const result = claudeCodeAdd(config.mcp.endpoint, token)
    return baseStatus(
      CLIENTS["claude-code"],
      config,
      result.ok ? config.mcp.endpoint : undefined,
      undefined,
      result.ok ? undefined : result.message
    )
  },
  repair: (config, token) => claudeCodeAdapter.setup(config, token),
  remove: (config) => {
    claudeCodeRemove()
    return baseStatus(CLIENTS["claude-code"], config)
  },
  printConfig: (config, token) =>
    mcpClientSnippet("claude-code", {
      endpoint: config.mcp.endpoint,
      token,
      reachable: config.service.reachable,
    }).body,
}

export const adapters: Record<ConnectorInstallableMcpClientId, Adapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  cursor: makeJsonAdapter(
    CLIENTS.cursor,
    cursorPath,
    "mcpServers",
    cursorEntry
  ),
  opencode: makeJsonAdapter(
    CLIENTS.opencode,
    opencodePath,
    "mcp",
    opencodeEntry
  ),
  vscode: makeJsonAdapter(
    CLIENTS.vscode,
    () => vscodePath() ?? defaultVscodePath(),
    "servers",
    vscodeEntry
  ),
}

export function listClients(includeAll = false): McpClientInfo[] {
  const supported = SUPPORTED_MCP_CLIENT_IDS.map((id) => CLIENTS[id])
  if (!includeAll) return supported
  return [...supported, ...PLANNED_MCP_CLIENT_IDS.map((id) => CLIENTS[id])]
}

export function detectInstalledClients(): ConnectorInstallableMcpClientId[] {
  return CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.filter((id) =>
    adapters[id].detect()
  )
}

export function detectDefaultClients(): ConnectorInstallableMcpClientId[] {
  return detectInstalledClients()
}

export function parseClientSelection(
  values: string[]
): ConnectorInstallableMcpClientId[] {
  const expanded = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)
  const ids = expanded.includes("all")
    ? [...CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS]
    : expanded
  for (const id of ids) {
    if (
      !CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.includes(
        id as ConnectorInstallableMcpClientId
      )
    ) {
      throw new UsageError(
        `Unsupported MCP client: ${id}. This command can configure: ${CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.join(", ")}. Use print-config for manual clients or Settings for desktop extensions.`
      )
    }
  }
  return [...new Set(ids as ConnectorInstallableMcpClientId[])]
}

export function setupClients(
  clientIds: ConnectorInstallableMcpClientId[],
  quiet = false,
  token?: string
): McpClientStatus[] {
  let results: McpClientStatus[] = []
  updateConfig((config) => {
    results = clientIds.map((clientId) => {
      setClientState(config, clientId, true, "pending")
      const result = adapters[clientId].setup(config, token)
      setClientState(config, clientId, true, result.state)
      return result
    })
  })
  if (!quiet) printMcpStatuses(results)
  return results
}

function managedTransactionClients(
  config: WorktableConfig,
  requested: ConnectorInstallableMcpClientId[]
): ConnectorInstallableMcpClientId[] {
  const desired = CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.filter((clientId) => {
    const stored = config.mcp.clients[clientId]
    return (
      stored?.desired &&
      (stored.state === "configured" || stored.state === "drift")
    )
  })
  return [...new Set([...requested, ...desired])]
}

async function rollbackManagedClientTransaction(
  snapshots: ClientConfigSnapshot[],
  candidateTokenIds: string[]
): Promise<string[]> {
  const errors: string[] = []
  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.mutationCaptured === undefined) continue
    if (!snapshot.mutationCaptured) {
      errors.push(
        `${MCP_CLIENTS[snapshot.id].label}: config was written but its rollback state could not be captured safely`
      )
      continue
    }
    const restored = restoreClientConfig(snapshot)
    if (!restored.ok) {
      errors.push(
        `${MCP_CLIENTS[snapshot.id].label}: ${restored.message ?? "rollback failed"}`
      )
    }
  }
  if (errors.length === 0) {
    for (const candidateTokenId of candidateTokenIds) {
      if (!(await revokeToken(candidateTokenId))) {
        errors.push(
          `could not revoke uncommitted replacement token ${candidateTokenId}`
        )
      }
    }
  } else {
    errors.push(
      "replacement credentials were left active because at least one client rollback was incomplete"
    )
  }
  return errors
}

async function abortManagedClientTransaction(
  err: unknown,
  snapshots: ClientConfigSnapshot[],
  candidateTokenIds: string[]
): Promise<never> {
  const rollbackErrors = await rollbackManagedClientTransaction(
    snapshots,
    candidateTokenIds
  )
  const rollbackMessage =
    rollbackErrors.length === 0
      ? "Previous client configurations and credentials remain active."
      : `Rollback needs attention: ${rollbackErrors.join("; ")}`
  throw new UsageError(
    `Managed MCP credential rotation was aborted: ${(err as Error).message}. ${rollbackMessage}`
  )
}

/**
 * Rotate per-client same-machine credentials as a two-phase config transaction.
 * Every previously configured or drifted desired client is included because it
 * may still carry a legacy shared token even when the command names only one.
 * Pending/missing clients have no known managed bearer and must not block an
 * unrelated repair merely because their setup previously failed.
 */
export async function setupManagedClients(
  requested: ConnectorInstallableMcpClientId[],
  quiet = false
): Promise<McpClientStatus[]> {
  const config = readConfig()
  applyRuntimeConfig(config)
  const clientIds = managedTransactionClients(config, requested)
  if (clientIds.length === 0) {
    return []
  }
  const preflights = clientIds.map((clientId) =>
    preflightClient(clientId, { replace: true })
  )
  const blocked = preflights.find((outcome) => !outcome.ok || !outcome.snapshot)
  if (blocked) {
    throw new UsageError(
      `Managed MCP credential rotation was not started because ${MCP_CLIENTS[blocked.id].label} could not be updated: ${blocked.message ?? "preflight failed"}`
    )
  }

  const snapshots = preflights.map((outcome) => outcome.snapshot!)
  const candidates: Array<Awaited<ReturnType<typeof createToken>>> = []
  try {
    for (const clientId of clientIds) {
      candidates.push(
        await createToken({
          scopes: MANAGED_TOKEN_SCOPES,
          agent: managedClientAgentLabel(clientId),
        })
      )
    }
  } catch (error) {
    for (const candidate of candidates) {
      await revokeToken(candidate.metadata.id).catch(() => false)
    }
    throw error
  }
  const candidateTokenIds = candidates.map((candidate) => candidate.metadata.id)

  let results: McpClientStatus[]
  try {
    for (let index = 0; index < clientIds.length; index++) {
      const clientId = clientIds[index]!
      const snapshot = snapshots[index]!
      const current = validateClientConfigSnapshot(snapshot)
      if (!current.ok) {
        throw new Error(
          `${MCP_CLIENTS[clientId].label}: ${current.message ?? "config changed after preflight"}`
        )
      }

      const installed = installClient(
        clientId,
        { endpoint: config.mcp.endpoint, token: candidates[index]!.token },
        { replace: true, existing: preflights[index]!.existing }
      )
      const captured = captureClientConfigMutation(snapshot)
      if (!captured.ok) {
        throw new Error(
          `${MCP_CLIENTS[clientId].label}: ${captured.message ?? "could not capture rollback state"}`
        )
      }
      if (!installed.ok) {
        throw new Error(
          `${MCP_CLIENTS[clientId].label}: ${installed.message ?? "configuration failed"}`
        )
      }
    }
  } catch (err) {
    return abortManagedClientTransaction(err, snapshots, candidateTokenIds)
  }

  try {
    if (
      !(await finalizeAgentTokenRotations(candidateTokenIds, {
        retireAgentLabels: [MANAGED_AGENT_LABEL],
      }))
    ) {
      throw new Error("could not finalize the replacement managed credentials")
    }
  } catch (err) {
    return abortManagedClientTransaction(err, snapshots, candidateTokenIds)
  }

  try {
    updateConfig((current) => {
      for (const clientId of clientIds) {
        setClientState(current, clientId, true, "configured")
      }
    })
    const committed = readConfig()
    results = clientIds.map((clientId) => adapters[clientId].status(committed))
  } catch (err) {
    throw new UsageError(
      `Managed MCP credential rotation committed, but Worktable could not persist the client status: ${(err as Error).message}. The new credentials and client configurations are active; do not restore the old credentials.`
    )
  }

  if (!quiet) printMcpStatuses(results)
  return results
}

export async function repairClients(): Promise<McpClientStatus[]> {
  const config = readConfig()
  // Point WORKTABLE_WORKSPACE at the config's workspace BEFORE any mint. Tokens
  // are workspace-bound (createToken defaults to getWorkspaceRoot()), and the
  // `mcp repair` action does not run applyRuntimeConfig first — without this a
  // repair in a clean env would mint a token bound to the ambient/default
  // workspace, so verifyToken would reject the injected bearer and 401 the very
  // agent repair is meant to keep working.
  applyRuntimeConfig(config)
  const desired = CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.filter(
    (clientId) => config.mcp.clients[clientId]?.desired
  )
  if (!isLoopbackHost(config.service.host)) {
    const repairable = desired.filter((clientId) => {
      const stored = config.mcp.clients[clientId]
      return (
        stored?.state === "configured" ||
        stored?.state === "drift" ||
        adapters[clientId].detect()
      )
    })
    return setupManagedClients(repairable)
  }

  let results: McpClientStatus[] = []
  updateConfig((current) => {
    results = desired.map((clientId) => {
      const result = adapters[clientId].repair(current)
      setClientState(current, clientId, true, result.state)
      return result
    })
  })
  printMcpStatuses(results)
  return results
}

export function removeClient(
  clientId: ConnectorInstallableMcpClientId
): McpClientStatus {
  let result: McpClientStatus | undefined
  updateConfig((config) => {
    result = adapters[clientId].remove(config)
    setClientState(config, clientId, false, "removed")
  })
  return result!
}

export function getMcpStatuses(config: WorktableConfig): McpClientStatus[] {
  return CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.map((clientId) =>
    adapters[clientId].status(config)
  )
}

export function printMcpStatuses(statuses: McpClientStatus[]): void {
  console.log("Agents:")
  for (const status of statuses) {
    let detail: string
    if (status.state === "drift" && status.configuredUrl) {
      detail = `drift: configured ${status.configuredUrl}, expected ${status.expectedUrl}`
    } else {
      // "pending" is internal jargon; show the friendlier phrase and, when we
      // captured a reason (e.g. "Claude Code CLI not found."), surface it so the
      // user sees WHY a client isn't connected rather than a bare state word.
      const label = status.state === "pending" ? "not connected" : status.state
      detail =
        status.state !== "configured" && status.message
          ? `${label} — ${status.message}`
          : label
    }
    console.log(`  ${status.label.padEnd(12)} ${detail}`)
  }
}

export function printClientConfig(
  clientId: McpSnippetClientId,
  config: WorktableConfig,
  token?: string
): void {
  console.log(
    mcpClientSnippet(clientId, {
      endpoint: config.mcp.endpoint,
      token,
      reachable: config.service.reachable,
    }).body
  )
}
