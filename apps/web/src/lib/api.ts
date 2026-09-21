import type {
  SearchResult,
  SpaceFile,
  SpaceWithDocs,
} from "@worktable/types"
import type { WidgetListEntry } from "./widgets-api.ts"
import { fetchJSON, fetchVoid } from "./http.ts"

export type WorkspaceMode = "daily" | "staging" | "sandbox" | "fixture"

export interface WorkspaceInfo {
  id: string
  name: string
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

export function getWorkspace() {
  return fetchJSON<WorkspaceInfo>("/api/workspace")
}

/**
 * Update mutable workspace fields. `name` renames the workspace. The agent-facing
 * public origin is machine-local and set via the settings API
 * (`network.publicUrl`), not here. Owner-only server-side; resolves with the
 * updated workspace info.
 */
export function updateWorkspace(patch: {
  name?: string
  onboarding?: { status: "complete" }
}) {
  return fetchJSON<WorkspaceInfo>("/api/workspace", {
    method: "PUT",
    body: JSON.stringify(patch),
  })
}

export function getSpaces() {
  return fetchJSON<{ spaces: SpaceWithDocs[] }>(
    "/api/spaces?includeArchived=true"
  ).then((r) => r.spaces)
}

export function getSpace(spaceId: string) {
  return fetchJSON<{ space: SpaceFile; widgets: WidgetListEntry[] }>(
    `/api/spaces/${spaceId}`
  )
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
  data: { name?: string; description?: string; icon?: string; group?: string }
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

export function searchWorkspace(opts: {
  query: string
  spaceId?: string
  includeArchived?: boolean
  maxResults?: number
}) {
  const params = new URLSearchParams({ query: opts.query })
  params.set("documentMode", "common")
  if (opts.spaceId) params.set("spaceId", opts.spaceId)
  if (opts.includeArchived !== undefined)
    params.set("includeArchived", String(opts.includeArchived))
  if (opts.maxResults !== undefined)
    params.set("maxResults", String(opts.maxResults))
  return fetchJSON<{ results: SearchResult[] }>(
    `/api/search?${params.toString()}`
  ).then((r) => r.results)
}

export async function deleteSpace(spaceId: string): Promise<void> {
  await fetchVoid(`/api/spaces/${spaceId}`, { method: "DELETE" })
}
