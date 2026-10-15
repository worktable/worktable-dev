// Release versions and the release-channel manifest. Pure and dependency-free,
// shared by the updaters (update-check.ts) and the release scripts that write
// the manifest (scripts/release-channels.ts).

// ── Versions ────────────────────────────────────────────────────────────────
//
// Releases are X.Y.Z. Beta builds of unreleased main are X.Y.Z-dev.N+<commit>:
// they sort after the release they follow and before X.Y.Z itself. Build
// metadata (after `+`) names the commit and never affects ordering.

interface ParsedVersion {
  core: [number, number, number]
  prerelease: Array<number | string>
  /** Canonical text without a leading `v`. */
  text: string
  /** The text without build metadata, as release tags carry it. */
  tagText: string
}

const VERSION_PATTERN =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/i

function parseVersion(input: string): ParsedVersion | null {
  const match = VERSION_PATTERN.exec(input.trim())
  if (!match) return null
  const core: [number, number, number] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ]
  const prereleaseText = match[4]
  const build = match[5]
  const tagText = `${core.join(".")}${prereleaseText ? `-${prereleaseText}` : ""}`
  return {
    core,
    prerelease: prereleaseText
      ? prereleaseText
          .split(".")
          .map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
    text: `${tagText}${build ? `+${build}` : ""}`,
    tagText,
  }
}

/**
 * Normalize a version string (release tags carry a leading `v`, manifests
 * don't). Accepts X.Y.Z with an optional prerelease and build suffix. Null when
 * the input isn't a version.
 */
export function normalizeVersion(input: string): string | null {
  return parseVersion(input)?.text ?? null
}

/** The release tag that publishes `version`: `v` plus the version without build metadata. */
export function releaseTagForVersion(version: string): string | null {
  const parsed = parseVersion(version)
  return parsed ? `v${parsed.tagText}` : null
}

function comparePrerelease(
  left: Array<number | string>,
  right: Array<number | string>
): number {
  // A release (no prerelease) sorts after any prerelease of the same core.
  if (!left.length || !right.length) {
    return left.length === right.length ? 0 : left.length ? -1 : 1
  }
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const l = left[i]
    const r = right[i]
    if (l === undefined) return -1
    if (r === undefined) return 1
    if (l === r) continue
    if (typeof l === "number" && typeof r === "number") return l < r ? -1 : 1
    if (typeof l === "number") return -1
    if (typeof r === "number") return 1
    return l < r ? -1 : 1
  }
  return 0
}

/** Semantic-version precedence of two versions. 0 when either is invalid. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  for (let i = 0; i < 3; i += 1) {
    if (left.core[i]! !== right.core[i]!)
      return left.core[i]! < right.core[i]! ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}

/** True when `candidate` is a strictly newer version than `current`. */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareVersions(candidate, current) > 0
}

// ── Channels ────────────────────────────────────────────────────────────────

export const UPDATE_CHANNELS = ["stable", "beta"] as const
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return value === "stable" || value === "beta"
}

interface ChannelEntry {
  version: string
  held: boolean
}

/**
 * The version a channel offers. Beta follows the newer of beta and stable, so
 * a beta install moves on to the release its builds led up to. A held channel
 * offers nothing new; an install never moves to a held version.
 */
export interface ChannelTarget {
  /** Newest offered version for the channel, or null when nothing is offered. */
  version: string | null
  /** Whether the followed channel is held. */
  held: boolean
}

function parseChannelEntry(value: unknown): ChannelEntry | null {
  if (!value || typeof value !== "object") return null
  const entry = value as Record<string, unknown>
  const version =
    typeof entry["version"] === "string"
      ? normalizeVersion(entry["version"])
      : null
  if (!version || typeof entry["held"] !== "boolean") return null
  return { version, held: entry["held"] }
}

/**
 * Resolve the target for `channel` from a parsed channels.json body. Null when
 * the manifest is malformed: the stable entry is required, and every entry
 * must say explicitly whether it is held.
 */
export function resolveChannelTarget(
  body: unknown,
  channel: UpdateChannel
): ChannelTarget | null {
  if (!body || typeof body !== "object") return null
  const manifest = body as Record<string, unknown>
  if (manifest["schema"] !== 1) return null
  const channels = manifest["channels"]
  if (!channels || typeof channels !== "object") return null
  const entries = channels as Record<string, unknown>
  const stable = parseChannelEntry(entries["stable"])
  if (!stable) return null
  // A missing or malformed beta entry leaves beta installs on stable.
  const beta = parseChannelEntry(entries["beta"])
  const followed = channel === "beta" && beta ? beta : stable
  const candidates = (channel === "beta" ? [beta, stable] : [stable]).filter(
    (entry): entry is ChannelEntry => Boolean(entry && !entry.held)
  )
  const version =
    candidates
      .map((entry) => entry.version)
      .sort((left, right) => compareVersions(right, left))[0] ?? null
  return { version, held: followed.held }
}
