import { useRouterState } from "@tanstack/react-router"
import { useSyncExternalStore } from "react"

// What the page frame and the header need to know about the sidebar: which
// layout it uses, which folder is listed beside the page. Kept apart from
// the sidebar's tree helpers so the header loads only this.

/** Whether `path` is the node's path or inside it. */
export function pathIsAtOrBelow(path: string | null, node: string): boolean {
  return path !== null && (path === node || path.startsWith(`${node}/`))
}

// ── Sidebar layout: the tree, or folders only ───────────────

export type SidebarLayout = "tree" | "folders"

const LAYOUT_KEY = "worktable-sidebar-layout"
const listeners = new Set<() => void>()
let fallback: SidebarLayout | undefined

function readLayout(): SidebarLayout {
  if (fallback) return fallback
  try {
    return localStorage.getItem(LAYOUT_KEY) === "folders" ? "folders" : "tree"
  } catch {
    return "tree"
  }
}

export function setSidebarLayout(layout: SidebarLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, layout)
  } catch {
    fallback = layout
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === LAYOUT_KEY) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

/** Kept on this device, like which Spaces are open. */
export function useSidebarLayout(): SidebarLayout {
  return useSyncExternalStore(subscribe, readLayout, () => "tree")
}

// ── Where the route is ──────────────────────────────────────

/**
 * What the route has open in this Space: a document's path, a folder's path
 * ("" for the Space's top level), or null for anything else.
 */
export function routePlace(
  pathname: string,
  spaceId: string
): { kind: "document" | "folder"; path: string } | null {
  const base = `/spaces/${spaceId}/`
  if (!pathname.startsWith(base)) return null
  const rest = pathname.slice(base.length)
  for (const [prefix, kind] of [
    ["documents/", "document"],
    ["docs/", "document"],
    ["widgets/", "document"],
  ] as const) {
    if (rest.startsWith(prefix)) {
      return { kind, path: safeDecode(rest.slice(prefix.length)) }
    }
  }
  if (rest === "folders" || rest.startsWith("folders/")) {
    return {
      kind: "folder",
      path: safeDecode(rest.slice("folders/".length).replace(/\/$/, "")),
    }
  }
  return null
}

/** The folder whose contents the route shows: an open folder, or a document's. */
export function routeFolder(pathname: string, spaceId: string): string | null {
  const place = routePlace(pathname, spaceId)
  if (!place) return null
  if (place.kind === "folder") return place.path
  const slash = place.path.lastIndexOf("/")
  return slash === -1 ? "" : place.path.slice(0, slash)
}

function safeDecode(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    return path
  }
}

// ── The folder being browsed ────────────────────────────────

/**
 * See All opens a folder's list beside the page. The list stays while the
 * person moves through that folder, and goes once they open something
 * elsewhere from the sidebar or close it. Folders Only always shows it.
 */
let browsing: { spaceId: string; path: string } | null = null
const browseListeners = new Set<() => void>()

export function browseFolder(spaceId: string, path: string | null): void {
  const next = path === null ? null : { spaceId, path }
  if (browsing?.spaceId === next?.spaceId && browsing?.path === next?.path) return
  browsing = next
  for (const listener of browseListeners) listener()
}

function subscribeBrowse(listener: () => void): () => void {
  browseListeners.add(listener)
  return () => browseListeners.delete(listener)
}

/** The folder whose list is open in this Space, outside Folders Only. */
export function useBrowsedFolder(spaceId: string): string | null {
  return useSyncExternalStore(
    subscribeBrowse,
    () => (browsing?.spaceId === spaceId ? browsing.path : null),
    () => null
  )
}

/**
 * The folder whose list sits beside the page in this Space, if any: every
 * open folder in Folders Only, otherwise the one See All opened while the
 * route stays in it.
 */
export function useListBeside(spaceId: string): string | null {
  const layout = useSidebarLayout()
  const browsed = useBrowsedFolder(spaceId)
  const folder = useRouterState({
    select: (state) => routeFolder(state.location.pathname, spaceId),
  })
  if (folder === null) return null
  // A list holds its folders' folders too: opening a document in one of
  // them keeps the list where it is.
  if (browsed !== null && (browsed === "" || pathIsAtOrBelow(folder, browsed))) {
    return browsed
  }
  return layout === "folders" ? folder : null
}
