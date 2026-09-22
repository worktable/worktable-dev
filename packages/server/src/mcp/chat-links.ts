import { documentReferenceHref } from "@worktable/types"
import { sanitizeDocPath } from "../store.ts"
import type { ResultLinkKind } from "./operations.ts"

/** Linked destinations have no remote browsing surface. Keep citations tied to
 * their device and present an authenticated open-locally instruction page. */
export function mcpContentUrl(origin: string, path: string): string {
  const url = new URL(origin)
  const destination = /^\/api\/mcp\/d\/([a-f0-9]{32})$/.exec(url.pathname)?.[1]
  return destination
    ? `${url.origin}/linked/open/${destination}?path=${encodeURIComponent(path)}`
    : new URL(path, origin).href
}

export function docUrlToSendInChat(
  origin: string,
  spaceId: string,
  docPath: string
): string {
  const path = sanitizeDocPath(docPath)
  return mcpContentUrl(origin, documentReferenceHref(spaceId, path))
}

export function widgetUrlToSendInChat(
  origin: string,
  spaceId: string,
  widgetId: string
): string {
  return mcpContentUrl(origin, documentReferenceHref(spaceId, widgetId))
}

export function recordUrlToSendInChat(
  origin: string,
  spaceId: string,
  collectionId: string,
  recordId: string
): string {
  return mcpContentUrl(origin, `/spaces/${encodeURIComponent(spaceId)}/records/${encodeURIComponent(collectionId)}/${encodeURIComponent(recordId)}`)
}

/**
 * Add an ephemeral, current-install URL only to MCP results that represent one
 * existing document. Durable identity remains docPath/widgetId; list and search
 * results deliberately stay path-only.
 */
export function addUrlToSendInChat(
  linkKind: ResultLinkKind,
  args: Record<string, unknown>,
  result: unknown,
  origin: string
): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result))
    return result
  const record = result as Record<string, unknown>
  const spaceId = args["spaceId"]
  if (typeof spaceId !== "string") return result

  if (linkKind === "doc") {
    const docPath = record["docPath"]
    if (typeof docPath !== "string") return result
    return {
      ...record,
      urlToSendInChat: docUrlToSendInChat(origin, spaceId, docPath),
    }
  }

  if (linkKind === "renamed_doc") {
    const newPath = record["newPath"]
    if (typeof newPath !== "string") return result
    return {
      ...record,
      urlToSendInChat: docUrlToSendInChat(origin, spaceId, newPath),
    }
  }

  if (linkKind === "html") {
    const widgetId = record["widgetId"] ?? args["widgetId"]
    if (typeof widgetId !== "string") return result
    return {
      ...record,
      urlToSendInChat: widgetUrlToSendInChat(origin, spaceId, widgetId),
    }
  }

  return result
}
