// What a person opened on this device, newest first, for search to offer
// before they type. Kept in the browser, so it costs no request. On a team,
// each member keeps their own, and signing out clears it.

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

export const RECENT_OPENS_LIMIT = 12

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

export function recordRecentOpen(worktableId: string, open: RecentOpen): void {
  try {
    localStorage.setItem(
      storageKey(worktableId),
      JSON.stringify(withRecentOpen(readRecentOpens(worktableId), open))
    )
  } catch {
    // Storage that is full or switched off only costs the list.
  }
}
