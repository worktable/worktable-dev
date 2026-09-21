import { existsSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
export const defaultBundlePath = join(
  appRoot,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
  "Worktable.app"
)
export const defaultDmgDirectory = join(
  appRoot,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "dmg"
)
export const defaultMacosBundleDirectory = join(
  appRoot,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos"
)

function resolveOnlyArtifact(
  description: string,
  suffix: string,
  directory: string
): string {
  if (!existsSync(directory)) {
    throw new Error(`Desktop ${description} directory is missing: ${directory}`)
  }
  const candidates = readdirSync(directory)
    .filter((name) => name.endsWith(suffix))
    .sort()
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one Desktop ${description} in ${directory}, found ${candidates.length}: ${candidates.join(", ") || "none"}`
    )
  }
  return join(directory, candidates[0]!)
}

export function resolveDesktopBundlePath(
  environment: NodeJS.ProcessEnv = process.env
): string {
  const configured = environment.WORKTABLE_DESKTOP_BUNDLE_PATH?.trim()
  return resolve(configured || defaultBundlePath)
}

export function resolveDesktopDmgPath(
  explicitPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
  dmgDirectory = defaultDmgDirectory
): string {
  const configured =
    explicitPath?.trim() || environment.WORKTABLE_DESKTOP_DMG_PATH?.trim()
  if (configured) return resolve(configured)

  return resolveOnlyArtifact("DMG", ".dmg", dmgDirectory)
}

export function resolveDesktopUpdaterBundlePath(
  explicitPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
  macosBundleDirectory = defaultMacosBundleDirectory
): string {
  const configured =
    explicitPath?.trim() ||
    environment.WORKTABLE_DESKTOP_UPDATER_BUNDLE_PATH?.trim()
  if (configured) return resolve(configured)

  return resolveOnlyArtifact(
    "updater bundle",
    ".app.tar.gz",
    macosBundleDirectory
  )
}

export function resolveDesktopUpdaterSignaturePath(
  updaterBundlePath = resolveDesktopUpdaterBundlePath(),
  explicitPath?: string,
  environment: NodeJS.ProcessEnv = process.env
): string {
  const configured =
    explicitPath?.trim() ||
    environment.WORKTABLE_DESKTOP_UPDATER_SIGNATURE_PATH?.trim()
  return resolve(configured || `${updaterBundlePath}.sig`)
}

if (import.meta.main) {
  const [kind, explicitPath] = process.argv.slice(2)
  if (kind === "bundle") {
    console.log(resolveDesktopBundlePath())
  } else if (kind === "dmg") {
    console.log(resolveDesktopDmgPath(explicitPath))
  } else if (kind === "updater-bundle") {
    console.log(resolveDesktopUpdaterBundlePath(explicitPath))
  } else if (kind === "updater-signature") {
    console.log(
      resolveDesktopUpdaterSignaturePath(
        resolveDesktopUpdaterBundlePath(),
        explicitPath
      )
    )
  } else {
    throw new Error(
      "Usage: bun run scripts/release-paths.ts bundle|dmg|updater-bundle|updater-signature [explicit-path]"
    )
  }
}
