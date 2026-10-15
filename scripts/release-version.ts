import type { ReleaseProfile } from "./release-targets.ts"

// Version stamped into a build.
//
// Releases carry the version prepared in package.json. Every other build of
// public source is unreleased, so it must not claim that version: a lab or beta
// build is X.Y.Z-dev.N+<commit>, where X.Y.Z is the release it leads up to, N
// is the commit count (monotonic along main) and <commit> the short commit.
// Semantic-version precedence orders it after the previous release and before
// X.Y.Z itself, so updaters treat it correctly on both sides.

const RELEASE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/
const DEV_VERSION = /^(\d+)\.(\d+)\.(\d+)-dev\.(\d+)\+([0-9a-f]{7})$/

export function isReleaseVersion(version: string): boolean {
  return RELEASE_VERSION.test(version)
}

/** True when `version` is a dev build version of exactly `commit`. */
export function isDevVersionOf(version: string, commit: string): boolean {
  const match = DEV_VERSION.exec(version)
  return Boolean(match && commit.startsWith(match[5]!))
}

export function devVersion(input: {
  packageVersion: string
  /** Whether `packageVersion` has already been released (its tag exists). */
  packageVersionReleased: boolean
  commitCount: number
  commit: string
}): string {
  const match = RELEASE_VERSION.exec(input.packageVersion)
  if (!match) {
    throw new Error(
      `package.json version must be X.Y.Z, got ${input.packageVersion}`
    )
  }
  if (!/^[0-9a-f]{40}$/.test(input.commit)) {
    throw new Error("A dev version needs the full source commit")
  }
  if (!Number.isInteger(input.commitCount) || input.commitCount < 1) {
    throw new Error("A dev version needs the source commit count")
  }
  const [major, minor, patch] = [match[1], match[2], match[3]].map(Number)
  // Once package.json's version is released, the next build leads up to the
  // following patch. A version prepared but not yet released is the target.
  const base = input.packageVersionReleased
    ? `${major}.${minor}.${patch! + 1}`
    : input.packageVersion
  return `${base}-dev.${input.commitCount}+${input.commit.slice(0, 7)}`
}

export function resolveBuildVersion(input: {
  root: string
  profile: ReleaseProfile
  packageVersion: string
  env?: NodeJS.ProcessEnv
}): string {
  const env = input.env ?? process.env
  const explicit = env["WORKTABLE_VERSION"]
  if (explicit) return explicit
  if (input.profile === "full") return input.packageVersion
  const git = (args: string[]): string => {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: input.root,
      stdout: "pipe",
      stderr: "ignore",
    })
    if (!result.success) {
      throw new Error(
        `Lab builds take their version from Git history: git ${args.join(" ")} failed`
      )
    }
    return result.stdout.toString().trim()
  }
  const released = Bun.spawnSync(
    [
      "git",
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/tags/v${input.packageVersion}`,
    ],
    { cwd: input.root, stdout: "ignore", stderr: "ignore" }
  ).success
  return devVersion({
    packageVersion: input.packageVersion,
    packageVersionReleased: released,
    commitCount: Number(git(["rev-list", "--count", "HEAD"])),
    commit: git(["rev-parse", "HEAD"]),
  })
}
