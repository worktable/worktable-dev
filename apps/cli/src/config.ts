import {
  ensureAppDir,
  getAppDir,
  getWorkspaceRoot,
  localClientHost,
  localHttpOrigin,
} from "@worktable/server/runtime";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS,
  PLANNED_MCP_CLIENT_IDS,
  SUPPORTED_MCP_CLIENT_IDS,
  type ConnectorInstallableMcpClientId,
  type McpClientId,
  type PlannedMcpClientId,
  type SupportedMcpClientId,
} from "@worktable/types";

export const CONFIG_VERSION = 2;
export const DEFAULT_HOST = "127.0.0.1";
export const REACHABLE_HOST = "0.0.0.0";
export const DEFAULT_PORT = 7480;

// The MCP client id registry now lives in @worktable/types (the single source of
// truth shared with the web Settings UI). Re-exported here so existing CLI call
// sites keep importing these names from ./config unchanged.
export { CONNECTOR_INSTALLABLE_MCP_CLIENT_IDS, PLANNED_MCP_CLIENT_IDS, SUPPORTED_MCP_CLIENT_IDS };
export type {
  ConnectorInstallableMcpClientId,
  McpClientId,
  PlannedMcpClientId,
  SupportedMcpClientId,
};

export type McpClientState = "configured" | "pending" | "missing" | "drift" | "removed";

export interface WorktableConfig {
  version: 2;
  workspace: string;
  service: {
    host: string;
    port: number;
    startAtLogin: boolean;
    /**
     * Durable persisted intent: is Worktable bound to be reachable from other
     * machines? Default false (loopback-only). The bind host is derived from
     * this (0.0.0.0 when true) unless an explicit --host override is given.
     */
    reachable: boolean;
    /**
     * Whether the operator has explicitly acknowledged the exposure (by setting
     * an owner password — the gate for reachability — or via the interactive
     * confirm). This is the ONLY source of "already acknowledged" — it is never
     * inferred from the host/reachable so that hand-editing config.json to a
     * non-loopback host can never sidestep the gate. Default false.
     */
    exposureAcknowledged: boolean;
    /**
     * Operator has declared that HTTPS is terminated upstream (a tunnel or
     * reverse proxy), so the plain-HTTP reachability reminder is suppressed.
     * Default false. Only meaningful when reachable; like exposureAcknowledged
     * it is NEVER inferred from the host. NOTE: this governs the reminder only,
     * not auth — see exposure-notice.ts.
     */
    httpsUpstream: boolean;
  };
  mcp: {
    endpoint: string;
    clients: Partial<Record<McpClientId, { desired: boolean; state: McpClientState }>>;
  };
}

/**
 * True if `host` is a loopback address (no other machine can reach it).
 * Covers the IPv4 loopback, the `localhost` name, and the IPv6 loopback.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/**
 * The effective bind host. An explicit override wins; otherwise reachable
 * binds all interfaces (0.0.0.0) and not-reachable binds loopback.
 */
export function bindHostFor(reachable: boolean, override?: string): string {
  const trimmed = override?.trim();
  if (trimmed) return trimmed;
  return reachable ? REACHABLE_HOST : DEFAULT_HOST;
}

/**
 * Map a bind/listen host to a CONNECTABLE client address. `0.0.0.0` and `::` are
 * wildcard listen addresses, not routable destinations — local MCP clients and
 * health probes that target them fail. A reachable install binds `0.0.0.0` but is
 * reachable on loopback too, so local clients/probes use `127.0.0.1`. Any other
 * host (loopback, a LAN IP, a custom override) is returned unchanged.
 */
export function clientHostFor(host: string): string {
  return localClientHost(host);
}

export function clientOriginFor(host: string, port: number): string {
  return localHttpOrigin(host, port);
}

export function getConfigPath(): string {
  return join(getAppDir(), "config.json");
}

/**
 * Sidecar holding the last config.json that parsed cleanly. writeConfig refreshes
 * it before each atomic replace, so a later corrupt read (e.g. a truncated file
 * after an unclean host stop) can recover the prior durable intent — including a
 * reachable bind — instead of silently falling back to loopback defaults.
 */
export function getConfigBackupPath(): string {
  return `${getConfigPath()}.bak`;
}

/**
 * Where a present-but-unparseable config.json is preserved (not deleted) so an
 * operator can inspect what went wrong. Overwritten on each corrupt read.
 */
export function getConfigCorruptPath(): string {
  return `${getConfigPath()}.corrupt`;
}

/**
 * Thrown when config.json exists but cannot be parsed AND no usable backup is
 * available. Callers must treat this as a hard error rather than proceeding on
 * loopback defaults — persisting those defaults is exactly the silent
 * reachable→loopback downgrade this guards against.
 */
export class ConfigCorruptError extends Error {
  readonly configPath: string;
  readonly corruptPath: string | null;
  constructor(message: string, configPath: string, corruptPath: string | null) {
    super(message);
    this.name = "ConfigCorruptError";
    this.configPath = configPath;
    this.corruptPath = corruptPath;
  }
}

export function endpointFor(host: string, port: number): string {
  return `${clientOriginFor(host, port)}/mcp`;
}

export interface ConfigOverrides {
  version?: WorktableConfig["version"];
  workspace?: string;
  service?: Partial<WorktableConfig["service"]>;
  mcp?: Partial<WorktableConfig["mcp"]>;
}

export function createDefaultConfig(overrides: ConfigOverrides = {}): WorktableConfig {
  const service = {
    host: overrides.service?.host ?? DEFAULT_HOST,
    port: overrides.service?.port ?? DEFAULT_PORT,
    startAtLogin: overrides.service?.startAtLogin ?? true,
    reachable: overrides.service?.reachable ?? false,
    exposureAcknowledged: overrides.service?.exposureAcknowledged ?? false,
    httpsUpstream: overrides.service?.httpsUpstream ?? false,
  };
  return {
    version: CONFIG_VERSION,
    workspace: overrides.workspace ?? getWorkspaceRoot(),
    service,
    mcp: {
      endpoint: overrides.mcp?.endpoint ?? endpointFor(service.host, service.port),
      clients: overrides.mcp?.clients ?? {},
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeConfig(value: unknown): WorktableConfig {
  const candidate = isRecord(value) ? value : {};
  const rawService =
    isRecord(candidate["service"]) ? candidate["service"] : {};
  const rawMcp =
    isRecord(candidate["mcp"]) ? candidate["mcp"] : {};
  const host = typeof rawService["host"] === "string" && rawService["host"].trim()
    ? rawService["host"].trim()
    : DEFAULT_HOST;
  const port = typeof rawService["port"] === "number" && Number.isInteger(rawService["port"])
    ? rawService["port"]
    : DEFAULT_PORT;
  const clients =
    rawMcp["clients"] && typeof rawMcp["clients"] === "object"
      ? (rawMcp["clients"] as WorktableConfig["mcp"]["clients"])
      : {};

  return {
    // Stamp the current version on every read. The v1→v2 migration is "absent
    // `reachable` field → false"; it is non-destructive and lazy — the upgraded
    // shape only persists on the next writeConfig, not merely on read.
    version: CONFIG_VERSION,
    workspace:
      typeof candidate["workspace"] === "string" && candidate["workspace"].trim()
        ? resolve(candidate["workspace"])
        : getWorkspaceRoot(),
    service: {
      host,
      port,
      startAtLogin:
        typeof rawService["startAtLogin"] === "boolean" ? rawService["startAtLogin"] : true,
      // Reconcile reachability with the bind host: a non-loopback host means the
      // install IS reachable, even if a hand-edited or v1-migrated config left
      // `reachable` false. This keeps exposure detection (token minting, the auth
      // gate) consistent with the actual bind, so a drifted host=0.0.0.0 /
      // reachable=false config can't be treated as loopback-only.
      reachable:
        (typeof rawService["reachable"] === "boolean" ? rawService["reachable"] : false) ||
        !isLoopbackHost(host),
      // NEVER inferred from host — only setting an owner password / the confirm
      // sets this, so a hand-edited non-loopback host cannot fake acknowledgement.
      exposureAcknowledged:
        typeof rawService["exposureAcknowledged"] === "boolean"
          ? rawService["exposureAcknowledged"]
          : false,
      // NEVER inferred from host — an explicit operator acknowledgement that
      // HTTPS is handled upstream. Governs the reminder only, not auth.
      httpsUpstream:
        typeof rawService["httpsUpstream"] === "boolean"
          ? rawService["httpsUpstream"]
          : false,
    },
    mcp: {
      endpoint: endpointFor(host, port),
      clients,
    },
  };
}

/**
 * A persisted config always carries a `service` object with at least a host or
 * port — createDefaultConfig and writeConfig guarantee it. A file that parses as
 * JSON but lacks that shape (e.g. `{}` or a truncated write that happens to stay
 * valid JSON) would otherwise normalize to loopback DEFAULTS, which is a silent
 * reachable→loopback downgrade if the backup still holds the real install. So we
 * treat such a file as unusable rather than a valid config.
 */
function isRealConfigShape(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  const service = raw["service"];
  if (!isRecord(service)) return false;
  // Require the durable fields writeConfig ALWAYS emits: a non-empty host (the
  // reachability determinant), an integer port, and a non-empty workspace path. A
  // partial-but-valid primary missing any of these — e.g. `{"service":{"host":"..."}}`
  // — would normalize to defaults (losing the bind OR silently moving the install to
  // the default workspace) and bypass recovery, so treat it as unusable and prefer
  // the backup that holds the full last-good install.
  const host = service["host"];
  const port = service["port"];
  const workspace = raw["workspace"];
  const hasHost = typeof host === "string" && host.trim() !== "";
  const hasPort = typeof port === "number" && Number.isInteger(port);
  const hasWorkspace = typeof workspace === "string" && workspace.trim() !== "";
  return hasHost && hasPort && hasWorkspace;
}

/** Parse + normalize a config file only if it has a real config shape; else null. */
function readConfigFileIfReal(path: string): WorktableConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  return isRealConfigShape(raw) ? normalizeConfig(raw) : null;
}

/**
 * Read config.json.
 *
 * - Absent file → default config (legitimate first run), UNLESS a backup exists —
 *   then the config was lost and we recover it (or fail loud if the backup is bad).
 * - Present + a real config → that config (seeding the backup if missing).
 * - Present + unparseable OR semantically empty (`{}`) → do NOT silently substitute
 *   loopback defaults (that is the silent downgrade bug). Recover from `<config>.bak`
 *   if it holds a real config; otherwise preserve the bytes and throw
 *   ConfigCorruptError (unparseable) or, when it is merely empty valid JSON with no
 *   backup to prefer, fall back to normalized defaults.
 */
export function readConfig(): WorktableConfig {
  const path = getConfigPath();
  const backupPath = getConfigBackupPath();
  if (!existsSync(path)) {
    // Missing primary. Recover from a real backup; a backup that exists but is
    // unusable proves a configured install with a damaged backup — fail loud rather
    // than downgrading. Only a total absence of backup is a genuine first run.
    const recovered = readConfigFileIfReal(backupPath);
    if (recovered) return writeConfig(recovered);
    if (existsSync(backupPath)) {
      throw new ConfigCorruptError(
        `Worktable config at ${path} is missing and its backup ${backupPath} is unreadable.` +
          " This was a configured install, so it is not treated as a first run." +
          " Run `worktable setup` to recreate it (re-choose --reachable if this install was network-reachable).",
        path,
        null
      );
    }
    return createDefaultConfig();
  }

  // Parse the primary, distinguishing "unparseable" from "valid JSON but not a real
  // config" — they get different terminal behavior when no backup can help.
  let raw: unknown;
  let rawText = "";
  let parseFailed = false;
  try {
    rawText = readFileSync(path, "utf8");
    raw = JSON.parse(rawText);
  } catch {
    parseFailed = true;
  }

  if (!parseFailed && isRealConfigShape(raw)) {
    const config = normalizeConfig(raw);
    // Keep the backup in sync with the authoritative primary — refresh it when
    // MISSING or STALE (e.g. a crash between the primary rename and the backup
    // refresh left an old/partial sidecar, which recovery would otherwise trust and
    // resurrect a pre-change bind). Only writes when the bytes actually differ, so a
    // clean read stays write-free and config.json is never touched. Best-effort.
    try {
      const backupStale = !existsSync(backupPath) || readFileSync(backupPath, "utf8") !== rawText;
      if (backupStale) {
        const tmp = `${backupPath}.tmp.${process.pid}`;
        writeFileSync(tmp, rawText, { mode: 0o600 });
        renameSync(tmp, backupPath);
      }
    } catch {
      // Advisory only; a missing/stale backup just weakens later recovery.
    }
    return config;
  }

  // Unusable primary (unparseable, or valid JSON without a real config shape).
  // Preserve genuinely corrupt bytes for inspection (not worth quarantining a
  // valid-JSON-but-empty file).
  let corruptPath: string | null = null;
  if (parseFailed) {
    corruptPath = getConfigCorruptPath();
    try {
      copyFileSync(path, corruptPath);
    } catch {
      corruptPath = null;
    }
  }

  // Prefer the last known-good config (may carry a reachable bind).
  const recovered = readConfigFileIfReal(backupPath);
  if (recovered) {
    // Re-persist so the recovered intent becomes canonical again and the next read
    // is clean. writeConfig refreshes the backup and fsyncs.
    return writeConfig(recovered);
  }

  // No usable backup recovered. A valid-JSON-but-empty file with NO backup at all
  // can't be recovered and isn't clearly corrupt, so normalize it (a genuine empty
  // config → defaults). But if a backup FILE exists and was merely unusable, this is
  // a configured install with a damaged backup — fail loud rather than default,
  // symmetric with the missing-primary branch. A genuinely unparseable primary is
  // always a hard corruption.
  const backupExists = existsSync(backupPath);
  if (!parseFailed && !backupExists) return normalizeConfig(raw);
  throw new ConfigCorruptError(
    `Worktable config at ${path} could not be loaded and no usable backup was found.` +
      (corruptPath ? ` The unparseable file was preserved at ${corruptPath}.` : "") +
      " Run `worktable setup` to recreate it (re-choose --reachable if this install was network-reachable).",
    path,
    corruptPath
  );
}

/**
 * Durably persist config.json: write tmp → fsync → atomic rename → fsync(dir) so
 * an unclean host stop can't leave a truncated config that later reads as loopback
 * defaults. fsync failures degrade to the plain write rather than aborting.
 *
 * Then refresh the `.bak` sidecar to mirror THIS just-written config. The backup
 * must track the last successfully written state — reachable OR loopback — so a
 * deliberate reachable→loopback downgrade is not silently undone by later
 * recovering a stale reachable backup. (Writing it after the primary, not from the
 * prior file, is the fix for that.)
 */
export function writeConfig(config: WorktableConfig): WorktableConfig {
  const normalized = normalizeConfig(config);
  const path = getConfigPath();
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const serialized = JSON.stringify(normalized, null, 2) + "\n";

  const tmp = `${path}.tmp.${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, serialized);
    try {
      fsyncSync(fd);
    } catch {
      // fsync can be unsupported on some filesystems; the write still lands.
    }
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dir);

  // Refresh the backup to the just-written content via its own atomic rename, so
  // the backup is always the last GOOD config and is never left torn by a crash
  // mid-copy. Best-effort: a missing/failed backup only weakens recovery, not the
  // primary write that already succeeded above.
  try {
    const bak = getConfigBackupPath();
    const bakTmp = `${bak}.tmp.${process.pid}`;
    writeFileSync(bakTmp, serialized, { mode: 0o600 });
    renameSync(bakTmp, bak);
  } catch {
    // Could not refresh the backup (e.g. a locked/read-only .bak). Remove any stale
    // one so a later recovery can't resurrect a previous — possibly reachable —
    // config after a deliberate change, silently undoing it. Losing the backup only
    // weakens recovery; the durable primary just written is the source of truth.
    try {
      rmSync(getConfigBackupPath(), { force: true });
    } catch {
      // Nothing more we can do; the primary write already succeeded.
    }
  }
  return normalized;
}

/** fsync a directory so a rename is durable. Best-effort; never throws. */
function fsyncDir(dir: string): void {
  let dirFd: number | null = null;
  try {
    dirFd = openSync(dir, "r");
    fsyncSync(dirFd);
  } catch {
    // Directory fsync is unsupported on some platforms/filesystems.
  } finally {
    if (dirFd !== null) {
      try {
        closeSync(dirFd);
      } catch {
        // Already closed / never opened.
      }
    }
  }
}

export function ensureConfig(): WorktableConfig {
  ensureAppDir();
  const config = readConfig();
  writeConfig(config);
  return config;
}

/**
 * Read config for `setup`, the explicit recreate path — WITHOUT persisting. Like
 * readConfig, but tolerates an UNRECOVERABLE corrupt config by returning in-memory
 * defaults instead of throwing (readConfig has already preserved the corrupt bytes
 * and attempted `.bak` recovery). Crucially it does NOT write: setup performs many
 * validations that can abort (terminal/--yes, owner-password, workspace adoption,
 * prompt cancellation), so persisting here would overwrite a corrupt-but-present
 * install with loopback defaults on an aborted run. The caller commits once, at the
 * end, via writeConfig. A network-reachable install is restored by re-running
 * `setup --reachable`, not silently downgraded.
 */
export function loadConfigForRecreate(): { config: WorktableConfig; recreated: boolean } {
  try {
    return { config: readConfig(), recreated: false };
  } catch (err) {
    if (err instanceof ConfigCorruptError) {
      // `recreated: true` signals that these defaults are NOT a trustworthy baseline
      // of the running install — callers (setup) must treat any service reconfigure
      // as a change, since we don't actually know the old host/port/workspace.
      return { config: createDefaultConfig(), recreated: true };
    }
    throw err;
  }
}

export function updateConfig(mutator: (config: WorktableConfig) => WorktableConfig | void): WorktableConfig {
  const current = readConfig();
  const next = mutator(current) ?? current;
  return writeConfig(next);
}

export function applyRuntimeConfig(config: WorktableConfig): void {
  process.env["WORKTABLE_WORKSPACE"] = config.workspace;
  process.env["HOST"] = config.service.host;
  process.env["PORT"] = String(config.service.port);
  // The exposure signal is derived from the effective bind host, never from
  // `reachable` alone — this closes the `launch -H 0.0.0.0` bypass. Delete the
  // var on a loopback bind so a stale value from a prior reachable run never
  // leaks into this in-process invocation (e.g. an in-process mint).
  if (!isLoopbackHost(config.service.host)) {
    process.env["WORKTABLE_REQUIRE_AUTH"] = "1";
  } else {
    delete process.env["WORKTABLE_REQUIRE_AUTH"];
  }
  // Forward the HTTPS-upstream acknowledgement to the server boot banner so it
  // suppresses the reachability reminder (the reminder only — auth is unchanged).
  // Delete a stale value so a prior reachable run never leaks in-process.
  if (config.service.httpsUpstream) {
    process.env["WORKTABLE_TLS_UPSTREAM"] = "1";
  } else {
    delete process.env["WORKTABLE_TLS_UPSTREAM"];
  }
}

export function setClientState(
  config: WorktableConfig,
  clientId: McpClientId,
  desired: boolean,
  state: McpClientState
): void {
  config.mcp.clients[clientId] = { desired, state };
}
