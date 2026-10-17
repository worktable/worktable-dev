import { applySpaceAccess, initializeBrowserTeamContext } from "./team-context";
import { rememberOneSpaceAccess } from "./team-access";
import { acceptWorkspaceContentEpoch } from "./workspace-content-epoch"
import type {
  PersonalNavigation,
  ResolvedStartHerePin,
  SearchResult,
  SpaceFile,
  WithContentRevision,
} from "@worktable/types"
import type { PersonalSetup } from "@worktable/types/setup"
import { fetchJSON, fetchVoid, type ReadOptions } from "./http.ts"

export type SpaceView = SpaceFile & {
  permissions?: { edit: boolean; manage: boolean; shared?: boolean; accessKey?: string };
};

export type WorkspaceMode = "daily" | "staging" | "sandbox" | "fixture"

export interface WorkspaceInfo {
  contentEpoch?: string
  teamContext?: {
    worktableId: string;
    memberId: string;
    policyRevision: number;
    access?: string | null;
    /** This member's content key for each Space they can read. */
    accessKeys?: Record<string, string>;
  };
  canManage?: boolean
  /**
   * The person's own groups and pins. null until they arrange anything;
   * absent for agents and anyone who is not a member or the owner.
   */
  navigation?: PersonalNavigation | null
  /** The person's own first steps; absent with `navigation`. */
  setup?: PersonalSetup
  /** Who is using this Worktable; absent with `navigation`. */
  person?: {
    /** Their participant id, which Threads also show. */
    id: string
    name: string
    role: "owner" | "member"
    /** How Activity names them as its actor. */
    activityId?: string
    /** How they sign out here; null without a session, such as on this computer. */
    signOut: "team" | "cloud" | "password" | null
  } | null
  id: string
  name: string
  /** The chosen recognition color, or null for the default from `id`. */
  color?: string | null
  createdAt: string
  /** Absent on older servers; generic document authoring requires V2. */
  storageVersion?: 1 | 2
  /** Absolute path of the workspace root on disk (owner-only; null for scoped tokens). */
  root?: string | null
  /** Normalized mode (an absent/unknown provenance reports "daily"). */
  mode: WorkspaceMode
  provenance: {
    mode: WorkspaceMode
    source?: { workspaceId?: string; label?: string; path?: string; host?: string }
    snapshotAt?: string
    oneWay?: boolean
    disposable?: boolean
    fixtureName?: string
  } | null
  onboarding?: {
    status: "pending" | "complete"
  }
}

export interface WorkspaceStorageUpgrade {
  state: "ready" | "upgrading" | "blocked"
  canRetry: boolean
}

export async function getWorkspace() {
  return acceptWorkspace(await fetchJSON<WorkspaceInfo>("/api/workspace"))
}

/** Adopt a workspace summary, read now or carried by the served page. */
export async function acceptWorkspace(workspace: WorkspaceInfo) {
  initializeBrowserTeamContext(workspace.teamContext);
  await acceptWorkspaceContentEpoch(workspace.id, workspace.contentEpoch)
  return workspace
}

/**
 * Update mutable workspace fields. `name` renames the workspace. The agent-facing
 * public origin is machine-local and set via the settings API
 * (`network.publicUrl`), not here. Owner-only server-side; resolves with the
 * updated workspace info.
 */
export function updateWorkspace(patch: {
  name?: string
  /** A recognition color, or "" for the default. */
  color?: string
  onboarding?: { status: "complete" }
}) {
  return fetchJSON<WorkspaceInfo>("/api/workspace", {
    method: "PUT",
    body: JSON.stringify(patch),
  })
}

/** Every Space, archived ones included. */
/** The spaces list without applying access changes; see getSpaces. */
export function fetchSpaces() {
  return fetchJSON<{ spaces: SpaceView[] }>("/api/spaces").then(
    (r) => r.spaces
  )
}

export function getSpaces() {
  return fetchSpaces().then((spaces) => {
    applySpaceAccess(spaces)
    return spaces
  })
}

export function getSpace(spaceId: string, options?: ReadOptions) {
  return fetchJSON<{
    space: SpaceView
    pins?: WithContentRevision<ResolvedStartHerePin>[]
  }>(`/api/spaces/${spaceId}`, options).then((result) => {
    // A document opened directly learns its Space's content key here.
    rememberOneSpaceAccess(result.space)
    return result
  })
}

export function createSpace(data: {
  name: string
  description?: string
  icon?: string
  group?: string
}) {
  return fetchJSON<{ spaceId: string }>("/api/spaces", {
    method: "POST",
    body: JSON.stringify(data),
  })
}

export function updateSpace(
  spaceId: string,
  data: {
    name?: string
    description?: string
    icon?: string
    group?: string
    /** A recognition color, or "" for the default. */
    color?: string
  }
) {
  return fetchJSON<{ space: SpaceFile }>(`/api/spaces/${spaceId}`, {
    method: "PUT",
    body: JSON.stringify(data),
  })
}

export type DocSortMode = "custom" | "alphabetical" | "updated"

export function updateDocOrder(
  spaceId: string,
  prefs: { order?: string[]; sort?: DocSortMode }
) {
  return fetchJSON<{ space: SpaceFile }>(`/api/spaces/${spaceId}/doc-order`, {
    method: "PUT",
    body: JSON.stringify(prefs),
  })
}

export function archiveSpace(spaceId: string, reason?: string) {
  return fetchJSON<{ ok: boolean; space: SpaceFile }>(
    `/api/spaces/${spaceId}/archive`,
    {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    }
  )
}

export function restoreSpace(spaceId: string) {
  return fetchJSON<{ ok: boolean; space: SpaceFile }>(
    `/api/spaces/${spaceId}/restore`,
    {
      method: "POST",
      body: JSON.stringify({}),
    }
  )
}

export function searchWorkspace(
  opts: {
    query: string
    spaceId?: string
    includeArchived?: boolean
    maxResults?: number
  },
  options?: ReadOptions
) {
  const params = new URLSearchParams({ query: opts.query })
  params.set("documentMode", "common")
  if (opts.spaceId) params.set("spaceId", opts.spaceId)
  if (opts.includeArchived !== undefined)
    params.set("includeArchived", String(opts.includeArchived))
  if (opts.maxResults !== undefined)
    params.set("maxResults", String(opts.maxResults))
  return fetchJSON<{
    results: WithContentRevision<SearchResult>[]
    indexing?: boolean
  }>(
    `/api/search?${params.toString()}`,
    options
  ).then((r) => ({ results: r.results, indexing: r.indexing === true }))
}

export async function deleteSpace(spaceId: string): Promise<void> {
  await fetchVoid(`/api/spaces/${spaceId}`, { method: "DELETE" })
}
