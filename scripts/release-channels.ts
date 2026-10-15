import {
  compareVersions,
  normalizeVersion,
  releaseTagForVersion,
  resolveChannelTarget,
  UPDATE_CHANNELS,
  type UpdateChannel,
} from "../packages/server/src/release-channels.ts"

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
//
// Writes need GH_TOKEN with contents: write on the repository
// (RELEASE_CHANNELS_REPOSITORY, default worktable/worktable-dev).

export const CHANNELS_BRANCH = "release-channels"
export const CHANNELS_PATH = "channels.json"

export interface ChannelRecord {
  version: string
  tag: string
  commit: string
  publishedAt: string
  held: boolean
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
  }
  return {
    manifest: {
      ...manifest,
      channels: { ...manifest.channels, [input.channel]: record },
    },
    changed: true,
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

/** Beta tags to delete: all but the newest `keep`, never the current pointer. */
export function betaTagsToPrune(
  tags: string[],
  keep: number,
  current: string | undefined
): string[] {
  return tags
    .filter((tag) => DEV_TAG.test(tag))
    .sort((left, right) => compareVersions(right, left))
    .slice(keep)
    .filter((tag) => tag !== current)
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
    "usage: release-channels.ts show | publish <channel> <version> <commit> | hold <channel> | release <channel> | prune-beta [--keep N]"
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
  } else if (command === "prune-beta") {
    const keepIndex = args.indexOf("--keep")
    const keep = keepIndex === -1 ? 10 : Number(args[keepIndex + 1])
    if (!Number.isInteger(keep) || keep < 1) usage()
    const current = parseManifest((await readRemote()).text).channels.beta?.tag
    for (const tag of betaTagsToPrune(await listReleaseTags(), keep, current)) {
      await deleteRelease(tag)
      console.log(`Deleted beta ${tag}`)
    }
  } else {
    usage()
  }
}
