import { useSyncExternalStore } from "react"
import { pathIsAtOrBelow } from "./list-beside"
import type { TreeNode } from "./tree"

export * from "./list-beside"

// ── What a Space's tree shows ───────────────────────────────

/** Rows a folder shows before See All. */
export const FOLDER_ROWS = 6

/**
 * Folders that hold one folder and nothing else read as one row
 * ("Companies / Acme / Roles"), which opens to the last one's contents.
 */
export function compactFolders(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    let current = node
    const labels = [node.label]
    while (
      current.isFolder &&
      current.kind === "folder" &&
      current.children.length === 1 &&
      current.children[0].isFolder &&
      current.children[0].kind === "folder"
    ) {
      current = current.children[0]
      labels.push(current.label)
    }
    const children = compactFolders(current.children)
    return current === node
      ? children === node.children
        ? node
        : { ...node, children }
      : {
          ...current,
          label: labels.join(" / "),
          // The row keeps the first folder's date, if its name had one.
          dated: node.dated ?? current.dated,
          children,
        }
  })
}

/** Only the folders, and documents that hold others, at every level. */
export function foldersOnly(nodes: TreeNode[]): TreeNode[] {
  // A document that holds others stays, as the way to what it holds.
  return nodes.flatMap((node) =>
    node.isFolder ? [{ ...node, children: foldersOnly(node.children) }] : []
  )
}

/**
 * A folder's first rows. They never grow to reveal the open document: the
 * tree keeps its length as you move around, and See All marks where the
 * open document is when it is further down. A single extra row shows
 * rather than hiding behind See All.
 */
export function folderRows(
  children: TreeNode[],
  currentPath: string | null,
  /** A document opened from outside the tree, which shows wherever it is. */
  revealedPath: string | null = null
): { shown: TreeNode[]; hidden: number; currentHidden: boolean } {
  if (children.length <= FOLDER_ROWS + 1) {
    return { shown: children, hidden: 0, currentHidden: false }
  }
  const shown = children.slice(0, FOLDER_ROWS)
  const rest = children.slice(FOLDER_ROWS)
  const revealed = rest.find((child) => pathIsAtOrBelow(revealedPath, child.path))
  if (revealed) shown.push(revealed)
  const currentHidden = rest.some(
    (child) => child !== revealed && pathIsAtOrBelow(currentPath, child.path)
  )
  return { shown, hidden: children.length - shown.length, currentHidden }
}

// ── Revealing what opened from elsewhere ────────────────────

/**
 * A document opened from outside the tree (search, Recent, a link, the
 * breadcrumb, a fresh load) is shown in the sidebar: its Space and folders
 * open, its row in view. Opening one from the tree or the list beside the
 * page reveals nothing, since the person is already looking there, so the
 * tree holds still. The revealed row stays until something else is opened
 * from outside, so moving on from it never pulls a row away.
 */
export interface Revealed {
  spaceId: string
  path: string
  /** Counts each reveal, so opening the same document again reveals again. */
  seq: number
}

let treeNavigationAt = -Infinity
let revealed: Revealed | null = null
let revealSeq = 0
const revealListeners = new Set<() => void>()

/** The tree or the list is opening something; the next route is theirs. */
export function markTreeNavigation(): void {
  treeNavigationAt = performance.now()
}

let lastPathname: string | null = null

/** Called when the route changes: reveals a document opened from elsewhere. */
export function noteRouteChange(pathname: string): void {
  // A change of search or hash on the same page opens nothing new.
  if (pathname === lastPathname) return
  lastPathname = pathname
  const fromTree = performance.now() - treeNavigationAt < 2000
  treeNavigationAt = -Infinity
  if (fromTree) return
  const match = /^\/spaces\/([^/]+)\/(?:documents|docs|widgets)\/(.+)$/.exec(pathname)
  if (!match) return
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  revealed = { spaceId: decode(match[1]), path: decode(match[2]), seq: ++revealSeq }
  for (const listener of revealListeners) listener()
}

function subscribeReveal(listener: () => void): () => void {
  revealListeners.add(listener)
  return () => revealListeners.delete(listener)
}

/** The document revealed last, anywhere. */
export function currentReveal(): Revealed | null {
  return revealed
}

export function useRevealed(): Revealed | null {
  return useSyncExternalStore(subscribeReveal, currentReveal, () => null)
}

/** The document revealed last, when it is in this Space. */
export function useRevealedIn(spaceId: string): Revealed | null {
  return useSyncExternalStore(
    subscribeReveal,
    () => (revealed?.spaceId === spaceId ? revealed : null),
    () => null
  )
}

// ── Show Archived, per Space ────────────────────────────────

const ARCHIVED_KEY = "worktable-sidebar-show-archived"
const archivedListeners = new Set<() => void>()
let archivedFallback: string[] | undefined

function readShownArchived(): string[] {
  if (archivedFallback) return archivedFallback
  try {
    const value = JSON.parse(localStorage.getItem(ARCHIVED_KEY) ?? "[]") as unknown
    return Array.isArray(value) ? value.filter((id) => typeof id === "string") : []
  } catch {
    return []
  }
}

let archivedSnapshot = ""
function shownArchivedSnapshot(): string {
  const next = readShownArchived().join("\n")
  if (next !== archivedSnapshot) archivedSnapshot = next
  return archivedSnapshot
}

export function setShowArchived(spaceId: string, show: boolean): void {
  const ids = new Set(readShownArchived())
  if (show) ids.add(spaceId)
  else ids.delete(spaceId)
  try {
    localStorage.setItem(ARCHIVED_KEY, JSON.stringify([...ids]))
  } catch {
    archivedFallback = [...ids]
  }
  for (const listener of archivedListeners) listener()
}

function subscribeArchived(listener: () => void): () => void {
  archivedListeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key === ARCHIVED_KEY) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    archivedListeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

/** Whether this Space's sidebar lists its archived documents, on this device. */
export function useShowArchived(spaceId: string): boolean {
  const ids = useSyncExternalStore(subscribeArchived, shownArchivedSnapshot, () => "")
  return ids.split("\n").includes(spaceId)
}

// ── Where a folder opens ────────────────────────────────────

/**
 * The document a folder opens to: the first its list shows, which is its
 * newest unless someone ordered the folder. Null when it holds only folders.
 */
export function openingDocument(children: readonly TreeNode[]): string | null {
  return children.find((child) => !(child.isFolder && child.kind === "folder"))?.path ?? null
}
