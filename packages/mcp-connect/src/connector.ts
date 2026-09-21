import { hostname } from "node:os"
import {
  CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS,
  MCP_CLIENTS,
  type ConnectorInstallableMcpClientId,
} from "@worktable/types/mcp-clients"
import {
  captureClientConfigMutation,
  detectClient,
  installClient,
  preflightClient,
  restoreClientConfig,
  validateClientConfigSnapshot,
  type ClientConfigSnapshot,
  type InstallOutcome,
  type PreflightOutcome,
} from "./client-config.ts"
import { verifyMcpEndpoint } from "./verify.ts"

// ============================================================
// Remote agent connector (the code behind `curl .../connect.sh | sh`)
// ============================================================
//
// Runs on the machine where the coding agent lives — NOT on the Worktable
// host. Redeems a pairing code against the Worktable instance, writes the
// local client config with the endpoint + minted bearer, verifies the real
// MCP path end to end, and reports progress back to the pairing session so
// the Settings flow shows live status. Must run under plain Node 18+ or Bun.
//
// Usage:
//   connect.mjs <code-or-pairing-url> [--client <id>] [--all] [--replace]
//   connect.mjs --oauth --server <origin> [--client <id>] [--all] [--replace]

interface ConnectorArgs {
  code: string | null
  origin: string
  client: ConnectorInstallableMcpClientId | null
  all: boolean
  replace: boolean
  oauth: boolean
}

export interface ConnectorIo {
  log(line: string): void
  error(line: string): void
}

function usage(): string {
  return [
    "Usage:",
    "  connect.mjs <code-or-pairing-url> [--client <id>] [--all] [--replace] [--server <origin>]",
    "  connect.mjs --oauth --server <origin> [--client <id>] [--all] [--replace]",
    `Clients: ${CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.join(", ")}`,
  ].join("\n")
}

export function parseConnectorArgs(argv: string[]): ConnectorArgs {
  let code: string | null = null
  let origin: string | null = null
  let client: ConnectorInstallableMcpClientId | null = null
  let all = false
  let replace = false
  let oauth = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--server") {
      origin = argv[++i] ?? null
    } else if (arg === "--client") {
      const value = argv[++i] ?? ""
      if (
        !CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.includes(
          value as ConnectorInstallableMcpClientId
        )
      ) {
        throw new Error(`Unknown client "${value}".\n${usage()}`)
      }
      client = value as ConnectorInstallableMcpClientId
    } else if (arg === "--all") {
      all = true
    } else if (arg === "--replace") {
      replace = true
    } else if (arg === "--oauth") {
      oauth = true
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag "${arg}".\n${usage()}`)
    } else if (!code) {
      code = arg
    } else {
      throw new Error(`Unexpected argument "${arg}".\n${usage()}`)
    }
  }

  if (!code && !oauth) throw new Error(usage())
  if (code && oauth) {
    throw new Error(
      `A pairing code cannot be combined with --oauth.\n${usage()}`
    )
  }
  if (client && all) {
    // --all installs every detected client while --client labels the single
    // minted token for one of them: a later reconnect of that client would
    // rotate the shared token out from under the others. Refuse the combo
    // BEFORE any redemption burns the code.
    throw new Error(`--client and --all are mutually exclusive.\n${usage()}`)
  }

  // A full pairing URL carries both the origin and the code:
  //   https://wt.example.com/connect/ABCDE-FGHJK
  if (code && /^https?:\/\//i.test(code)) {
    const url = new URL(code)
    const last = url.pathname.split("/").filter(Boolean).pop()
    if (!last) throw new Error(`No pairing code in URL "${code}".`)
    origin = origin ?? url.origin
    code = last
  }

  if (!origin) {
    throw new Error(
      "No server origin. Pass the full pairing URL, or --server <origin>."
    )
  }

  return {
    code,
    origin: new URL(origin).origin,
    client,
    all,
    replace,
    oauth,
  }
}

interface RedeemResponse {
  mcpUrl: string
  token: string
  client: ConnectorInstallableMcpClientId | null
  scopes: string[]
  workspaceName: string
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  bearer?: string
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, json }
}

type CompletionResult = "completed" | "failed"

export interface ConnectorDependencies {
  postJson: typeof postJson
  sleep(delayMs: number): Promise<void>
  hostname(): string
  detectClient: typeof detectClient
  preflightClient: typeof preflightClient
  validateClientConfigSnapshot: typeof validateClientConfigSnapshot
  installClient: typeof installClient
  captureClientConfigMutation: typeof captureClientConfigMutation
  restoreClientConfig: typeof restoreClientConfig
  verifyMcpEndpoint: typeof verifyMcpEndpoint
}

const DEFAULT_CONNECTOR_DEPENDENCIES: ConnectorDependencies = {
  postJson,
  sleep: (delayMs) =>
    new Promise((resolve) => {
      setTimeout(resolve, delayMs)
    }),
  hostname,
  detectClient,
  preflightClient,
  validateClientConfigSnapshot,
  installClient,
  captureClientConfigMutation,
  restoreClientConfig,
  verifyMcpEndpoint,
}

/** Commit verified rotation with retries. */
async function completePairing(
  origin: string,
  code: string,
  token: string,
  dependencies: ConnectorDependencies
): Promise<CompletionResult> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await dependencies.postJson(
        `${origin}/api/pairing/complete`,
        { code },
        token
      )
      if (response.status === 200) return "completed"
    } catch {
      // A dropped response is ambiguous: the idempotent endpoint is safe to retry.
    }
    if (attempt < 4) {
      await dependencies.sleep(250 * 2 ** attempt)
    }
  }
  return "failed"
}

/** Progress reports are best-effort: never fail the install over one. */
async function reportProgress(
  origin: string,
  code: string,
  event: string,
  detail: string | undefined,
  dependencies: ConnectorDependencies
): Promise<void> {
  try {
    await dependencies.postJson(`${origin}/api/pairing/progress`, {
      code,
      event,
      ...(detail ? { detail } : {}),
    })
  } catch {
    // The Settings status view just misses this step; the install proceeds.
  }
}

/**
 * Confirm terminal failures that revoke a now-unreferenced bearer. These
 * events are idempotent on the host, so a lost success response is safe to
 * retry instead of leaving an active token behind after local rollback.
 */
async function commitFailureProgress(
  origin: string,
  code: string,
  event: "rolled_back" | "failed_no_config",
  detail: string | undefined,
  dependencies: ConnectorDependencies
): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await dependencies.postJson(
        `${origin}/api/pairing/progress`,
        {
          code,
          event,
          ...(detail ? { detail } : {}),
        }
      )
      if (response.status === 200) return true
    } catch {
      // The host may have committed before the response was lost; retry.
    }
    if (attempt < 4) {
      await dependencies.sleep(250 * 2 ** attempt)
    }
  }
  return false
}

function runPreflight(
  clients: ConnectorInstallableMcpClientId[],
  replace: boolean,
  io: ConnectorIo,
  dependencies: ConnectorDependencies
): Map<ConnectorInstallableMcpClientId, PreflightOutcome> | null {
  const outcomes = clients.map((id) =>
    dependencies.preflightClient(id, { replace })
  )
  const failed = outcomes.filter((outcome) => !outcome.ok)
  for (const outcome of failed) {
    io.error(
      `  ${MCP_CLIENTS[outcome.id].label}: BLOCKED: ${outcome.message ?? "preflight failed"}`
    )
  }
  if (failed.length > 0) return null
  return new Map(outcomes.map((outcome) => [outcome.id, outcome]))
}

function rollbackConfigs(
  snapshots: ClientConfigSnapshot[],
  dependencies: ConnectorDependencies
): {
  ok: boolean
  detail: string
} {
  const restored = [...snapshots]
    .reverse()
    .map(dependencies.restoreClientConfig)
  return {
    ok: restored.every((outcome) => outcome.ok),
    detail: restored
      .map(
        (outcome) =>
          `${outcome.id}: ${outcome.ok ? "restored" : `restore failed (${outcome.message ?? "?"})`}`
      )
      .join("; "),
  }
}

function configureClients(
  clients: ConnectorInstallableMcpClientId[],
  preflight: Map<ConnectorInstallableMcpClientId, PreflightOutcome>,
  target: { endpoint: string; token?: string },
  replace: boolean,
  io: ConnectorIo,
  dependencies: ConnectorDependencies
): {
  outcomes: InstallOutcome[]
  attemptedSnapshots: ClientConfigSnapshot[]
} {
  const outcomes: InstallOutcome[] = []
  const attemptedSnapshots: ClientConfigSnapshot[] = []
  for (const id of clients) {
    const checked = preflight.get(id)!
    const stillCurrent = dependencies.validateClientConfigSnapshot(
      checked.snapshot!
    )
    if (!stillCurrent.ok) {
      outcomes.push({
        id,
        ok: false,
        configPath: checked.configPath,
        message: stillCurrent.message ?? "Config changed after preflight.",
      })
      io.error(
        `  ${MCP_CLIENTS[id].label}: FAILED: ${stillCurrent.message ?? "config changed after preflight"}`
      )
      break
    }
    attemptedSnapshots.push(checked.snapshot!)
    let outcome = dependencies.installClient(id, target, {
      replace,
      existing: checked.existing,
    })
    const captured = dependencies.captureClientConfigMutation(checked.snapshot!)
    if (!captured.ok) {
      outcome = {
        id,
        ok: false,
        configPath: checked.configPath,
        message:
          `Could not secure rollback after the config write: ` +
          (captured.message ?? "unknown error"),
      }
    }
    outcomes.push(outcome)
    const label = MCP_CLIENTS[outcome.id].label
    if (outcome.ok) {
      io.log(
        `  ${label}: configured${outcome.configPath ? ` (${outcome.configPath})` : ""}`
      )
    } else {
      io.error(`  ${label}: FAILED: ${outcome.message ?? "unknown error"}`)
      break
    }
  }
  return { outcomes, attemptedSnapshots }
}

async function runOAuthConnector(
  args: ConnectorArgs,
  io: ConnectorIo,
  dependencies: ConnectorDependencies
): Promise<number> {
  io.log(`Configuring Worktable Cloud at ${args.origin} ...`)
  const detected = CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.filter((id) =>
    dependencies.detectClient(id)
  )
  const clients = args.client ? [args.client] : detected
  if (clients.length === 0) {
    io.error(
      "No supported MCP clients detected on this machine. " +
        `Rerun with --client <${CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.join("|")}>.`
    )
    io.error("No configs were changed.")
    return 1
  }
  const selected = args.all ? detected : clients
  const preflight = runPreflight(selected, args.replace, io, dependencies)
  if (!preflight) {
    io.error("No configs were changed.")
    return 1
  }
  const configured = configureClients(
    selected,
    preflight,
    { endpoint: `${args.origin}/api/mcp` },
    args.replace,
    io,
    dependencies
  )
  const failed = configured.outcomes.find((outcome) => !outcome.ok)
  if (failed) {
    const rollback = rollbackConfigs(
      configured.attemptedSnapshots,
      dependencies
    )
    if (rollback.ok) {
      io.error(
        configured.attemptedSnapshots.length > 0
          ? "All attempted config changes were rolled back."
          : "No configs were changed."
      )
    } else {
      io.error(`Rollback was incomplete: ${rollback.detail}`)
    }
    return 1
  }
  io.log("")
  io.log(
    "Worktable Cloud is configured without a stored token. Restart or open the client to sign in with OAuth."
  )
  for (const outcome of configured.outcomes) {
    if (outcome.restartHint) io.log(`  Note: ${outcome.restartHint}`)
  }
  return 0
}

export async function runConnector(
  argv: string[],
  io: ConnectorIo = { log: console.log, error: console.error },
  overrides: Partial<ConnectorDependencies> = {}
): Promise<number> {
  const dependencies = { ...DEFAULT_CONNECTOR_DEPENDENCIES, ...overrides }
  let args: ConnectorArgs
  try {
    args = parseConnectorArgs(argv)
  } catch (err) {
    io.error((err as Error).message)
    return 2
  }

  if (args.oauth) {
    return runOAuthConnector(args, io, dependencies)
  }

  const { origin } = args
  const code = args.code!
  io.log(`Connecting this machine to Worktable at ${origin} ...`)

  // Detect and preflight BEFORE redeeming: the pairing code is single-use,
  // while checking config shape, conflicts, and filesystem viability is free.
  const detected = CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.filter((id) =>
    dependencies.detectClient(id)
  )
  const singleDetected = detected.length === 1 ? detected[0] : undefined
  // Resolve the server-selected target without consuming the single-use code
  // so preflight remains both precise and non-mutating.
  let selectedClient = args.client
  {
    const target = await dependencies
      .postJson(`${origin}/api/pairing/target`, {
        code,
      })
      .catch((err) => {
        io.error(`Could not reach ${origin}: ${(err as Error).message}`)
        return null
      })
    if (!target) return 1
    if (target.status !== 200) {
      const message =
        typeof target.json["error"] === "string"
          ? (target.json["error"] as string)
          : `pairing target lookup failed (HTTP ${target.status})`
      io.error(message)
      return 1
    }
    if (!selectedClient && !args.all) {
      const value = target.json["client"]
      if (
        value !== null &&
        (typeof value !== "string" ||
          !CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.includes(
            value as ConnectorInstallableMcpClientId
          ))
      ) {
        io.error("The Worktable server returned an unsupported pairing client.")
        return 1
      }
      selectedClient = value as ConnectorInstallableMcpClientId | null
    }
  }
  const initialClients = selectedClient ? [selectedClient] : detected
  if (initialClients.length === 0) {
    io.error(
      "No supported MCP clients detected on this machine. " +
        `Rerun this same command with --client <${CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS.join("|")}>.`
    )
    io.error("No configs were changed and the pairing code was not used.")
    return 1
  }
  let preflight = runPreflight(initialClients, args.replace, io, dependencies)
  if (!preflight) {
    io.error("No configs were changed and the pairing code was not used.")
    return 1
  }

  // 1. Redeem only after local mutation preflight passes.
  const redeem = await dependencies
    .postJson(`${origin}/api/pairing/redeem`, {
      code,
      hostname: dependencies.hostname().split(".")[0],
      ...(args.client ? { client: args.client } : {}),
      ...(!args.client && singleDetected
        ? { detectedClient: singleDetected }
        : {}),
      ...(args.all ? { all: true } : {}),
    })
    .catch((err) => {
      io.error(`Could not reach ${origin}: ${(err as Error).message}`)
      return null
    })
  if (!redeem) return 1
  if (redeem.status !== 200) {
    const message =
      typeof redeem.json["error"] === "string"
        ? (redeem.json["error"] as string)
        : `redeem failed (HTTP ${redeem.status})`
    io.error(message)
    return 1
  }
  const session = redeem.json as unknown as RedeemResponse

  // 2. Configure the explicit or server-selected client, or all detected
  // clients when the pairing target is automatic.
  const explicit = args.client ?? session.client
  const clients = explicit && !args.all ? [explicit] : detected
  if (clients.length === 0) {
    const revoked = await commitFailureProgress(
      origin,
      code,
      "failed_no_config",
      "no supported clients detected",
      dependencies
    )
    io.error("No supported MCP clients were available to configure.")
    io.error(
      "No configs were changed. Generate a new command with --client to retry."
    )
    if (!revoked) {
      io.error(
        "Worktable could not confirm revocation of the unused pairing credential."
      )
    }
    return 1
  }
  const missingPreflight = clients.filter((id) => !preflight!.has(id))
  if (missingPreflight.length > 0) {
    const additionalPreflight = runPreflight(
      missingPreflight,
      args.replace,
      io,
      dependencies
    )
    if (!additionalPreflight) {
      const revoked = await commitFailureProgress(
        origin,
        code,
        "failed_no_config",
        "selected client failed preflight",
        dependencies
      )
      io.error("No configs were changed. Generate a new command to retry.")
      if (!revoked) {
        io.error(
          "Worktable could not confirm revocation of the unused pairing credential."
        )
      }
      return 1
    }
    preflight = new Map([...preflight, ...additionalPreflight])
  }

  // 3. Write sequentially. A failed client stops the transaction; every
  // attempted config (including the failing one) is restored from its snapshot.
  const configured = configureClients(
    clients,
    preflight,
    { endpoint: session.mcpUrl, token: session.token },
    args.replace,
    io,
    dependencies
  )
  const { outcomes, attemptedSnapshots } = configured
  const outcomeDetail = outcomes
    .map(
      (o) =>
        `${o.id}: ${o.ok ? (o.configPath ?? "via CLI") : `failed (${o.message ?? "?"})`}`
    )
    .join("; ")
  const failed = outcomes.find((outcome) => !outcome.ok)
  if (failed) {
    const rollback =
      attemptedSnapshots.length > 0
        ? rollbackConfigs(attemptedSnapshots, dependencies)
        : { ok: true, detail: "no config writes attempted" }
    const terminalEvent =
      attemptedSnapshots.length > 0 ? "rolled_back" : "failed_no_config"
    let revocationConfirmed = false
    if (rollback.ok) {
      revocationConfirmed = await commitFailureProgress(
        origin,
        code,
        terminalEvent,
        `${outcomeDetail}; ${rollback.detail}`,
        dependencies
      )
    } else {
      await reportProgress(
        origin,
        code,
        "failed",
        `${outcomeDetail}; ${rollback.detail}`,
        dependencies
      )
    }
    if (rollback.ok) {
      io.error(
        attemptedSnapshots.length > 0
          ? "All attempted config changes were rolled back."
          : "No configs were changed. Generate a new command to retry."
      )
      if (!revocationConfirmed) {
        io.error(
          "Worktable could not confirm revocation of the unused pairing credential."
        )
      }
    } else {
      io.error(`Rollback was incomplete: ${rollback.detail}`)
      io.error(
        "A client config may still contain the new connection credential."
      )
    }
    return 1
  }
  const written = outcomes
  await reportProgress(
    origin,
    code,
    "config_written",
    outcomeDetail,
    dependencies
  )

  // 4. Verify the real MCP path with the minted bearer.
  await reportProgress(origin, code, "verifying", undefined, dependencies)
  const verify = await dependencies.verifyMcpEndpoint(
    session.mcpUrl,
    session.token
  )
  if (!verify.ok) {
    const rollback = rollbackConfigs(attemptedSnapshots, dependencies)
    let revocationConfirmed = false
    if (rollback.ok) {
      revocationConfirmed = await commitFailureProgress(
        origin,
        code,
        "rolled_back",
        `${verify.message ?? "verification failed"}; ${rollback.detail}`,
        dependencies
      )
    } else {
      await reportProgress(
        origin,
        code,
        "failed",
        `${verify.message ?? "verification failed"}; ${rollback.detail}`,
        dependencies
      )
    }
    io.error(`Verification failed: ${verify.message ?? "unknown error"}`)
    if (rollback.ok) {
      io.error(
        "The original client configs were restored. Generate a new command to retry."
      )
      if (!revocationConfirmed) {
        io.error(
          "Worktable could not confirm revocation of the unused pairing credential."
        )
      }
    } else {
      io.error(`Rollback was incomplete: ${rollback.detail}`)
      io.error(
        "A client config may still contain the new connection credential."
      )
    }
    return 1
  }

  const completion = await completePairing(
    origin,
    code,
    session.token,
    dependencies
  )
  if (completion === "failed") {
    io.error(
      "MCP verified, but Worktable could not confirm the completed connection after retries."
    )
    io.error(
      "The new client config is active. Check the host connection before creating another pairing."
    )
    return 1
  }

  io.log("")
  io.log(
    `Connected to workspace "${session.workspaceName}". MCP verified (${verify.toolCount} tools).`
  )
  for (const outcome of written) {
    if (outcome.restartHint) io.log(`  Note: ${outcome.restartHint}`)
  }
  return 0
}
