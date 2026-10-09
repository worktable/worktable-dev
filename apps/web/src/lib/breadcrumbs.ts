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
  | "activity"
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
  /** The space's chosen icon, on its crumb. */
  icon?: string
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
  spaceIcon?: string
  documents?: Pick<SpaceDocumentTrees, "active" | "archived">
}

/** The space whose name and documents label the route, if any. */
export function breadcrumbSpaceId(pathname: string): string | undefined {
  const match = pathname.match(/^\/(?:threads\/)?spaces\/([^/]+)/)
  return match ? safeDecode(match[1]!) : undefined
}

/** Route sections that open a document; `docs` and `widgets` redirect. */
const DOCUMENT_SECTIONS = new Set(["documents", "docs", "widgets"])

export function isDocumentPathname(pathname: string): boolean {
  const [, section, ...segments] =
    pathname.match(/^\/spaces\/[^/]+\/([^/]+)\/(.*)$/) ?? []
  return !!section && DOCUMENT_SECTIONS.has(section) && segments.join("") !== ""
}

/** "Threads", linking to the list when a thread is open, then its title. */
function threadsCrumbs(
  list: BreadcrumbTarget,
  threadOpen: boolean,
  titleOverride: string | undefined
): Breadcrumb[] {
  const crumbs: Breadcrumb[] = [
    threadOpen
      ? { kind: "link", role: "threads", label: "Threads", target: list }
      : { kind: "text", role: "threads", label: "Threads" },
  ]
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

/**
 * Route context for the shell header. The last crumb is the current page;
 * ancestors link to the page they name, and folders open their contents.
 */
export function buildBreadcrumbs({
  pathname,
  titleOverride,
  parentTitleOverride,
  spaceName,
  spaceIcon,
  documents,
}: BreadcrumbInput): Breadcrumb[] {
  const crumbs: Breadcrumb[] = []
  const spaceCrumb = (spaceId: string, fallback?: string): Breadcrumb => ({
    kind: "link",
    role: "space",
    label: spaceName ?? fallback ?? humanizeSegment(spaceId),
    icon: spaceIcon,
    target: { to: "/spaces/$spaceId", params: { spaceId } },
  })

  if (pathname === "/") return [{ kind: "text", role: "home", label: "Home" }]
  if (pathname === "/activity") {
    return [{ kind: "text", role: "activity", label: "Activity" }]
  }

  const threadsMatch = pathname.match(/^\/threads(?:\/(.*))?$/)
  if (threadsMatch) {
    const splat = threadsMatch[1] ?? ""
    const spaceThread = splat.match(/^spaces\/([^/]+)\/[^/]+$/)
    if (spaceThread) {
      crumbs.push(spaceCrumb(safeDecode(spaceThread[1]!), parentTitleOverride))
    }
    crumbs.push(
      ...threadsCrumbs(
        { to: "/threads/$", params: { _splat: "" } },
        splat !== "",
        titleOverride
      )
    )
    return crumbs
  }

  const spaceMatch = pathname.match(/^\/spaces\/([^/]+)(?:\/(.*))?$/)
  if (!spaceMatch) return crumbs
  const spaceId = safeDecode(spaceMatch[1]!)
  const rest = (spaceMatch[2] ?? "").split("/").map(safeDecode)
  crumbs.push(spaceCrumb(spaceId))

  const [section, ...segments] = rest
  if (section === "threads") {
    crumbs.push(
      ...threadsCrumbs(
        {
          to: "/spaces/$spaceId/threads/$",
          params: { spaceId, _splat: "" },
        },
        segments.join("/") !== "",
        titleOverride
      )
    )
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
    section !== undefined &&
    DOCUMENT_SECTIONS.has(section) &&
    segments.some(Boolean)
  ) {
    // A trailing or doubled slash names no document of its own.
    const parts = segments.filter(Boolean)
    const currentPath = parts.join("/")
    parts.forEach((segment, index) => {
      const path = parts.slice(0, index + 1).join("/")
      const active = documents && findTreeNode(documents.active, path)
      const node =
        active ?? (documents && findTreeNode(documents.archived, path))
      const label = node?.label ?? humanizeSegment(segment)
      if (index === parts.length - 1) {
        crumbs.push({
          kind: "text",
          role: "document",
          label: titleOverride ?? label,
          node,
        })
        return
      }
      // Folders whose contents are all archived have nothing to open.
      crumbs.push(
        active
          ? {
              kind: "folder",
              role: "folder",
              label,
              node: active,
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
