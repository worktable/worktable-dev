import { flushDrawingBeforeMove } from "./drawing-drafts"
import type {
  DocumentContent,
  DocumentContentRevisionChanged,
  DocumentListItem,
  DocumentNavigationTarget,
  DocumentPageResult,
  WithContentRevision,
} from "@worktable/types"
import {
  BASE_URL,
  HttpError,
  UnauthorizedError,
  authenticatedFetch,
  fetchJSON,
  redirectToLogin,
  type ReadOptions,
} from "./http.ts"

export function listDocuments(
  spaceId: string,
  includeArchived = false,
  options?: ReadOptions
): Promise<WithContentRevision<DocumentListItem>[]> {
  return fetchJSON<{ documents: WithContentRevision<DocumentListItem>[] }>(
    `/api/spaces/${spaceId}/documents?includeArchived=${includeArchived ? "true" : "false"}`,
    options
  ).then((result) => result.documents)
}

/** The revision a stale content address was answered with, if that was why. */
export function changedRevision(error: unknown): string | null {
  if (!(error instanceof HttpError) || error.status !== 409) return null
  const body = error.body as Partial<DocumentContentRevisionChanged> | null
  return body?.code === "REVISION_CHANGED" && typeof body.revision === "string"
    ? body.revision
    : null
}

/**
 * A Doc's content at one revision. The browser keeps the response; a
 * revision that is no longer current fails with the current one (see
 * changedRevision).
 */
export function readDocumentContent(
  spaceId: string,
  path: string,
  revision: string,
  options?: ReadOptions
): Promise<DocumentContent> {
  const query = new URLSearchParams({ path, rev: revision })
  return fetchJSON<DocumentContent>(
    `/api/spaces/${encodeURIComponent(spaceId)}/documents/content?${query}`,
    options
  )
}

export function resolveDocumentNavigation(
  spaceId: string,
  path: string
): Promise<DocumentNavigationTarget> {
  const query = new URLSearchParams({ path })
  return fetchJSON<{ target: DocumentNavigationTarget }>(
    `/api/spaces/${encodeURIComponent(spaceId)}/documents/resolve?${query}`
  ).then((result) => result.target)
}

function exactDocumentQuery(path: string): string {
  return new URLSearchParams({ path }).toString()
}

export function readDocumentPage(
  spaceId: string,
  path: string,
  options?: ReadOptions
): Promise<DocumentPageResult> {
  return fetchJSON<{ page: DocumentPageResult }>(
    `/api/spaces/${encodeURIComponent(spaceId)}/documents/page?${exactDocumentQuery(path)}`,
    options
  ).then((result) => result.page)
}

function downloadFileName(disposition: string | null, path: string): string {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encoded) {
    try {
      return decodeURIComponent(encoded)
    } catch {
      // Fall through to the stable path-derived name.
    }
  }
  return path.split("/").filter(Boolean).at(-1) || "document"
}

export async function downloadDocumentSource(
  spaceId: string,
  path: string
): Promise<void> {
  const response = await authenticatedFetch(
    `${BASE_URL}/api/spaces/${encodeURIComponent(spaceId)}/documents/source?${exactDocumentQuery(path)}`
  )
  if (response.status === 401) {
    redirectToLogin()
    throw new UnauthorizedError()
  }
  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ error: response.statusText }))
    throw new HttpError(
      response.status,
      body,
      (body as { error?: string }).error ?? `HTTP ${response.status}`
    )
  }
  const url = URL.createObjectURL(await response.blob())
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = downloadFileName(
    response.headers.get("content-disposition"),
    path
  )
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export async function moveDocumentFolder(
  spaceId: string,
  oldPath: string,
  newPath: string
): Promise<{
  ok: true
  oldPath: string
  newPath: string
  count: number
  renamed: Array<{ from: string; to: string }>
}> {
  await flushDrawingBeforeMove(spaceId, oldPath)
  return fetchJSON(`/api/spaces/${spaceId}/documents/move-folder`, {
    method: "POST",
    body: JSON.stringify({ oldPath, newPath }),
  })
}

type DocumentFolderArchiveResult = {
  ok: true
  path: string
  archived: boolean
  count: number
  paths: string[]
}

export function archiveDocumentFolder(
  spaceId: string,
  path: string,
  reason?: string
): Promise<DocumentFolderArchiveResult> {
  return fetchJSON(`/api/spaces/${spaceId}/documents/archive-folder`, {
    method: "POST",
    body: JSON.stringify({ path, ...(reason ? { reason } : {}) }),
  })
}

export function restoreDocumentFolder(
  spaceId: string,
  path: string
): Promise<DocumentFolderArchiveResult> {
  return fetchJSON(`/api/spaces/${spaceId}/documents/restore-folder`, {
    method: "POST",
    body: JSON.stringify({ path }),
  })
}

export function deleteDocumentFolder(
  spaceId: string,
  path: string
): Promise<{
  ok: true
  path: string
  count: number
  paths: string[]
}> {
  return fetchJSON(`/api/spaces/${spaceId}/documents/delete-folder`, {
    method: "POST",
    body: JSON.stringify({ path }),
  })
}

export interface EditableDocumentSource {
  documentId: string
  path: string
  format: { id: string; sourceVersion: number }
  source: string
  sourceRevision: string
}

export function readEditableDocument(
  spaceId: string,
  path: string
): Promise<EditableDocumentSource> {
  return fetchJSON(
    `/api/spaces/${encodeURIComponent(spaceId)}/documents/editable-source?${exactDocumentQuery(path)}`
  )
}

export function writeDocumentSource(
  spaceId: string,
  input: {
    path: string
    source: string
    format?: { id: string; sourceVersion: number }
    expectedRevision?: string
    /** New documents only; omitted means durable. */
    lifetime?: "durable" | "temporary"
  }
): Promise<{ path: string; documentId: string; sourceRevision: string }> {
  return fetchJSON(`/api/spaces/${encodeURIComponent(spaceId)}/documents`, {
    method: input.format ? "POST" : "PUT",
    body: JSON.stringify({ ...input, encoding: "utf8" }),
  })
}

export async function mutateDocument(
  spaceId: string,
  action: "move" | "archive" | "restore" | "delete",
  path: string,
  to?: string
): Promise<{ to?: string }> {
  if (action === "move") await flushDrawingBeforeMove(spaceId, path)
  return fetchJSON(
    `/api/spaces/${encodeURIComponent(spaceId)}/documents/${action}`,
    {
      method: "POST",
      body: JSON.stringify({ path, ...(to ? { to } : {}) }),
    }
  )
}
