// An open tab keeps running the build it loaded. After Worktable updates, the
// server answers with a different build id; the tab then loads the new build
// at its next navigation instead of calling endpoints that may have changed.
//
// A tab reloads for a given build at most once in a short window. When the
// page it loads still names another build (a stale build-id.txt, a cached
// page), the tab keeps running instead of reloading again.

declare const __WORKTABLE_BUILD_ID__: string | undefined

export const BUILD_HEADER = "X-Worktable-Build"

const RELOADS_KEY = "worktable-build-reloads"
const RELOAD_WINDOW_MS = 5 * 60_000

let serverBuild: string | null = null

/** This tab's build, or null in development, where nothing is compared. */
function ownBuild(): string | null {
  if (import.meta.env.DEV) return null
  return typeof __WORKTABLE_BUILD_ID__ === "string"
    ? __WORKTABLE_BUILD_ID__
    : null
}

/** Record the build a server response came from. */
export function noteServerBuild(response: Response): void {
  noteServerBuildId(response.headers.get(BUILD_HEADER))
}

/** Record the build the server named, in a response or the page it served. */
export function noteServerBuildId(build: string | null | undefined): void {
  const own = ownBuild()
  if (build && own && build !== own) serverBuild = build
}

/**
 * Whether to load the server's build in full now. A true answer claims the
 * reload for that build, so the page it loads does not reload for it again.
 */
export function claimServerBuildReload(): boolean {
  return serverBuild !== null && claimReload(serverBuild)
}

/** A lazily loaded chunk of an old build is gone: load the current one. */
export function reloadWhenChunksAreGone(): void {
  if (typeof window === "undefined") return
  window.addEventListener("vite:preloadError", (event) => {
    // The reload loads the build the server named, or else this one again. A
    // chunk still missing after it surfaces as the route's error.
    if (!claimReload(serverBuild ?? ownBuild() ?? "")) return
    event.preventDefault()
    window.location.reload()
  })
}

function claimReload(build: string): boolean {
  try {
    const now = Date.now()
    const recent = recentReloads(sessionStorage.getItem(RELOADS_KEY), now)
    if (Object.hasOwn(recent, build)) return false
    recent[build] = now
    sessionStorage.setItem(RELOADS_KEY, JSON.stringify(recent))
    return true
  } catch {
    // Without a record that survives the reload, a reload could repeat.
    return false
  }
}

function recentReloads(
  stored: string | null,
  now: number
): Record<string, number> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stored ?? "{}")
  } catch {
    return {}
  }
  const recent: Record<string, number> = {}
  if (!parsed || typeof parsed !== "object") return recent
  for (const [build, at] of Object.entries(parsed)) {
    if (typeof at === "number" && Math.abs(now - at) < RELOAD_WINDOW_MS) {
      recent[build] = at
    }
  }
  return recent
}
