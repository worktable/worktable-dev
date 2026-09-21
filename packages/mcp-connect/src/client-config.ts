import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MCP_CLIENTS, type ConnectorInstallableMcpClientId } from "@worktable/types/mcp-clients";
import { parse as parseToml } from "smol-toml";

// ============================================================
// MCP client config manipulation (shared core)
// ============================================================
//
// The one implementation of "write/read/remove the worktable MCP entry in
// client X's config" — consumed by the CLI's same-machine `worktable mcp`
// adapters AND by the remote-agent connector bundle (connect.mjs) that runs
// on machines where only Node is guaranteed. Everything here must stay
// runnable under plain Node 18+: node: imports only, no Bun globals.
//
// Hard rule carried over from the CLI adapters: preserve existing config,
// mutate ONLY the `worktable` server entry.

export interface ConnectTarget {
  /** MCP endpoint URL the client should call. */
  endpoint: string;
  /** Bearer token to embed. Omit on tokenless loopback installs. */
  token?: string;
}

// Every spawn passes an explicit env SNAPSHOT: under Bun, node:child_process
// children otherwise inherit the process's ORIGINAL environment, silently
// ignoring runtime process.env mutations (same family as the os.homedir()
// footgun) — which would let `claude`/`codex` resolve and run against the
// real user config in an env-isolated context.
function spawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

export function commandExists(command: string): boolean {
  return (
    spawnSync("sh", ["-c", `command -v ${command} >/dev/null 2>&1`], {
      env: spawnEnv(),
    }).status === 0
  );
}

// ---- JSON config files -----------------------------------------------------

export function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readJsonObjectForMutation(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON; it was left unchanged.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object; it was left unchanged.`);
  }
  return parsed as Record<string, unknown>;
}

function writeFilePrivate(path: string, contents: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  // Dotfile managers commonly make client configs symlinks. Preserve that
  // contract by writing through an existing symlink instead of replacing it.
  try {
    if (lstatSync(path).isSymbolicLink()) {
      writeFileSync(path, contents);
      chmodSync(path, mode);
      return;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const tmp = `${path}.worktable-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(tmp, contents, { flag: "wx", mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function writeJsonObject(path: string, value: Record<string, unknown>): void {
  writeFilePrivate(path, JSON.stringify(value, null, 2) + "\n");
}

export function bearerHeaders(token?: string): Record<string, string> | undefined {
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

export function readJsonUrl(path: string, parentKey: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const root = readJsonObject(path);
  const parent = root[parentKey];
  if (!parent || typeof parent !== "object") return undefined;
  const worktable = (parent as Record<string, unknown>)["worktable"];
  if (!worktable || typeof worktable !== "object") return undefined;
  const url = (worktable as Record<string, unknown>)["url"];
  return typeof url === "string" ? url : undefined;
}

/** True if the worktable entry carries a non-empty Authorization header. */
export function readJsonAuth(path: string, parentKey: string): boolean {
  if (!existsSync(path)) return false;
  const root = readJsonObject(path);
  const parent = root[parentKey];
  if (!parent || typeof parent !== "object") return false;
  const worktable = (parent as Record<string, unknown>)["worktable"];
  if (!worktable || typeof worktable !== "object") return false;
  const headers = (worktable as Record<string, unknown>)["headers"];
  if (!headers || typeof headers !== "object") return false;
  const auth = (headers as Record<string, unknown>)["Authorization"];
  return typeof auth === "string" && auth.trim().length > 0;
}

export function setupJsonUrl(path: string, parentKey: string, entry: Record<string, unknown>): void {
  // The same-machine CLI intentionally repairs malformed client JSON. The
  // remote connector is fail-closed because strict preflight and its TOCTOU
  // recheck run before this shared writer is called.
  const root = readJsonObject(path);
  const parent =
    root[parentKey] && typeof root[parentKey] === "object" ? (root[parentKey] as Record<string, unknown>) : {};
  parent["worktable"] = entry;
  root[parentKey] = parent;
  writeJsonObject(path, root);
}

export function removeJsonUrl(path: string, parentKey: string): void {
  if (!existsSync(path)) return;
  const root = readJsonObject(path);
  const parent = root[parentKey];
  if (parent && typeof parent === "object") {
    delete (parent as Record<string, unknown>)["worktable"];
  }
  writeJsonObject(path, root);
}

// ---- Per-client config locations and entry shapes ---------------------------

export function cursorPath(): string {
  return process.env["WORKTABLE_CURSOR_MCP_CONFIG"]?.trim() || join(homedir(), ".cursor", "mcp.json");
}

export function opencodePath(): string {
  return process.env["WORKTABLE_OPENCODE_CONFIG"]?.trim() || join(homedir(), ".config", "opencode", "opencode.json");
}

export function defaultVscodePath(): string {
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Code", "User", "mcp.json")
    : join(homedir(), ".config", "Code", "User", "mcp.json");
}

export function vscodePath(): string | null {
  const env = process.env["WORKTABLE_VSCODE_MCP_CONFIG"]?.trim();
  if (env) return env;
  const candidate = defaultVscodePath();
  return existsSync(candidate) ? candidate : null;
}

export function cursorEntry(endpoint: string, token?: string): Record<string, unknown> {
  return { url: endpoint, ...(token ? { headers: bearerHeaders(token) } : {}) };
}

export function opencodeEntry(endpoint: string, token?: string): Record<string, unknown> {
  return {
    type: "remote",
    url: endpoint,
    enabled: true,
    ...(token ? { headers: bearerHeaders(token) } : {}),
  };
}

export function vscodeEntry(endpoint: string, token?: string): Record<string, unknown> {
  return {
    type: "http",
    url: endpoint,
    ...(token ? { headers: bearerHeaders(token) } : {}),
  };
}

/** The JSON parent key each JSON-config client nests MCP servers under. */
export const JSON_CLIENT_PARENT_KEYS = {
  cursor: "mcpServers",
  opencode: "mcp",
  vscode: "servers",
} as const;

// ---- Codex (TOML) ------------------------------------------------------------

const CODEX_WORKTABLE_KEY_SOURCE = String.raw`mcp_servers[ \t]*\.[ \t]*(?:worktable|"worktable"|'worktable')`;
const CODEX_TABLE_HEADER_REGEX = /^[ \t]*\[[^\]\r\n]+\][ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)/gm;
const CODEX_WORKTABLE_TABLE_HEADER_REGEX = new RegExp(
  String.raw`^[ \t]*\[[ \t]*${CODEX_WORKTABLE_KEY_SOURCE}(?:[ \t]*\.[^\]\r\n]+)?[ \t]*\][ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)`
);

interface CodexTableSection {
  start: number;
  end: number;
}

function codexWorktableSections(text: string): CodexTableSection[] {
  const headers = [...text.matchAll(CODEX_TABLE_HEADER_REGEX)];
  const sections: CodexTableSection[] = [];
  for (let index = 0; index < headers.length; index++) {
    const header = headers[index]!;
    if (!CODEX_WORKTABLE_TABLE_HEADER_REGEX.test(header[0])) continue;
    sections.push({
      start: header.index,
      end: headers[index + 1]?.index ?? text.length,
    });
  }
  return sections;
}

function replaceCodexWorktableSections(text: string, replacement: string): string {
  const sections = codexWorktableSections(text);
  if (sections.length === 0) {
    return `${text.trimEnd()}${text.trim().length > 0 ? "\n\n" : ""}${replacement}`;
  }

  let cursor = 0;
  let next = "";
  sections.forEach((section, index) => {
    next += text.slice(cursor, section.start);
    if (index === 0) next += replacement;
    cursor = section.end;
  });
  next += text.slice(cursor);
  return next;
}

function parseCodexConfig(text: string): Record<string, unknown> {
  return parseToml(text) as Record<string, unknown>;
}

function codexWorktableConfig(text: string): Record<string, unknown> | undefined {
  const parsed = parseCodexConfig(text);
  const servers = parsed["mcp_servers"];
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return undefined;
  const worktable = (servers as Record<string, unknown>)["worktable"];
  if (!worktable || typeof worktable !== "object" || Array.isArray(worktable)) {
    return undefined;
  }
  return worktable as Record<string, unknown>;
}

function redactBearer(value: string): string {
  return value.replace(/Bearer[ \t]+[^\s"'\\,}\]]+/g, "Bearer <redacted>");
}

function hasCodexWorktable(path = codexPath()): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  // A recognized table family is replaceable even when its duplicate child
  // table makes the original document invalid. This is the recovery path for
  // the inline-plus-nested http_headers incident. Other TOML shapes still use
  // the parser so inline/dotted Worktable entries cannot be mistaken as absent.
  if (codexWorktableSections(text).length > 0) return true;
  return codexWorktableConfig(text) !== undefined;
}

export function codexPath(): string {
  const env = process.env["WORKTABLE_CODEX_CONFIG"]?.trim();
  if (env) return env;
  const codexHome = process.env["CODEX_HOME"]?.trim();
  if (codexHome) return join(codexHome, "config.toml");
  return join(homedir(), ".codex", "config.toml");
}

export function readCodexUrl(path = codexPath()): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const url = codexWorktableConfig(readFileSync(path, "utf8"))?.["url"];
    return typeof url === "string" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** True if the codex worktable block carries an Authorization http_header. */
export function readCodexAuth(path = codexPath()): boolean {
  if (!existsSync(path)) return false;
  try {
    const headers = codexWorktableConfig(readFileSync(path, "utf8"))?.["http_headers"];
    if (!headers || typeof headers !== "object" || Array.isArray(headers)) return false;
    const authorization = (headers as Record<string, unknown>)["Authorization"];
    return typeof authorization === "string" && authorization.trim().length > 0;
  } catch {
    return false;
  }
}

/** Return a safe parse error for status/doctor surfaces, or undefined when valid. */
export function readCodexConfigError(path = codexPath()): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    parseCodexConfig(readFileSync(path, "utf8"));
    return undefined;
  } catch (err) {
    return redactBearer((err as Error).message);
  }
}

function codexBlock(endpoint: string, token?: string): string {
  const header = token ? `http_headers = { Authorization = "Bearer ${token}" }\n` : "";
  return `[mcp_servers.worktable]\nurl = "${endpoint}"\n${header}`;
}

export function writeCodexUrl(endpoint: string, token?: string, path = codexPath()): void {
  const block = codexBlock(endpoint, token);
  if (!existsSync(path)) {
    parseCodexConfig(block);
    writeFilePrivate(path, `${block}`);
    return;
  }
  const text = readFileSync(path, "utf8");
  const sections = codexWorktableSections(text);
  if (sections.length === 0 && codexWorktableConfig(text)) {
    throw new Error(`${path} defines mcp_servers.worktable outside a replaceable TOML table; it was left unchanged.`);
  }
  const next = replaceCodexWorktableSections(text, block);
  parseCodexConfig(next);
  writeFilePrivate(path, `${next.trimEnd()}\n`);
}

export function removeCodex(path = codexPath()): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  const sections = codexWorktableSections(text);
  if (sections.length === 0) {
    if (codexWorktableConfig(text)) {
      throw new Error(`${path} defines mcp_servers.worktable outside a removable TOML table; it was left unchanged.`);
    }
    return;
  }
  const next = replaceCodexWorktableSections(text, "");
  parseCodexConfig(next);
  writeFilePrivate(path, `${next.trimEnd()}\n`);
}

/**
 * Tokenless codex setup via the codex CLI (same-machine path). The
 * `codex mcp add` CLI cannot inject an Authorization header, so tokened
 * setups must write the TOML directly instead.
 */
export function codexCliAdd(endpoint: string): boolean {
  if (!commandExists("codex")) return false;
  const result = spawnSync("codex", ["mcp", "add", "worktable", "--url", endpoint], {
    stdio: ["ignore", "pipe", "pipe"],
    env: spawnEnv(),
  });
  return result.status === 0;
}

// ---- Claude Code (CLI-managed) -------------------------------------------------

function claudeCodeCommand(): string {
  return process.env["WORKTABLE_CLAUDE_COMMAND"]?.trim() || "claude";
}

function claudeCodeAvailable(): boolean {
  const command = claudeCodeCommand();
  if (command === "claude") return commandExists(command);
  try {
    accessSync(command, constants.X_OK);
    return statSync(command).isFile();
  } catch {
    return false;
  }
}

/** Claude's user-scoped MCP config, used only for preflight and rollback. */
export function claudeCodePath(): string {
  const configDir = process.env["CLAUDE_CONFIG_DIR"]?.trim();
  return configDir ? join(configDir, ".claude.json") : join(homedir(), ".claude.json");
}

export function claudeCodeAdd(endpoint: string, token?: string): { ok: boolean; message?: string } {
  if (!claudeCodeAvailable()) {
    return { ok: false, message: "Claude Code CLI not found." };
  }
  const result = spawnSync(
    claudeCodeCommand(),
    [
      "mcp",
      "add",
      "--transport",
      "http",
      "worktable",
      // The URL must come right after the name and BEFORE --header: claude's
      // `-H, --header <header...>` is variadic and greedily swallows a trailing
      // URL, yielding "missing required argument 'commandOrUrl'". Keep --header
      // last (matches claude's own documented example).
      endpoint,
      "--scope",
      "user",
      ...(token ? ["--header", `Authorization: Bearer ${token}`] : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", env: spawnEnv() }
  );
  if (result.status === 0) return { ok: true };
  return { ok: false, message: (result.stderr ?? "").toString().trim() };
}

export function claudeCodeRemove(): void {
  if (!claudeCodeAvailable()) return;
  spawnSync(claudeCodeCommand(), ["mcp", "remove", "worktable", "--scope", "user"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: spawnEnv(),
  });
}

function claudeCodeRemoveForReplace(): { ok: boolean; message?: string } {
  if (!claudeCodeAvailable()) {
    return { ok: false, message: "Claude Code CLI not found." };
  }
  const result = spawnSync(claudeCodeCommand(), ["mcp", "remove", "worktable", "--scope", "user"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: spawnEnv(),
  });
  if (result.status === 0) return { ok: true };
  return { ok: false, message: (result.stderr ?? "").toString().trim() };
}

function claudeCodeScopePreflight(): {
  ok: boolean;
  shadowed: boolean;
  message?: string;
} {
  const result = spawnSync(claudeCodeCommand(), ["mcp", "get", "worktable"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: spawnEnv(),
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  if (result.status === 0) {
    if (/^\s*Scope:\s*User\b/im.test(output)) {
      return { ok: true, shadowed: false };
    }
    if (/^\s*Scope:\s*(?:Local|Project)\b/im.test(output)) {
      return {
        ok: true,
        shadowed: true,
        message:
          "Claude Code has a higher-priority local or project Worktable server. " +
          "Remove that scoped entry before configuring the user connection.",
      };
    }
    return {
      ok: false,
      shadowed: false,
      message: "Could not determine the scope of Claude Code's existing Worktable server.",
    };
  }
  if (/No MCP server named ["']?worktable/i.test(output)) {
    return { ok: true, shadowed: false };
  }
  return {
    ok: false,
    shadowed: false,
    message: output || "Could not inspect Claude Code MCP scopes.",
  };
}

// ---- Connector transaction surface -------------------------------------------

export interface ClientConfigSnapshot {
  id: ConnectorInstallableMcpClientId;
  configPath: string;
  existed: boolean;
  contents?: Buffer;
  mode?: number;
  symlinkTarget?: string;
  mutationCaptured?: boolean;
  postMutation?: {
    existed: boolean;
    contents?: Buffer;
    mode?: number;
    symlinkTarget?: string;
  };
}

export interface PreflightOutcome {
  id: ConnectorInstallableMcpClientId;
  ok: boolean;
  configPath: string | null;
  existing: boolean;
  snapshot?: ClientConfigSnapshot;
  message?: string;
}

export interface RestoreOutcome {
  id: ConnectorInstallableMcpClientId;
  ok: boolean;
  message?: string;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function ensureWritableTarget(path: string): void {
  if (pathEntryExists(path)) {
    const link = lstatSync(path);
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error(`${path} is not a regular file.`);
    accessSync(path, constants.R_OK | constants.W_OK);
    // Regular files are replaced through an adjacent temp+rename, which
    // requires directory write and traversal permission. Existing symlinks
    // are deliberately written through to preserve dotfile-manager links.
    if (!link.isSymbolicLink()) {
      accessSync(dirname(path), constants.W_OK | constants.X_OK);
    }
    return;
  }

  let parent = dirname(path);
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const stat = statSync(parent);
  if (!stat.isDirectory()) {
    throw new Error(`${parent} is not a directory.`);
  }
  accessSync(parent, constants.W_OK | constants.X_OK);
}

function snapshotClientConfig(id: ConnectorInstallableMcpClientId, configPath: string): ClientConfigSnapshot {
  if (!pathEntryExists(configPath)) return { id, configPath, existed: false };
  const link = lstatSync(configPath);
  const stat = statSync(configPath);
  return {
    id,
    configPath,
    existed: true,
    contents: readFileSync(configPath),
    mode: stat.mode & 0o777,
    ...(link.isSymbolicLink() ? { symlinkTarget: readlinkSync(configPath) } : {}),
  };
}

function currentConfigState(configPath: string): NonNullable<ClientConfigSnapshot["postMutation"]> {
  if (!pathEntryExists(configPath)) return { existed: false };
  const link = lstatSync(configPath);
  const stat = statSync(configPath);
  if (!stat.isFile()) throw new Error(`${configPath} is not a regular file.`);
  return {
    existed: true,
    contents: readFileSync(configPath),
    mode: stat.mode & 0o777,
    ...(link.isSymbolicLink() ? { symlinkTarget: readlinkSync(configPath) } : {}),
  };
}

function configStatesEqual(
  left: NonNullable<ClientConfigSnapshot["postMutation"]>,
  right: NonNullable<ClientConfigSnapshot["postMutation"]>
): boolean {
  return (
    left.existed === right.existed &&
    left.mode === right.mode &&
    left.symlinkTarget === right.symlinkTarget &&
    (left.contents === undefined
      ? right.contents === undefined
      : right.contents !== undefined && left.contents.equals(right.contents))
  );
}

function snapshotInitialState(snapshot: ClientConfigSnapshot): NonNullable<ClientConfigSnapshot["postMutation"]> {
  return {
    existed: snapshot.existed,
    ...(snapshot.contents ? { contents: snapshot.contents } : {}),
    ...(snapshot.mode !== undefined ? { mode: snapshot.mode } : {}),
    ...(snapshot.symlinkTarget ? { symlinkTarget: snapshot.symlinkTarget } : {}),
  };
}

/** Recheck the preflight snapshot immediately before mutation (TOCTOU guard). */
export function validateClientConfigSnapshot(snapshot: ClientConfigSnapshot): RestoreOutcome {
  try {
    if (!configStatesEqual(currentConfigState(snapshot.configPath), snapshotInitialState(snapshot))) {
      throw new Error(`${snapshot.configPath} changed after preflight; rerun the command against the current config`);
    }
    return { id: snapshot.id, ok: true };
  } catch (err) {
    return { id: snapshot.id, ok: false, message: (err as Error).message };
  }
}

/** Capture exactly what this transaction wrote so rollback cannot clobber a later edit. */
export function captureClientConfigMutation(snapshot: ClientConfigSnapshot): RestoreOutcome {
  try {
    snapshot.postMutation = currentConfigState(snapshot.configPath);
    snapshot.mutationCaptured = true;
    return { id: snapshot.id, ok: true };
  } catch (err) {
    snapshot.mutationCaptured = false;
    return { id: snapshot.id, ok: false, message: (err as Error).message };
  }
}

function configSurface(id: ConnectorInstallableMcpClientId): {
  path: string;
  kind: "codex" | "json";
  parentKey?: string;
} | null {
  switch (id) {
    case "claude-code":
      return { path: claudeCodePath(), kind: "json", parentKey: "mcpServers" };
    case "codex":
      return { path: codexPath(), kind: "codex" };
    case "cursor":
      return { path: cursorPath(), kind: "json", parentKey: "mcpServers" };
    case "opencode":
      return { path: opencodePath(), kind: "json", parentKey: "mcp" };
    case "vscode":
      return {
        path: vscodePath() ?? defaultVscodePath(),
        kind: "json",
        parentKey: "servers",
      };
  }
}

/**
 * Prove a connector mutation is viable and snapshot its rollback point before
 * the one-use pairing code is redeemed. Existing Worktable entries require an
 * explicit --replace so an automatic multi-client run cannot overwrite them.
 */
export function preflightClient(id: ConnectorInstallableMcpClientId, options: { replace: boolean }): PreflightOutcome {
  const surface = configSurface(id);
  if (!surface) {
    return {
      id,
      ok: false,
      configPath: null,
      existing: false,
      message: "This client has no writable automatic config surface.",
    };
  }
  if (id === "claude-code" && !claudeCodeAvailable()) {
    return {
      id,
      ok: false,
      configPath: surface.path,
      existing: false,
      message: "Claude Code CLI not found.",
    };
  }

  try {
    ensureWritableTarget(surface.path);
    let existing = false;
    if (surface.kind === "codex" && existsSync(surface.path)) {
      existing = hasCodexWorktable(surface.path);
    } else if (surface.kind === "json" && existsSync(surface.path)) {
      const root = readJsonObjectForMutation(surface.path);
      const parent = root[surface.parentKey!];
      if (parent !== undefined && (!parent || typeof parent !== "object" || Array.isArray(parent))) {
        throw new Error(`${surface.path} has a non-object ${surface.parentKey} value; it was left unchanged.`);
      }
      existing = Boolean(parent && hasOwn(parent as Record<string, unknown>, "worktable"));
    }

    if (id === "claude-code") {
      const scoped = claudeCodeScopePreflight();
      if (!scoped.ok) throw new Error(scoped.message);
      if (scoped.shadowed) {
        return {
          id,
          ok: false,
          configPath: surface.path,
          existing: true,
          message: scoped.message,
        };
      }
    }

    if (existing && !options.replace) {
      return {
        id,
        ok: false,
        configPath: surface.path,
        existing: true,
        message:
          `${MCP_CLIENTS[id].label} already has a Worktable MCP server. ` +
          "Rerun this same command with --replace to replace it intentionally.",
      };
    }
    return {
      id,
      ok: true,
      configPath: surface.path,
      existing,
      snapshot: snapshotClientConfig(id, surface.path),
    };
  } catch (err) {
    return {
      id,
      ok: false,
      configPath: surface.path,
      existing: false,
      message: redactBearer((err as Error).message),
    };
  }
}

/** Restore the exact pre-connector bytes (or remove a newly created config). */
export function restoreClientConfig(snapshot: ClientConfigSnapshot): RestoreOutcome {
  try {
    if (!snapshot.mutationCaptured || !snapshot.postMutation) {
      throw new Error("the connector could not capture a safe rollback point");
    }
    const current = currentConfigState(snapshot.configPath);
    if (!configStatesEqual(current, snapshot.postMutation)) {
      throw new Error(
        `${snapshot.configPath} changed again after Worktable wrote it; refusing to overwrite the newer edit`
      );
    }

    if (!snapshot.existed) {
      rmSync(snapshot.configPath, { force: true });
      return { id: snapshot.id, ok: true };
    }

    if (snapshot.symlinkTarget) {
      let sameLink = false;
      try {
        sameLink =
          lstatSync(snapshot.configPath).isSymbolicLink() &&
          readlinkSync(snapshot.configPath) === snapshot.symlinkTarget;
      } catch {
        // Restore the original link below.
      }
      if (!sameLink) {
        rmSync(snapshot.configPath, { recursive: true, force: true });
        mkdirSync(dirname(snapshot.configPath), {
          recursive: true,
          mode: 0o700,
        });
        symlinkSync(snapshot.symlinkTarget, snapshot.configPath);
      }
    }
    writeFilePrivate(snapshot.configPath, snapshot.contents!, snapshot.mode ?? 0o600);
    return { id: snapshot.id, ok: true };
  } catch (err) {
    return { id: snapshot.id, ok: false, message: (err as Error).message };
  }
}

// ---- Connector-facing install surface -----------------------------------------

export interface InstallOutcome {
  id: ConnectorInstallableMcpClientId;
  ok: boolean;
  /** File the entry was written to; null for CLI-managed clients. */
  configPath: string | null;
  message?: string;
  /** Shown to the user after install (e.g. "restart Cursor"). */
  restartHint?: string;
}

/** Is this client present on THIS machine (weak signal: CLI or config file). */
export function detectClient(id: ConnectorInstallableMcpClientId): boolean {
  switch (id) {
    case "claude-code":
      return claudeCodeAvailable();
    case "codex":
      return commandExists("codex") || existsSync(codexPath());
    case "cursor":
      return existsSync(cursorPath()) || existsSync(join(homedir(), ".cursor"));
    case "opencode":
      return commandExists("opencode") || existsSync(opencodePath());
    case "vscode":
      return vscodePath() !== null || commandExists("code");
  }
}

/**
 * Write the worktable MCP entry for one connector-installable client.
 * Never throws: a failed write (unwritable path, parent-is-a-file, ...) is a
 * failed outcome, so the connector can report it and continue with the rest.
 */
export function installClient(
  id: ConnectorInstallableMcpClientId,
  target: ConnectTarget,
  options: { replace?: boolean; existing?: boolean } = {}
): InstallOutcome {
  try {
    return installClientUnsafe(id, target, options);
  } catch (err) {
    return {
      id,
      ok: false,
      configPath: null,
      message: redactBearer((err as Error).message),
    };
  }
}

function installClientUnsafe(
  id: ConnectorInstallableMcpClientId,
  target: ConnectTarget,
  options: { replace?: boolean; existing?: boolean }
): InstallOutcome {
  switch (id) {
    case "claude-code": {
      if (options.replace && options.existing) {
        const removed = claudeCodeRemoveForReplace();
        if (!removed.ok) {
          return {
            id,
            ok: false,
            configPath: claudeCodePath(),
            message: removed.message ?? "Could not remove the existing Worktable server.",
          };
        }
      }
      const result = claudeCodeAdd(target.endpoint, target.token);
      return {
        id,
        ok: result.ok,
        configPath: claudeCodePath(),
        ...(result.message ? { message: result.message } : {}),
      };
    }
    case "codex": {
      writeCodexUrl(target.endpoint, target.token);
      return {
        id,
        ok: true,
        configPath: codexPath(),
        restartHint: "Restart Codex sessions to pick up the new server.",
      };
    }
    case "cursor": {
      setupJsonUrl(cursorPath(), "mcpServers", cursorEntry(target.endpoint, target.token));
      return {
        id,
        ok: true,
        configPath: cursorPath(),
        restartHint: "Restart Cursor to pick up the new server.",
      };
    }
    case "opencode": {
      setupJsonUrl(opencodePath(), "mcp", opencodeEntry(target.endpoint, target.token));
      return { id, ok: true, configPath: opencodePath() };
    }
    case "vscode": {
      const path = vscodePath() ?? defaultVscodePath();
      setupJsonUrl(path, "servers", vscodeEntry(target.endpoint, target.token));
      return {
        id,
        ok: true,
        configPath: path,
        restartHint: "Reload VS Code windows to pick up the new server.",
      };
    }
  }
}
