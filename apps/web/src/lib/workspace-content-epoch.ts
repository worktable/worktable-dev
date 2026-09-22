import {
  setWorkspaceWritesFrozen,
  setCurrentWorkspaceContentEpoch,
} from "./workspace-content-state"
import { clearPersistedThreadDrafts } from "./thread-drafts"
import { clearPersistedDrawingDrafts } from "./drawing-drafts"

let identity: { id: string; epoch: string } | null = null
let changed = false
let resetting: Promise<void> | null = null

export function workspaceContentEpoch(): string | null {
  return changed ? null : (identity?.epoch ?? null)
}

export function workspaceContentChanged(): boolean {
  return changed
}

function readPrevious(id: string): string | null {
  try {
    return sessionStorage.getItem(`worktable-content-epoch:${id}`)
  } catch {
    return null
  }
}

async function resetBrowserWorkspace(
  id: string,
  oldEpoch: string | null
): Promise<void> {
  clearPersistedThreadDrafts(id)
  clearPersistedDrawingDrafts(id, oldEpoch ?? undefined)
  if (typeof indexedDB !== "undefined" && indexedDB.databases) {
    const databases = await indexedDB.databases().catch(() => [])
    for (const database of databases) {
      if (
        database.name?.startsWith("worktable-") &&
        (!oldEpoch || database.name.includes(`-yjs-v1-${oldEpoch}`))
      ) {
        // A mounted provider can hold the DB open until navigation. Deletion remains queued.
        indexedDB.deleteDatabase(database.name)
      }
    }
  }
}

/** Freeze old mutations before notifying React or navigating. Never replay under a new epoch. */
export async function acceptWorkspaceContentEpoch(
  id: string,
  epoch?: string
): Promise<void> {
  if (!epoch || typeof window === "undefined") return
  const previous = identity?.id === id ? identity.epoch : readPrevious(id)
  const wasMounted = identity !== null
  if (previous && previous !== epoch) {
    changed = true
    setWorkspaceWritesFrozen(true)
    if (!resetting) {
      window.dispatchEvent(new Event("worktable:workspace-changed"))
      resetting = resetBrowserWorkspace(id, previous).finally(() => {
        try {
          sessionStorage.setItem(`worktable-content-epoch:${id}`, epoch)
        } catch {
          /* private browsing */
        }
        if (wasMounted) window.location.replace("/")
      })
    }
    await resetting
    if (wasMounted) return
    changed = false
    setWorkspaceWritesFrozen(false)
    resetting = null
  }
  // A rejected request with a missing fence can return the same current epoch.
  // Resume future edits after verification; the rejected body is never replayed.
  changed = false
  setWorkspaceWritesFrozen(false)
  identity = { id, epoch }
  setCurrentWorkspaceContentEpoch(epoch)
  try {
    sessionStorage.setItem(`worktable-content-epoch:${id}`, epoch)
  } catch {
    /* private browsing */
  }
}

export function fenceChangedWorkspace(): void {
  changed = true
  setWorkspaceWritesFrozen(true)
  window.dispatchEvent(new Event("worktable:workspace-refresh"))
}

export function isBrowserContentMutation(
  method: string,
  input: RequestInfo | URL
): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return false
  const pathname = new URL(
    input instanceof Request ? input.url : String(input),
    typeof location === "undefined" ? "http://localhost" : location.href
  ).pathname
  return ["/api/spaces", "/api/threads", "/api/shares"].some(
    (root) => pathname === root || pathname.startsWith(`${root}/`)
  )
}
