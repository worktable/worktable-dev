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

/** Announce once on visibility, re-reading shared storage when a hidden tab returns. */
export function announceUpdateWhenVisible(
  version: string,
  announce: () => void,
  visibility: Pick<
    Document,
    "visibilityState" | "addEventListener" | "removeEventListener"
  > = document,
  seen: () => string | null = seenUpdateVersion,
  markSeen: (version: string) => void = markUpdateVersionSeen
): () => void {
  let announced = false
  const onVisible = () => {
    if (announced || visibility.visibilityState !== "visible") return
    announced = true
    visibility.removeEventListener("visibilitychange", onVisible)
    if (seen() === version) return
    markSeen(version)
    announce()
  }
  if (visibility.visibilityState === "visible") onVisible()
  else visibility.addEventListener("visibilitychange", onVisible)
  return () => visibility.removeEventListener("visibilitychange", onVisible)
}
