export interface ReleaseTarget {
  artifact: string
  bunTarget: string
  platform: "darwin" | "linux"
  arch: "arm64" | "x64"
}

export const CLI_RELEASE_TARGETS: ReleaseTarget[] = [
  {
    artifact: "worktable-darwin-arm64.tar.gz",
    bunTarget: "bun-darwin-arm64",
    platform: "darwin",
    arch: "arm64",
  },
  {
    artifact: "worktable-darwin-x64.tar.gz",
    bunTarget: "bun-darwin-x64",
    platform: "darwin",
    arch: "x64",
  },
  {
    artifact: "worktable-linux-x64.tar.gz",
    bunTarget: "bun-linux-x64-baseline",
    platform: "linux",
    arch: "x64",
  },
  {
    artifact: "worktable-linux-arm64.tar.gz",
    bunTarget: "bun-linux-arm64",
    platform: "linux",
    arch: "arm64",
  },
]

export const SERVER_RELEASE_TARGETS: ReleaseTarget[] = [
  {
    artifact: "worktable-server-linux-x64.tar.gz",
    bunTarget: "bun-linux-x64-baseline",
    platform: "linux",
    arch: "x64",
  },
]

export function skillInstallerArtifact(target: ReleaseTarget): string {
  return `worktable-skills-${target.platform}-${target.arch}.tar.gz`
}

export type ReleaseProfile = "full" | "lab"

export function releaseOutputNames(profile: ReleaseProfile): {
  artifacts: string
  work: string
} {
  return profile === "lab"
    ? { artifacts: "lab-releases", work: "lab-release-work" }
    : { artifacts: "releases", work: "release-work" }
}

export function parseReleaseProfile(argv: string[]): ReleaseProfile {
  const index = argv.indexOf("--profile")
  if (index === -1) return "full"
  const value = argv[index + 1]
  if (value === "full" || value === "lab") return value
  throw new Error(
    `Unsupported release profile: ${value ?? "(missing)"}. Expected full or lab.`
  )
}

export function selectReleaseTargets(options: {
  profile: ReleaseProfile
  platform: NodeJS.Platform
  arch: string
}): { cli: ReleaseTarget[]; server: ReleaseTarget[] } {
  if (options.profile === "full")
    return { cli: CLI_RELEASE_TARGETS, server: SERVER_RELEASE_TARGETS }
  if (options.platform !== "linux" && options.platform !== "darwin")
    throw new Error(
      `The lab release profile does not support ${options.platform} hosts.`
    )

  const arch =
    options.arch === "x64" || options.arch === "x86_64"
      ? "x64"
      : options.arch === "arm64" || options.arch === "aarch64"
        ? "arm64"
        : undefined
  if (!arch)
    throw new Error(
      `Unsupported host architecture for the lab release profile: ${options.arch}`
    )

  const target = CLI_RELEASE_TARGETS.find(
    (candidate) => candidate.platform === "linux" && candidate.arch === arch
  )
  if (!target)
    throw new Error(`No Linux guest release target is registered for ${arch}.`)
  return { cli: [target], server: [] }
}
