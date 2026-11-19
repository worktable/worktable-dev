import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
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
import {
  MCP_CLIENTS,
  SERVER_LISTS,
  type ConnectorInstallableMcpClientId,
} from "@worktable/types/mcp-clients";
// The ES module build: bundlers keep the UMD one's runtime require() calls,
// which the single-file connector can't resolve.
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser/lib/esm/main.js";
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
//
// Client configs are read as JSON with comments and trailing commas, which
// Zed, Kilo and VS Code write, and edited in place so the rest of the file,
// comments included, stays as it was.

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The file's value, or undefined when it isn't JSON (with comments). */
function parseJsonText(text: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  return errors.length > 0 || text.trim() === "" ? undefined : value;
}

export function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = parseJsonText(readFileSync(path, "utf8"));
  return isObject(parsed) ? parsed : {};
}

function readJsonObjectForMutation(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed = parseJsonText(readFileSync(path, "utf8"));
  if (parsed === undefined) {
    throw new Error(`${path} is not valid JSON; it was left unchanged.`);
  }
  if (!isObject(parsed)) {
    throw new Error(`${path} must contain a JSON object; it was left unchanged.`);
  }
  return parsed;
}

/**
 * The file's text with only what changed between `before` and `after`
 * edited, so its comments and layout stay where the person put them.
 */
function editJsonText(
  text: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  path: string[] = []
): string {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[key];
    const now = after[key];
    if (isObject(was) && isObject(now)) {
      text = editJsonText(text, was, now, [...path, key]);
    } else if (JSON.stringify(was) !== JSON.stringify(now)) {
      text = applyEdits(
        text,
        modify(text, [...path, key], now, {
          formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
        })
      );
    }
  }
  return text;
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
  const text = existsSync(path) ? readFileSync(path, "utf8") : null;
  const before = text === null ? undefined : parseJsonText(text);
  writeFilePrivate(
    path,
    text !== null && isObject(before)
      ? editJsonText(text, before, value)
      : JSON.stringify(value, null, 2) + "\n"
  );
}

export function bearerHeaders(token?: string): Record<string, string> | undefined {
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

/**
 * Where a JSON client keeps its servers, as key paths from the file's root:
 * where Worktable writes first, then older places the client still reads,
 * which a write moves the entry out of.
 */
export type JsonEntryPlaces = readonly (readonly string[])[];

function objectAt(root: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> | undefined {
  let node: unknown = root;
  for (const key of keys) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node && typeof node === "object" && !Array.isArray(node) ? (node as Record<string, unknown>) : undefined;
}

/** The worktable entry, from the first place that has one. */
function jsonEntry(root: Record<string, unknown>, places: JsonEntryPlaces): Record<string, unknown> | undefined {
  for (const keys of places) {
    const entry = objectAt(root, keys)?.["worktable"];
    if (entry && typeof entry === "object" && !Array.isArray(entry)) return entry as Record<string, unknown>;
  }
  return undefined;
}

export function readJsonUrl(path: string, places: JsonEntryPlaces): string | undefined {
  if (!existsSync(path)) return undefined;
  const entry = jsonEntry(readJsonObject(path), places);
  // Antigravity's own key is serverUrl.
  const url = entry?.["url"] ?? entry?.["serverUrl"];
  return typeof url === "string" ? url : undefined;
}

/** True if the worktable entry carries a non-empty Authorization header. */
export function readJsonAuth(path: string, places: JsonEntryPlaces): boolean {
  if (!existsSync(path)) return false;
  const headers = jsonEntry(readJsonObject(path), places)?.["headers"];
  if (!headers || typeof headers !== "object") return false;
  const auth = (headers as Record<string, unknown>)["Authorization"];
  return typeof auth === "string" && auth.trim().length > 0;
}

function removeEntries(root: Record<string, unknown>, places: JsonEntryPlaces): void {
  for (const keys of places) {
    const parent = objectAt(root, keys);
    if (parent) delete parent["worktable"];
  }
}

const JSON_FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };

/** The file's text when it holds a JSON object, so it can be edited in place. */
function editableJsonText(path: string): string | null {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  return isObject(parseJsonText(text)) ? text : null;
}

/** Removes the worktable entries from the text, keeping everything else. */
function withoutEntries(text: string, places: JsonEntryPlaces): string {
  let edited = text;
  for (const keys of places) {
    const parent = objectAt(parseJsonText(edited) as Record<string, unknown>, keys);
    if (parent && hasOwn(parent, "worktable"))
      edited = applyEdits(edited, modify(edited, [...keys, "worktable"], undefined, JSON_FORMAT));
  }
  return edited;
}

export function setupJsonUrl(path: string, places: JsonEntryPlaces, entry: Record<string, unknown>): void {
  // The same-machine CLI intentionally repairs malformed client JSON. The
  // remote connector is fail-closed because strict preflight and its TOCTOU
  // recheck run before this shared writer is called.
  const text = editableJsonText(path);
  if (text === null) {
    const root: Record<string, unknown> = {};
    let parent = root;
    for (const key of places[0]!) parent = (parent[key] = {}) as Record<string, unknown>;
    parent["worktable"] = entry;
    writeJsonObject(path, root);
    return;
  }
  // The entry in the first place is replaced where it stands; older places lose theirs.
  let edited = withoutEntries(text, places.slice(1));
  // A list that holds something other than an object becomes an empty one.
  const keys = places[0]!;
  for (let depth = 1; depth <= keys.length; depth++) {
    let node: unknown = parseJsonText(edited);
    for (const key of keys.slice(0, depth)) node = isObject(node) ? node[key] : undefined;
    if (node !== undefined && !isObject(node))
      edited = applyEdits(edited, modify(edited, keys.slice(0, depth), {}, JSON_FORMAT));
  }
  edited = applyEdits(edited, modify(edited, [...keys, "worktable"], entry, JSON_FORMAT));
  writeFilePrivate(path, edited.endsWith("\n") ? edited : `${edited}\n`);
}

export function removeJsonUrl(path: string, places: JsonEntryPlaces): void {
  if (!existsSync(path)) return;
  const text = editableJsonText(path);
  if (text === null) {
    const root = readJsonObject(path);
    removeEntries(root, places);
    writeJsonObject(path, root);
    return;
  }
  writeFilePrivate(path, withoutEntries(text, places));
}

// ---- Per-client config locations and entry shapes ---------------------------

/**
 * Every variable, besides HOME and XDG_CONFIG_HOME, that moves where the
 * paths below find a client's servers or where its skills are copied. An
 * isolated run clears them all; add a client's own here with its path.
 */
export const CLIENT_CONFIG_ENV_KEYS = [
  "WORKTABLE_CODEX_CONFIG",
  "WORKTABLE_CURSOR_MCP_CONFIG",
  "WORKTABLE_OPENCODE_CONFIG",
  "WORKTABLE_KILO_CONFIG",
  "WORKTABLE_VSCODE_MCP_CONFIG",
  "WORKTABLE_COPILOT_MCP_CONFIG",
  "WORKTABLE_ANTIGRAVITY_MCP_CONFIG",
  "WORKTABLE_DEVIN_MCP_CONFIG",
  "WORKTABLE_JUNIE_MCP_CONFIG",
  "WORKTABLE_ZED_SETTINGS",
  "WORKTABLE_CLINE_MCP_CONFIG",
  "WORKTABLE_WARP_MCP_CONFIG",
  "WORKTABLE_PI_MCP_CONFIG",
  "WORKTABLE_DROID_MCP_CONFIG",
  "WORKTABLE_AMP_SETTINGS",
  "WORKTABLE_KIRO_MCP_CONFIG",
  "WORKTABLE_SKILL_HOME",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "COPILOT_HOME",
  "JUNIE_HOME",
  "CLINE_MCP_SETTINGS_PATH",
  "CLINE_DATA_DIR",
  "CLINE_DIR",
  "PI_CODING_AGENT_DIR",
] as const;

export function cursorPath(): string {
  return process.env["WORKTABLE_CURSOR_MCP_CONFIG"]?.trim() || join(homedir(), ".cursor", "mcp.json");
}

/** Where XDG apps such as OpenCode and Kilo keep their settings. */
function xdgConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
  return xdg || join(homedir(), ".config");
}

export function opencodePath(): string {
  return process.env["WORKTABLE_OPENCODE_CONFIG"]?.trim() || join(xdgConfigDir(), "opencode", "opencode.json");
}

/** Kilo's own file is kilo.jsonc; one who keeps kilo.json keeps it. */
export function kiloPath(): string {
  const explicit = process.env["WORKTABLE_KILO_CONFIG"]?.trim();
  if (explicit) return explicit;
  const dir = join(xdgConfigDir(), "kilo");
  const json = join(dir, "kilo.json");
  const jsonc = join(dir, "kilo.jsonc");
  return existsSync(json) && !existsSync(jsonc) ? json : jsonc;
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

/** Copilot CLI's own servers; COPILOT_HOME moves its whole folder. */
export function copilotPath(): string {
  const explicit = process.env["WORKTABLE_COPILOT_MCP_CONFIG"]?.trim();
  if (explicit) return explicit;
  const home = process.env["COPILOT_HOME"]?.trim();
  return join(home || join(homedir(), ".copilot"), "mcp-config.json");
}

/** Antigravity's global servers, which its app and agy CLI share. */
export function antigravityPath(): string {
  return (
    process.env["WORKTABLE_ANTIGRAVITY_MCP_CONFIG"]?.trim() || join(homedir(), ".gemini", "config", "mcp_config.json")
  );
}

/**
 * Devin's user servers, which Devin Desktop and Devin CLI share. On Windows
 * Devin keeps them in %APPDATA%; elsewhere under XDG_CONFIG_HOME or ~/.config.
 */
export function devinPath(): string {
  const explicit = process.env["WORKTABLE_DEVIN_MCP_CONFIG"]?.trim();
  if (explicit) return explicit;
  const appData = process.env["APPDATA"]?.trim();
  const base = process.platform === "win32" && appData ? appData : xdgConfigDir();
  return join(base, "devin", "mcp_config.json");
}

/** Junie's user servers, shared by Junie CLI and Junie in JetBrains IDEs. JUNIE_HOME moves its folder. */
export function juniePath(): string {
  const explicit = process.env["WORKTABLE_JUNIE_MCP_CONFIG"]?.trim();
  if (explicit) return explicit;
  const home = process.env["JUNIE_HOME"]?.trim();
  return join(home || join(homedir(), ".junie"), "mcp", "mcp.json");
}

/** Zed's settings, which hold its servers among everything else. */
export function zedPath(): string {
  const explicit = process.env["WORKTABLE_ZED_SETTINGS"]?.trim();
  if (explicit) return explicit;
  const appData = process.env["APPDATA"]?.trim();
  if (process.platform === "win32" && appData) return join(appData, "Zed", "settings.json");
  return join(xdgConfigDir(), "zed", "settings.json");
}

/**
 * The servers Cline CLI and Cline in editors share. Cline moves the file with
 * CLINE_MCP_SETTINGS_PATH, its data folder with CLINE_DATA_DIR, and its whole
 * folder with CLINE_DIR.
 */
export function clinePath(): string {
  const explicit =
    process.env["WORKTABLE_CLINE_MCP_CONFIG"]?.trim() || process.env["CLINE_MCP_SETTINGS_PATH"]?.trim();
  if (explicit) return explicit;
  const data =
    process.env["CLINE_DATA_DIR"]?.trim() || join(process.env["CLINE_DIR"]?.trim() || join(homedir(), ".cline"), "data");
  return join(data, "settings", "cline_mcp_settings.json");
}

/** Warp's own global servers. */
export function warpPath(): string {
  return process.env["WORKTABLE_WARP_MCP_CONFIG"]?.trim() || join(homedir(), ".warp", ".mcp.json");
}

/** Pi's user servers; PI_CODING_AGENT_DIR moves its folder. */
export function piPath(): string {
  const explicit = process.env["WORKTABLE_PI_MCP_CONFIG"]?.trim();
  if (explicit) return explicit;
  return join(process.env["PI_CODING_AGENT_DIR"]?.trim() || join(homedir(), ".pi", "agent"), "mcp.json");
}

/** Factory Droid's personal servers. */
export function droidPath(): string {
  return process.env["WORKTABLE_DROID_MCP_CONFIG"]?.trim() || join(homedir(), ".factory", "mcp.json");
}

/** Amp's user settings, which hold its servers among everything else. */
export function ampPath(): string {
  return process.env["WORKTABLE_AMP_SETTINGS"]?.trim() || join(xdgConfigDir(), "amp", "settings.json");
}

/** The servers Kiro IDE and kiro-cli share. */
export function kiroPath(): string {
  return process.env["WORKTABLE_KIRO_MCP_CONFIG"]?.trim() || join(homedir(), ".kiro", "settings", "mcp.json");
}

type ListedClient = keyof typeof SERVER_LISTS;

/** A server entry for a client in SERVER_LISTS: its address and the bearer. */
export function listedEntry(id: ListedClient, endpoint: string, token?: string): Record<string, unknown> {
  return { ...SERVER_LISTS[id].extra, url: endpoint, ...(token ? { headers: bearerHeaders(token) } : {}) };
}

export function cursorEntry(endpoint: string, token?: string): Record<string, unknown> {
  return { url: endpoint, ...(token ? { headers: bearerHeaders(token) } : {}) };
}

/**
 * OpenCode and Kilo list servers under `mcp.servers`; OpenCode 2 ignores one
 * directly under `mcp` and rejects keys such as `enabled` there.
 */
export function opencodeEntry(endpoint: string, token?: string): Record<string, unknown> {
  return {
    type: "remote",
    url: endpoint,
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

/** `tools` is what `copilot mcp add` writes: every tool, as Copilot asks. */
export function copilotEntry(endpoint: string, token?: string): Record<string, unknown> {
  return {
    type: "http",
    url: endpoint,
    ...(token ? { headers: bearerHeaders(token) } : {}),
    tools: ["*"],
  };
}

export function antigravityEntry(endpoint: string, token?: string): Record<string, unknown> {
  return { serverUrl: endpoint, ...(token ? { headers: bearerHeaders(token) } : {}) };
}

/** What `devin mcp add --scope user` writes. */
export function devinEntry(endpoint: string, token?: string): Record<string, unknown> {
  return { url: endpoint, transport: "http", ...(token ? { headers: bearerHeaders(token) } : {}) };
}

export function junieEntry(endpoint: string, token?: string): Record<string, unknown> {
  return { url: endpoint, ...(token ? { headers: bearerHeaders(token) } : {}) };
}

/** Where each JSON-config client keeps its servers. */
export const JSON_CLIENT_ENTRY_PLACES = {
  cursor: [["mcpServers"]],
  // Earlier Worktable versions wrote the entry directly under `mcp`.
  opencode: [["mcp", "servers"], ["mcp"]],
  kilo: [["mcp", "servers"], ["mcp"]],
  vscode: [["servers"]],
  copilot: [["mcpServers"]],
  antigravity: [["mcpServers"]],
  devin: [["mcpServers"]],
  junie: [["mcpServers"]],
  zed: [[SERVER_LISTS.zed.key]],
  cline: [[SERVER_LISTS.cline.key]],
  warp: [[SERVER_LISTS.warp.key]],
  pi: [[SERVER_LISTS.pi.key]],
  droid: [[SERVER_LISTS.droid.key]],
  amp: [[SERVER_LISTS.amp.key]],
  kiro: [[SERVER_LISTS.kiro.key]],
} as const satisfies Record<string, JsonEntryPlaces>;

export const LISTED_PATHS: Record<ListedClient, () => string> = {
  zed: zedPath,
  cline: clinePath,
  warp: warpPath,
  pi: piPath,
  droid: droidPath,
  amp: ampPath,
  kiro: kiroPath,
};

/** How to load the new server in each of these clients. */
const LISTED_RESTART_HINTS: Record<ListedClient, string> = {
  zed: "Start a new Zed agent thread to load Worktable.",
  cline: "Start a new Cline task to load Worktable.",
  warp: "Start a new Warp agent conversation to load Worktable.",
  pi: "Start a new Pi session, or run /reload, to load Worktable.",
  droid: "Start a new Droid session to load Worktable.",
  amp: "Start a new Amp thread to load Worktable.",
  kiro: "Start a new Kiro chat to load Worktable.",
};

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

export function claudeCodeCommand(): string {
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
  /** The client already has exactly this tokenless entry; nothing to write. */
  unchanged?: boolean;
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

interface ConfigSurface {
  path: string;
  kind: "codex" | "json";
  places?: JsonEntryPlaces;
}

function configSurface(id: ConnectorInstallableMcpClientId): ConfigSurface | null {
  switch (id) {
    case "claude-code":
      return { path: claudeCodePath(), kind: "json", places: [["mcpServers"]] };
    case "codex":
      return { path: codexPath(), kind: "codex" };
    case "cursor":
      return { path: cursorPath(), kind: "json", places: JSON_CLIENT_ENTRY_PLACES.cursor };
    case "opencode":
      return { path: opencodePath(), kind: "json", places: JSON_CLIENT_ENTRY_PLACES.opencode };
    case "kilo":
      return { path: kiloPath(), kind: "json", places: JSON_CLIENT_ENTRY_PLACES.kilo };
    case "vscode":
      return {
        path: vscodePath() ?? defaultVscodePath(),
        kind: "json",
        places: JSON_CLIENT_ENTRY_PLACES.vscode,
      };
    case "copilot":
      return { path: copilotPath(), kind: "json", places: JSON_CLIENT_ENTRY_PLACES.copilot };
    case "antigravity":
      return { path: antigravityPath(), kind: "json", places: JSON_CLIENT_ENTRY_PLACES.antigravity };
    case "devin":
      return { path: devinPath(), kind: "json", places: JSON_CLIENT_ENTRY_PLACES.devin };
    case "junie":
      return { path: juniePath(), kind: "json", places: JSON_CLIENT_ENTRY_PLACES.junie };
    case "zed":
    case "cline":
    case "warp":
    case "pi":
    case "droid":
    case "amp":
    case "kiro":
      return { path: LISTED_PATHS[id](), kind: "json", places: JSON_CLIENT_ENTRY_PLACES[id] };
  }
}

function configuredUrl(surface: ConfigSurface): string | undefined {
  return surface.kind === "codex" ? readCodexUrl(surface.path) : readJsonUrl(surface.path, surface.places!);
}

/** The entry the connector writes for a tokenless target. */
function tokenlessEntry(id: ConnectorInstallableMcpClientId, endpoint: string): Record<string, unknown> {
  switch (id) {
    case "claude-code":
      return { type: "http", url: endpoint };
    case "codex":
      return { url: endpoint };
    case "cursor":
      return cursorEntry(endpoint);
    case "opencode":
    case "kilo":
      return opencodeEntry(endpoint);
    case "vscode":
      return vscodeEntry(endpoint);
    case "copilot":
      return copilotEntry(endpoint);
    case "antigravity":
      return antigravityEntry(endpoint);
    case "devin":
      return devinEntry(endpoint);
    case "junie":
      return junieEntry(endpoint);
    case "zed":
    case "cline":
    case "warp":
    case "pi":
    case "droid":
    case "amp":
    case "kiro":
      return listedEntry(id, endpoint);
  }
}

function storedEntry(surface: ConfigSurface): unknown {
  if (surface.kind === "codex") {
    try {
      return codexWorktableConfig(readFileSync(surface.path, "utf8"));
    } catch {
      return undefined;
    }
  }
  return jsonEntry(readJsonObject(surface.path), surface.places!);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) =>
      sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])
    )
  );
}

/**
 * Prove a connector mutation is viable and snapshot its rollback point before
 * the one-use pairing code is redeemed. Existing Worktable entries require an
 * explicit --replace so an automatic multi-client run cannot overwrite them.
 */
export function preflightClient(
  id: ConnectorInstallableMcpClientId,
  options: { replace: boolean; target?: ConnectTarget }
): PreflightOutcome {
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
      for (const keys of surface.places!) {
        let node: unknown = root;
        for (const [depth, key] of keys.entries()) {
          node = (node as Record<string, unknown>)[key];
          if (node === undefined) break;
          if (!node || typeof node !== "object" || Array.isArray(node)) {
            throw new Error(
              `${surface.path} has a non-object ${keys.slice(0, depth + 1).join(".")} value; it was left unchanged.`
            );
          }
        }
        if (node && hasOwn(node as Record<string, unknown>, "worktable")) existing = true;
      }
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

    // Running the same tokenless command again finds exactly the entry it
    // writes: that is already done, not a conflict. --replace still rewrites.
    if (
      existing &&
      !options.replace &&
      options.target &&
      !options.target.token &&
      sameValue(storedEntry(surface), tokenlessEntry(id, options.target.endpoint))
    ) {
      return { id, ok: true, configPath: surface.path, existing: true, unchanged: true };
    }
    const currentUrl = existing ? configuredUrl(surface) : undefined;
    if (existing && !options.replace) {
      return {
        id,
        ok: false,
        configPath: surface.path,
        existing: true,
        message:
          `${MCP_CLIENTS[id].label} already connects to ${currentUrl ? `Worktable at ${currentUrl}` : "a Worktable"}. ` +
          "To connect it here instead, rerun this same command with --replace.",
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
    case "kilo":
      return commandExists("kilo") || existsSync(dirname(kiloPath()));
    case "vscode":
      return vscodePath() !== null || commandExists("code");
    case "copilot":
      return commandExists("copilot") || existsSync(copilotPath());
    case "antigravity":
      return commandExists("agy") || existsSync(dirname(antigravityPath()));
    case "devin":
      return commandExists("devin") || existsSync(dirname(devinPath()));
    case "junie":
      return commandExists("junie") || existsSync(dirname(dirname(juniePath())));
    case "zed":
      return commandExists("zed") || commandExists("zeditor") || existsSync(dirname(zedPath()));
    case "cline":
      // Its folder or data folder, wherever CLINE_DIR or CLINE_DATA_DIR moved them.
      return (
        commandExists("cline") ||
        existsSync(join(homedir(), ".cline")) ||
        Boolean(process.env["CLINE_DIR"]?.trim() && existsSync(process.env["CLINE_DIR"].trim())) ||
        existsSync(dirname(dirname(clinePath())))
      );
    // Warp has no command of its own; its folder appears once it runs.
    case "warp":
      return existsSync(dirname(warpPath()));
    // `pi` is a common name, so only Pi's own folder counts.
    case "pi":
      return existsSync(dirname(piPath()));
    case "droid":
      return commandExists("droid") || existsSync(dirname(droidPath()));
    case "amp":
      return commandExists("amp") || existsSync(dirname(ampPath()));
    case "kiro":
      return commandExists("kiro-cli") || existsSync(dirname(dirname(kiroPath())));
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
      setupJsonUrl(cursorPath(), JSON_CLIENT_ENTRY_PLACES.cursor, cursorEntry(target.endpoint, target.token));
      return {
        id,
        ok: true,
        configPath: cursorPath(),
        restartHint: "Restart Cursor to pick up the new server.",
      };
    }
    case "opencode": {
      setupJsonUrl(opencodePath(), JSON_CLIENT_ENTRY_PLACES.opencode, opencodeEntry(target.endpoint, target.token));
      return { id, ok: true, configPath: opencodePath(), restartHint: "Restart OpenCode to load Worktable." };
    }
    case "kilo": {
      const path = kiloPath();
      setupJsonUrl(path, JSON_CLIENT_ENTRY_PLACES.kilo, opencodeEntry(target.endpoint, target.token));
      return { id, ok: true, configPath: path, restartHint: "Run /reload in Kilo, or start a new session, to load Worktable." };
    }
    case "vscode": {
      const path = vscodePath() ?? defaultVscodePath();
      setupJsonUrl(path, JSON_CLIENT_ENTRY_PLACES.vscode, vscodeEntry(target.endpoint, target.token));
      return {
        id,
        ok: true,
        configPath: path,
        restartHint: "Reload VS Code windows to pick up the new server.",
      };
    }
    case "copilot": {
      const path = copilotPath();
      setupJsonUrl(path, JSON_CLIENT_ENTRY_PLACES.copilot, copilotEntry(target.endpoint, target.token));
      return { id, ok: true, configPath: path, restartHint: "Start a new Copilot CLI session to load Worktable." };
    }
    case "antigravity": {
      const path = antigravityPath();
      setupJsonUrl(path, JSON_CLIENT_ENTRY_PLACES.antigravity, antigravityEntry(target.endpoint, target.token));
      return { id, ok: true, configPath: path, restartHint: "Start a new Antigravity conversation to load Worktable." };
    }
    case "devin": {
      const path = devinPath();
      setupJsonUrl(path, JSON_CLIENT_ENTRY_PLACES.devin, devinEntry(target.endpoint, target.token));
      return { id, ok: true, configPath: path, restartHint: "Start a new Devin session to load Worktable." };
    }
    case "junie": {
      const path = juniePath();
      setupJsonUrl(path, JSON_CLIENT_ENTRY_PLACES.junie, junieEntry(target.endpoint, target.token));
      return { id, ok: true, configPath: path, restartHint: "Start a new Junie session to load Worktable." };
    }
    case "zed":
    case "cline":
    case "warp":
    case "pi":
    case "droid":
    case "amp":
    case "kiro": {
      const path = LISTED_PATHS[id]();
      setupJsonUrl(path, JSON_CLIENT_ENTRY_PLACES[id], listedEntry(id, target.endpoint, target.token));
      return { id, ok: true, configPath: path, restartHint: LISTED_RESTART_HINTS[id] };
    }
  }
}

// ---- OAuth sign-in -------------------------------------------------------------

/** The client's own command that signs it in to the `worktable` server. */
function signInCommand(id: ConnectorInstallableMcpClientId): string[] | null {
  switch (id) {
    case "claude-code":
      return claudeCodeAvailable() ? [claudeCodeCommand(), "mcp", "login", "worktable"] : null;
    case "codex":
      return commandExists("codex") ? ["codex", "mcp", "login", "worktable"] : null;
    case "opencode":
      return commandExists("opencode") ? ["opencode", "mcp", "auth", "worktable"] : null;
    case "kilo":
      return commandExists("kilo") ? ["kilo", "mcp", "auth", "worktable"] : null;
    case "devin":
      return commandExists("devin") ? ["devin", "mcp", "login", "worktable"] : null;
    case "pi":
      return commandExists("pi") ? ["pi", "mcp", "login", "worktable"] : null;
    case "droid":
      return commandExists("droid") ? ["droid", "mcp", "auth"] : null;
    case "zed":
    case "cline":
    case "warp":
    case "amp":
    case "kiro":
    case "junie":
    case "cursor":
    case "vscode":
    case "copilot":
    case "antigravity":
      return null;
  }
}

/** How a person signs the client in themselves, when it can't happen here. */
export function signInInstruction(id: ConnectorInstallableMcpClientId): string {
  switch (id) {
    case "claude-code":
      return "Open Claude Code, type /mcp, choose worktable and sign in.";
    case "codex":
      return commandExists("codex")
        ? "Run: codex mcp login worktable"
        : "Open Codex, then sign in to worktable from its MCP settings.";
    case "opencode":
      return "Run: opencode mcp auth worktable";
    case "kilo":
      return "Run: kilo mcp auth worktable";
    case "cursor":
      return "Open Cursor and sign in to worktable from its MCP settings.";
    case "vscode":
      return "In VS Code, start worktable from the MCP servers list and sign in.";
    case "copilot":
      return "In Copilot CLI, run /mcp and sign in to worktable.";
    case "antigravity":
      return "In Antigravity, open MCP servers and sign in to worktable.";
    case "devin":
      return commandExists("devin")
        ? "Run: devin mcp login worktable"
        : "Open Devin, then sign in to worktable from its MCP settings.";
    case "junie":
      return "In Junie, run /mcp, choose worktable and Authorize.";
    case "zed":
      return "In Zed, open the agent panel's MCP servers and sign in to worktable.";
    case "cline":
      return "In Cline, open MCP Servers, choose worktable and Authorize.";
    case "warp":
      return "In Warp, open MCP servers and start worktable to sign in.";
    case "pi":
      return "Run: pi mcp login worktable";
    case "droid":
      return "Run: droid mcp auth";
    // Amp signs in the first time a thread uses the server.
    case "amp":
      return "Start a new Amp thread and sign in to worktable when Amp asks.";
    case "kiro":
      return "In Kiro, open MCP servers and sign in to worktable.";
  }
}

export type SignInResult = "signed-in" | "failed" | "cancelled" | "no-terminal" | "no-command";

/**
 * Run the client's own OAuth sign-in on the person's terminal. Under
 * `curl … | sh` stdin is the script, so the sign-in reads from /dev/tty;
 * without one (an agent ran the command) the person signs in themselves.
 * Ctrl+C reaches the sign-in as well; the connector keeps running so it can
 * say how to finish.
 */
export async function signInClient(
  id: ConnectorInstallableMcpClientId,
  onStart: () => void = () => {}
): Promise<SignInResult> {
  const command = signInCommand(id);
  if (!command) return "no-command";
  let tty: number;
  try {
    tty = openSync("/dev/tty", "r");
  } catch {
    return "no-terminal";
  }
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };
  process.on("SIGINT", interrupt);
  try {
    onStart();
    const result = spawnSync(command[0]!, command.slice(1), {
      stdio: [tty, "inherit", "inherit"],
      env: spawnEnv(),
    });
    // A Ctrl+C during the blocking sign-in is delivered once the loop runs.
    await new Promise((resolve) => setImmediate(resolve));
    if (interrupted || result.signal === "SIGINT" || result.status === 130) return "cancelled";
    return result.status === 0 ? "signed-in" : "failed";
  } finally {
    process.off("SIGINT", interrupt);
    closeSync(tty);
  }
}

/**
 * Have a signed-in client connect to Worktable once. Cloud lists an agent
 * from its first MCP request, so this is what lets Worktable notice it
 * without the person opening the client first. False when it couldn't.
 */
export async function connectClientOnce(id: ConnectorInstallableMcpClientId): Promise<boolean> {
  switch (id) {
    case "claude-code": {
      // `mcp get` health-checks the server, which connects with the new sign-in.
      const result = spawnSync(claudeCodeCommand(), ["mcp", "get", "worktable"], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        env: spawnEnv(),
        timeout: 60_000,
      });
      return result.status === 0 && /Status:.*Connected/i.test(result.stdout ?? "");
    }
    case "codex":
      return codexConnectOnce();
    case "cursor":
    case "opencode":
    case "kilo":
    case "vscode":
    case "copilot":
    case "antigravity":
    case "devin":
    case "junie":
    case "zed":
    case "cline":
    case "warp":
    case "pi":
    case "droid":
    case "amp":
    case "kiro":
      return false;
  }
}

/** Codex's app server starts its MCP servers to report their status. */
function codexConnectOnce(): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"], env: spawnEnv() });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    let buffered = "";
    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(connected);
    };
    const timer = setTimeout(() => finish(false), 60_000);
    child.on("error", () => finish(false));
    child.on("exit", () => finish(false));
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let message: { id?: unknown; result?: { data?: unknown } };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id !== 1) continue;
        const servers = Array.isArray(message.result?.data) ? (message.result.data as Array<Record<string, unknown>>) : [];
        const worktable = servers.find((server) => server["name"] === "worktable");
        const tools = worktable?.["tools"];
        finish(Boolean(tools && typeof tools === "object" && Object.keys(tools).length > 0));
      }
    });
    child.stdin!.on("error", () => finish(false));
    child.stdin!.write(
      [
        { method: "initialize", id: 0, params: { clientInfo: { name: "worktable-connect", version: "1" } } },
        { method: "initialized" },
        { method: "mcpServerStatus/list", id: 1, params: {} },
      ]
        .map((message) => JSON.stringify(message))
        .join("\n") + "\n"
    );
  });
}
