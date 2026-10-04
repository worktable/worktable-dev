import { humanizeSegment } from "./tree"
import type { TreeNode } from "./tree"
import { findTreeNode } from "./space-document-tree"
import type { SpaceDocumentTrees } from "./space-document-tree"

export type BreadcrumbTarget =
  | { to: "/spaces/$spaceId"; params: { spaceId: string } }
  | {
      to: "/spaces/$spaceId/records/$" | "/spaces/$spaceId/threads/$"
      params: { spaceId: string; _splat: string }
    }
  | { to: "/threads/$"; params: { _splat: string } }

/** What a crumb names, for icons and narrow-screen presentation. */
export type BreadcrumbRole =
  | "home"
  | "space"
  | "threads"
  | "thread"
  | "collection"
  | "record"
  | "folder"
  | "document"

export type Breadcrumb = {
  label: string
  role: BreadcrumbRole
  /** The catalog entry a folder or document crumb names, once loaded. */
  node?: TreeNode
  /** A pane title that narrow screens leave to the pane itself. */
  mobileHidden?: boolean
} & (
  | { kind: "text" }
  | { kind: "link"; target: BreadcrumbTarget }
  | {
      kind: "folder"
      node: TreeNode
      spaceId: string
      /** The open document, marked in the folder's menu. */
      currentPath: string
    }
)

export interface BreadcrumbInput {
  pathname: string
  titleOverride?: string
  parentTitleOverride?: string
  spaceName?: string
  documents?: SpaceDocumentTrees
}

/** The space whose name and documents label the route, if any. */
export function breadcrumbSpaceId(pathname: string): string | undefined {
  const match = pathname.match(/^\/(?:threads\/)?spaces\/([^/]+)/)
  return match ? safeDecode(match[1]!) : undefined
}

export function isDocumentPathname(pathname: string): boolean {
  return /^\/spaces\/[^/]+\/(?:documents|docs|widgets)\/./.test(pathname)
}

/**
 * Route context for the shell header. The last crumb is the current page;
 * ancestors link to the page they name, and folders open their contents.
 */
export function buildBreadcrumbs({
  pathname,
  titleOverride,
  parentTitleOverride,
  spaceName,
  documents,
}: BreadcrumbInput): Breadcrumb[] {
  const crumbs: Breadcrumb[] = []
  const spaceCrumb = (spaceId: string, fallback?: string): Breadcrumb => ({
    kind: "link",
    role: "space",
    label: spaceName ?? fallback ?? humanizeSegment(spaceId),
    target: { to: "/spaces/$spaceId", params: { spaceId } },
  })

  if (pathname === "/") return [{ kind: "text", role: "home", label: "Home" }]

  const threadsMatch = pathname.match(/^\/threads(?:\/(.*))?$/)
  if (threadsMatch) {
    const splat = threadsMatch[1] ?? ""
    const spaceThread = splat.match(/^spaces\/([^/]+)\/[^/]+$/)
    if (spaceThread) {
      crumbs.push(spaceCrumb(safeDecode(spaceThread[1]!), parentTitleOverride))
    }
    crumbs.push(
      splat
        ? {
            kind: "link",
            role: "threads",
            label: "Threads",
            target: { to: "/threads/$", params: { _splat: "" } },
          }
        : { kind: "text", role: "threads", label: "Threads" }
    )
    if (titleOverride) {
      crumbs.push({
        kind: "text",
        role: "thread",
        label: titleOverride,
        mobileHidden: true,
      })
    }
    return crumbs
  }

  const spaceMatch = pathname.match(/^\/spaces\/([^/]+)(?:\/(.*))?$/)
  if (!spaceMatch) return crumbs
  const spaceId = safeDecode(spaceMatch[1]!)
  const rest = (spaceMatch[2] ?? "").split("/").map(safeDecode)
  crumbs.push(spaceCrumb(spaceId))

  const [section, ...segments] = rest
  if (section === "threads") {
    const threadId = segments.join("/")
    crumbs.push(
      threadId
        ? {
            kind: "link",
            role: "threads",
            label: "Threads",
            target: {
              to: "/spaces/$spaceId/threads/$",
              params: { spaceId, _splat: "" },
            },
          }
        : { kind: "text", role: "threads", label: "Threads" }
    )
    if (titleOverride) {
      crumbs.push({
        kind: "text",
        role: "thread",
        label: titleOverride,
        mobileHidden: true,
      })
    }
  } else if (section === "records" && segments[0]) {
    const [collectionId, recordId] = segments
    if (recordId) {
      crumbs.push({
        kind: "link",
        role: "collection",
        label: parentTitleOverride ?? collectionId,
        target: {
          to: "/spaces/$spaceId/records/$",
          params: { spaceId, _splat: collectionId },
        },
      })
      crumbs.push({
        kind: "text",
        role: "record",
        label: titleOverride ?? recordId,
      })
    } else {
      crumbs.push({
        kind: "text",
        role: "collection",
        label: titleOverride ?? collectionId,
      })
    }
  } else if (
    (section === "documents" || section === "docs" || section === "widgets") &&
    segments.some(Boolean)
  ) {
    const currentPath = segments.join("/")
    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join("/")
      const node =
        (documents && findTreeNode(documents.active, path)) ??
        (documents && findTreeNode(documents.archived, path))
      const label = node?.label ?? humanizeSegment(segment)
      if (index === segments.length - 1) {
        crumbs.push({
          kind: "text",
          role: "document",
          label: titleOverride ?? label,
          node,
        })
        return
      }
      // Folders whose contents are all archived have nothing to open.
      const folder = documents && findTreeNode(documents.active, path)
      crumbs.push(
        folder && (folder.children.length > 0 || folder.kind !== "folder")
          ? {
              kind: "folder",
              role: "folder",
              label,
              node: folder,
              spaceId,
              currentPath,
            }
          : { kind: "text", role: "folder", label, node }
      )
    })
  }

  return crumbs
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
