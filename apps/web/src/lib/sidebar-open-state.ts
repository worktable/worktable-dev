import { browserTeamCacheKey } from "./team-context"

/**
 * What the person left open or closed in the sidebar: sections, Spaces and
 * folders. It stays on this device, for each Worktable and member, so a
 * reload or the next visit shows the sidebar as they left it.
 */
type Kind = "section" | "space" | "folder"

let cache: { key: string; state: Record<string, boolean> } | null = null

function storageKey(): string {
  return `worktable-sidebar-open:${browserTeamCacheKey() ?? "solo"}`
}

function load(): Record<string, boolean> {
  const key = storageKey()
  if (cache?.key === key) return cache.state
  let state: Record<string, boolean> = {}
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "{}") as unknown
    if (parsed && typeof parsed === "object") {
      state = parsed as Record<string, boolean>
    }
  } catch {
    // Unavailable or unreadable storage starts from the defaults.
  }
  cache = { key, state }
  return state
}

export function rememberedOpen(kind: Kind, id: string): boolean | undefined {
  const value = load()[`${kind}:${id}`]
  return typeof value === "boolean" ? value : undefined
}

export function rememberOpen(kind: Kind, id: string, open: boolean): void {
  const key = storageKey()
  const state = { ...load(), [`${kind}:${id}`]: open }
  cache = { key, state }
  try {
    localStorage.setItem(key, JSON.stringify(state))
  } catch {
    // The choice still holds until the page reloads.
  }
}
