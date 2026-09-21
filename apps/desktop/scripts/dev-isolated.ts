import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const MANIFEST_FILE = ".worktable-desktop-dev.json"
const MANIFEST_KIND = "worktable.desktop-dev"
const MANIFEST_VERSION = 1

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = realpathSync(resolve(appRoot, "../.."))

export interface IsolatedDevOptions {
  help: boolean
  reset: boolean
}

interface IsolatedDevManifest {
  schemaVersion: 1
  kind: typeof MANIFEST_KIND
  repoRoot: string
  createdAt: string
}

export function parseIsolatedDevArgs(argv: string[]): IsolatedDevOptions {
  const options: IsolatedDevOptions = {
    help: false,
    reset: false,
  }
  for (const argument of argv) {
    if (argument === "--help" || argument === "-h") options.help = true
    else if (argument === "--reset") options.reset = true
    else throw new Error(`Unknown isolated Desktop option: ${argument}`)
  }
  return options
}

export function isolatedDevRoot(
  repository: string,
  temporaryRoot = tmpdir()
): string {
  const canonical = realpathSync(repository)
  const key = createHash("sha256").update(canonical).digest("hex").slice(0, 12)
  return join(temporaryRoot, "worktable-desktop-dev", key)
}

function manifestPath(root: string): string {
  return join(root, MANIFEST_FILE)
}

function readOwnedManifest(
  root: string,
  repository: string
): IsolatedDevManifest | null {
  try {
    const value = JSON.parse(
      readFileSync(manifestPath(root), "utf8")
    ) as Partial<IsolatedDevManifest>
    return value.schemaVersion === MANIFEST_VERSION &&
      value.kind === MANIFEST_KIND &&
      value.repoRoot === repository
      ? (value as IsolatedDevManifest)
      : null
  } catch {
    return null
  }
}

export function resetIsolatedDevRoot(
  root: string,
  repository: string
): boolean {
  if (!existsSync(root)) return false
  if (!readOwnedManifest(root, repository)) {
    throw new Error(
      `Refusing to reset unowned isolated Desktop directory: ${root}`
    )
  }
  rmSync(root, { recursive: true })
  return true
}

export function ensureIsolatedDevRoot(
  root: string,
  repository: string
): { appData: string; localAppData: string; home: string; workspace: string } {
  if (existsSync(root) && !readOwnedManifest(root, repository)) {
    throw new Error(
      `Isolated Desktop directory exists without a matching ownership manifest: ${root}`
    )
  }
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const current = readOwnedManifest(root, repository)
  if (!current) {
    const manifest: IsolatedDevManifest = {
      schemaVersion: MANIFEST_VERSION,
      kind: MANIFEST_KIND,
      repoRoot: repository,
      createdAt: new Date().toISOString(),
    }
    writeFileSync(
      manifestPath(root),
      `${JSON.stringify(manifest, null, 2)}\n`,
      {
        mode: 0o600,
      }
    )
    chmodSync(manifestPath(root), 0o600)
  }
  const home = join(root, "home")
  const appData = join(root, "app-data")
  const localAppData = join(root, "local-app-data")
  const workspace = join(home, "Worktable")
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(appData, { recursive: true, mode: 0o700 })
  mkdirSync(localAppData, { recursive: true, mode: 0o700 })
  return { appData, localAppData, home, workspace }
}

export function isolatedDevEnvironment(
  base: Record<string, string | undefined>,
  paths: { appData: string; localAppData: string; workspace: string }
): Record<string, string | undefined> {
  const environment = { ...base }
  for (const key of [
    "WORKTABLE_APP_DIR",
    "WORKTABLE_DESKTOP_APP_DIR",
    "WORKTABLE_DESKTOP_LOCAL_APP_DIR",
    "WORKTABLE_DESKTOP_DEFAULT_WORKSPACE",
    "WORKTABLE_DESKTOP_PICKER_DIRECTORY",
    "WORKTABLE_DESKTOP_PORT",
    "WORKTABLE_DESKTOP_WORKSPACE",
    "WORKTABLE_WORKSPACE",
  ]) {
    delete environment[key]
  }
  environment.WORKTABLE_DESKTOP_APP_DIR = paths.appData
  environment.WORKTABLE_DESKTOP_LOCAL_APP_DIR = paths.localAppData
  environment.WORKTABLE_DESKTOP_DEFAULT_WORKSPACE = paths.workspace
  return environment
}

function usage(): string {
  return `Usage: bun run desktop:dev:isolated -- [options]

Run the real Tauri development app with a repo-specific bundle identity,
Desktop app-data directory, and default workspace. Developer toolchain caches
keep using the normal home. State is retained between runs so ready/restart
behavior is easy to review.

Options:
  --reset              Remove this repo's owned disposable state before launch
  -h, --help           Show this help
`
}

async function main(): Promise<void> {
  const options = parseIsolatedDevArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage())
    return
  }

  const root = isolatedDevRoot(repoRoot)
  if (options.reset && resetIsolatedDevRoot(root, repoRoot)) {
    console.log(`[desktop-dev] reset ${root}`)
  }
  const paths = ensureIsolatedDevRoot(root, repoRoot)
  console.log(`[desktop-dev] isolated root: ${root}`)
  console.log(`[desktop-dev] default workspace: ${paths.workspace}`)
  console.log(
    "[desktop-dev] state is retained; pass --reset to return to first-run onboarding"
  )

  const child = Bun.spawn([process.execPath, "run", "native:dev:isolated"], {
    cwd: appRoot,
    env: isolatedDevEnvironment(process.env, paths),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await child.exited
  if (exitCode !== 0) process.exitCode = exitCode
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
