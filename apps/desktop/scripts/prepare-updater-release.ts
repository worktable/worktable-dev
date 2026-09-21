import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  resolveDesktopUpdaterBundlePath,
  resolveDesktopUpdaterSignaturePath,
} from "./release-paths"

const updaterBundleName = "worktable-desktop-darwin-arm64.app.tar.gz"
const updaterSignatureName = `${updaterBundleName}.sig`
const updaterFeedName = "desktop-updater.json"
const stableVersionPattern = /^\d+\.\d+\.\d+$/
const rfc3339Pattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

interface DesktopPackage {
  version: string
}

export interface DesktopUpdaterFeed {
  version: string
  notes: string
  pub_date: string
  platforms: {
    "darwin-aarch64": {
      signature: string
      url: string
    }
  }
}

export interface PrepareDesktopUpdaterReleaseOptions {
  appVersion: string
  tag: string
  pubDate: string
  releaseNotes: string
  releaseDirectory: string
  updaterBundlePath: string
  updaterSignaturePath: string
}

export interface PreparedDesktopUpdaterRelease {
  bundlePath: string
  signaturePath: string
  feedPath: string
  feed: DesktopUpdaterFeed
}

function fail(message: string): never {
  throw new Error(message)
}

function normalizePubDate(value: string): string {
  const trimmed = value.trim()
  if (!rfc3339Pattern.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    fail(`Desktop updater publication date is not RFC3339: ${value}`)
  }
  return new Date(trimmed).toISOString()
}

export function renderDesktopUpdaterNotes(markdown: string): string {
  const beforeInstallFooter = markdown.split(/\r?\n---\r?(?:\n|$)/, 1)[0]
  let insideFence = false
  const rendered = beforeInstallFooter
    .split(/\r?\n/)
    .flatMap((sourceLine) => {
      const trimmed = sourceLine.trim()
      if (/^```/.test(trimmed)) {
        insideFence = !insideFence
        return []
      }
      if (insideFence || /^<!--.*-->$/.test(trimmed)) return []
      const line = trimmed
        .replace(/^#{1,6}\s+/, "")
        .replace(/^[-*+]\s+/, "• ")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/\*([^*]+)\*/g, "$1")
        .replace(/_([^_]+)_/g, "$1")
        .replace(/~~([^~]+)~~/g, "$1")
        .replace(/<[^>]+>/g, "")
        .trim()
      return [line]
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (!rendered) fail("Desktop updater release notes are empty")
  return rendered
}

export function prepareDesktopUpdaterRelease(
  options: PrepareDesktopUpdaterReleaseOptions
): PreparedDesktopUpdaterRelease {
  const appVersion = options.appVersion.trim()
  if (!stableVersionPattern.test(appVersion)) {
    fail(`Desktop updater version must be stable semver: ${options.appVersion}`)
  }
  if (options.tag.trim() !== `v${appVersion}`) {
    fail(
      `Desktop updater tag ${options.tag} does not match application version ${appVersion}`
    )
  }

  const signature = readFileSync(options.updaterSignaturePath, "utf8").trim()
  if (!signature) fail("Desktop updater detached signature is empty")

  const releaseNotes = renderDesktopUpdaterNotes(options.releaseNotes)

  const releaseDirectory = resolve(options.releaseDirectory)
  mkdirSync(releaseDirectory, { recursive: true })
  const bundlePath = join(releaseDirectory, updaterBundleName)
  const signaturePath = join(releaseDirectory, updaterSignatureName)
  const feedPath = join(releaseDirectory, updaterFeedName)
  copyFileSync(options.updaterBundlePath, bundlePath)
  copyFileSync(options.updaterSignaturePath, signaturePath)

  const feed: DesktopUpdaterFeed = {
    version: appVersion,
    notes: releaseNotes,
    pub_date: normalizePubDate(options.pubDate),
    platforms: {
      "darwin-aarch64": {
        signature,
        url: `https://worktable.dev/releases/v${appVersion}/${updaterBundleName}`,
      },
    },
  }
  writeFileSync(feedPath, `${JSON.stringify(feed, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o644,
  })

  return { bundlePath, signaturePath, feedPath, feed }
}

function run(command: string[]): string {
  const result = Bun.spawnSync(command, {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (!result.success) {
    const detail = [result.stdout.toString(), result.stderr.toString()]
      .map((value) => value.trim())
      .filter(Boolean)
      .join("\n")
    fail(`${command.join(" ")} failed${detail ? `:\n${detail}` : ""}`)
  }
  return result.stdout.toString().trim()
}

if (import.meta.main) {
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const repoRoot = resolve(appRoot, "../..")
  const desktopPackage = JSON.parse(
    readFileSync(join(appRoot, "package.json"), "utf8")
  ) as DesktopPackage
  const releaseDirectory = resolve(
    process.env.WORKTABLE_RELEASE_DIRECTORY?.trim() ||
      join(repoRoot, "dist", "releases")
  )
  const releaseNotesPath = resolve(
    process.env.WORKTABLE_RELEASE_NOTES_PATH?.trim() ||
      join(releaseDirectory, "RELEASE_NOTES.md")
  )
  const tag =
    process.env.WORKTABLE_RELEASE_TAG?.trim() || `v${desktopPackage.version}`
  const pubDate =
    process.env.WORKTABLE_UPDATER_PUB_DATE?.trim() ||
    run(["git", "show", "-s", "--format=%cI", "HEAD"])

  const prepared = prepareDesktopUpdaterRelease({
    appVersion: desktopPackage.version,
    tag,
    pubDate,
    releaseNotes: readFileSync(releaseNotesPath, "utf8"),
    releaseDirectory,
    updaterBundlePath: resolveDesktopUpdaterBundlePath(),
    updaterSignaturePath: resolveDesktopUpdaterSignaturePath(),
  })
  console.log(
    `Prepared signed Desktop updater assets for ${prepared.feed.version}: ${prepared.bundlePath}, ${prepared.signaturePath}, ${prepared.feedPath}`
  )
}
