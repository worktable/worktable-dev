import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { chmod, rename, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { ensureAppDir } from "./app-storage.ts";
import { normalizePublicUrl } from "./public-origin.ts";

// ============================================================
// Server settings store (machine-local user preferences)
// ============================================================
//
// User-tunable server preferences for the in-app Settings dialog: background
// update checks, editor behavior. Machine-local (lives under the app data root,
// NEVER the workspace) because these are per-install preferences, not portable
// workspace content.
//
// Persistence mirrors session-store.ts: ensureAppDir() (0o700 dir), atomic
// tmp→rename writes, chmod 0o600. The on-disk file is `settings.json`.
//
// TOLERANT READ, on purpose. Unlike config.json (load-bearing install config,
// which throws on corruption so a bad install fails loud), these are just
// preferences. A missing or malformed field falls back to its default per-field
// (wiki-config style); unknown keys are ignored. A fully corrupt or unreadable
// file is preserved where possible and replaced with defaults, but security
// posture fails closed until an explicit settings write clears the marker.

/**
 * Doc version-history retention. `all` keeps every snapshot forever (the
 * historical default); `age` keeps only versions newer than `maxAgeDays`; `count`
 * keeps only the newest `maxPerDoc` versions per doc. The newest version of every
 * doc is always kept regardless of policy — see `version-retention.ts`.
 */
export type RetentionPolicy =
  | { mode: "all" }
  | { mode: "age"; maxAgeDays: number }
  | { mode: "count"; maxPerDoc: number };

/** Sanity caps for the numeric retention fields (strict-write validation). */
export const RETENTION_MAX_AGE_DAYS = 3650;
export const RETENTION_MAX_PER_DOC = 10000;

export interface ServerSettings {
  version: 1;
  updates: {
    /** Whether the server performs background/scheduled update checks. */
    autoCheck: boolean;
  };
  editor: {
    /** Native browser spellcheck in the editor. */
    spellcheck: boolean;
  };
  network: {
    /**
     * The public origin this install is reached at (a tunnel / reverse-proxy
     * front door), or null when it should be auto-detected. MACHINE-LOCAL, not
     * workspace-portable: it describes *this install's* front door, so a copied
     * or synced workspace must not keep pointing agents at the old server.
     */
    publicUrl: string | null;
  };
  history: {
    /** How long doc version snapshots are retained. */
    retention: RetentionPolicy;
  };
}

export const SETTINGS_DEFAULTS: ServerSettings = {
  version: 1,
  updates: { autoCheck: true },
  editor: { spellcheck: false },
  network: { publicUrl: null },
  history: { retention: { mode: "all" } },
};

/**
 * Coerce an arbitrary stored value into a valid RetentionPolicy, tolerantly.
 * Anything unrecognized (bad mode, missing/NaN/non-positive/non-integer numeric
 * field, out-of-cap value) falls back to `{ mode: "all" }` — losing an over-tight
 * or corrupt policy must never delete versions or block a read.
 */
function coerceRetention(value: unknown): RetentionPolicy {
  const all: RetentionPolicy = { mode: "all" };
  if (!value || typeof value !== "object") return all;
  const obj = value as Record<string, unknown>;
  const mode = obj["mode"];
  if (mode === "all") return all;
  const posInt = (v: unknown, cap: number): number | null =>
    typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= cap ? v : null;
  if (mode === "age") {
    const days = posInt(obj["maxAgeDays"], RETENTION_MAX_AGE_DAYS);
    return days === null ? all : { mode: "age", maxAgeDays: days };
  }
  if (mode === "count") {
    const per = posInt(obj["maxPerDoc"], RETENTION_MAX_PER_DOC);
    return per === null ? all : { mode: "count", maxPerDoc: per };
  }
  return all;
}

// ============================================================
// Persistence
// ============================================================

function settingsFile(): string {
  return join(ensureAppDir(), "settings.json");
}

function failClosedFile(): string {
  return join(ensureAppDir(), "settings.fail-closed");
}

let _failClosedInMemory = false;

function markFailClosed(reason: string): void {
  _failClosedInMemory = true;
  try {
    writeFileSync(failClosedFile(), `${reason}\n`, { mode: 0o600 });
  } catch (err) {
    console.warn("[settings] failed to persist fail-closed marker:", err);
  }
}

async function clearFailClosed(): Promise<void> {
  _failClosedInMemory = false;
  try {
    await rm(failClosedFile(), { force: true });
  } catch (err) {
    console.warn("[settings] failed to clear fail-closed marker:", err);
  }
}

export function settingsFailClosed(): boolean {
  return _failClosedInMemory || existsSync(failClosedFile());
}

function coercePublicUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const result = normalizePublicUrl(value);
  return result.ok && typeof result.value === "string" ? result.value : null;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Coerce arbitrary parsed JSON into a valid ServerSettings, falling back per
 * field to the defaults. Never throws; unknown keys are dropped.
 */
function coerce(parsed: unknown): ServerSettings {
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  const updates = (obj["updates"] && typeof obj["updates"] === "object"
    ? obj["updates"]
    : {}) as Record<string, unknown>;
  const editor = (obj["editor"] && typeof obj["editor"] === "object"
    ? obj["editor"]
    : {}) as Record<string, unknown>;
  const network = (obj["network"] && typeof obj["network"] === "object"
    ? obj["network"]
    : {}) as Record<string, unknown>;
  const history = (obj["history"] && typeof obj["history"] === "object"
    ? obj["history"]
    : {}) as Record<string, unknown>;
  return {
    version: 1,
    updates: {
      autoCheck: boolOr(updates["autoCheck"], SETTINGS_DEFAULTS.updates.autoCheck),
    },
    editor: {
      spellcheck: boolOr(editor["spellcheck"], SETTINGS_DEFAULTS.editor.spellcheck),
    },
    network: {
      publicUrl: coercePublicUrl(network["publicUrl"]),
    },
    history: {
      retention: coerceRetention(history["retention"]),
    },
  };
}

async function persist(settings: ServerSettings): Promise<void> {
  const file = settingsFile();
  // Unique tmp name (pid + random): two concurrent writers must not share a tmp
  // path, or the loser's rename would ENOENT after the winner moved it away.
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(settings, null, 2), "utf8");
  await chmod(tmp, 0o600);
  await rename(tmp, file);
  await clearFailClosed();
}

let _cache: ServerSettings | null = null;

// Monotonic RETENTION-POLICY write counter — bumped only when a write actually
// changes history.retention. Long-running consumers of a policy SNAPSHOT (the
// retention sweep walks every doc dir with the policy it launched with) compare
// generations to notice a superseding policy change mid-run; unrelated settings
// writes (editor/update toggles) must NOT abort an in-flight sweep, since only
// a policy change launches a replacement sweep.
let _retentionGeneration = 0;

export function getRetentionPolicyGeneration(): number {
  return _retentionGeneration;
}

/**
 * Read settings from disk, tolerantly. A missing file (fresh install) returns
 * the in-memory defaults WITHOUT writing — the file is materialized only on the
 * first explicit `updateServerSettings`, so a read never races a concurrent
 * write and can never clobber a just-written value with defaults. A
 * partially-valid file is coerced per-field. A file that is not even parseable
 * JSON is preserved as `settings.json.corrupt`, then overwritten with defaults.
 * Because settings now carry the public-origin exposure signal, corrupt or
 * unreadable settings fail closed until an explicit settings write succeeds.
 */
function readFromDisk(): ServerSettings {
  const file = settingsFile();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      markFailClosed("settings.json could not be read; requiring auth until settings are rewritten");
      console.warn("[settings] settings.json could not be read; requiring auth until rewritten:", err);
    }
    // Missing (ENOENT) is a fresh install — fall back to defaults, no write.
    return { ...SETTINGS_DEFAULTS };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON: preserve the bytes for forensics, reset to defaults, and
    // require auth until an owner successfully rewrites settings.
    markFailClosed("settings.json was corrupt; requiring auth until settings are rewritten");
    try {
      renameSync(file, `${file}.corrupt`);
      writeFileSync(file, JSON.stringify(SETTINGS_DEFAULTS, null, 2), {
        mode: 0o600,
      });
    } catch (writeErr) {
      console.warn("[settings] failed to quarantine corrupt settings.json:", writeErr);
    }
    console.warn(
      `[settings] settings.json was not valid JSON; preserved as settings.json.corrupt, reset to defaults, and auth will fail closed until settings are rewritten`,
    );
    return { ...SETTINGS_DEFAULTS };
  }

  return coerce(parsed);
}

// ============================================================
// Public API
// ============================================================

/** Current server settings (cached; invalidated on every write). */
export function getServerSettings(): ServerSettings {
  if (!_cache) _cache = readFromDisk();
  return _cache;
}

/** Drop the in-memory cache (tests, and after an out-of-band file change). */
export function invalidateServerSettingsCache(): void {
  _cache = null;
  _failClosedInMemory = false;
}

/** A partial patch: any subset of the known groups and their known fields. */
export interface ServerSettingsPatch {
  updates?: { autoCheck?: unknown };
  editor?: { spellcheck?: unknown };
  network?: { publicUrl?: unknown };
  history?: { retention?: unknown };
}

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

function assertPublicUrl(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new SettingsValidationError("network.publicUrl must be a string or null");
  }
  const result = normalizePublicUrl(value);
  if (!result.ok) {
    throw new SettingsValidationError(
      result.error ?? "network.publicUrl is not a valid origin",
    );
  }
  // A valid empty/whitespace input normalizes to null (clear); otherwise the
  // normalized origin string.
  return result.value ?? null;
}

function assertBool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new SettingsValidationError(`${field} must be a boolean`);
  }
  return value;
}

function assertPositiveInt(value: unknown, field: string, cap: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new SettingsValidationError(`${field} must be a positive integer`);
  }
  if (value > cap) {
    throw new SettingsValidationError(`${field} must be at most ${cap}`);
  }
  return value;
}

/**
 * Strictly validate an inbound retention policy. Unlike the tolerant read, a bad
 * mode, unknown key, or out-of-range numeric field throws (→ 400) rather than
 * silently degrading — a user setting a policy must get an error, not a surprise.
 */
function assertRetention(value: unknown): RetentionPolicy {
  if (!value || typeof value !== "object") {
    throw new SettingsValidationError("history.retention must be an object");
  }
  const obj = value as Record<string, unknown>;
  const mode = obj["mode"];
  if (mode === "all") {
    for (const key of Object.keys(obj)) {
      if (key !== "mode") {
        throw new SettingsValidationError(`Unknown history.retention field: ${key}`);
      }
    }
    return { mode: "all" };
  }
  if (mode === "age") {
    for (const key of Object.keys(obj)) {
      if (key !== "mode" && key !== "maxAgeDays") {
        throw new SettingsValidationError(`Unknown history.retention field: ${key}`);
      }
    }
    return {
      mode: "age",
      maxAgeDays: assertPositiveInt(obj["maxAgeDays"], "history.retention.maxAgeDays", RETENTION_MAX_AGE_DAYS),
    };
  }
  if (mode === "count") {
    for (const key of Object.keys(obj)) {
      if (key !== "mode" && key !== "maxPerDoc") {
        throw new SettingsValidationError(`Unknown history.retention field: ${key}`);
      }
    }
    return {
      mode: "count",
      maxPerDoc: assertPositiveInt(obj["maxPerDoc"], "history.retention.maxPerDoc", RETENTION_MAX_PER_DOC),
    };
  }
  throw new SettingsValidationError(
    `history.retention.mode must be "all", "age", or "count"`,
  );
}

/**
 * Deep-merge a patch into the current settings, one top-level group at a time,
 * with STRICT validation of every provided field. Unknown keys (at either level)
 * or wrong-typed known fields throw SettingsValidationError — the route maps that
 * to a 400. Returns the merged settings after persisting; the cache is refreshed.
 */
let _writeChain: Promise<unknown> = Promise.resolve();

export interface ServerSettingsUpdateResult {
  settings: ServerSettings;
  previous: ServerSettings;
  retentionChanged: boolean;
  retentionGeneration: number;
}

export function updateServerSettings(
  patch: ServerSettingsPatch,
): Promise<ServerSettings> {
  return updateServerSettingsWithResult(patch).then((result) => result.settings);
}

export function updateServerSettingsWithResult(
  patch: ServerSettingsPatch,
): Promise<ServerSettingsUpdateResult> {
  // Serialize read→merge→persist. Two concurrent patches (e.g. one toggling
  // updates.autoCheck, one editor.spellcheck) would otherwise both merge from
  // the same snapshot and the later persist would silently revert the earlier
  // group. Chaining makes the later writer re-read the earlier one's result; a
  // rejected predecessor (validation error) must not poison the chain.
  const run = _writeChain.then(
    () => applyPatchWithResult(patch),
    () => applyPatchWithResult(patch),
  );
  _writeChain = run.catch(() => undefined);
  return run;
}

async function applyPatchWithResult(
  patch: ServerSettingsPatch,
): Promise<ServerSettingsUpdateResult> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new SettingsValidationError("Expected a settings patch object");
  }

  const current = getServerSettings();
  const next: ServerSettings = {
    version: 1,
    updates: { ...current.updates },
    editor: { ...current.editor },
    network: { ...current.network },
    history: { ...current.history },
  };

  const patchObj = patch as Record<string, unknown>;
  for (const key of Object.keys(patchObj)) {
    if (key !== "updates" && key !== "editor" && key !== "network" && key !== "history") {
      throw new SettingsValidationError(`Unknown settings group: ${key}`);
    }
  }

  if (patch.updates !== undefined) {
    if (
      !patch.updates ||
      typeof patch.updates !== "object" ||
      Array.isArray(patch.updates)
    ) {
      throw new SettingsValidationError("updates must be an object");
    }
    const group = patch.updates as Record<string, unknown>;
    for (const key of Object.keys(group)) {
      if (key !== "autoCheck") {
        throw new SettingsValidationError(`Unknown updates field: ${key}`);
      }
    }
    if (group["autoCheck"] !== undefined) {
      next.updates.autoCheck = assertBool(group["autoCheck"], "updates.autoCheck");
    }
  }

  if (patch.editor !== undefined) {
    if (
      !patch.editor ||
      typeof patch.editor !== "object" ||
      Array.isArray(patch.editor)
    ) {
      throw new SettingsValidationError("editor must be an object");
    }
    const group = patch.editor as Record<string, unknown>;
    for (const key of Object.keys(group)) {
      if (key !== "spellcheck") {
        throw new SettingsValidationError(`Unknown editor field: ${key}`);
      }
    }
    if (group["spellcheck"] !== undefined) {
      next.editor.spellcheck = assertBool(group["spellcheck"], "editor.spellcheck");
    }
  }

  if (patch.network !== undefined) {
    if (
      !patch.network ||
      typeof patch.network !== "object" ||
      Array.isArray(patch.network)
    ) {
      throw new SettingsValidationError("network must be an object");
    }
    const group = patch.network as Record<string, unknown>;
    for (const key of Object.keys(group)) {
      if (key !== "publicUrl") {
        throw new SettingsValidationError(`Unknown network field: ${key}`);
      }
    }
    if (group["publicUrl"] !== undefined) {
      next.network.publicUrl = assertPublicUrl(group["publicUrl"]);
    }
  }

  if (patch.history !== undefined) {
    if (
      !patch.history ||
      typeof patch.history !== "object" ||
      Array.isArray(patch.history)
    ) {
      throw new SettingsValidationError("history must be an object");
    }
    const group = patch.history as Record<string, unknown>;
    for (const key of Object.keys(group)) {
      if (key !== "retention") {
        throw new SettingsValidationError(`Unknown history field: ${key}`);
      }
    }
    if (group["retention"] !== undefined) {
      next.history.retention = assertRetention(group["retention"]);
    }
  }

  const retentionChanged =
    JSON.stringify(current.history.retention) !==
    JSON.stringify(next.history.retention);
  await persist(next);
  _cache = next;
  if (retentionChanged) _retentionGeneration += 1;
  return {
    settings: next,
    previous: current,
    retentionChanged,
    retentionGeneration: _retentionGeneration,
  };
}
