import { existsSync, readFileSync } from "node:fs"
import { resolveDesktopDmgPath } from "./release-paths"
import { assertDeveloperIdSignature } from "./signature-contract"

interface NotarySubmission {
  id?: unknown
  message?: unknown
  status?: unknown
}

function fail(message: string): never {
  throw new Error(message)
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) fail(`Required release environment variable ${name} is missing`)
  return value
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

if (process.platform !== "darwin") {
  fail("Desktop DMG notarization requires macOS")
}

const dmg = resolveDesktopDmgPath(process.argv[2])
if (!existsSync(dmg)) fail(`Desktop DMG is missing: ${dmg}`)

const keyPath = requiredEnvironment("APPLE_API_KEY_PATH")
const keyId = requiredEnvironment("APPLE_API_KEY")
const issuer = requiredEnvironment("APPLE_API_ISSUER")
const signingIdentity = requiredEnvironment("APPLE_SIGNING_IDENTITY")
const teamId = requiredEnvironment("APPLE_TEAM_ID")
if (!existsSync(keyPath)) fail(`Apple API private key is missing: ${keyPath}`)
if (!readFileSync(keyPath, "utf8").includes("BEGIN PRIVATE KEY")) {
  fail(`Apple API private key is not a PEM private key: ${keyPath}`)
}

run(["codesign", "--verify", "--verbose=2", dmg])
const signature = run(["codesign", "--display", "--verbose=4", dmg])
assertDeveloperIdSignature(
  `${signature.stdout}\n${signature.stderr}`,
  dmg,
  { signingIdentity, teamId },
  { hardenedRuntime: false }
)
const submissionResult = run([
  "xcrun",
  "notarytool",
  "submit",
  dmg,
  "--key",
  keyPath,
  "--key-id",
  keyId,
  "--issuer",
  issuer,
  "--wait",
  "--output-format",
  "json",
])

let submission: NotarySubmission
try {
  submission = JSON.parse(submissionResult.stdout) as NotarySubmission
} catch {
  fail(`Apple notarization returned invalid JSON:\n${submissionResult.stdout}`)
}
if (submission.status !== "Accepted") {
  fail(
    `Apple rejected Desktop DMG notarization${typeof submission.id === "string" ? ` submission ${submission.id}` : ""}: ${String(submission.status ?? submission.message ?? "unknown status")}`
  )
}

run(["xcrun", "stapler", "staple", dmg])
run(["xcrun", "stapler", "validate", dmg])
console.log(
  `Notarized and stapled Desktop DMG${typeof submission.id === "string" ? ` (submission ${submission.id})` : ""}: ${dmg}`
)
