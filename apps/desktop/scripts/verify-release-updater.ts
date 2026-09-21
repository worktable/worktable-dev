import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { DesktopUpdaterFeed } from "./prepare-updater-release"
import {
  appRoot,
  resolveDesktopUpdaterBundlePath,
  resolveDesktopUpdaterSignaturePath,
} from "./release-paths"

function fail(message: string): never {
  throw new Error(message)
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) fail(`Required release environment variable ${name} is missing`)
  return value
}

function run(
  command: string[],
  environment: NodeJS.ProcessEnv = process.env
): { stdout: string; stderr: string } {
  const result = Bun.spawnSync(command, {
    cwd: appRoot,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = result.stdout.toString().trim()
  const stderr = result.stderr.toString().trim()
  if (!result.success) {
    throw new Error(
      `${command.join(" ")} failed with exit code ${result.exitCode}:\n${[stdout, stderr].filter(Boolean).join("\n")}`
    )
  }
  return { stdout, stderr }
}

if (process.platform !== "darwin") {
  fail("Desktop updater bundle verification requires macOS")
}

const updaterBundle = resolveDesktopUpdaterBundlePath()
const updaterSignature = resolveDesktopUpdaterSignaturePath(updaterBundle)
for (const path of [updaterBundle, updaterSignature]) {
  if (!existsSync(path)) fail(`Desktop updater artifact is missing: ${path}`)
}
const signature = readFileSync(updaterSignature, "utf8").trim()
if (!signature) fail("Desktop updater detached signature is empty")

const config = JSON.parse(
  readFileSync(join(appRoot, "src-tauri", "tauri.conf.json"), "utf8")
) as {
  plugins?: { updater?: { pubkey?: unknown } }
  version?: unknown
}
const publicKey = config.plugins?.updater?.pubkey
if (
  typeof publicKey !== "string" ||
  !publicKey.trim() ||
  publicKey.includes("REQUIRED")
) {
  fail("Desktop updater public key is missing or still a placeholder")
}
run(
  [
    "cargo",
    "run",
    "--quiet",
    "--release",
    "--manifest-path",
    join(appRoot, "src-tauri", "Cargo.toml"),
    "--example",
    "verify_updater_signature",
    "--",
    updaterBundle,
    updaterSignature,
  ],
  {
    ...process.env,
    WORKTABLE_UPDATER_PUBLIC_KEY: publicKey,
  }
)

const releaseDirectory = resolve(
  process.env.WORKTABLE_RELEASE_DIRECTORY?.trim() ||
    join(appRoot, "..", "..", "dist", "releases")
)
const feedPath = join(releaseDirectory, "desktop-updater.json")
const publicBundlePath = join(
  releaseDirectory,
  "worktable-desktop-darwin-arm64.app.tar.gz"
)
const publicSignaturePath = `${publicBundlePath}.sig`
for (const path of [feedPath, publicBundlePath, publicSignaturePath]) {
  if (!existsSync(path))
    fail(`Prepared Desktop updater asset is missing: ${path}`)
}
if (
  !readFileSync(publicBundlePath).equals(readFileSync(updaterBundle)) ||
  readFileSync(publicSignaturePath, "utf8") !==
    readFileSync(updaterSignature, "utf8")
) {
  fail("Prepared Desktop updater assets differ from Tauri's signed artifacts")
}
const feed = JSON.parse(readFileSync(feedPath, "utf8")) as DesktopUpdaterFeed
if (feed.version !== config.version) {
  fail(
    `Desktop updater feed version ${String(feed.version)} does not match Tauri version ${String(config.version)}`
  )
}
const platformKeys = Object.keys(feed.platforms ?? {})
if (platformKeys.length !== 1 || platformKeys[0] !== "darwin-aarch64") {
  fail(
    `Desktop updater feed must contain only darwin-aarch64, found: ${platformKeys.join(", ") || "none"}`
  )
}
const platform = feed.platforms["darwin-aarch64"]
if (platform.signature !== signature) {
  fail("Desktop updater feed signature does not match the detached signature")
}
const expectedUrl = `https://worktable.dev/releases/v${config.version}/worktable-desktop-darwin-arm64.app.tar.gz`
if (platform.url !== expectedUrl) {
  fail(
    `Desktop updater feed URL is not the immutable versioned artifact URL: ${platform.url}`
  )
}

const archiveEntries = run(["tar", "-tzf", updaterBundle])
  .stdout.split("\n")
  .map((entry) => entry.replace(/^\.\//, ""))
  .filter(Boolean)
if (
  archiveEntries.length === 0 ||
  archiveEntries.some(
    (entry) =>
      entry.startsWith("/") ||
      entry.split("/").includes("..") ||
      (entry !== "Worktable.app" && !entry.startsWith("Worktable.app/"))
  )
) {
  fail("Desktop updater archive contains an unsafe or unexpected path")
}

const root = mkdtempSync(join(tmpdir(), "worktable-desktop-updater-verify-"))
try {
  run(["tar", "-xzf", updaterBundle, "-C", root])
  const extractedBundle = join(root, "Worktable.app")
  if (!existsSync(extractedBundle)) {
    fail("Desktop updater archive does not contain Worktable.app")
  }
  const environment = {
    ...process.env,
    WORKTABLE_DESKTOP_BUNDLE_PATH: extractedBundle,
    WORKTABLE_DESKTOP_REQUIRE_DEVELOPER_ID: "1",
    APPLE_SIGNING_IDENTITY: requiredEnvironment("APPLE_SIGNING_IDENTITY"),
    APPLE_TEAM_ID: requiredEnvironment("APPLE_TEAM_ID"),
  }
  run([process.execPath, "run", "scripts/verify-bundle.ts"], environment)
  const bundleVersion = run([
    "plutil",
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    join(extractedBundle, "Contents", "Info.plist"),
  ]).stdout
  if (bundleVersion !== config.version) {
    fail(
      `Desktop updater archive version ${bundleVersion} does not match ${String(config.version)}`
    )
  }
  console.log(
    `Verified signed, notarized Desktop updater archive and immutable feed for ${feed.version}: ${updaterBundle}`
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
