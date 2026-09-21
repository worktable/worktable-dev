import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  getAppDir,
  localRuntimeProcessAlive,
  readLocalRuntime,
} from "@worktable/server/runtime";
import { isLoopbackHost, readConfig, type WorktableConfig } from "./config.ts";
import { getExecutablePath, getReleaseDir, VERSION } from "./paths.ts";

export type ServiceBackend = "launchd" | "systemd" | "process" | "unsupported";
export type ServiceState =
  | "running"
  | "stopped"
  | "not-installed"
  | "unsupported"
  | "unknown";

/**
 * Thrown when a service lifecycle operation could NOT achieve its contract —
 * install refused (a competing backend couldn't be torn down), uninstall left a
 * live unit behind, or a stop/restart couldn't confirm the process is down.
 *
 * A THROW, not a status note, on the ConfigCorruptError precedent: failure then
 * propagates to every caller by default, so no command can print "running"/exit 0
 * or keep mutating (config writes, token mints, installer runs) after the service
 * layer failed. Advisory conditions (linger fallback, split-brain warnings) stay on
 * ServiceStatus.message/warnings — this class is only for outcomes that must abort.
 */
export class ServiceLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceLifecycleError";
  }
}

// The home directory used to locate manager unit files (systemd/launchd). Tests
// MUST override this: Bun's os.homedir() reads the INITIAL environment and ignores
// a later process.env.HOME change, so setting HOME at runtime does not redirect it —
// without this seam an in-process test would read and WRITE the real user's
// ~/.config/systemd/user/worktable.service (which once clobbered a live install).
let _serviceHomeOverride: string | null = null;
export function setServiceHomeOverride(dir: string | null): void {
  _serviceHomeOverride = dir;
}
function serviceHome(): string {
  return _serviceHomeOverride ?? homedir();
}

export interface ServiceStatus {
  // `platform` names the service backend in use, not the OS. A Linux box without
  // a reachable systemd user manager falls back to the portable "process" backend.
  platform: ServiceBackend;
  state: ServiceState;
  installed: boolean;
  startsAtLogin: boolean;
  serviceFile: string | null;
  logs: { stdout: string; stderr: string };
  message?: string;
  /**
   * Non-fatal warnings surfaced to the operator — currently a split-brain notice
   * when more than one backend's artifacts coexist (e.g. a leftover managed
   * process marker alongside a systemd unit), which can cause port contention and
   * a lying "stopped" status. Empty/absent when the install is clean.
   */
  warnings?: string[];
}

export interface ServiceInstallOptions {
  publicUrl?: string;
  authorityHandoff?: string;
}

export const SERVICE_LABEL = "dev.worktable.local";

// Tag appended to the @reboot crontab line so we can find and rewrite just ours.
const CRON_TAG = "# worktable-managed-service";

function run(cmd: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  // Bun.spawnSync THROWS when the executable is missing (e.g. systemctl absent
  // in a minimal VM) instead of returning a non-zero exit code. Treat a missing
  // binary, or any spawn failure, as a handled non-zero result so callers can
  // degrade gracefully rather than crash with a fatal error.
  try {
    // env passed explicitly: Bun resolves the executable against the CURRENT
    // process.env.PATH only when env is provided (its default resolution uses the
    // initial environment, like os.homedir() — see setServiceHomeOverride), and
    // tests rely on runtime PATH manipulation to sandbox systemctl/crontab.
    const result = Bun.spawnSync(cmd, {
      env: process.env as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode ?? -1,
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
    };
  } catch (error) {
    return {
      exitCode: -1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function runWithInput(cmd: string[], input: string): { exitCode: number } {
  try {
    const result = Bun.spawnSync(cmd, {
      env: process.env as Record<string, string>,
      stdin: new TextEncoder().encode(input),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { exitCode: result.exitCode ?? -1 };
  } catch {
    return { exitCode: -1 };
  }
}

// Resolve a command against $PATH without spawning it — cheaper and more
// reliable than probing via a child process, and never throws.
function commandExists(cmd: string): boolean {
  const path = process.env["PATH"] ?? "";
  for (const dir of path.split(delimiter)) {
    if (dir && existsSync(join(dir, cmd))) return true;
  }
  return false;
}

// systemd `--user` needs both the systemctl binary and a reachable user manager
// (logind session + user D-Bus). Containers and minimal VMs often have neither,
// so probe for an actually-usable manager rather than assuming all Linux qualifies.
function systemdUserAvailable(): boolean {
  if (!commandExists("systemctl")) return false;
  return run(["systemctl", "--user", "show-environment"]).exitCode === 0;
}

function backendOverride(): ServiceBackend | null {
  const override = process.env["WORKTABLE_SERVICE_BACKEND"]?.trim();
  if (
    override === "launchd" ||
    override === "systemd" ||
    override === "process" ||
    override === "unsupported"
  ) {
    return override;
  }
  return null;
}

// Fresh detection from platform + a live systemd-user probe. Used ONLY to CHOOSE
// a backend at install time (or when no choice has been persisted). Every other
// command resolves through resolveBackend(), which prefers the persisted choice —
// so a session where `systemctl --user` happens to be unavailable (SSH, cron,
// sudo) can't silently switch an installed systemd service to the process backend.
function detectBackend(): ServiceBackend {
  const override = backendOverride();
  if (override) return override;
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") {
    return systemdUserAvailable() ? "systemd" : "process";
  }
  // No portable detach primitive we support (e.g. Windows).
  return "unsupported";
}

// The authoritative backend for an existing install: env override > persisted
// choice > existing on-disk artifact > fresh detection. Persisting the choice at
// install time and honoring it here is what makes service behavior stable across
// differing shell environments.
export function resolveBackend(): ServiceBackend {
  const override = backendOverride();
  if (override) return override;
  const persisted = readPersistedBackend();
  // Trust the persisted choice only if its artifact actually exists AND it can run
  // on this OS. An interrupted install (state written, artifact never created) or an
  // app dir synced across OSes (launchd persisted, now on Linux) would otherwise
  // make status/install act on a backend that isn't real here, while ignoring or
  // fighting the actual one. Falling through to adoption/detection picks the real one.
  if (
    persisted &&
    backendValidForPlatform(persisted) &&
    backendArtifactExists(persisted)
  ) {
    return persisted;
  }
  // No recorded choice yet — e.g. an install predating this change. Adopt an
  // existing on-disk backend rather than re-detecting: a degraded session
  // (SSH/cron/sudo without a reachable `systemctl --user`) would otherwise detect
  // `process` and then tear the real systemd unit down as a "competing" backend on
  // install, recreating the very reachable→non-starting regression this guards
  // against. When multiple artifacts coexist (split-brain), PREFER a service
  // manager (launchd/systemd) over the portable `process` fallback so consolidation
  // never deletes the boot-durable service — the process backend is only chosen
  // when it is the sole survivor. Only with zero artifacts do we detect fresh.
  // (detectInstalledBackends already ignores platform-invalid artifacts, so a stale
  // launchd plist on Linux can't be adopted here.)
  const installed = detectInstalledBackends();
  if (installed.includes("launchd")) return "launchd";
  if (installed.includes("systemd")) return "systemd";
  if (installed.includes("process")) return "process";
  return detectBackend();
}

// Whether a backend can actually run on the current OS. launchd is macOS-only,
// systemd(-user) is Linux-only, and the portable process backend runs on both.
function backendValidForPlatform(backend: ServiceBackend): boolean {
  if (backend === "launchd") return process.platform === "darwin";
  if (backend === "systemd") return process.platform === "linux";
  if (backend === "process")
    return process.platform === "darwin" || process.platform === "linux";
  return false;
}

// The on-disk file each backend owns; its existence is what `installed` means for
// that backend. Independent of which backend is currently resolved, so split-brain
// detection and cleanup can probe every backend, not just the active one.
function backendFilePath(backend: ServiceBackend): string | null {
  if (backend === "launchd") {
    return join(
      serviceHome(),
      "Library",
      "LaunchAgents",
      `${SERVICE_LABEL}.plist`
    );
  }
  if (backend === "systemd") {
    return join(
      serviceHome(),
      ".config",
      "systemd",
      "user",
      "worktable.service"
    );
  }
  if (backend === "process") {
    return join(getAppDir(), "managed-service.json");
  }
  return null;
}

export function getServicePaths(): ServiceStatus["logs"] & {
  file: string | null;
  platform: ServiceBackend;
} {
  const logDir = join(getAppDir(), "logs");
  const logs = {
    stdout: join(logDir, "service.out.log"),
    stderr: join(logDir, "service.err.log"),
  };
  const platform = resolveBackend();
  return { platform, file: backendFilePath(platform), ...logs };
}

// ---- Persisted backend choice ----------------------------------------------

function getServiceStatePath(): string {
  return join(getAppDir(), "service-state.json");
}

function readPersistedBackend(): ServiceBackend | null {
  const path = getServiceStatePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      backend?: unknown;
    };
    const backend = parsed.backend;
    if (
      backend === "launchd" ||
      backend === "systemd" ||
      backend === "process"
    ) {
      return backend;
    }
    return null;
  } catch {
    return null;
  }
}

function writePersistedBackend(backend: ServiceBackend): void {
  if (backend === "unsupported") return;
  const path = getServiceStatePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(
    tmp,
    JSON.stringify(
      { backend, label: SERVICE_LABEL, version: VERSION },
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  );
  renameSync(tmp, path);
}

function clearPersistedBackend(): void {
  const path = getServiceStatePath();
  if (existsSync(path)) rmSync(path);
}

// ---- Split-brain detection & cleanup ---------------------------------------

const ALL_BACKENDS: ServiceBackend[] = ["launchd", "systemd", "process"];

function backendArtifactExists(backend: ServiceBackend): boolean {
  const file = backendFilePath(backend);
  return Boolean(file && existsSync(file));
}

// Which backends currently have artifacts on disk AND can run on this OS. More
// than one ⇒ split-brain: two managers can fight over the port and status can
// report "stopped" while another backend holds it — exactly the confusing state
// this cleanup prevents. Platform-invalid artifacts (a Linux systemd unit synced
// onto a Mac, or vice-versa) are ignored at this single choke point so adoption,
// cleanup, split-brain warnings, and uninstall all agree: an artifact that can't
// run here is inert clutter, not a competitor to fight or a backend to adopt.
function detectInstalledBackends(): ServiceBackend[] {
  return ALL_BACKENDS.filter(
    (backend) =>
      backendValidForPlatform(backend) && backendArtifactExists(backend)
  );
}

// Fully tear down a single backend: stop it via its manager AND remove its
// artifacts, so a leftover backend can neither hold the port nor restart at boot.
// Returns true when the artifact was actually removed, false when it had to be left
// in place (a degraded session that couldn't stop the service) — the caller uses that
// to avoid falsely claiming a clean uninstall.
function teardownBackend(backend: ServiceBackend): boolean {
  if (backend === "launchd") {
    run([
      "launchctl",
      "bootout",
      `gui/${process.getuid?.() ?? ""}/${SERVICE_LABEL}`,
    ]);
    const plist = backendFilePath("launchd");
    if (plist && existsSync(plist)) rmSync(plist);
    return !(plist && existsSync(plist));
  } else if (backend === "systemd") {
    // Stop the RUNNING unit first: `disable` is a unit-file command that only
    // affects boot, so without `stop` a live worktable.service keeps holding the
    // port after its unit file is gone — the port contention this cleanup exists
    // to prevent. (launchd `bootout` above both stops and unloads in one step.)
    const stop = run(["systemctl", "--user", "stop", "worktable.service"]);
    run(["systemctl", "--user", "disable", "worktable.service"]);
    const unit = backendFilePath("systemd");
    // Confirm the service is actually DOWN before removing anything. A clean stop
    // confirms it; so does the manager reporting inactive/failed — which covers a
    // fileless, never-loaded unit where `stop` exits non-zero ("not loaded") yet
    // there is nothing running. Empty is-active output means the manager was
    // unreachable: NOT confirmed, so leave the unit visible and report incomplete —
    // deleting it would hide a possibly-live service while it keeps serving.
    const active = run([
      "systemctl",
      "--user",
      "is-active",
      "worktable.service",
    ]).stdout.trim();
    const confirmedDown =
      stop.exitCode === 0 || active === "inactive" || active === "failed";
    if (confirmedDown && unit && existsSync(unit)) rmSync(unit);
    run(["systemctl", "--user", "daemon-reload"]);
    return confirmedDown && !(unit && existsSync(unit));
  } else if (backend === "process") {
    // Stop the running server (frees the port) FIRST; only then remove its boot
    // persistence, and only then the marker. If the process is alive but
    // unverifiable, remove NOTHING — deleting the marker would report the backend
    // not-installed while the old server may still hold the port. Likewise if the
    // @reboot cron entry can't be removed, keep the marker: cron would resurrect
    // the backend at boot, so reporting it torn down would be a lie.
    const stopped = stopManagedProcess();
    if (!stopped) return false;
    if (!disableBootPersistence()) return false;
    const marker = backendFilePath("process");
    if (marker && existsSync(marker)) rmSync(marker);
    return !(marker && existsSync(marker));
  }
  return true;
}

// Remove every backend that isn't the selected one. Returns which competitors were
// removed and which could NOT be torn down (a degraded session). This is what keeps
// a single install from ending up with competing systemd + managed-process backends
// — and install must abort when a competitor is left behind rather than create the
// split-brain this exists to prevent.
function cleanupCompetingBackends(selected: ServiceBackend): {
  removed: ServiceBackend[];
  failed: ServiceBackend[];
} {
  const removed: ServiceBackend[] = [];
  const failed: ServiceBackend[] = [];
  // detectInstalledBackends (not ALL_BACKENDS) so platform-invalid artifacts — a
  // Linux unit synced onto a Mac — are ignored here exactly as adoption ignores
  // them: they can't run, so they're inert clutter, not competitors whose
  // un-stoppable manager should block this install.
  for (const backend of detectInstalledBackends()) {
    if (backend === selected) continue;
    if (teardownBackend(backend)) removed.push(backend);
    else failed.push(backend);
  }
  return { removed, failed };
}

// Operator-facing warning when more than one backend's artifacts coexist. Empty
// on a clean install. Surfaced through every ServiceStatus so `status`/`doctor`
// flag the split-brain rather than silently reporting one backend's view.
function splitBrainWarnings(): string[] {
  const installed = detectInstalledBackends();
  if (installed.length <= 1) return [];
  return [
    `Multiple service backends are installed (${installed.join(", ")}). They can contend for the port and make status unreliable. Run \`worktable service install\` to consolidate onto the active backend, or \`worktable service uninstall\` to remove them all.`,
  ];
}

function getPidPath(): string {
  return join(getAppDir(), "service.pid");
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function effectiveServicePublicUrl(
  options: ServiceInstallOptions
): string | undefined {
  const explicit = options.publicUrl?.trim();
  // An explicit empty value intentionally clears an ambient public URL.
  return explicit === undefined
    ? process.env["WORKTABLE_PUBLIC_URL"]?.trim() || undefined
    : explicit || undefined;
}

function serviceEnvironment(
  config: WorktableConfig,
  options: ServiceInstallOptions = {}
): Record<string, string> {
  const env: Record<string, string> = {
    WORKTABLE_WORKSPACE: config.workspace,
    WORKTABLE_APP_DIR: getAppDir(),
    HOST: config.service.host,
    PORT: String(config.service.port),
    WORKTABLE_VERSION: VERSION,
    WORKTABLE_LOCAL_OWNER: "service",
  };
  // The background service derives its exposure signal from the effective bind
  // host, exactly like applyRuntimeConfig, so a reachable install carries the
  // flag into launchd/systemd/managed-process alike.
  if (!isLoopbackHost(config.service.host)) {
    env["WORKTABLE_REQUIRE_AUTH"] = "1";
  }
  // Carry the HTTPS-upstream acknowledgement so the managed service's boot banner
  // suppresses the reachability reminder too (reminder only, not auth) — parity
  // with applyRuntimeConfig.
  if (config.service.httpsUpstream) {
    env["WORKTABLE_TLS_UPSTREAM"] = "1";
  }
  const publicUrl = effectiveServicePublicUrl(options);
  if (publicUrl) {
    env["WORKTABLE_PUBLIC_URL"] = publicUrl;
  }
  const authorityHandoff = options.authorityHandoff?.trim();
  if (authorityHandoff) {
    env["WORKTABLE_LOCAL_AUTHORITY_HANDOFF"] = authorityHandoff;
  }
  const releaseDir = getReleaseDir();
  if (releaseDir) env["WORKTABLE_RELEASE_DIR"] = releaseDir;
  const staticDir = process.env["WORKTABLE_STATIC_DIR"]?.trim();
  if (staticDir) env["WORKTABLE_STATIC_DIR"] = staticDir;
  return env;
}

export function renderLaunchdPlist(
  config: WorktableConfig,
  executable = getExecutablePath(),
  options: ServiceInstallOptions = {}
): string {
  const logs = getServicePaths();
  const env = serviceEnvironment(config, options);
  const envXml = Object.entries(env)
    .map(
      ([key, value]) =>
        `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(executable)}</string>
    <string>launch</string>
    <string>--foreground</string>
    <string>--no-browser</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key>
  <${config.service.startAtLogin ? "true" : "false"}/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logs.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logs.stderr)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(
  config: WorktableConfig,
  executable = getExecutablePath(),
  options: ServiceInstallOptions = {}
): string {
  const logs = getServicePaths();
  const env = serviceEnvironment(config, options);
  const envLines = Object.entries(env)
    .map(([key, value]) => `Environment=${key}=${shellQuote(value)}`)
    .join("\n");
  return `[Unit]
Description=Worktable local workspace
After=network.target

[Service]
Type=simple
${envLines}
ExecStart=${shellQuote(executable)} launch --foreground --no-browser
Restart=on-failure
RestartSec=2
StandardOutput=append:${logs.stdout}
StandardError=append:${logs.stderr}

[Install]
WantedBy=default.target
`;
}

function renderManagedMarker(
  config: WorktableConfig,
  startsAtLogin: boolean,
  options: ServiceInstallOptions = {}
): string {
  const publicUrl = effectiveServicePublicUrl(options);
  return (
    JSON.stringify(
      {
        label: SERVICE_LABEL,
        version: VERSION,
        // The achieved boot-persistence state, not merely what was requested —
        // keeps the marker consistent with getServiceStatus().startsAtLogin.
        startAtLogin: startsAtLogin,
        host: config.service.host,
        port: config.service.port,
        ...(publicUrl ? { publicUrl } : {}),
        ...(options.authorityHandoff?.trim()
          ? { authorityHandoff: options.authorityHandoff.trim() }
          : {}),
      },
      null,
      2
    ) + "\n"
  );
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

function decodeShellQuoted(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("'") || !trimmed.endsWith("'")) return trimmed;
  return trimmed.slice(1, -1).replaceAll("'\\''", "'");
}

function readManagedServiceInstallOptions(path: string): ServiceInstallOptions {
  try {
    const marker = JSON.parse(readFileSync(path, "utf8")) as {
      publicUrl?: unknown;
      authorityHandoff?: unknown;
    };
    return {
      ...(typeof marker.publicUrl === "string"
        ? { publicUrl: marker.publicUrl }
        : {}),
      ...(typeof marker.authorityHandoff === "string"
        ? { authorityHandoff: marker.authorityHandoff }
        : {}),
    };
  } catch {
    return {};
  }
}

export function getInstalledServicePublicUrl(): string | undefined {
  const paths = getServicePaths();
  if (!paths.file || !existsSync(paths.file)) return undefined;
  let contents: string;
  try {
    contents = readFileSync(paths.file, "utf8");
  } catch {
    // The service may be removed between the status/path check and the read.
    // Treat that transition exactly like an absent install.
    return undefined;
  }
  if (paths.platform === "launchd") {
    const match = contents.match(
      /<key>WORKTABLE_PUBLIC_URL<\/key>\s*<string>([^<]*)<\/string>/
    );
    return match?.[1] ? decodeXml(match[1]).trim() || undefined : undefined;
  }
  if (paths.platform === "systemd") {
    const line = contents
      .split("\n")
      .find((candidate) =>
        candidate.startsWith("Environment=WORKTABLE_PUBLIC_URL=")
      );
    if (!line) return undefined;
    return (
      decodeShellQuoted(
        line.slice("Environment=WORKTABLE_PUBLIC_URL=".length)
      ).trim() || undefined
    );
  }
  if (paths.platform === "process") {
    return (
      readManagedServiceInstallOptions(paths.file).publicUrl?.trim() ||
      undefined
    );
  }
  return undefined;
}

// ---- Managed-process backend (no systemd/launchd) ---------------------------

function sleepSync(ms: number): void {
  // Block without busy-spinning so we can synchronously wait for the detached
  // child to record its PID.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readPid(): number | null {
  const path = getPidPath();
  if (!existsSync(path)) return null;
  const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs existence/permission checks without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we may not signal it — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

type PidVerdict = "ours" | "foreign" | "unknown";

export function classifyManagedPidReadFailure(
  processStillAlive: boolean
): Extract<PidVerdict, "foreign" | "unknown"> {
  return processStillAlive ? "unknown" : "foreign";
}

// Identify whether a live PID is OUR managed Worktable child before signaling it, so
// a stale service.pid whose PID has been recycled to an unrelated same-user process
// isn't killed (e.g. during competing-backend cleanup on install). Linux: match the
// WORKTABLE_MANAGED_PID_FILE marker we set on the child in its /proc environ — a
// strong positive identity. Tri-state so callers can distinguish "positively someone
// else" from "couldn't tell":
//   ours    — environ carries our marker → safe to stop.
//   foreign — environ readable, no marker → a recycled/unrelated process, don't kill.
//   unknown — environ unreadable (hardened procfs/hidepid) → can't confirm; don't kill
//             AND don't discard the pid file, so we never falsely report "stopped".
// No /proc (macOS): trust the pid file we wrote rather than leave a child unstoppable.
function verifyManagedPid(pid: number): PidVerdict {
  if (!existsSync("/proc")) return "ours";
  try {
    const environ = readFileSync(`/proc/${pid}/environ`, "utf8");
    return environ
      .split("\0")
      .some((entry) => entry === `WORKTABLE_MANAGED_PID_FILE=${getPidPath()}`)
      ? "ours"
      : "foreign";
  } catch {
    // `/proc/<pid>` can disappear between the liveness check and environment
    // read. Recheck before calling the process unknowable: a confirmed exit is
    // stopped/stale state, while a still-live unreadable PID remains protected.
    return classifyManagedPidReadFailure(isAlive(pid));
  }
}

function startManagedProcess(): boolean {
  const pidPath = getPidPath();
  const existing = readPid();
  if (existing !== null && isAlive(existing)) {
    const verdict = verifyManagedPid(existing);
    // Fast-path "already running" ONLY for a verified managed child — a recycled
    // PID pointing at an unrelated live process must not make start/install claim
    // a running Worktable that was never spawned.
    if (verdict === "ours") return true;
    // Stale recycled PID: clear it and spawn fresh. Unverifiable (`unknown`): keep
    // the PID file (it may really be ours) and attempt a spawn anyway — if the old
    // process is ours and bound, the child fails to bind and we report failure
    // honestly instead of lying either way.
    if (verdict === "foreign" && existsSync(pidPath)) rmSync(pidPath);
  } else if (existsSync(pidPath)) {
    rmSync(pidPath);
  }

  const config = readConfig();
  const logs = getServicePaths();
  mkdirSync(dirname(logs.stdout), { recursive: true });
  const out = openSync(logs.stdout, "a");
  const err = openSync(logs.stderr, "a");
  const executable = getExecutablePath();
  const args = ["launch", "--foreground", "--no-browser"];
  // setsid puts the server in its own session with no controlling terminal, so
  // it survives the launching shell/SSH closing. Where setsid is absent we
  // detach as far as Bun allows (unref lets the launcher exit) and the child
  // ignores SIGHUP (see recordManagedPid) so a terminal hangup doesn't kill it.
  // The child writes its own PID file, so a setsid re-fork never confuses tracking.
  const cmd = commandExists("setsid")
    ? ["setsid", executable, ...args]
    : [executable, ...args];
  try {
    const child = Bun.spawn(cmd, {
      env: {
        ...process.env,
        ...serviceEnvironment(
          config,
          readManagedServiceInstallOptions(getServicePaths().file ?? "")
        ),
        WORKTABLE_MANAGED_PID_FILE: pidPath,
      },
      stdin: "ignore",
      stdout: out,
      stderr: err,
    });
    child.unref();
  } catch {
    closeSync(out);
    closeSync(err);
    return false;
  }
  closeSync(out);
  closeSync(err);

  // The child writes its own PID — and only after the server has bound the port
  // (see recordManagedPid) — so a live PID means the service is actually up, and
  // a bind failure leaves no PID file. Writing it child-side also keeps the PID
  // correct through any setsid re-fork. Wait briefly for that signal.
  for (let i = 0; i < 50; i++) {
    const pid = readPid();
    if (pid !== null && isAlive(pid)) return true;
    sleepSync(100);
  }

  // Gave up waiting. If the child did record a live PID just after the timeout it
  // stays tracked (a later start/stop adopts it); only clear a stale/dead file so
  // it can't block the next start.
  const pid = readPid();
  if (pid === null || !isAlive(pid)) {
    if (existsSync(pidPath)) rmSync(pidPath);
  }
  return false;
}

function waitForExit(pid: number, steps: number): boolean {
  for (let i = 0; i < steps; i++) {
    if (!isAlive(pid)) return true;
    sleepSync(100);
  }
  return !isAlive(pid);
}

// Returns true when the managed process is confirmed gone (stopped, or never/no
// longer ours), false when an unverifiable live process was left in place — the
// caller must treat false as an incomplete teardown and keep the marker.
function stopManagedProcess(): boolean {
  const pid = readPid();
  const verdict =
    pid !== null && isAlive(pid) ? verifyManagedPid(pid) : "foreign";
  let stopped = verdict !== "unknown";
  if (verdict === "ours" && pid !== null) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    // Wait for the process to actually exit (and release the port) before we
    // remove the PID file — otherwise status reports "stopped" while the old
    // server is still bound, and a quick restart races the shutting-down one.
    if (!waitForExit(pid, 50)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
      stopped = waitForExit(pid, 20);
    }
  }
  // Remove the pid file EXCEPT when the process is alive but unverifiable — deleting
  // it there would falsely report "stopped" while a possibly-still-bound server runs.
  // ("foreign" is safe to clear: it's a recycled/dead pid, so our tracking is stale.)
  if (verdict !== "unknown") {
    const pidPath = getPidPath();
    if (existsSync(pidPath)) rmSync(pidPath);
  }
  return stopped;
}

// Best-effort auto-start without a service manager: a crontab @reboot entry.
// Requires `crontab`; absent it, background mode still runs now but won't
// survive a reboot.
function bootPersistenceEnabled(): boolean {
  if (!commandExists("crontab")) return false;
  const current = run(["crontab", "-l"]);
  return current.exitCode === 0 && current.stdout.includes(CRON_TAG);
}

function crontabWithoutOurLine(): string[] {
  const current = run(["crontab", "-l"]);
  if (current.exitCode !== 0) return [];
  return current.stdout
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.includes(CRON_TAG));
}

function enableBootPersistence(): boolean {
  if (!commandExists("crontab")) return false;
  // cron runs commands via `/bin/sh -c`, so the leading VAR=value assignment
  // applies for this command only. Pin WORKTABLE_APP_DIR so a custom-app-dir
  // install can still locate its config at boot, when that env isn't present.
  const line = `@reboot WORKTABLE_APP_DIR=${shellQuote(getAppDir())} ${shellQuote(getExecutablePath())} service start ${CRON_TAG}`;
  const lines = [...crontabWithoutOurLine(), line];
  return runWithInput(["crontab", "-"], lines.join("\n") + "\n").exitCode === 0;
}

// Returns true when our @reboot entry is confirmed absent afterward (removed, or
// never detectable), false when it was seen but could not be removed — callers must
// then treat the teardown as incomplete, or cron resurrects the backend at boot.
function disableBootPersistence(): boolean {
  if (!commandExists("crontab") || !bootPersistenceEnabled()) return true;
  const lines = crontabWithoutOurLine();
  if (lines.length === 0) {
    run(["crontab", "-r"]);
  } else {
    runWithInput(["crontab", "-"], lines.join("\n") + "\n");
  }
  // Verify the post-state instead of trusting the write: a failed `crontab -`
  // (read-only crontab, quota, etc.) would otherwise be reported as removed.
  return !bootPersistenceEnabled();
}

// ---- systemd user-lingering -------------------------------------------------

function currentUser(): string {
  return process.env["USER"]?.trim() || process.env["LOGNAME"]?.trim() || "";
}

// Is systemd user-lingering enabled? Without it an "enabled" user unit does NOT
// start at boot on a headless box (there is no login session to trigger it) —
// the exact gap that took the reachable install down after an LXC restart, while
// `is-enabled` still cheerfully reported "enabled".
function lingerEnabled(user: string): boolean {
  if (!user || !commandExists("loginctl")) return false;
  const result = run(["loginctl", "show-user", user, "--property=Linger"]);
  return result.exitCode === 0 && result.stdout.trim() === "Linger=yes";
}

// Best-effort enable. May require privileges the current user lacks (e.g. root in
// a minimal container), so callers must treat a false return as "couldn't enable —
// tell the operator how", not a hard failure.
function enableLinger(user: string): boolean {
  if (!user || !commandExists("loginctl")) return false;
  if (lingerEnabled(user)) return true;
  run(["loginctl", "enable-linger", user]);
  return lingerEnabled(user);
}

// ---- Public API -------------------------------------------------------------

/**
 * Verify a service (re)install can actually complete in THIS session, and tear
 * down competing backends — throwing ServiceLifecycleError otherwise — before any
 * durable state changes. Checks, for the resolved backend:
 *   - systemd: the user manager is reachable (else daemon-reload/enable would
 *     silently fail and the manager would keep serving the OLD unit);
 *   - process: any live managed process is verifiable (else it can't be stopped,
 *     and a reinstall would leave it serving the old config);
 *   - competitors: every platform-valid competing artifact can be torn down.
 * Idempotent and safe to call ahead of config/token mutations: the only side
 * effect is removing competitors, which any successful install does anyway.
 * installService calls this itself as a safety net; commands that persist durable
 * state BEFORE installing (launch --background, setup) must call it first.
 */
export function prepareServiceInstall(): void {
  prepareServiceStart();
  const platform = resolveBackend();
  if (platform === "unsupported") return; // installService reports unsupported itself
  if (platform === "systemd" && !systemdUserAvailable()) {
    throw new ServiceLifecycleError(
      "Can't install the systemd service: the user manager (systemctl --user) isn't reachable in this session. Re-run from a full login session."
    );
  }
  if (platform === "process") {
    const pid = readPid();
    if (pid !== null && isAlive(pid) && verifyManagedPid(pid) === "unknown") {
      throw new ServiceLifecycleError(
        "The managed background process could not be verified, so it can't be safely stopped or replaced. Check the service logs, or stop it manually before retrying."
      );
    }
  }
  const cleanup = cleanupCompetingBackends(platform);
  if (cleanup.failed.length) {
    throw new ServiceLifecycleError(
      `Refusing to install the ${platform} backend: a competing ${cleanup.failed.join(", ")} service could not be removed (its manager was unreachable in this session). Re-run from a full login session.`
    );
  }
}

/**
 * Refuse to start a managed service beside any live local host that the active
 * service manager does not prove it owns. The runtime owner field is only a
 * process claim; it is not authority on its own.
 */
export function serviceManagerOwnsRuntimePid(pid: number): boolean {
  const paths = getServicePaths();
  if (!paths.file || !existsSync(paths.file)) return false;

  if (paths.platform === "process") {
    const managedPid = readPid();
    return (
      managedPid === pid &&
      isAlive(managedPid) &&
      verifyManagedPid(managedPid) === "ours"
    );
  }

  if (paths.platform === "launchd") {
    const result = run([
      "launchctl",
      "print",
      `gui/${process.getuid?.() ?? ""}/${SERVICE_LABEL}`,
    ]);
    if (result.exitCode !== 0) return false;
    const managerPid = result.stdout.match(/^\s*pid = (\d+)\s*$/m)?.[1];
    return managerPid !== undefined && Number(managerPid) === pid;
  }

  if (paths.platform === "systemd") {
    const result = run([
      "systemctl",
      "--user",
      "show",
      "worktable.service",
      "--property=MainPID",
      "--value",
    ]);
    if (result.exitCode !== 0) return false;
    const managerPid = Number.parseInt(result.stdout.trim(), 10);
    return (
      Number.isSafeInteger(managerPid) && managerPid > 0 && managerPid === pid
    );
  }

  return false;
}

export function prepareServiceStart(): void {
  const runtime = readLocalRuntime();
  if (!runtime || !localRuntimeProcessAlive(runtime)) return;

  // The service manager's exact PID proof is authoritative. Older releases can
  // leave a stale descriptive owner in an otherwise live lease, and rejecting
  // that proven service would strand updates and Desktop restarts.
  if (serviceManagerOwnsRuntimePid(runtime.pid)) return;

  if (runtime.owner === "service") {
    throw new ServiceLifecycleError(
      `An unmanaged Worktable service process already owns the local endpoint for ${runtime.workspacePath}. Stop it before starting the background service.`
    );
  }

  throw new ServiceLifecycleError(
    `${runtime.owner === "desktop" ? "Worktable Desktop" : "A foreground Worktable command"} already owns the local endpoint for ${runtime.workspacePath}. Stop it before starting the background service.`
  );
}

export function installService(
  config: WorktableConfig,
  options: ServiceInstallOptions = {}
): ServiceStatus {
  const paths = getServicePaths();
  if (paths.platform === "unsupported" || !paths.file) {
    return statusWith(
      "unsupported",
      "This platform does not support Worktable service install yet."
    );
  }

  // Preflight everything that could make this install impossible — manager
  // unreachable, an unstoppable current process, a competing backend that can't be
  // torn down — and tear competitors down, all BEFORE any artifact is written.
  // Throws ServiceLifecycleError on failure so every caller aborts by default.
  // Commands that persist config/tokens ahead of installing (launch --background,
  // setup) call prepareServiceInstall() themselves first, so their durable
  // mutations never outrun a service transition that was doomed from the start.
  prepareServiceInstall();
  // Persist the chosen backend only AFTER the preflight succeeds (and its own
  // artifact is written just below), so a persisted choice always has a real artifact.
  writePersistedBackend(paths.platform);

  mkdirSync(dirname(paths.file), { recursive: true });
  mkdirSync(dirname(paths.stdout), { recursive: true });

  if (paths.platform === "launchd") {
    writeFileSync(
      paths.file,
      renderLaunchdPlist(config, getExecutablePath(), options)
    );
    return getServiceStatus();
  }

  if (paths.platform === "systemd") {
    writeFileSync(
      paths.file,
      renderSystemdUnit(config, getExecutablePath(), options)
    );
    run(["systemctl", "--user", "daemon-reload"]);
    run([
      "systemctl",
      "--user",
      config.service.startAtLogin ? "enable" : "disable",
      "worktable.service",
    ]);
    // An enabled user unit only survives a reboot when lingering is on. Auto-enable
    // it; if that needs privileges we don't have, surface clear instructions rather
    // than leaving a service that silently won't come back after a restart.
    if (config.service.startAtLogin) {
      const user = currentUser();
      if (!enableLinger(user)) {
        return getServiceStatus(
          [
            "Background service installed, but user lingering could not be enabled, so it may not start automatically after a reboot.",
            `  Enable it (may need sudo):  loginctl enable-linger ${user || "$USER"}`,
          ].join("\n")
        );
      }
    }
    return getServiceStatus();
  }

  // Managed-process backend: apply boot persistence first, then write the
  // marker with the state we actually achieved so the file, status, and CLI
  // output all agree.
  let startsAtLogin = false;
  if (config.service.startAtLogin) {
    startsAtLogin = enableBootPersistence();
  } else {
    disableBootPersistence();
  }
  writeFileSync(
    paths.file,
    renderManagedMarker(config, startsAtLogin, options)
  );

  if (config.service.startAtLogin && !startsAtLogin) {
    // Install only records intent; the caller starts the service separately, so
    // don't claim it is already running here.
    return getServiceStatus(
      [
        "Background service configured, but auto-start at boot is unavailable (no `crontab` found), so it won't restart automatically after a reboot.",
        "  To start it manually after a reboot, run:  worktable launch --background",
        "  For automatic start, install `cron`, or run under a systemd user session and enable lingering:  loginctl enable-linger $USER",
      ].join("\n")
    );
  }
  return getServiceStatus();
}

export function startService(): ServiceStatus {
  prepareServiceStart();
  const paths = getServicePaths();
  let failure: string | undefined;
  if (paths.platform === "launchd" && paths.file) {
    run([
      "launchctl",
      "bootout",
      `gui/${process.getuid?.() ?? ""}/${SERVICE_LABEL}`,
    ]);
    const boot = run([
      "launchctl",
      "bootstrap",
      `gui/${process.getuid?.() ?? ""}`,
      paths.file,
    ]);
    const kick = run([
      "launchctl",
      "kickstart",
      "-k",
      `gui/${process.getuid?.() ?? ""}/${SERVICE_LABEL}`,
    ]);
    if (kick.exitCode !== 0)
      failure = (kick.stderr || boot.stderr).trim() || undefined;
  } else if (paths.platform === "systemd") {
    const started = run(["systemctl", "--user", "start", "worktable.service"]);
    if (started.exitCode !== 0) failure = started.stderr.trim() || undefined;
  } else if (
    paths.platform === "process" &&
    paths.file &&
    existsSync(paths.file)
  ) {
    // Only start when installed (the marker exists); otherwise status would
    // report not-installed while a background server is actually running.
    if (!startManagedProcess()) {
      failure =
        "Failed to start the managed background process. Check the service logs.";
    }
  }
  const status = getServiceStatus();
  return failure ? { ...status, message: failure } : status;
}

/**
 * Restart the service with a single command the service manager owns, so the
 * restart completes even if the caller (e.g. a self-update worker that lives
 * inside the service's own job/cgroup) is killed the instant the restart kicks
 * in. launchd `kickstart -k` and `systemctl restart` are atomic from the
 * manager's side; the managed-process backend has no manager, so it falls back
 * to stop+start (the worker must outlive this — see the setsid note in the
 * update runner).
 */
export function restartService(): ServiceStatus {
  prepareServiceStart();
  const paths = getServicePaths();
  let failure: string | undefined;
  if (paths.platform === "launchd" && paths.file) {
    const kick = run([
      "launchctl",
      "kickstart",
      "-k",
      `gui/${process.getuid?.() ?? ""}/${SERVICE_LABEL}`,
    ]);
    if (kick.exitCode !== 0) failure = kick.stderr.trim() || undefined;
  } else if (paths.platform === "systemd") {
    const restarted = run([
      "systemctl",
      "--user",
      "restart",
      "worktable.service",
    ]);
    if (restarted.exitCode !== 0)
      failure = restarted.stderr.trim() || undefined;
  } else if (paths.platform === "process") {
    stopService();
    return startService();
  }
  const status = getServiceStatus();
  return failure ? { ...status, message: failure } : status;
}

export function stopService(): ServiceStatus {
  const paths = getServicePaths();
  if (paths.platform === "launchd") {
    run([
      "launchctl",
      "bootout",
      `gui/${process.getuid?.() ?? ""}/${SERVICE_LABEL}`,
    ]);
  } else if (paths.platform === "systemd") {
    run(["systemctl", "--user", "stop", "worktable.service"]);
  } else if (paths.platform === "process") {
    // A live managed process whose identity can't be verified was NOT stopped —
    // throw so `service stop`/`restart` and self-updates can't report success (or
    // start a second server onto the same port) while the old one is still bound.
    if (!stopManagedProcess()) {
      throw new ServiceLifecycleError(
        "The managed background process could not be verified and was not stopped. Check the service logs, or stop it manually before retrying."
      );
    }
  }
  return getServiceStatus();
}

// Everything an uninstall must tear down: every platform-valid backend with an
// artifact PLUS the persisted backend even when its artifact is gone — a unit file
// deleted out-of-band (or a failed prior teardown) can leave the service LOADED and
// running with no artifact on disk; `systemctl stop` acts on loaded units, not unit
// files, so the stop must still be attempted or uninstall strands a live server.
function teardownTargets(): ServiceBackend[] {
  const targets = new Set(detectInstalledBackends());
  const persisted = readPersistedBackend();
  if (persisted && backendValidForPlatform(persisted)) targets.add(persisted);
  return [...targets];
}

/**
 * Verify a full service teardown can complete in THIS session — throwing
 * ServiceLifecycleError otherwise — WITHOUT touching anything. For each teardown
 * target: systemd needs a reachable user manager; a live managed process must be
 * verifiable (stoppable). Commands that persist durable state before uninstalling
 * (setup toggling background off) call this ahead of their mutation boundary, so a
 * doomed teardown can't strand config saying "disabled" while the service runs on.
 */
export function prepareServiceUninstall(): void {
  for (const backend of teardownTargets()) {
    if (backend === "systemd" && !systemdUserAvailable()) {
      throw new ServiceLifecycleError(
        "Can't remove the systemd service: the user manager (systemctl --user) isn't reachable in this session. Re-run from a full login session."
      );
    }
    if (backend === "process") {
      const pid = readPid();
      if (pid !== null && isAlive(pid) && verifyManagedPid(pid) === "unknown") {
        throw new ServiceLifecycleError(
          "The managed background process could not be verified, so it can't be safely stopped. Check the service logs, or stop it manually before retrying."
        );
      }
    }
  }
}

export function uninstallService(): ServiceStatus {
  // Tear down EVERY teardown target — every backend with artifacts (repairing any
  // split-brain leftover) plus the persisted backend even if its artifact is gone,
  // so a loaded-but-fileless service is still stopped. (teardownBackend stops each
  // backend itself; a stop the manager can't confirm reports as incompleteness.)
  let incomplete = false;
  for (const backend of teardownTargets()) {
    if (!teardownBackend(backend)) incomplete = true;
  }
  if (incomplete) {
    // A unit/process couldn't be stopped or removed (manager unreachable or the
    // managed PID unverifiable). Throw so no caller can claim a clean uninstall
    // and delete the launchers/app dir a still-bootable service points at. The
    // persisted backend record is kept — the install is still real.
    throw new ServiceLifecycleError(
      "A service could not be stopped or removed (its manager was unreachable in this session). Re-run `worktable uninstall` from a full login session before deleting anything else."
    );
  }
  clearPersistedBackend();
  return getServiceStatus();
}

function statusWith(state: ServiceState, message?: string): ServiceStatus {
  const paths = getServicePaths();
  const warnings = splitBrainWarnings();
  return {
    platform: paths.platform,
    state,
    installed: Boolean(paths.file && existsSync(paths.file)),
    startsAtLogin: false,
    serviceFile: paths.file,
    logs: { stdout: paths.stdout, stderr: paths.stderr },
    message,
    ...(warnings.length ? { warnings } : {}),
  };
}

export function getServiceStatus(message?: string): ServiceStatus {
  const paths = getServicePaths();
  if (paths.platform === "unsupported" || !paths.file)
    return statusWith("unsupported", message);
  const installed = existsSync(paths.file);
  if (!installed) return statusWith("not-installed", message);

  if (paths.platform === "launchd") {
    const result = run([
      "launchctl",
      "print",
      `gui/${process.getuid?.() ?? ""}/${SERVICE_LABEL}`,
    ]);
    return {
      ...statusWith(result.exitCode === 0 ? "running" : "stopped", message),
      installed,
      startsAtLogin: readFileSync(paths.file, "utf8").includes(
        "<key>RunAtLoad</key>\n  <true/>"
      ),
    };
  }

  if (paths.platform === "process") {
    const pid = readPid();
    // "running" requires a VERIFIED managed child — a recycled PID pointing at an
    // unrelated process reports stopped, and an unverifiable one reports unknown
    // (mirroring the systemd unreachable-manager case) rather than lying either way.
    const verdict = pid !== null && isAlive(pid) ? verifyManagedPid(pid) : null;
    const state: ServiceState =
      verdict === "ours"
        ? "running"
        : verdict === "unknown"
          ? "unknown"
          : "stopped";
    const base = statusWith(state, message);
    const warnings = [...(base.warnings ?? [])];
    if (verdict === "unknown") {
      warnings.push(
        "A process matches the service PID file but its identity can't be verified, so the service state is unknown. Check the service logs to confirm."
      );
    }
    return {
      ...base,
      installed,
      startsAtLogin: bootPersistenceEnabled(),
      ...(warnings.length ? { warnings } : {}),
    };
  }

  const result = run(["systemctl", "--user", "is-active", "worktable.service"]);
  const enabled = run([
    "systemctl",
    "--user",
    "is-enabled",
    "worktable.service",
  ]);
  const activeState = result.stdout.trim();
  // `is-active` prints the state word (active/inactive/failed/…) even on a non-zero
  // exit. EMPTY stdout means systemctl couldn't answer at all — no user manager
  // reachable in this session — which is exactly the systemctl-less case persisting
  // the systemd backend introduces. Reporting "stopped" there would be a lie about a
  // possibly-running enabled service, so surface "unknown" instead.
  const systemctlAnswered = activeState !== "";
  const state: ServiceState = !systemctlAnswered
    ? "unknown"
    : activeState === "active"
      ? "running"
      : "stopped";
  const isEnabled = enabled.stdout.trim() === "enabled";
  const base = statusWith(state, message);
  const warnings = [...(base.warnings ?? [])];
  const user = currentUser();
  if (!systemctlAnswered) {
    warnings.push(
      "Could not query systemctl --user in this session, so the service state is unknown. Run from a full user login session (or check `systemctl --user status worktable.service`) to confirm."
    );
  } else if (isEnabled && !lingerEnabled(user)) {
    // An enabled unit without lingering won't start after a reboot on a headless
    // box — report that honestly instead of the old `is-enabled`-only view that hid
    // the gap behind a truthy startsAtLogin.
    warnings.push(
      `systemd user lingering is off, so the service may not start after a reboot. Enable it (may need sudo): loginctl enable-linger ${user || "$USER"}`
    );
  }
  return {
    ...base,
    installed,
    startsAtLogin: isEnabled,
    ...(warnings.length ? { warnings } : {}),
  };
}
