import { existsSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"

declare const __WORKTABLE_BUILD_VERSION__: string | undefined
declare const __WORKTABLE_SOURCE_URL__: string | undefined

/** Source identity embedded by the release build; never a runtime override. */
export const SOURCE_URL =
  typeof __WORKTABLE_SOURCE_URL__ === "string" && __WORKTABLE_SOURCE_URL__
    ? __WORKTABLE_SOURCE_URL__
    : undefined

// ============================================================
// Release / version path authority
// ============================================================
//
// Single source of truth for the running build's version and the on-disk
// release tree. The CLI (apps/cli) re-exports these so a Worktable install has
// exactly one notion of "what version am I" and "where is my install.sh" — the
// server serves it to the UI, the CLI uses it to update. Both read the same env
// contract the installer writes (WORKTABLE_VERSION / WORKTABLE_LAUNCHER /
// WORKTABLE_RELEASE_DIR); neither invents a root of its own.

/**
 * The installed release version. The launcher environment remains authoritative
 * for normal installs; compiled CLI and Desktop-sidecar binaries carry the same
 * build identity so direct execution cannot silently fall back to 0.0.1.
 */
export const VERSION =
  process.env["WORKTABLE_VERSION"] ??
  (typeof __WORKTABLE_BUILD_VERSION__ === "string"
    ? __WORKTABLE_BUILD_VERSION__
    : "0.0.1")

/**
 * Absolute path to the running launcher. The installer always exports
 * WORKTABLE_LAUNCHER as the canonical `worktable` binary; outside an install we
 * fall back to argv/execPath. A relative argv entry (a subcommand name like
 * `setup`) is never treated as a path.
 */
export function getExecutablePath(): string {
  const launcher = process.env["WORKTABLE_LAUNCHER"]?.trim()
  if (launcher) return launcher
  const argvPath = process.argv[1]
  if (argvPath && isAbsolute(argvPath) && !argvPath.startsWith("/$bunfs/"))
    return argvPath
  return process.execPath
}

/**
 * The release directory holding this build's artifacts (install.sh,
 * manifest.json, the version tree). An explicit WORKTABLE_RELEASE_DIR wins;
 * otherwise it's two levels up from the launcher (e.g. .../releases from
 * .../releases/<version>/bin/worktable).
 */
export function getReleaseDir(): string | null {
  const env = process.env["WORKTABLE_RELEASE_DIR"]?.trim()
  if (env) return env
  const executable = getExecutablePath()
  return dirname(dirname(executable))
}

export interface ReleaseInfo {
  sourceUrl?: string
  version: string
  releaseDir: string | null
  /**
   * Whether this build ships the embedded installer that `worktable update`
   * drives. Source checkouts and bare binaries don't, so the UI must offer
   * "update via CLI" instead of a button.
   */
  hasEmbeddedInstaller: boolean
  /**
   * Whether the server can trigger an in-place update: it needs both the
   * embedded installer AND a launcher binary it can spawn detached.
   */
  canUpdate: boolean
}

export function getReleaseInfo(): ReleaseInfo {
  const releaseDir = getReleaseDir()
  const installer = releaseDir ? join(releaseDir, "install.sh") : null
  const hasEmbeddedInstaller = Boolean(installer && existsSync(installer))
  const hasLauncher = Boolean(process.env["WORKTABLE_LAUNCHER"]?.trim())
  return {
    version: VERSION,
    sourceUrl: SOURCE_URL,
    releaseDir,
    hasEmbeddedInstaller,
    canUpdate: hasEmbeddedInstaller && hasLauncher,
  }
}
