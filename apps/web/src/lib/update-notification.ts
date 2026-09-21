const SEEN_UPDATE_VERSION_KEY = "worktable-update-nudge-seen"

export function seenUpdateVersion(): string | null {
  try {
    return localStorage.getItem(SEEN_UPDATE_VERSION_KEY)
  } catch {
    return null
  }
}

export function markUpdateVersionSeen(version: string): void {
  try {
    localStorage.setItem(SEEN_UPDATE_VERSION_KEY, version)
  } catch {
    // Storage can be unavailable in private or locked-down browsers. The
    // persistent badge remains useful; at worst the toast repeats next load.
  }
}
