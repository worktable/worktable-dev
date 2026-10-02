import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback } from "react"
import type {
  DocumentLifetime,
  DocumentSummary,
  ResolvedStartHerePin,
  StartHerePin,
} from "@worktable/types"
import { useDocuments, documentQueryKeys } from "./documents-queries.ts"
import { fetchJSON } from "./http.ts"

// ── Lifetime ────────────────────────────────────────────────

export function setDocumentLifetime(
  spaceId: string,
  path: string,
  lifetime: DocumentLifetime,
  archiveOn?: string
): Promise<{ path: string; lifetime: DocumentLifetime; archiveOn?: string }> {
  return fetchJSON(`/api/spaces/${encodeURIComponent(spaceId)}/documents/lifetime`, {
    method: "POST",
    body: JSON.stringify({ path, lifetime, ...(archiveOn ? { archiveOn } : {}) }),
  })
}

/** "Oct 9" this year, "Oct 9, 2027" otherwise. */
export function formatArchiveDate(iso: string): string {
  const date = new Date(iso)
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  })
}

/** The document summary for one path, from the Space's shared list query. */
export function useDocumentSummary(
  spaceId: string,
  path: string
): DocumentSummary | undefined {
  const { data } = useDocuments(spaceId)
  return data?.find(
    (item): item is DocumentSummary => item.kind === "document" && item.path === path
  )
}

/** Refresh every list that shows lifetimes after a change. */
export function useRefreshDocumentLists(spaceId: string): () => Promise<void> {
  const queryClient = useQueryClient()
  return useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: documentQueryKeys.list(spaceId) }),
      queryClient.invalidateQueries({ queryKey: recentQueryKeys.all }),
      queryClient.invalidateQueries({ queryKey: ["search"] }),
    ])
  }, [queryClient, spaceId])
}

// ── New-document lifetime preference ───────────────────────

const NEW_LIFETIME_KEY = "worktable-new-document-lifetime"

/** New documents start temporary unless the person last chose durable. */
export function readNewDocumentLifetime(): DocumentLifetime {
  try {
    return localStorage.getItem(NEW_LIFETIME_KEY) === "durable" ? "durable" : "temporary"
  } catch {
    return "temporary"
  }
}

export function writeNewDocumentLifetime(lifetime: DocumentLifetime): void {
  try {
    localStorage.setItem(NEW_LIFETIME_KEY, lifetime)
  } catch {
    // Private browsing: the choice applies to this creation only.
  }
}

// ── Recent documents ───────────────────────────────────────

export interface RecentDocument {
  spaceId: string
  spaceName: string
  document: DocumentSummary
}

export interface RecentDocuments {
  items: RecentDocument[]
  spaces: Array<{ spaceId: string; lastActivityAt?: string }>
}

export const recentQueryKeys = {
  all: ["recent"] as const,
  list: (options: RecentOptions) => ["recent", options] as const,
}

export interface RecentOptions {
  spaceId?: string
  sort: "updated" | "created"
  includeTemporary: boolean
  limit?: number
}

export function recentQueryOptions(options: RecentOptions) {
  return queryOptions({
    queryKey: recentQueryKeys.list(options),
    queryFn: () => {
      const query = new URLSearchParams({
        sort: options.sort,
        includeTemporary: options.includeTemporary ? "true" : "false",
        limit: String(options.limit ?? 30),
        ...(options.spaceId ? { spaceId: options.spaceId } : {}),
      })
      return fetchJSON<RecentDocuments>(`/api/recent?${query}`)
    },
    staleTime: 10_000,
  })
}

export function useRecentDocuments(options: RecentOptions) {
  return useQuery(recentQueryOptions(options))
}

// ── Start here ─────────────────────────────────────────────

export function setStartHere(
  spaceId: string,
  pins: StartHerePin[]
): Promise<{ startHere: ResolvedStartHerePin[] }> {
  return fetchJSON(`/api/spaces/${encodeURIComponent(spaceId)}/start-here`, {
    method: "PUT",
    body: JSON.stringify({ pins }),
  })
}
