import type {
  DocumentFormatClaim,
  DocumentHealth,
  DocumentSpecializedView,
  SearchResult,
} from "@worktable/types"

export type SpecializedDocumentView = DocumentSpecializedView

export type DocumentRoute = {
  to: "/spaces/$spaceId/documents/$"
  params: { spaceId: string; _splat: string }
}

export type SpecializedDocumentRoute = DocumentRoute

export function documentRoute(spaceId: string, path: string): DocumentRoute {
  return {
    to: "/spaces/$spaceId/documents/$",
    params: { spaceId, _splat: path },
  }
}

export function specializedDocumentRoute(
  view: SpecializedDocumentView,
  spaceId: string,
  path: string
): SpecializedDocumentRoute {
  void view
  return documentRoute(spaceId, path)
}

export function documentHref(spaceId: string, path: string): string {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/")
  return `/spaces/${encodeURIComponent(spaceId)}/documents/${encodedPath}`
}

export function specializedDocumentHref(
  view: SpecializedDocumentView,
  spaceId: string,
  path: string
): string {
  void view
  return documentHref(spaceId, path)
}

const DOCUMENT_VIEW_REGISTRATIONS: Readonly<
  Record<string, { view: SpecializedDocumentView }>
> = {
  "worktable.markdown": { view: "doc" },
  "worktable.rich-text": { view: "doc" },
  "worktable.html": { view: "html" },
}

export function specializedDocumentView(document: {
  kind: "folder" | "document" | "conflict"
  format?: DocumentFormatClaim
  health?: DocumentHealth
}): SpecializedDocumentView | null {
  if (
    document.kind !== "document" ||
    document.health !== "supported" ||
    !document.format
  ) {
    return null
  }
  return DOCUMENT_VIEW_REGISTRATIONS[document.format.id]?.view ?? null
}

type FolderOperationDocument = {
  kind: "folder" | "document" | "conflict"
  format?: DocumentFormatClaim
  health?: DocumentHealth
  folderOperations?: {
    move?: boolean
    archive?: boolean
    delete?: boolean
  }
}

function supportsManagedFolderOperation(
  document: FolderOperationDocument,
  operation: "move" | "archive" | "delete"
): boolean {
  return (
    document.kind === "document" &&
    document.health === "supported" &&
    document.folderOperations?.[operation] === true
  )
}

export function supportsManagedFolderMove(
  document: FolderOperationDocument
): boolean {
  return supportsManagedFolderOperation(document, "move")
}

export function supportsManagedFolderArchive(
  document: FolderOperationDocument
): boolean {
  return supportsManagedFolderOperation(document, "archive")
}

export function supportsManagedFolderDelete(
  document: FolderOperationDocument
): boolean {
  return supportsManagedFolderOperation(document, "delete")
}

/** Match server folder membership for paths already admitted to discovery. */
export function documentPathIsAtOrBelow(
  candidatePath: string,
  ancestorPath: string
): boolean {
  const candidateKey = candidatePath.normalize("NFC").toLowerCase()
  const ancestorKey = ancestorPath.normalize("NFC").toLowerCase()
  return (
    candidateKey === ancestorKey || candidateKey.startsWith(`${ancestorKey}/`)
  )
}

/** Legacy search hits are Docs. Common hits declare their format explicitly. */
export function searchResultDocumentView(
  result: SearchResult
): SpecializedDocumentView | null {
  if (result.type !== "doc") return null
  if (!result.documentKind) return "doc"
  if (result.documentKind !== "document" || result.health !== "supported") {
    return null
  }
  return result.documentView ?? null
}
