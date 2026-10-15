import {
  compareVersions,
  normalizeVersion,
  releaseTagForVersion,
  resolveChannelTarget,
  UPDATE_CHANNELS,
  type UpdateChannel,
} from "../packages/server/src/release-channels.ts"
import { isDevVersionOf } from "./release-version.ts"

// Maintains the release-channel manifest that every updater reads.
//
// channels.json lives on the `release-channels` branch of the public
// repository and is served at https://worktable.dev/releases/channels.json.
// Release automation moves a channel forward; anyone with release access holds
// or releases a channel. Updaters never move an install to a held version, and
// installing fails closed when the manifest can't be read.
//
//   bun scripts/release-channels.ts show
//   bun scripts/release-channels.ts publish <channel> <version> <commit>
//   bun scripts/release-channels.ts hold <channel>
//   bun scripts/release-channels.ts release <channel>
//   bun scripts/release-channels.ts prune-beta [--keep N]
//   bun scripts/release-channels.ts soak <commit>
//   bun scripts/release-channels.ts publish-desktop <version> <commit>
//   bun scripts/release-channels.ts desktop-due [--last-attempt ISO] [--min-hours H] [--force]
//
// Writes need GH_TOKEN with contents: write on the repository
// (RELEASE_CHANNELS_REPOSITORY, default worktable/worktable-dev).

export const CHANNELS_BRANCH = "release-channels"
export const CHANNELS_PATH = "channels.json"

/** A signed Desktop build published with a beta prerelease. */
export interface DesktopBuildRecord {
  version: string
  tag: string
  commit: string
  publishedAt: string
}

export interface ChannelRecord {
  version: string
  tag: string
  commit: string
  publishedAt: string
  held: boolean
  /**
   * Beta only: the newest beta with a signed Desktop build. Desktop builds are
   * made less often than beta moves, and Desktop on beta installs only this.
   */
  desktop?: DesktopBuildRecord
}

export interface ChannelsManifest {
  schema: 1
  channels: Partial<Record<UpdateChannel, ChannelRecord>>
}

function isChannel(value: string): value is UpdateChannel {
  return (UPDATE_CHANNELS as readonly string[]).includes(value)
}

export function parseManifest(text: string | null): ChannelsManifest {
  if (text === null) return { schema: 1, channels: {} }
  const parsed = JSON.parse(text) as ChannelsManifest
  if (parsed?.schema !== 1 || !parsed.channels) {
    throw new Error("channels.json is not a schema 1 manifest")
  }
  return parsed
}

export function serializeManifest(manifest: ChannelsManifest): string {
  const text = JSON.stringify(manifest, null, 2) + "\n"
  // Never write what updaters would reject. Stable must exist first: publish
  // the current stable release before the first beta.
  if (!resolveChannelTarget(JSON.parse(text), "stable")) {
    throw new Error(
      "Refusing to write a manifest updaters would reject (stable is required)"
    )
  }
  return text
}

/**
 * Point `channel` at `version`. Beta only moves forward, so an older build
 * finishing late never replaces a newer one, and a held beta stays held for
 * new builds. Publishing a stable release releases a hold on stable: the
 * release is the deliberate act that ends it.
 */
export function publishChannel(
  manifest: ChannelsManifest,
  input: {
    channel: UpdateChannel
    version: string
    commit: string
    publishedAt: string
  }
): { manifest: ChannelsManifest; changed: boolean } {
  const version = normalizeVersion(input.version)
  const tag = version ? releaseTagForVersion(version) : null
  if (!version || !tag) throw new Error(`Not a version: ${input.version}`)
  // Stable only ever offers releases, never a beta build.
  if (input.channel === "stable" && !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Stable takes a release version (X.Y.Z), not ${version}`)
  }
  if (!/^[0-9a-f]{40}$/.test(input.commit)) {
    throw new Error("publish needs the full 40-character source commit")
  }
  const current = manifest.channels[input.channel]
  if (
    input.channel === "beta" &&
    current &&
    compareVersions(current.version, version) >= 0
  ) {
    return { manifest, changed: false }
  }
  const record: ChannelRecord = {
    version,
    tag,
    commit: input.commit,
    publishedAt: input.publishedAt,
    held: input.channel === "beta" ? (current?.held ?? false) : false,
    // A new beta keeps naming the newest beta that has a Desktop build.
    ...(input.channel === "beta" && current?.desktop
      ? { desktop: current.desktop }
      : {}),
  }
  return {
    manifest: {
      ...manifest,
      channels: { ...manifest.channels, [input.channel]: record },
    },
    changed: true,
  }
}

/**
 * Record that beta `version` now has a signed Desktop build. Only ever moves
 * forward, and only to a version beta has offered.
 */
export function publishDesktop(
  manifest: ChannelsManifest,
  input: { version: string; commit: string; publishedAt: string }
): { manifest: ChannelsManifest; changed: boolean } {
  const version = normalizeVersion(input.version)
  const tag = version ? releaseTagForVersion(version) : null
  if (!version || !tag) throw new Error(`Not a version: ${input.version}`)
  if (!/^[0-9a-f]{40}$/.test(input.commit)) {
    throw new Error("publish-desktop needs the full 40-character source commit")
  }
  if (!isDevVersionOf(version, input.commit)) {
    throw new Error(
      `A Desktop beta is a dev build of its full source commit, not ${version} of ${input.commit}`
    )
  }
  const beta = manifest.channels.beta
  if (!beta) throw new Error("The beta channel has no build yet")
  if (compareVersions(version, beta.version) > 0) {
    throw new Error(`Beta has not offered ${version} yet`)
  }
  if (beta.desktop && compareVersions(beta.desktop.version, version) >= 0) {
    return { manifest, changed: false }
  }
  return {
    manifest: {
      ...manifest,
      channels: {
        ...manifest.channels,
        beta: {
          ...beta,
          desktop: {
            version,
            tag,
            commit: input.commit,
            publishedAt: input.publishedAt,
          },
        },
      },
    },
    changed: true,
  }
}

export type DesktopBuildDecision =
  | { due: true; version: string; tag: string; commit: string }
  | { due: false; reason: string }

/**
 * Whether to build a signed Desktop for the newest beta. A macOS build is
 * costly, so it runs only when beta has a build Desktop lacks, and at most
 * once per `minIntervalMs` since the last attempt unless forced.
 */
export function desktopBuildDue(
  manifest: ChannelsManifest,
  input: {
    now: number
    lastAttemptAt: number | null
    minIntervalMs: number
    force: boolean
  }
): DesktopBuildDecision {
  const beta = manifest.channels.beta
  if (!beta) return { due: false, reason: "Beta has no build yet." }
  if (beta.held) return { due: false, reason: "Beta is held." }
  if (
    beta.desktop &&
    compareVersions(beta.desktop.version, beta.version) >= 0
  ) {
    return {
      due: false,
      reason: `Beta ${beta.version} already has a Desktop build.`,
    }
  }
  if (
    !input.force &&
    input.lastAttemptAt !== null &&
    input.now - input.lastAttemptAt < input.minIntervalMs
  ) {
    const hours = (input.now - input.lastAttemptAt) / 3_600_000
    return {
      due: false,
      reason: `The last Desktop build started ${hours.toFixed(1)} h ago.`,
    }
  }
  return {
    due: true,
    version: beta.version,
    tag: beta.tag,
    commit: beta.commit,
  }
}

export function setHeld(
  manifest: ChannelsManifest,
  channel: UpdateChannel,
  held: boolean
): { manifest: ChannelsManifest; changed: boolean } {
  const current = manifest.channels[channel]
  if (!current) throw new Error(`The ${channel} channel has no release yet`)
  if (current.held === held) return { manifest, changed: false }
  return {
    manifest: {
      ...manifest,
      channels: { ...manifest.channels, [channel]: { ...current, held } },
    },
    changed: true,
  }
}

const DEV_TAG = /^v\d+\.\d+\.\d+-dev\.\d+$/

/** One state of channels.json, from the moment it was committed. */
export interface ManifestSnapshot {
  at: number
  manifest: ChannelsManifest
}

/**
 * How long `commit` has been what beta installs run: the time the beta
 * channel pointed at it, unheld, until it moved on (or until `now`). A build
 * replaced by a newer beta stops soaking, even though the newer one contains
 * its changes, because a later fix could hide its bugs.
 */
export function betaResidenceMs(
  history: ManifestSnapshot[],
  commit: string,
  now: number
): number {
  const ordered = [...history].sort((left, right) => left.at - right.at)
  let total = 0
  ordered.forEach((snapshot, index) => {
    const beta = snapshot.manifest.channels.beta
    if (!beta || beta.held || beta.commit !== commit) return
    const end = ordered[index + 1]?.at ?? now
    total += Math.max(0, Math.min(end, now) - snapshot.at)
  })
  return total
}

/**
 * Beta tags to delete: all but the newest `keep`, never one the manifest
 * points at (the current beta, and the beta Desktop installs).
 */
export function betaTagsToPrune(
  tags: string[],
  keep: number,
  kept: Array<string | undefined>
): string[] {
  return tags
    .filter((tag) => DEV_TAG.test(tag))
    .sort((left, right) => compareVersions(right, left))
    .slice(keep)
    .filter((tag) => !kept.includes(tag))
}

// ── GitHub ──────────────────────────────────────────────────────────────────

const repository =
  process.env["RELEASE_CHANNELS_REPOSITORY"] ?? "worktable/worktable-dev"
const api = process.env["GITHUB_API_URL"] ?? "https://api.github.com"

async function github(
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<Response> {
  const token = process.env["GH_TOKEN"] ?? process.env["GITHUB_TOKEN"]
  return fetch(`${api}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(30_000),
  })
}

async function expectOk(response: Response, action: string): Promise<any> {
  if (!response.ok) {
    throw new Error(
      `${action} failed: HTTP ${response.status} ${await response.text()}`
    )
  }
  return response.status === 204 ? null : response.json()
}

async function readRemote(): Promise<{
  text: string | null
  sha: string | null
  branchExists: boolean
}> {
  const response = await github(
    `/repos/${repository}/contents/${CHANNELS_PATH}?ref=${CHANNELS_BRANCH}`
  )
  if (response.status === 404) {
    const branch = await github(
      `/repos/${repository}/branches/${CHANNELS_BRANCH}`
    )
    return { text: null, sha: null, branchExists: branch.ok }
  }
  const body = await expectOk(response, "Reading channels.json")
  return {
    text: Buffer.from(body.content, "base64").toString("utf8"),
    sha: body.sha,
    branchExists: true,
  }
}

/** Create the branch as an orphan holding only channels.json. */
async function createBranch(text: string, message: string): Promise<void> {
  const blob = await expectOk(
    await github(`/repos/${repository}/git/blobs`, {
      method: "POST",
      body: { content: text, encoding: "utf-8" },
    }),
    "Creating the manifest blob"
  )
  const tree = await expectOk(
    await github(`/repos/${repository}/git/trees`, {
      method: "POST",
      body: {
        tree: [
          { path: CHANNELS_PATH, mode: "100644", type: "blob", sha: blob.sha },
        ],
      },
    }),
    "Creating the manifest tree"
  )
  const commit = await expectOk(
    await github(`/repos/${repository}/git/commits`, {
      method: "POST",
      body: { message, tree: tree.sha, parents: [] },
    }),
    "Creating the manifest commit"
  )
  await expectOk(
    await github(`/repos/${repository}/git/refs`, {
      method: "POST",
      body: { ref: `refs/heads/${CHANNELS_BRANCH}`, sha: commit.sha },
    }),
    "Creating the release-channels branch"
  )
}

/**
 * Read, change and write channels.json with optimistic concurrency, retrying
 * when another writer (a beta build, a release, a hold) got there first.
 */
async function updateRemote(
  change: (manifest: ChannelsManifest) => {
    manifest: ChannelsManifest
    changed: boolean
  },
  message: string
): Promise<ChannelsManifest> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const remote = await readRemote()
    const result = change(parseManifest(remote.text))
    if (!result.changed) return result.manifest
    const text = serializeManifest(result.manifest)
    if (!remote.branchExists) {
      await createBranch(text, message)
      return result.manifest
    }
    const response = await github(
      `/repos/${repository}/contents/${CHANNELS_PATH}`,
      {
        method: "PUT",
        body: {
          message,
          content: Buffer.from(text).toString("base64"),
          branch: CHANNELS_BRANCH,
          ...(remote.sha ? { sha: remote.sha } : {}),
        },
      }
    )
    if (response.ok) return result.manifest
    // 409/422: the file changed under us. Read it again and reapply.
    if (response.status !== 409 && response.status !== 422) {
      await expectOk(response, "Writing channels.json")
    }
    await Bun.sleep(attempt * 1_000)
  }
  throw new Error("channels.json kept changing; giving up after 5 attempts")
}

/** channels.json as of every change since `since` (ISO), oldest first. */
async function readHistory(since: string): Promise<ManifestSnapshot[]> {
  const snapshots: ManifestSnapshot[] = []
  for (let page = 1; page <= 10; page += 1) {
    const commits = (await expectOk(
      await github(
        `/repos/${repository}/commits?sha=${CHANNELS_BRANCH}&path=${CHANNELS_PATH}&since=${encodeURIComponent(since)}&per_page=100&page=${page}`
      ),
      "Listing channel history"
    )) as Array<{ sha: string; commit: { committer: { date: string } } }>
    for (const entry of commits) {
      const file = await expectOk(
        await github(
          `/repos/${repository}/contents/${CHANNELS_PATH}?ref=${entry.sha}`
        ),
        `Reading channels.json at ${entry.sha}`
      )
      snapshots.push({
        at: Date.parse(entry.commit.committer.date),
        manifest: parseManifest(
          Buffer.from(file.content, "base64").toString("utf8")
        ),
      })
    }
    if (commits.length < 100) break
  }
  return snapshots.sort((left, right) => left.at - right.at)
}

async function listReleaseTags(): Promise<string[]> {
  const tags: string[] = []
  for (let page = 1; page <= 10; page += 1) {
    const releases = (await expectOk(
      await github(`/repos/${repository}/releases?per_page=100&page=${page}`),
      "Listing releases"
    )) as Array<{ tag_name: string; prerelease: boolean }>
    tags.push(
      ...releases.filter((release) => release.prerelease).map((r) => r.tag_name)
    )
    if (releases.length < 100) break
  }
  return tags
}

async function deleteRelease(tag: string): Promise<void> {
  const release = await expectOk(
    await github(`/repos/${repository}/releases/tags/${tag}`),
    `Finding ${tag}`
  )
  await expectOk(
    await github(`/repos/${repository}/releases/${release.id}`, {
      method: "DELETE",
    }),
    `Deleting release ${tag}`
  )
  const ref = await github(`/repos/${repository}/git/refs/tags/${tag}`, {
    method: "DELETE",
  })
  if (!ref.ok && ref.status !== 422 && ref.status !== 404) {
    await expectOk(ref, `Deleting tag ${tag}`)
  }
}

function usage(): never {
  console.error(
    "usage: release-channels.ts show | publish <channel> <version> <commit> | hold <channel> | release <channel> | prune-beta [--keep N] | soak <commit> | publish-desktop <version> <commit> | desktop-due [--last-attempt ISO] [--min-hours H] [--force]"
  )
  process.exit(2)
}

function channelArgument(value: string | undefined): UpdateChannel {
  if (!value || !isChannel(value)) usage()
  return value
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  const at = new Date().toISOString()
  if (command === "show") {
    const remote = await readRemote()
    process.stdout.write(remote.text ?? "{}\n")
  } else if (command === "publish") {
    const channel = channelArgument(args[0])
    const version = args[1] ?? usage()
    const commit = args[2] ?? usage()
    const manifest = await updateRemote(
      (current) =>
        publishChannel(current, { channel, version, commit, publishedAt: at }),
      `Point ${channel} at ${version}`
    )
    console.log(`${channel}: ${JSON.stringify(manifest.channels[channel])}`)
  } else if (command === "hold" || command === "release") {
    const channel = channelArgument(args[0])
    const held = command === "hold"
    const manifest = await updateRemote(
      (current) => setHeld(current, channel, held),
      `${held ? "Hold" : "Release"} ${channel}`
    )
    console.log(`${channel}: ${JSON.stringify(manifest.channels[channel])}`)
  } else if (command === "soak") {
    // Prints the hours `commit` has been the unheld beta build.
    const commit = args[0] ?? usage()
    if (!/^[0-9a-f]{40}$/.test(commit)) usage()
    const source = await expectOk(
      await github(`/repos/${repository}/commits/${commit}`),
      `Reading ${commit}`
    )
    const history = await readHistory(source.commit.committer.date)
    const hours = betaResidenceMs(history, commit, Date.now()) / 3_600_000
    console.log(hours.toFixed(1))
  } else if (command === "publish-desktop") {
    const version = args[0] ?? usage()
    const commit = args[1] ?? usage()
    const manifest = await updateRemote(
      (current) =>
        publishDesktop(current, { version, commit, publishedAt: at }),
      `Offer Desktop ${version} on beta`
    )
    console.log(`beta: ${JSON.stringify(manifest.channels.beta)}`)
  } else if (command === "desktop-due") {
    // Prints {"due": true, version, tag, commit} or {"due": false, reason}.
    const option = (name: string) => {
      const index = args.indexOf(name)
      return index === -1 ? undefined : args[index + 1]
    }
    const lastAttempt = option("--last-attempt")
    const lastAttemptAt = lastAttempt ? Date.parse(lastAttempt) : null
    const minHours = Number(option("--min-hours") ?? 3)
    if (Number.isNaN(lastAttemptAt) || !(minHours >= 0)) usage()
    const decision = desktopBuildDue(parseManifest((await readRemote()).text), {
      now: Date.now(),
      lastAttemptAt,
      minIntervalMs: minHours * 3_600_000,
      force: args.includes("--force"),
    })
    console.log(JSON.stringify(decision))
  } else if (command === "prune-beta") {
    const keepIndex = args.indexOf("--keep")
    const keep = keepIndex === -1 ? 10 : Number(args[keepIndex + 1])
    if (!Number.isInteger(keep) || keep < 1) usage()
    const beta = parseManifest((await readRemote()).text).channels.beta
    const kept = [beta?.tag, beta?.desktop?.tag]
    for (const tag of betaTagsToPrune(await listReleaseTags(), keep, kept)) {
      await deleteRelease(tag)
      console.log(`Deleted beta ${tag}`)
    }
  } else {
    usage()
  }
}
