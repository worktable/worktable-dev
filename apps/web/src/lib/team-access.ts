import type { QueryClient } from "@tanstack/react-query"
import type { SpaceView } from "./api"

/**
 * Per-Space cache keys from the server (never computed here). Content and
 * frame addresses carry them on a team, so a change to one Space's access
 * leaves every other Space's cached content in place.
 */
const accessKeys = new Map<string, string>()
const editable = new Map<string, boolean>()
let queryClient: QueryClient | null = null

export function registerTeamQueryClient(client: QueryClient): void {
  queryClient = client
}

export function teamQueryClient(): QueryClient | null {
  return queryClient
}

export interface SpaceAccessChange {
  /** Spaces this member can no longer read. */
  lost: string[]
  /** Spaces this member can now read. */
  gained: string[]
  /** Spaces whose level changed. */
  changed: string[]
  /** Spaces that are now read-only for this member. */
  readOnly: string[]
}

/** Keys from the page's workspace summary, so the first render addresses content once. */
export function adoptSpaceAccessKeys(keys: Record<string, string> | undefined): void {
  if (!keys || accessKeys.size > 0) return
  for (const [spaceId, key] of Object.entries(keys)) accessKeys.set(spaceId, key)
}

/** Record the keys from a spaces list and report what changed since the last. */
export function rememberSpaceAccess(spaces: SpaceView[]): SpaceAccessChange {
  const change: SpaceAccessChange = { lost: [], gained: [], changed: [], readOnly: [] }
  // The first list only establishes the keys; nothing was cached against others.
  const first = accessKeys.size === 0
  const seen = new Set<string>()
  for (const space of spaces) {
    const key = space.permissions?.accessKey
    if (!key) continue
    seen.add(space.id)
    const previous = accessKeys.get(space.id)
    if (!previous) {
      if (!first) change.gained.push(space.id)
    } else if (previous !== key) change.changed.push(space.id)
    if (editable.get(space.id) === true && space.permissions?.edit === false)
      change.readOnly.push(space.id)
    accessKeys.set(space.id, key)
    editable.set(space.id, space.permissions?.edit !== false)
  }
  for (const spaceId of [...accessKeys.keys()]) {
    if (seen.has(spaceId)) continue
    change.lost.push(spaceId)
    accessKeys.delete(spaceId)
    editable.delete(spaceId)
  }
  return change
}

/** One Space's key, from a read of that Space; other Spaces are left as they are. */
export function rememberOneSpaceAccess(space: SpaceView): void {
  const key = space.permissions?.accessKey
  if (!key || accessKeys.get(space.id) === key) return
  // A changed key is the spaces list's to apply, with what it invalidates.
  if (accessKeys.has(space.id)) return
  accessKeys.set(space.id, key)
  editable.set(space.id, space.permissions?.edit !== false)
}

/** The `a` cache key for a Space's content, or null when none is known. */
export function spaceAccessKey(spaceId: string): string | null {
  return accessKeys.get(spaceId) ?? null
}

export function forgetSpaceAccess(): void {
  accessKeys.clear()
  editable.clear()
}
