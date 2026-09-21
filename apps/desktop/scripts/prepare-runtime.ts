import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveRustHostTuple } from "./rust-toolchain"
import { copyReleaseLicenses } from "../../../scripts/release-licenses.ts"
import { writeNativeNotices } from "../../../scripts/native-notices.ts"

interface ReleaseManifest {
  type: string
  version: string
  platform: string
  arch: string
  sourceCommit?: string
}

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repoRoot = resolve(appRoot, "../..")
const repoVersion = (
  JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    version: string
  }
).version
const generatedRoot = join(appRoot, "src-tauri", "generated")
const extractRoot = join(generatedRoot, "extracted")
const runtimeRoot = join(generatedRoot, "runtime", "worktable")
const binaryRoot = join(generatedRoot, "bin")
const rebuild = process.argv.includes("--rebuild")

function sourceTreeIsDirty(): boolean {
  const result = Bun.spawnSync(
    [
      "git",
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--",
      "apps/cli",
      "apps/web",
      "packages/server",
      "packages/types",
      "packages/ui",
      "packages/mcp-connect",
      "plugins/worktable/skills",
      "plugins/worktable/skill-inventory.json",
      "plugins/worktable/LICENSE",
      "scripts/build-release.ts",
      "scripts/release-archive.py",
      "scripts/release-source.ts",
      "scripts/release-licenses.ts",
      "scripts/compiled-js-notices.ts",
      "scripts/bun-runtime-notices.ts",
      "scripts/dependency-notices.ts",
      "scripts/browser-notices.ts",
      "scripts/licenses",
      "LICENSE",
      "NOTICE",
      "package.json",
      "bun.lock",
    ],
    { cwd: repoRoot, stdout: "pipe", stderr: "inherit" }
  )
  return !result.success || result.stdout.toString().trim().length > 0
}

function readArtifactManifest(path: string): ReleaseManifest | null {
  if (!existsSync(path)) return null
  const result = Bun.spawnSync(["tar", "-xOzf", path, "./manifest.json"], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "ignore",
  })
  if (!result.success) return null
  try {
    return JSON.parse(result.stdout.toString()) as ReleaseManifest
  } catch {
    return null
  }
}

function run(command: string[], cwd = repoRoot): string {
  const result = Bun.spawnSync(command, {
    cwd,
    stdout: "pipe",
    stderr: "inherit",
    env: process.env,
  })
  if (!result.success) {
    throw new Error(
      `${command.join(" ")} failed with exit code ${result.exitCode}`
    )
  }
  return result.stdout.toString().trim()
}

if (process.platform !== "darwin") {
  throw new Error("Worktable Desktop currently supports macOS builds only.")
}

const arch =
  process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null
if (!arch) throw new Error(`Unsupported macOS architecture: ${process.arch}`)

const artifact = join(
  repoRoot,
  "dist",
  "releases",
  `worktable-darwin-${arch}.tar.gz`
)
const currentCommit = run(["git", "rev-parse", "HEAD"])
const artifactManifest = readArtifactManifest(artifact)
const staleArtifact =
  artifactManifest?.sourceCommit !== currentCommit || sourceTreeIsDirty()
if (rebuild || !artifactManifest || staleArtifact) {
  console.log(
    rebuild
      ? "Rebuilding packaged Worktable runtime..."
      : artifactManifest
        ? "Packaged runtime is stale; rebuilding it..."
        : "Packaged runtime missing or unreadable; building it..."
  )
  run([process.execPath, "run", "release:local"])
}

const hostTuple = resolveRustHostTuple()
const expectedTuple =
  arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"
if (hostTuple !== expectedTuple) {
  throw new Error(
    `Rust host tuple ${hostTuple} does not match the selected ${arch} runtime (${expectedTuple}).`
  )
}

rmSync(generatedRoot, { recursive: true, force: true })
mkdirSync(extractRoot, { recursive: true })
mkdirSync(runtimeRoot, { recursive: true })
mkdirSync(binaryRoot, { recursive: true })
run(["tar", "-xzf", artifact, "-C", extractRoot])

const manifestPath = join(extractRoot, "manifest.json")
const manifest = JSON.parse(
  readFileSync(manifestPath, "utf8")
) as ReleaseManifest
if (
  manifest.type !== "worktable.release" ||
  manifest.platform !== "darwin" ||
  manifest.arch !== arch ||
  manifest.version !== repoVersion
) {
  throw new Error(
    `Release manifest does not match this Mac: ${JSON.stringify(manifest)}`
  )
}

const targetBinary = join(binaryRoot, `worktable-${hostTuple}`)
copyFileSync(join(extractRoot, "bin", "worktable"), targetBinary)
chmodSync(targetBinary, 0o755)
copyFileSync(manifestPath, join(runtimeRoot, "manifest.json"))
cpSync(join(extractRoot, "web"), join(runtimeRoot, "web"), { recursive: true })
cpSync(join(extractRoot, "connector"), join(runtimeRoot, "connector"), {
  recursive: true,
})
cpSync(join(extractRoot, "integrations"), join(runtimeRoot, "integrations"), {
  recursive: true,
})
cpSync(join(extractRoot, "licenses"), join(runtimeRoot, "licenses"), {
  recursive: true,
})
copyReleaseLicenses(repoRoot, runtimeRoot, "desktop")
writeNativeNotices(
  JSON.parse(
    run(
      [
        "cargo",
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        hostTuple,
        "--manifest-path",
        join(appRoot, "src-tauri", "Cargo.toml"),
      ],
      appRoot
    )
  ),
  readFileSync(join(appRoot, "src-tauri", "Cargo.lock"), "utf8"),
  hostTuple,
  runtimeRoot,
  {
    sysroot: run(["rustc", "--print", "sysroot"], appRoot),
    verboseVersion: run(["rustc", "-Vv"], appRoot),
  }
)

copyFileSync(
  join(repoRoot, "packages", "ui", "src", "styles", "theme.generated.css"),
  join(appRoot, "ui", "theme.generated.css")
)
copyFileSync(
  join(repoRoot, "apps", "web", "public", "pwa-512x512.png"),
  join(generatedRoot, "icon.png")
)

rmSync(extractRoot, { recursive: true, force: true })
console.log(
  `Prepared Worktable Desktop runtime ${manifest.version} for ${hostTuple}.`
)
