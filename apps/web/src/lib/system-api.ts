import {
  authenticatedFetch,
  BASE_URL,
  fetchJSON,
  redirectToLogin,
  UnauthorizedError,
} from "./http.ts"

// Client for the /api/system control surface that backs the Settings drawer.

export interface SystemVersion {
  /** Source for this running build, when supplied by the release. */
  sourceUrl?: string
  /** The running build's version. */
  current: string
  /** Whether the server can trigger an in-place update (embedded installer + launcher). */
  canUpdate: boolean
  /** Whether this build ships the embedded installer at all. */
  hasEmbeddedInstaller: boolean
  /** Newest published release version, or null when unknown (offline, source build). */
  latest: string | null
  /** True when `latest` is known and strictly newer than `current`. */
  updateAvailable: boolean
  /** ISO timestamp of the check that produced `latest`, or null. */
  checkedAt: string | null
  /** ISO timestamp of the most recent network attempt, successful or not. */
  lastAttemptAt: string | null
  /** Server-calculated time remaining before a fresh answer expires. */
  checkTtlRemainingMs: number | null
  /** Whether the release answer is current and trustworthy. */
  checkStatus: UpdateCheckStatus
}

export type UpdateCheckStatus =
  | "unchecked"
  | "fresh"
  | "stale"
  | "failed"
  | "disabled"
  | "unsupported"
  | "managed"

export const SYSTEM_VERSION_QUERY_KEY = ["system", "version"] as const
export const CACHED_SYSTEM_VERSION_QUERY_KEY = [
  "system",
  "version-cached",
] as const

export const UPDATE_CHECK_FRESH_MS = 6 * 60 * 60_000

/**
 * Older self-managed servers do not send checkStatus yet. Derive a conservative
 * value so a newer web client never turns an unknown answer into an update CTA.
 */
export function normalizeSystemVersion(
  version: Omit<
    SystemVersion,
    "lastAttemptAt" | "checkTtlRemainingMs" | "checkStatus"
  > &
    Partial<
      Pick<
        SystemVersion,
        "lastAttemptAt" | "checkTtlRemainingMs" | "checkStatus"
      >
    >
): SystemVersion {
  const checkedAt = version.checkedAt
  const checkedAge = checkedAt ? Date.now() - Date.parse(checkedAt) : Infinity
  const checkStatusWasProvided = version.checkStatus !== undefined
  const checkStatus =
    version.checkStatus ??
    (checkedAt &&
    Number.isFinite(checkedAge) &&
    checkedAge >= 0 &&
    checkedAge < UPDATE_CHECK_FRESH_MS
      ? "fresh"
      : checkedAt
        ? "stale"
        : "unchecked")
  return {
    ...version,
    lastAttemptAt: version.lastAttemptAt ?? checkedAt,
    // Older servers lack this relative value. Trust their explicit fresh
    // verdict for one local TTL instead of comparing clocks across machines.
    checkTtlRemainingMs:
      version.checkTtlRemainingMs ??
      (checkStatus === "fresh"
        ? checkStatusWasProvided
          ? UPDATE_CHECK_FRESH_MS
          : Math.max(0, UPDATE_CHECK_FRESH_MS - checkedAge)
        : null),
    checkStatus,
  }
}

export type UpdateState =
  | "idle"
  | "running"
  | "restarting"
  | "succeeded"
  | "failed"

export interface UpdateStatus {
  state: UpdateState
  from?: string
  to?: string
  startedAt?: string
  finishedAt?: string
  error?: string
  /** Succeeded without installing anything — the install was already current. */
  noop?: boolean
}

export interface HealthInfo {
  ok: true
  service: "worktable"
  version: string
  uptime: number
  desktopConnection: {
    protocolVersion: 1
    provider: "selfHosted" | "cloud"
  }
}

export type DeploymentMode = "cloud" | "self-managed"

export interface DeploymentInfo {
  mode: DeploymentMode
  capabilities: {
    cloudAccount: boolean
    workspaceName: boolean
    workspacePath: boolean
    workspaceUrl: boolean
    workspaceClear?: boolean
    workspacePortability: boolean
    editorSettings: boolean
    historySettings: boolean
    softwareUpdates: boolean
    updateChecks: boolean
    documentSharing: boolean
  }
}

/** How an agent connects to this install, from GET /api/system/connection. */
export interface ConnectionInfo {
  /** Hosted agents authorize through OAuth; other installs manage local wt_ tokens. */
  mcpAuthMode: "oauth" | "local-token"
  /** Connectable MCP endpoint URL, e.g. http://127.0.0.1:7480/mcp */
  endpoint: string
  /** True when the install is bound reachable (non-loopback) and needs a token. */
  reachable: boolean
  /** True when the server rejects unauthenticated requests (exposed mode). */
  authRequired: boolean
  /** Origin used to build clickable URLs handed to agents. */
  origin: string
  /** Canonical MCP URL for agents outside this machine. */
  remoteMcpUrl: string
  /** Where `origin` was resolved from. `config` = settings `network.publicUrl`. */
  originSource: "env" | "config" | "resource" | "request" | "fallback"
  /** True when the origin was explicitly configured. */
  originConfigured: boolean
  /**
   * True when /mcp demands a bearer because the install is exposed, has an
   * explicit deployment credential, or has a configured public/auth origin.
   * Scoped token inventory alone does not disable implicit literal-loopback use.
   */
  mcpTokenRequired: boolean
}

/**
 * Doc version-history retention policy. Mirrors the server's `RetentionPolicy`
 * (settings-store.ts): `all` keeps everything, `age` keeps versions newer than
 * N days, `count` keeps the newest N per doc.
 */
export type RetentionPolicy =
  | { mode: "all" }
  | { mode: "age"; maxAgeDays: number }
  | { mode: "count"; maxPerDoc: number }

/**
 * Persisted server-side settings from GET /api/system/settings. `version` is a
 * forward-compat marker; the grouped sub-objects hold the actual toggles.
 */
export interface ServerSettings {
  version: 1
  updates: { autoCheck: boolean }
  editor: { spellcheck: boolean }
  /** Machine-local network config — the configured public origin for agent URLs. */
  network: { publicUrl: string | null }
  history: { retention: RetentionPolicy }
}

/**
 * A partial patch for PUT /api/system/settings — any subset of the grouped
 * toggles. The server deep-merges it and returns the full merged settings.
 */
export interface ServerSettingsPatch {
  updates?: Partial<ServerSettings["updates"]>
  editor?: Partial<ServerSettings["editor"]>
  network?: Partial<ServerSettings["network"]>
  history?: Partial<ServerSettings["history"]>
}

export async function getSystemVersion() {
  const version = await fetchJSON<SystemVersion>("/api/system/version")
  return normalizeSystemVersion(version)
}

/** Authoritative product/deployment capabilities for this server process. */
export function getDeploymentInfo() {
  return fetchJSON<DeploymentInfo>("/api/system/deployment")
}

/**
 * Passive variant of getSystemVersion: answers from the server's update-check
 * cache and never contacts the release host. For ambient surfaces (the
 * app-shell update nudge) that poll without user intent — the live check stays
 * behind the self-managed Settings System section.
 */
export async function getCachedSystemVersion() {
  const version = await fetchJSON<SystemVersion>("/api/system/version?cached=1")
  return normalizeSystemVersion(version)
}

/** User-initiated release check. Always asks the server to contact the host. */
export async function checkSystemVersionNow() {
  const version = await fetchJSON<SystemVersion>("/api/system/version/check", {
    method: "POST",
  })
  return normalizeSystemVersion(version)
}

export function getUpdateStatus() {
  return fetchJSON<UpdateStatus>("/api/system/update")
}

/** Probe used while polling for the post-restart server to come back. */
export function getHealth() {
  return fetchJSON<HealthInfo>("/health")
}

/** How to connect an agent to this install (endpoint, reachability, origin). */
export function getConnection() {
  return fetchJSON<ConnectionInfo>("/api/system/connection")
}

/** Read the persisted server settings that back the Settings dialog toggles. */
export function getSettings() {
  return fetchJSON<ServerSettings>("/api/system/settings")
}

/** Apply a partial settings patch; resolves with the full merged settings. */
export function patchSettings(patch: ServerSettingsPatch) {
  return fetchJSON<ServerSettings>("/api/system/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  })
}

/**
 * Kick off an update. Resolves with the initial `running` status (202) — or, if
 * an update is already in flight (409), with that in-flight status, so a
 * duplicate click is treated as "already running", not a failure. Throws only on
 * a genuine refusal (e.g. the build can't self-update) or a real error.
 */
export async function startUpdate(version?: string): Promise<UpdateStatus> {
  const res = await authenticatedFetch(`${BASE_URL}/api/system/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(version ? { version } : {}),
  })
  if (res.status === 401) {
    redirectToLogin()
    throw new UnauthorizedError()
  }
  if (res.status === 202) return (await res.json()) as UpdateStatus
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string
      status?: UpdateStatus
    }
    // Benign "already in progress" carries the in-flight status — surface it as
    // a normal result. A refusal without an in-flight status (can't self-update)
    // is a real error.
    if (
      body.status &&
      (body.status.state === "running" || body.status.state === "restarting")
    ) {
      return body.status
    }
    throw new Error(body.error ?? "Update was refused.")
  }
  const body = (await res.json().catch(() => ({ error: res.statusText }))) as {
    error?: string
  }
  throw new Error(body.error ?? `HTTP ${res.status}`)
}
