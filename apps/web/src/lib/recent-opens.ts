// What a person opened on this device, newest first, for search to offer
// before they type and the sidebar's Recent. Kept in the browser, so it
// costs no request. On a team, each member keeps their own, and signing out
// clears it.

import { useSyncExternalStore } from "react"
import { browserTeamCacheKey } from "./team-context"

export type RecentOpenRole =
  | "document"
  | "record"
  | "collection"
  | "thread"
  | "skill"

export interface RecentOpen {
  /** The page's path in the app, without the Worktable's base. */
  path: string
  title: string
  role: RecentOpenRole
  /** A document's format, for its icon. */
  formatId?: string
  at: number
}

export const RECENT_OPENS_LIMIT = 30

const ROLES: ReadonlySet<string> = new Set<RecentOpenRole>([
  "document",
  "record",
  "collection",
  "thread",
  "skill",
])

export function isRecentOpenRole(role: string): role is RecentOpenRole {
  return ROLES.has(role)
}

function storageKey(worktableId: string): string {
  const member = browserTeamCacheKey()
  return member
    ? `worktable-recent-opens:member:${member}`
    : `worktable-recent-opens:${worktableId}`
}

/** `opens` with `open` first, once, and no longer than the limit. */
export function withRecentOpen(
  opens: readonly RecentOpen[],
  open: RecentOpen,
  limit = RECENT_OPENS_LIMIT
): RecentOpen[] {
  return [open, ...opens.filter((other) => other.path !== open.path)].slice(
    0,
    limit
  )
}

function isRecentOpen(value: unknown): value is RecentOpen {
  if (!value || typeof value !== "object") return false
  const open = value as Record<string, unknown>
  return (
    typeof open["path"] === "string" &&
    // A page of this app, never another site's address.
    /^\/(?!\/)/.test(open["path"]) &&
    typeof open["title"] === "string" &&
    typeof open["role"] === "string" &&
    isRecentOpenRole(open["role"]) &&
    typeof open["at"] === "number" &&
    (open["formatId"] === undefined || typeof open["formatId"] === "string")
  )
}

export function readRecentOpens(worktableId: string): RecentOpen[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(storageKey(worktableId)) ?? "[]"
    )
    return Array.isArray(parsed) ? parsed.filter(isRecentOpen) : []
  } catch {
    return []
  }
}

// The page opened from a Recent list, which keeps its place there.
let keepingPlace: string | null = null

/**
 * The next open of `path` comes from a Recent list. It keeps its place
 * while it stays open, so the list holds still as the person uses it.
 */
export function openFromRecent(path: string): void {
  keepingPlace = path
}

/** The route is at `path` now: a page left behind no longer keeps its place. */
export function noteRecentRoute(path: string): void {
  if (keepingPlace !== path) keepingPlace = null
}

/** `opens` with `open` where it was, under its latest name; else first. */
export function withOpenInPlace(
  opens: readonly RecentOpen[],
  open: RecentOpen
): RecentOpen[] {
  const at = opens.findIndex((other) => other.path === open.path)
  if (at === -1) return withRecentOpen(opens, open)
  return opens.map((other, index) => (index === at ? open : other))
}

export function recordRecentOpen(worktableId: string, open: RecentOpen): void {
  noteRecentRoute(open.path)
  const opens = readRecentOpens(worktableId)
  const next = keepingPlace
    ? withOpenInPlace(opens, open)
    : withRecentOpen(opens, open)
  try {
    localStorage.setItem(storageKey(worktableId), JSON.stringify(next))
  } catch {
    // Storage that is full or switched off only costs the list.
  }
  for (const listener of listeners) listener()
}

/** The Space a page belongs to, if any. */
export function recentOpenSpace(open: RecentOpen): string | undefined {
  return open.path.match(/^\/(?:threads\/)?spaces\/([^/]+)/)?.[1]
}

const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith("worktable-recent-opens:")) listener()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener("storage", onStorage)
  }
}

const NONE: RecentOpen[] = []
let snapshot: { key: string; raw: string | null; opens: RecentOpen[] } | null = null

function currentOpens(worktableId: string | undefined): RecentOpen[] {
  if (!worktableId) return NONE
  const key = storageKey(worktableId)
  let raw: string | null = null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return NONE
  }
  if (snapshot?.key !== key || snapshot.raw !== raw) {
    snapshot = { key, raw, opens: readRecentOpens(worktableId) }
  }
  return snapshot.opens
}

/** What this person opened on this device, newest first, kept current. */
export function useRecentOpens(worktableId: string | undefined): RecentOpen[] {
  return useSyncExternalStore(
    subscribe,
    () => currentOpens(worktableId),
    () => NONE
  )
}
