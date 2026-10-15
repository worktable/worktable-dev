import { runtimePath } from "./runtime-path"
interface BrowserTeamContext {
  worktableId: string
  memberId: string
  policyRevision: number
}
let context: BrowserTeamContext | null = null
let resetting = false

export function initializeBrowserTeamContext(
  value: BrowserTeamContext | undefined
): void {
  if (value && !context) context = value
}

export function browserTeamMemberId(): string | null {
  return context?.memberId ?? null
}

export function browserTeamCacheKey(): string | null {
  return context ? `${context.worktableId}:${context.memberId}` : null
}

/** Human identity and access are supplied by the authenticated runtime. */
export function acceptTeamResponse(
  response: Response,
  method: string,
  input: RequestInfo | URL
): void {
  const raw = response.headers.get("X-Worktable-Team")
  if (!raw) return
  let next: BrowserTeamContext
  try {
    next = JSON.parse(raw)
  } catch {
    return
  }
  if (
    typeof next.worktableId !== "string" ||
    typeof next.memberId !== "string" ||
    !Number.isSafeInteger(next.policyRevision)
  )
    return
  const previous = context
  context = next
  if (!previous || resetting) return
  const changedMember =
    previous.memberId !== next.memberId ||
    previous.worktableId !== next.worktableId
  if (!changedMember && previous.policyRevision === next.policyRevision) return
  const path =
    typeof input === "string"
      ? input
      : input instanceof Request
        ? input.url
        : input.toString()
  // Creating or configuring one's agent leaves the human's content access
  // intact and may return a credential that must remain visible exactly once.
  if (
    !changedMember &&
    method.toUpperCase() !== "GET" &&
    (/\/api\/(tokens|agent-connections|pairing|team\/agents)(\/|$)/.test(
      path
    ) ||
      (method.toUpperCase() === "POST" && /\/api\/spaces(?:\?|$)/.test(path)))
  )
    return
  resetting = true
  window.dispatchEvent(new Event("worktable:workspace-changed"))
  void (
    changedMember ? clearTeamBrowserData() : clearRevokedTeamCaches()
  ).finally(() => window.location.replace(runtimePath("/")))
}

async function clearRevokedTeamCaches(): Promise<void> {
  const member = browserTeamMemberId()
  const base =
    window.location.pathname.match(/^\/t\/[A-Za-z0-9_-]+(?=\/|$)/)?.[0] ?? ""
  const response = await fetch(`${base}/api/spaces`, {
    credentials: "include",
    headers: member ? { "X-Worktable-Member": member } : {},
  })
  if (response.status === 401) return clearTeamBrowserData()
  if (!response.ok) return // The server remains authoritative; keep recoverable authorized drafts on an outage.
  const result = (await response.json()) as {
    spaces: Array<{ id: string; permissions?: { edit: boolean } }>
  }
  const editable = new Set(
    result.spaces
      .filter((space) => space.permissions?.edit !== false)
      .map((space) => space.id)
  )
  const scope = browserTeamCacheKey()
  if (!scope || typeof indexedDB === "undefined" || !indexedDB.databases) return
  const prefix = `worktable-team:${encodeURIComponent(scope)}:`
  for (const database of await indexedDB.databases().catch(() => [])) {
    if (!database.name?.startsWith(prefix)) continue
    const spaceId = decodeURIComponent(
      database.name.slice(prefix.length).split(":", 1)[0]!
    )
    if (!editable.has(spaceId)) indexedDB.deleteDatabase(database.name)
  }
}

export async function clearTeamBrowserData(): Promise<void> {
  try {
    localStorage.removeItem("worktable-profile")
  } catch {
    /* unavailable */
  }
  try {
    for (const key of Object.keys(localStorage))
      if (
        key.startsWith("worktable:drawing-draft:") ||
        key.startsWith("worktable-profile:")
      )
        localStorage.removeItem(key)
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith("worktable:thread-drafts:"))
        sessionStorage.removeItem(key)
  } catch {
    /* unavailable */
  }
  if (typeof indexedDB !== "undefined" && indexedDB.databases) {
    const databases = await indexedDB.databases().catch(() => [])
    for (const database of databases)
      if (database.name?.startsWith("worktable-"))
        indexedDB.deleteDatabase(database.name)
  }
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
