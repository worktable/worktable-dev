import { createHash, randomBytes } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"

const REPO_ROOT = resolve(import.meta.dirname, "..", "..")
const APP_ROOT = join(REPO_ROOT, "apps", "desktop")
export const DESKTOP_BUNDLE = join(
  APP_ROOT,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
  "Worktable.app"
)
export const DESKTOP_EXECUTABLE = join(
  DESKTOP_BUNDLE,
  "Contents",
  "MacOS",
  "worktable-desktop"
)
const RUNTIME_MANIFEST = join(
  DESKTOP_BUNDLE,
  "Contents",
  "Resources",
  "worktable-runtime",
  "manifest.json"
)
const BUILD_MARKER = join(
  dirname(DESKTOP_BUNDLE),
  ".worktable-desktop-lab-build.json"
)

export const DESKTOP_BUNDLE_INPUTS = [
  "apps/desktop",
  "apps/cli",
  "apps/web",
  "packages/config-typescript",
  "packages/hosted-contract/LICENSE",
  "packages/mcp-connect",
  "packages/server",
  "packages/types",
  "packages/ui",
  "scripts/build-release.ts",
  "scripts/release-archive.py",
  "scripts/release-source.ts",
  "scripts/release-licenses.ts",
  "scripts/native-notices.ts",
  "scripts/compiled-js-notices.ts",
  "scripts/bun-runtime-notices.ts",
  "scripts/dependency-notices.ts",
  "scripts/browser-notices.ts",
  "scripts/licenses",
  "plugins/worktable/LICENSE",
  "plugins/worktable/skills",
  "plugins/worktable/skill-inventory.json",
  "scripts/install.sh",
  "LICENSE",
  "NOTICE",
  "SOURCE-MATERIALS.json",
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "turbo.json",
] as const

interface DesktopBuildMarker {
  schemaVersion: 1
  sourceCommit: string
  inputFingerprint: string
  arch: DesktopArch
  builtAt: string
}

type DesktopArch = "arm64" | "x64"

export interface DesktopBuildStatus {
  sourceCommit: string
  inputFingerprint: string
  arch: DesktopArch
  reusable: boolean
}

function run(
  command: string[],
  options: { stdout?: "inherit" | "pipe" } = {}
): string {
  const result = Bun.spawnSync(command, {
    cwd: REPO_ROOT,
    env: process.env,
    stdout: options.stdout ?? "pipe",
    stderr: "inherit",
  })
  if (!result.success) {
    throw new Error(
      `${command.join(" ")} failed with exit code ${result.exitCode}`
    )
  }
  return result.stdout?.toString().trim() ?? ""
}

function currentCommit(): string {
  return run(["git", "rev-parse", "HEAD"])
}

function listedDesktopInputs(): string[] {
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "-co",
      "--exclude-standard",
      "-z",
      "--",
      ...DESKTOP_BUNDLE_INPUTS,
    ],
    { cwd: REPO_ROOT }
  )
  return [...new Set(output.toString().split("\0").filter(Boolean))].sort()
}

export function desktopInputFingerprint(): string {
  const hash = createHash("sha256")
  hash.update(currentCommit())
  for (const path of listedDesktopInputs()) {
    hash.update("\0path\0")
    hash.update(path)
    const absolute = join(REPO_ROOT, path)
    if (!existsSync(absolute)) {
      hash.update("\0missing")
      continue
    }
    const info = lstatSync(absolute)
    hash.update(`\0mode\0${info.mode & 0o777}`)
    if (info.isSymbolicLink()) {
      hash.update("\0link\0")
      hash.update(readlinkSync(absolute))
    } else if (info.isFile()) {
      hash.update("\0file\0")
      hash.update(readFileSync(absolute))
    }
  }
  return hash.digest("hex")
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return null
  }
}

function readBuildMarker(): DesktopBuildMarker | null {
  const marker = readJson<DesktopBuildMarker>(BUILD_MARKER)
  return marker?.schemaVersion === 1 ? marker : null
}

function desktopArch(): DesktopArch {
  if (process.arch === "arm64" || process.arch === "x64") return process.arch
  throw new Error(`Unsupported macOS architecture: ${process.arch}`)
}

function runtimeManifest(): {
  sourceCommit?: string
  arch?: string
} | null {
  return readJson<{ sourceCommit?: string; arch?: string }>(RUNTIME_MANIFEST)
}

export function desktopBundleMayBeReused(options: {
  executableExists: boolean
  marker?: DesktopBuildMarker | null
  sourceCommit: string
  runtimeSourceCommit?: string
  expectedArch: DesktopArch
  runtimeArch?: string
  inputFingerprint: string
}): boolean {
  return Boolean(
    options.executableExists &&
    options.marker?.schemaVersion === 1 &&
    options.marker.sourceCommit === options.sourceCommit &&
    options.marker.inputFingerprint === options.inputFingerprint &&
    options.marker.arch === options.expectedArch &&
    options.runtimeSourceCommit === options.sourceCommit &&
    options.runtimeArch === options.expectedArch
  )
}

export function writeAtomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  })
  renameSync(temporary, path)
  chmodSync(path, 0o600)
}

export function desktopBuildStatus(): DesktopBuildStatus {
  const sourceCommit = currentCommit()
  const inputFingerprint = desktopInputFingerprint()
  const arch = desktopArch()
  const runtime = runtimeManifest()
  return {
    sourceCommit,
    inputFingerprint,
    arch,
    reusable: desktopBundleMayBeReused({
      executableExists: existsSync(DESKTOP_EXECUTABLE),
      marker: readBuildMarker(),
      sourceCommit,
      runtimeSourceCommit: runtime?.sourceCommit,
      expectedArch: arch,
      runtimeArch: runtime?.arch,
      inputFingerprint,
    }),
  }
}

export function prepareDesktopBundle(rebuild: boolean): DesktopBuildStatus & {
  rebuilt: boolean
} {
  if (process.platform !== "darwin")
    throw new Error("The Worktable Desktop lab requires macOS.")
  let status = desktopBuildStatus()
  if (rebuild || !status.reusable) {
    console.log(
      rebuild
        ? "[lab] rebuilding the packaged Desktop checkout"
        : "[lab] packaged Desktop checkout is stale; building it"
    )
    run([process.execPath, "run", "desktop:build"], { stdout: "inherit" })
    status = desktopBuildStatus()
    if (!existsSync(DESKTOP_EXECUTABLE))
      throw new Error(`Desktop build did not produce ${DESKTOP_EXECUTABLE}`)
    const runtime = runtimeManifest()
    if (
      runtime?.sourceCommit !== status.sourceCommit ||
      runtime.arch !== status.arch
    ) {
      throw new Error(
        "Packaged Desktop runtime provenance or architecture does not match the current checkout"
      )
    }
    writeAtomicJson(BUILD_MARKER, {
      schemaVersion: 1,
      sourceCommit: status.sourceCommit,
      inputFingerprint: status.inputFingerprint,
      arch: status.arch,
      builtAt: new Date().toISOString(),
    } satisfies DesktopBuildMarker)
    return { ...status, reusable: true, rebuilt: true }
  }

  run([process.execPath, "run", "apps/desktop/scripts/verify-bundle.ts"], {
    stdout: "inherit",
  })
  return { ...status, rebuilt: false }
}
