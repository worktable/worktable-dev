import type {
  DocListEntry,
  DocumentListItem,
  SpaceFile,
} from "@worktable/types"
import type { WidgetListEntry } from "./widgets-api"
import { documentPathKey } from "./document-views"
import { buildTree } from "./tree"
import type { DocSortMode, TreeInput, TreeNode } from "./tree"

/** Manual sidebar doc order from space settings (untrusted on-disk data). */
export function getDocOrder(space: SpaceFile): string[] | undefined {
  const value = space.settings["docOrder"]
  if (!Array.isArray(value)) return undefined
  const paths = value.filter((v): v is string => typeof v === "string")
  return paths.length > 0 ? paths : undefined
}

/** Sidebar doc sort mode from space settings; default is custom order. */
export function getDocSort(space: SpaceFile): DocSortMode {
  const value = space.settings["docSort"]
  return value === "alphabetical" || value === "updated" ? value : "custom"
}

export function documentListItemArchived(item: DocumentListItem): boolean {
  if (item.kind === "document") return item.archived === true
  const documents = item.claims.filter((claim) => claim.kind === "document")
  return (
    documents.length > 0 && documents.every((claim) => claim.archived === true)
  )
}

export function documentFolderPaths(items: DocumentListItem[]): Set<string> {
  const paths = new Set<string>()
  for (const item of items) {
    const documentPath = item.kind === "conflict" ? item.pathKey : item.path
    const segments = documentPath.split("/")
    for (let index = 1; index < segments.length; index += 1) {
      paths.add(segments.slice(0, index).join("/"))
    }
  }
  return paths
}

/**
 * Project catalog entries into tree inputs with the labels people see: a
 * Markdown or rich-text doc's first heading, an HTML doc's name, otherwise the
 * catalog title.
 */
export function documentTreeInputResolver(
  docs: DocListEntry[],
  widgets: WidgetListEntry[]
): (item: DocumentListItem) => TreeInput {
  const docDetails = new Map(docs.map((doc) => [doc.path, doc]))
  const widgetDetails = new Map(widgets.map((widget) => [widget.id, widget]))
  const legacyDocFor = (
    item: Extract<DocumentListItem, { kind: "document" }>
  ) => {
    const candidate = docDetails.get(item.path)
    return candidate &&
      !!candidate.archived === !!item.archived &&
      ((item.format.id === "worktable.markdown" &&
        candidate.format === "markdown") ||
        (item.format.id === "worktable.rich-text" &&
          candidate.format === "blocknote"))
      ? candidate
      : undefined
  }
  return (item) => {
    if (item.kind === "conflict") {
      return {
        path: item.pathKey,
        kind: "conflict" as const,
        health: item.health,
      }
    }
    const widgetCandidate = widgetDetails.get(item.path)
    const doc = legacyDocFor(item)
    const widget =
      widgetCandidate &&
      item.format.id === "worktable.html" &&
      !!widgetCandidate.archive === !!item.archived
        ? widgetCandidate
        : undefined
    return {
      path: item.path,
      kind: "document" as const,
      title: doc?.headings?.[0]?.trim() || widget?.name || item.title,
      format: item.format,
      health: item.health,
      archived: item.archived,
      updatedAt:
        doc?.provenance?.updatedAt ??
        (typeof doc?.updatedAt === "number"
          ? new Date(doc.updatedAt).toISOString()
          : (widget?.updatedAt ?? item.updatedAt)),
    }
  }
}

/** Temporary documents are supporting work the sidebar lists on their own. */
export function isTemporaryDocument(item: DocumentListItem): boolean {
  return item.kind === "document" && item.lifetime === "temporary"
}

export interface SpaceDocumentTrees {
  /** Active documents in sidebar order; includes temporary ones unless separated. */
  active: TreeNode[]
  /** Temporary documents, when separated from the active tree. */
  temporary: TreeNode[]
  archived: TreeNode[]
}

/** The catalog as the sidebar and breadcrumb both present it. */
export function buildSpaceDocumentTrees({
  documents,
  docs,
  widgets,
  sort,
  order,
  separateTemporary = false,
}: {
  documents: DocumentListItem[]
  docs: DocListEntry[]
  widgets: WidgetListEntry[]
  sort: DocSortMode
  order?: string[]
  separateTemporary?: boolean
}): SpaceDocumentTrees {
  const toTreeInput = documentTreeInputResolver(docs, widgets)
  const options = { folderPaths: documentFolderPaths(documents) }
  const treeSort = { mode: sort, order }
  const build = (items: DocumentListItem[]) =>
    buildTree(items.map(toTreeInput), treeSort, options)
  const active = documents.filter((item) => !documentListItemArchived(item))
  return {
    active: build(
      separateTemporary
        ? active.filter((item) => !isTemporaryDocument(item))
        : active
    ),
    temporary: separateTemporary
      ? build(active.filter(isTemporaryDocument))
      : [],
    archived: build(documents.filter(documentListItemArchived)),
  }
}

export function findTreeNode(
  nodes: TreeNode[],
  path: string
): TreeNode | undefined {
  let current: TreeNode | undefined
  let level = nodes
  // Paths that differ only in case or Unicode form name the same document,
  // as they do on the server (conflict pages keep the URL as typed).
  for (const segment of path.split("/")) {
    const key = documentPathKey(segment)
    current = level.find((node) => documentPathKey(node.name) === key)
    if (!current) return undefined
    level = current.children
  }
  return current
}
