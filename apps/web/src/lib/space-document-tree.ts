import type {
  DocListEntry,
  DocumentListItem,
  SpaceFile,
} from "@worktable/types"
import type { WidgetListEntry } from "./widgets-api"
import {
  documentPathKey,
  supportsManagedFolderArchive,
  supportsManagedFolderDelete,
  supportsManagedFolderMove,
} from "./document-views"
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
  const index = buildSpaceDocumentIndex({ documents: [], docs, widgets })
  const legacyDocFor = (
    item: Extract<DocumentListItem, { kind: "document" }>
  ) => {
    const candidate = index.doc(item.path, item.archived)
    return candidate &&
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
    const doc = legacyDocFor(item)
    const widget =
      item.format.id === "worktable.html"
        ? index.widget(item.path, item.archived)
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

export type FolderOperation = "move" | "archive" | "delete"

const FOLDER_OPERATIONS: Record<
  FolderOperation,
  (item: DocumentListItem) => boolean
> = {
  move: supportsManagedFolderMove,
  archive: supportsManagedFolderArchive,
  delete: supportsManagedFolderDelete,
}

/** Lookups a tree row needs, built once per catalog read. */
export interface SpaceDocumentIndex {
  /** The legacy list entry for a Markdown or rich-text document. */
  doc(path: string, archived: boolean | undefined): DocListEntry | undefined
  /** The HTML document at this path in the given archive state. */
  widget(
    path: string,
    archived: boolean | undefined
  ): WidgetListEntry | undefined
  /** Whether an HTML document lives at this exact path, archived or not. */
  hasWidget(path: string): boolean
  /** Whether everything at or below the path supports the folder operation. */
  folderSupports(path: string, operation: FolderOperation): boolean
}

function archiveKey(path: string, archived: unknown): string {
  return `${archived ? "archived" : "active"}:${path}`
}

/** The path's key and each of its ancestors' keys. */
function pathKeyAndAncestors(path: string): string[] {
  const segments = documentPathKey(path).split("/")
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"))
}

export function buildSpaceDocumentIndex({
  documents,
  docs,
  widgets,
}: {
  documents: DocumentListItem[]
  docs: DocListEntry[]
  widgets: WidgetListEntry[]
}): SpaceDocumentIndex {
  const docEntries = new Map<string, DocListEntry>()
  for (const doc of docs) {
    const key = archiveKey(doc.path, doc.archived)
    if (!docEntries.has(key)) docEntries.set(key, doc)
  }
  const widgetEntries = new Map<string, WidgetListEntry>()
  for (const widget of widgets) {
    const key = archiveKey(widget.id, widget.archive)
    if (!widgetEntries.has(key)) widgetEntries.set(key, widget)
  }
  const widgetPaths = new Set(widgets.map((widget) => widget.id))
  // A folder operation is unavailable when any entry at or below the folder
  // cannot take part: record each such entry's path and all its ancestors.
  const unavailable: Record<FolderOperation, Set<string>> = {
    move: new Set(),
    archive: new Set(),
    delete: new Set(),
  }
  for (const item of documents) {
    const path = item.kind === "conflict" ? item.pathKey : item.path
    for (const operation of ["move", "archive", "delete"] as const) {
      if (item.kind === "conflict" || !FOLDER_OPERATIONS[operation](item)) {
        for (const key of pathKeyAndAncestors(path)) {
          unavailable[operation].add(key)
        }
      }
    }
  }
  return {
    doc: (path, archived) => docEntries.get(archiveKey(path, archived)),
    widget: (path, archived) => widgetEntries.get(archiveKey(path, archived)),
    hasWidget: (path) => widgetPaths.has(path),
    folderSupports: (path, operation) =>
      !unavailable[operation].has(documentPathKey(path)),
  }
}

// The sidebar and the header both present a Space's catalog. Each reads the
// same cached query results, so build once per read and share the result
// across components and renders instead of rebuilding per render.
interface CachedBuild<T> {
  docs: DocListEntry[]
  widgets: WidgetListEntry[]
  variant: string
  value: T
}

function cachedBuild<T>(
  cache: WeakMap<DocumentListItem[], CachedBuild<T>[]>,
  input: {
    documents: DocumentListItem[]
    docs: DocListEntry[]
    widgets: WidgetListEntry[]
  },
  variant: string,
  build: () => T
): T {
  const entries = cache.get(input.documents) ?? []
  const hit = entries.find(
    (entry) =>
      entry.docs === input.docs &&
      entry.widgets === input.widgets &&
      entry.variant === variant
  )
  if (hit) return hit.value
  const value = build()
  // A few variants per read: the sidebar's and the header's trees, and a
  // pending custom order while a drag saves.
  cache.set(input.documents, [
    { docs: input.docs, widgets: input.widgets, variant, value },
    ...entries.slice(0, 3),
  ])
  return value
}

const treeCache = new WeakMap<
  DocumentListItem[],
  CachedBuild<SpaceDocumentTrees>[]
>()
const indexCache = new WeakMap<
  DocumentListItem[],
  CachedBuild<SpaceDocumentIndex>[]
>()

/** `buildSpaceDocumentTrees`, shared while its inputs are the same reads. */
export function spaceDocumentTrees(
  input: Parameters<typeof buildSpaceDocumentTrees>[0]
): SpaceDocumentTrees {
  const variant = [
    input.sort,
    input.separateTemporary ? "separate" : "together",
    ...(input.order ?? []),
  ].join("\n")
  return cachedBuild(treeCache, input, variant, () =>
    buildSpaceDocumentTrees(input)
  )
}

/** `buildSpaceDocumentIndex`, shared while its inputs are the same reads. */
export function spaceDocumentIndex(
  input: Parameters<typeof buildSpaceDocumentIndex>[0]
): SpaceDocumentIndex {
  return cachedBuild(indexCache, input, "", () =>
    buildSpaceDocumentIndex(input)
  )
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
