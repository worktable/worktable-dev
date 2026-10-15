import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  isDevVersionOf,
  isReleaseVersion,
} from "../../../scripts/release-version.ts"
import { appRoot } from "./release-paths"

// The version a Desktop build carries.
//
// A release carries the version prepared in tauri.conf.json. A beta build of
// unreleased main carries the dev version its beta prerelease has
// (X.Y.Z-dev.N+<commit>, scripts/release-version.ts), passed in through
// WORKTABLE_VERSION exactly as the CLI build takes it. It is published under
// the beta's tag, which drops the build metadata.

export function resolveDesktopVersion(input: {
  configVersion: string
  buildVersion: string | undefined
  commit: string
}): string {
  const configVersion = input.configVersion.trim()
  if (!isReleaseVersion(configVersion)) {
    throw new Error(
      `Desktop's prepared version must be X.Y.Z: ${configVersion}`
    )
  }
  const buildVersion = input.buildVersion?.trim()
  if (!buildVersion || buildVersion === configVersion) return configVersion
  if (isDevVersionOf(buildVersion, input.commit)) return buildVersion
  throw new Error(
    `WORKTABLE_VERSION ${buildVersion} is neither Desktop's version ${configVersion} nor a beta build of ${input.commit}`
  )
}

/** The release tag that publishes `version`: `v` without build metadata. */
export function desktopReleaseTag(version: string): string {
  return `v${version.split("+", 1)[0]}`
}

/** This checkout's Desktop build version, from tauri.conf.json and the environment. */
export function desktopBuildVersion(
  environment: NodeJS.ProcessEnv = process.env
): string {
  const config = JSON.parse(
    readFileSync(join(appRoot, "src-tauri", "tauri.conf.json"), "utf8")
  ) as { version: string }
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: appRoot,
    stdout: "pipe",
    stderr: "ignore",
  })
  return resolveDesktopVersion({
    configVersion: config.version,
    buildVersion: environment.WORKTABLE_VERSION,
    commit: head.success ? head.stdout.toString().trim() : "",
  })
}

if (import.meta.main) {
  const version = desktopBuildVersion()
  console.log(process.argv[2] === "tag" ? desktopReleaseTag(version) : version)
}
