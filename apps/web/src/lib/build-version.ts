// An open tab keeps running the build it loaded. After Worktable updates, the
// server answers with a different build id; the tab then loads the new build
// at its next navigation instead of calling endpoints that may have changed.

declare const __WORKTABLE_BUILD_ID__: string | undefined

export const BUILD_HEADER = "X-Worktable-Build"

let serverBuildChanged = false

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
  if (build && own && build !== own) serverBuildChanged = true
}

/** Whether the server now runs a different build than this tab. */
export function serverBuildIsNewer(): boolean {
  return serverBuildChanged
}

/** A lazily loaded chunk of an old build is gone: load the current one. */
export function reloadWhenChunksAreGone(): void {
  if (typeof window === "undefined") return
  window.addEventListener("vite:preloadError", (event) => {
    event.preventDefault()
    window.location.reload()
  })
}
