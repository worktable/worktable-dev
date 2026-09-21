import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ============================================================
// App-private storage resolution
// ============================================================
//
// Machine-local data that must NOT live in the workspace folder: token
// hashes, credentials, caches, OS-level state. The workspace stays
// portable and safe to sync, share, or commit; this directory does not
// travel with it. (Counterpart to workspace.ts, which is the only
// authority for workspace paths — this module is the only authority for
// app-private paths.)

/** Override for testing. Set before calling any token-store functions. */
let _appDirOverride: string | null = null;

export function setAppDirOverride(dir: string | null): void {
  _appDirOverride = dir;
}

export function getAppDir(): string {
  if (_appDirOverride) return _appDirOverride;
  const env = process.env["WORKTABLE_APP_DIR"]?.trim();
  if (env) return resolve(env);
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Worktable");
  }
  const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
  const base = xdg ? resolve(xdg) : join(homedir(), ".config");
  return join(base, "worktable");
}

/** Create the app dir (owner-only permissions) and return its path. */
export function ensureAppDir(): string {
  const dir = getAppDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
