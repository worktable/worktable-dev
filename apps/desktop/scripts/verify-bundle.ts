import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { resolveDesktopBundlePath } from "./release-paths"
import { assertDeveloperIdSignature } from "./signature-contract"
import { verifyReleaseLicenses } from "../../../scripts/release-licenses.ts"
import { verifyNativeNotices } from "../../../scripts/native-notices.ts"

const bundle = resolveDesktopBundlePath()
const contents = join(bundle, "Contents")
const shellBinary = join(contents, "MacOS", "worktable-desktop")
const sidecarBinary = join(contents, "MacOS", "worktable")
const runtimeRoot = join(contents, "Resources", "worktable-runtime")
const expectedEnvironment =
  process.env.WORKTABLE_DESKTOP_EXPECTED_ENVIRONMENT === "staging"
    ? "staging"
    : "production"
const skillInventory = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../plugins/worktable/skill-inventory.json"),
    "utf8"
  )
) as {
  skills: Array<{ name: string; files: string[] }>
}

function run(command: string[]): { stdout: string; stderr: string } {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" })
  const stdout = result.stdout.toString().trim()
  const stderr = result.stderr.toString().trim()
  if (!result.success) {
    throw new Error(
      `${command.join(" ")} failed with exit code ${result.exitCode}:\n${[stdout, stderr].filter(Boolean).join("\n")}`
    )
  }
  return { stdout, stderr }
}

function minimumVersion(binary: string): string {
  const match = run(["otool", "-l", binary]).stdout.match(
    /\bminos\s+(\d+(?:\.\d+)*)/
  )
  if (!match?.[1])
    throw new Error(`Could not read macOS deployment target from ${binary}`)
  return match[1]
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

for (const path of [
  bundle,
  shellBinary,
  sidecarBinary,
  join(runtimeRoot, "manifest.json"),
  join(runtimeRoot, "web", "_shell.html"),
  join(runtimeRoot, "connector", "connect.mjs"),
  join(runtimeRoot, "integrations", "worktable-claude-desktop.mcpb"),
  ...skillInventory.skills.flatMap(({ name, files }) =>
    files.map((file) =>
      join(runtimeRoot, "integrations", "worktable-skills", name, file)
    )
  ),
]) {
  if (!existsSync(path)) throw new Error(`Bundle is missing ${path}`)
}

verifyReleaseLicenses(join(import.meta.dir, "../../.."), runtimeRoot, "desktop")
run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", bundle])
const infoPlist = join(contents, "Info.plist")
const expectedIdentifier =
  expectedEnvironment === "staging"
    ? "dev.worktable.desktop.staging"
    : "dev.worktable.desktop"
const actualIdentifier = run([
  "plutil",
  "-extract",
  "CFBundleIdentifier",
  "raw",
  infoPlist,
]).stdout
if (actualIdentifier !== expectedIdentifier) {
  throw new Error(
    `Desktop bundle identifier ${actualIdentifier} does not match ${expectedIdentifier}`
  )
}
const stagingOrigin = process.env.WORKTABLE_DESKTOP_STAGING_ORIGIN
if (expectedEnvironment === "staging" && !stagingOrigin) {
  throw new Error(
    "Staging verification requires WORKTABLE_DESKTOP_STAGING_ORIGIN"
  )
}
const shellStrings = run(["strings", shellBinary]).stdout
const requiredBinaryValues =
  expectedEnvironment === "staging"
    ? [stagingOrigin!, "dev.worktable.desktop.staging.workos"]
    : ["https://app.worktable.cloud", "dev.worktable.desktop.workos"]
for (const value of requiredBinaryValues) {
  if (!shellStrings.includes(value)) {
    throw new Error(
      `Desktop shell is missing its ${expectedEnvironment} identity`
    )
  }
}
if (expectedEnvironment === "production") {
  for (const forbidden of [
    ...(stagingOrigin ? [stagingOrigin] : []),
    "dev.worktable.desktop.staging",
    "dev.worktable.desktop.staging.workos",
  ]) {
    if (shellStrings.includes(forbidden)) {
      throw new Error(`Production Desktop shell contains staging identity`)
    }
  }
} else if (
  shellStrings.includes(
    "https://worktable.dev/releases/latest/desktop-updater.json"
  )
) {
  throw new Error("Staging Desktop shell contains the production updater feed")
}
const production = process.env.WORKTABLE_DESKTOP_REQUIRE_DEVELOPER_ID === "1"
if (production) {
  const signingIdentity = process.env.APPLE_SIGNING_IDENTITY?.trim()
  const teamId = process.env.APPLE_TEAM_ID?.trim()
  if (!signingIdentity || !teamId) {
    throw new Error(
      "Production bundle verification requires APPLE_SIGNING_IDENTITY and APPLE_TEAM_ID"
    )
  }
  for (const signedPath of [bundle, shellBinary, sidecarBinary]) {
    const display = run(["codesign", "--display", "--verbose=4", signedPath])
    const details = `${display.stdout}\n${display.stderr}`
    assertDeveloperIdSignature(
      details,
      signedPath,
      { signingIdentity, teamId },
      { hardenedRuntime: true }
    )
    const entitlements = run([
      "codesign",
      "--display",
      "--entitlements",
      "-",
      signedPath,
    ])
    if (
      `${entitlements.stdout}\n${entitlements.stderr}`.includes(
        "com.apple.security.get-task-allow"
      )
    ) {
      throw new Error(
        `${signedPath} enables the development get-task-allow entitlement`
      )
    }
  }
  run(["xcrun", "stapler", "validate", bundle])
  run(["spctl", "--assess", "--type", "execute", "--verbose=4", bundle])
}
const advertisedMinimum = run([
  "plutil",
  "-extract",
  "LSMinimumSystemVersion",
  "raw",
  infoPlist,
]).stdout
for (const binary of [shellBinary, sidecarBinary]) {
  const binaryMinimum = minimumVersion(binary)
  if (compareVersions(advertisedMinimum, binaryMinimum) < 0) {
    throw new Error(
      `Bundle advertises macOS ${advertisedMinimum}, but ${binary} requires ${binaryMinimum}`
    )
  }
}

const release = JSON.parse(
  readFileSync(join(runtimeRoot, "manifest.json"), "utf8")
) as {
  version: string
  arch: string
}
const nativeTarget =
  release.arch === "arm64"
    ? "aarch64-apple-darwin"
    : release.arch === "x64"
      ? "x86_64-apple-darwin"
      : "unsupported"
verifyNativeNotices(runtimeRoot, nativeTarget)
console.log(
  `Verified ${production ? "Developer ID signed and notarized" : "signed"} Worktable Desktop bundle with runtime ${release.version} (macOS ${advertisedMinimum}+): ${bundle}`
)
