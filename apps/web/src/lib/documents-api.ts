import { flushDrawingBeforeMove } from "./drawing-drafts"
import type {
  DocumentListItem,
  DocumentNavigationTarget,
  DocumentPageResult,
} from "@worktable/types"
import {
  BASE_URL,
  HttpError,
  UnauthorizedError,
  authenticatedFetch,
  fetchJSON,
  redirectToLogin,
} from "./http.ts"

export function listDocuments(
  spaceId: string,
  includeArchived = false
): Promise<DocumentListItem[]> {
  return fetchJSON<{ documents: DocumentListItem[] }>(
    `/api/spaces/${spaceId}/documents?includeArchived=${includeArchived ? "true" : "false"}`
  ).then((result) => result.documents)
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
  path: string
): Promise<DocumentPageResult> {
  return fetchJSON<{ page: DocumentPageResult }>(
    `/api/spaces/${encodeURIComponent(spaceId)}/documents/page?${exactDocumentQuery(path)}`
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
