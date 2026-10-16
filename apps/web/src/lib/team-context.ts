import { runtimePath } from "./runtime-path"
import { fetchSpaces, type SpaceView } from "./api"
import {
  adoptSpaceAccessKeys,
  forgetSpaceAccess,
  rememberSpaceAccess,
  teamQueryClient,
  type SpaceAccessChange,
} from "./team-access"

interface BrowserTeamContext {
  worktableId: string
  memberId: string
  policyRevision: number
  /** Changes only when this member's own access changes. */
  access?: string | null
}
let context: BrowserTeamContext | null = null
let resetting = false
let refreshingAccess: Promise<void> | null = null

export function initializeBrowserTeamContext(
  value: (BrowserTeamContext & { accessKeys?: Record<string, string> }) | undefined
): void {
  if (!value || context) return
  const { accessKeys, ...current } = value
  context = current
  adoptSpaceAccessKeys(accessKeys)
}

/** Forget this tab's team identity; tests share one module instance. */
export function resetBrowserTeamContext(): void {
  context = null
  resetting = false
  forgetSpaceAccess()
}

export function browserTeamMemberId(): string | null {
  return context?.memberId ?? null
}

export function browserTeamCacheKey(): string | null {
  return context ? `${context.worktableId}:${context.memberId}` : null
}

function parseContext(value: unknown): BrowserTeamContext | null {
  if (!value || typeof value !== "object") return null
  const next = value as Partial<BrowserTeamContext>
  if (
    typeof next.worktableId !== "string" ||
    typeof next.memberId !== "string" ||
    !Number.isSafeInteger(next.policyRevision)
  )
    return null
  return {
    worktableId: next.worktableId,
    memberId: next.memberId,
    policyRevision: next.policyRevision!,
    access: typeof next.access === "string" ? next.access : null,
  }
}

/**
 * Apply the authenticated runtime's view of who this tab is and what they may
 * access. Another member's actions never reload this tab: only a change to
 * this member's own access refreshes the affected data, in place.
 */
export function acceptTeamContext(value: unknown): void {
  const next = parseContext(value)
  if (!next) return
  const previous = context
  const sameMember =
    previous?.memberId === next.memberId &&
    previous.worktableId === next.worktableId
  // A response that was delayed or replayed must not move the tab backwards.
  if (previous && sameMember && next.policyRevision < previous.policyRevision)
    return
  // `access` stays the last one applied until its refresh succeeds, so a
  // failed refresh is retried by the next response that carries it.
  const changed = Boolean(
    sameMember && next.access && previous?.access && next.access !== previous.access
  )
  context = changed ? { ...next, access: previous!.access } : next
  if (!previous || resetting) return
  if (!sameMember) {
    resetting = true
    window.dispatchEvent(new Event("worktable:workspace-changed"))
    void clearTeamBrowserData(previous).finally(() =>
      window.location.replace(runtimePath("/"))
    )
    return
  }
  if (changed) void refreshTeamAccess(next.access!)
}

/** The server detached a realtime socket: check this member's access now. */
export function reconcileTeamAccess(): void {
  if (context?.access && !resetting) void refreshTeamAccess(null)
}

/** Human identity and access are supplied by the authenticated runtime. */
export function acceptTeamResponse(response: Response): void {
  const raw = response.headers.get("X-Worktable-Team")
  if (!raw) return
  try {
    acceptTeamContext(JSON.parse(raw))
  } catch {
    // An unreadable header changes nothing; the server stays authoritative.
  }
}

function currentSpaceId(): string | null {
  const match = window.location.pathname.match(
    /^(?:\/t\/[A-Za-z0-9_-]+)?\/spaces\/([^/]+)/
  )
  return match ? decodeURIComponent(match[1]!) : null
}

// Lists that gather items from every Space this member can read.
const CROSS_SPACE_LISTS = new Set(["recent", "activity", "pending", "threads", "search"])

/**
 * Every spaces list carries this member's per-Space keys. Whichever request
 * brings a change first applies it: lost Spaces' data goes, changed Spaces
 * refresh, lists spanning Spaces refresh when the set of Spaces moved, and
 * the tab leaves only a Space it can no longer read.
 */
export function applySpaceAccess(spaces: SpaceView[]): SpaceAccessChange | null {
  if (!context) return null
  const change = rememberSpaceAccess(spaces)
  const queryClient = teamQueryClient()
  for (const spaceId of change.lost)
    queryClient?.removeQueries({ queryKey: ["spaces", spaceId] })
  for (const spaceId of [...change.changed, ...change.gained])
    void queryClient?.invalidateQueries({ queryKey: ["spaces", spaceId] })
  // A lost Space's titles leave every list at once; a gained one's arrive
  // with the next read.
  if (change.lost.length)
    queryClient?.removeQueries({
      predicate: (query) => CROSS_SPACE_LISTS.has(String(query.queryKey[0])),
    })
  else if (change.gained.length)
    void queryClient?.invalidateQueries({
      predicate: (query) => CROSS_SPACE_LISTS.has(String(query.queryKey[0])),
    })
  const scope = browserTeamCacheKey()
  if (scope && (change.lost.length || change.readOnly.length))
    void deleteTeamStores(scope, new Set([...change.lost, ...change.readOnly]))
  const here = currentSpaceId()
  if (here && change.lost.includes(here)) window.location.replace(runtimePath("/"))
  return change
}

/**
 * This member's access changed: refresh what it affects, stay on the page.
 * `applied` becomes the recorded access once the refresh succeeded.
 */
function refreshTeamAccess(applied: string | null): Promise<void> {
  refreshingAccess ??= (async () => {
    const spaces = await fetchSpaces().catch(() => null)
    if (!spaces) return // The server stays authoritative; keep drafts on an outage.
    applySpaceAccess(spaces)
    teamQueryClient()?.setQueryData(["spaces"], spaces)
    if (applied && context) context = { ...context, access: applied }
  })().finally(() => {
    refreshingAccess = null
  })
  return refreshingAccess
}

async function deleteTeamStores(
  scope: string,
  spaceIds: Set<string> | null
): Promise<void> {
  if (typeof indexedDB === "undefined" || !indexedDB.databases) return
  const prefix = `worktable-team:${encodeURIComponent(scope)}:`
  for (const database of await indexedDB.databases().catch(() => [])) {
    if (!database.name?.startsWith(prefix)) continue
    const spaceId = decodeURIComponent(
      database.name.slice(prefix.length).split(":", 1)[0]!
    )
    if (!spaceIds || spaceIds.has(spaceId)) indexedDB.deleteDatabase(database.name)
  }
}

/**
 * Remove one member's local data for one Worktable: their cached rooms,
 * drafts and profile. Other Worktables on the same origin and solo caches are
 * left alone. Without a scope, every member's team data on this origin goes.
 */
export async function clearTeamBrowserData(
  scope: Pick<BrowserTeamContext, "worktableId" | "memberId"> | null = context
): Promise<void> {
  forgetSpaceAccess()
  const key = scope ? `${scope.worktableId}:${scope.memberId}` : null
  const owns = (name: string) =>
    key ? name.includes(`member:${key}`) || name.endsWith(`:${key}`) : name.includes("member:")
  try {
    for (const name of Object.keys(localStorage))
      if (
        (name.startsWith("worktable:drawing-draft:") ||
          name.startsWith("worktable-profile:") ||
          name.startsWith("worktable-space-focus:")) &&
        owns(name)
      )
        localStorage.removeItem(name)
    for (const name of Object.keys(sessionStorage))
      if (name.startsWith("worktable:thread-drafts:") && owns(name))
        sessionStorage.removeItem(name)
  } catch {
    /* unavailable */
  }
  if (typeof indexedDB === "undefined" || !indexedDB.databases) return
  if (key) return deleteTeamStores(key, null)
  for (const database of await indexedDB.databases().catch(() => []))
    if (database.name?.startsWith("worktable-team:"))
      indexedDB.deleteDatabase(database.name)
}

export async function signOutLocalTeam(): Promise<void> {
  const response = await fetch(runtimePath("/auth/team/sign-out"), {
    method: "POST",
    credentials: "include",
  })
  if (!response.ok) throw new Error("Could not sign out. Try again.")
  const channel =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel("worktable-auth")
      : null
  channel?.postMessage({ type: "logout" })
  channel?.close()
  await clearTeamBrowserData()
  window.location.replace(runtimePath("/login"))
}
