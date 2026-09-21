import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appRoot, resolveDesktopDmgPath } from "./release-paths"
import { assertDeveloperIdSignature } from "./signature-contract"

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
  fail("Desktop DMG verification requires macOS")
}

const dmg = resolveDesktopDmgPath(process.argv[2])
if (!existsSync(dmg)) fail(`Desktop DMG is missing: ${dmg}`)
const signingIdentity = requiredEnvironment("APPLE_SIGNING_IDENTITY")
const teamId = requiredEnvironment("APPLE_TEAM_ID")

run(["hdiutil", "verify", dmg])
run(["codesign", "--verify", "--verbose=2", dmg])
const signature = run(["codesign", "--display", "--verbose=4", dmg])
const signatureDetails = `${signature.stdout}\n${signature.stderr}`
assertDeveloperIdSignature(
  signatureDetails,
  dmg,
  { signingIdentity, teamId },
  { hardenedRuntime: false }
)
run(["xcrun", "stapler", "validate", dmg])
run([
  "spctl",
  "--assess",
  "--type",
  "open",
  "--context",
  "context:primary-signature",
  "--verbose=4",
  dmg,
])

const root = mkdtempSync(join(tmpdir(), "worktable-desktop-dmg-verify-"))
const mountPoint = join(root, "mounted")
const installedBundle = join(root, "Applications", "Worktable.app")
let attached = false
try {
  try {
    mkdirSync(mountPoint, { recursive: true })
    run([
      "hdiutil",
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mountPoint,
      dmg,
    ])
    attached = true
    const mountedBundle = join(mountPoint, "Worktable.app")
    if (!existsSync(mountedBundle)) {
      fail(`Mounted Desktop DMG does not contain ${mountedBundle}`)
    }
    mkdirSync(join(root, "Applications"), { recursive: true })
    run(["ditto", mountedBundle, installedBundle])
  } finally {
    if (attached) run(["hdiutil", "detach", mountPoint])
  }

  const environment = {
    ...process.env,
    WORKTABLE_DESKTOP_BUNDLE_PATH: installedBundle,
    WORKTABLE_DESKTOP_REQUIRE_DEVELOPER_ID: "1",
  }
  run([process.execPath, "run", "scripts/verify-bundle.ts"], environment)
  run([process.execPath, "run", "scripts/smoke-bundle.ts"], environment)
  console.log(
    `Verified signed, notarized, stapled, mounted, copied, and launched Desktop DMG: ${dmg}`
  )
} finally {
  rmSync(root, { recursive: true, force: true })
}
