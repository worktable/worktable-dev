import { Link, Navigate, useParams, useRouterState } from "@tanstack/react-router"
import { ChevronLeft, ChevronRight, Folder, FolderOpen, X } from "lucide-react"
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { TruncatedText } from "@worktable/ui/components/truncated-text"
import { cn } from "@worktable/ui/lib/utils"
import { DocumentNodeIcon } from "@/components/document-node-icon"
import { TemporaryMark } from "@/components/sidebar/temporary-mark"
import { useFolderColumnFits } from "@/lib/list-beside"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@worktable/ui/components/collapsible"
import { ScrollFadeArea } from "@/components/scroll-fade-area"
import { rememberedOpen, rememberOpen } from "@/lib/sidebar-open-state"
import { collapsiblePanel, transitionSidebar } from "@/lib/sidebar-transition"
import { useSpaceDocs } from "@/lib/docs-queries"
import { useDocuments } from "@/lib/documents-queries"
import { useSpaces } from "@/lib/queries"
import {
  browseFolder,
  markTreeNavigation,
  openingDocument,
  pathIsAtOrBelow,
  routePlace,
  useSidebarLayout,
} from "@/lib/sidebar-live"
import {
  findTreeNode,
  getDocOrder,
  getDocSort,
  spaceDocumentTrees,
} from "@/lib/space-document-tree"
import type { TreeNode } from "@/lib/tree"
import type { DocListEntry, DocumentListItem } from "@worktable/types"

const NO_DOCUMENTS: DocumentListItem[] = []
const NO_DOCS: DocListEntry[] = []

function parentFolder(path: string): string {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? "" : path.slice(0, slash)
}

/**
 * One folder's contents in the sidebar's order (newest first unless someone
 * ordered it), and its parent's, from the Space's cached catalog.
 */
function useFolder(spaceId: string, folder: string) {
  const { data: spaces } = useSpaces()
  const space = spaces?.find((entry) => entry.id === spaceId)
  const { data: documents, isLoading } = useDocuments(spaceId)
  const { data: docs } = useSpaceDocs(spaceId)
  const trees = spaceDocumentTrees({
    documents: documents ?? NO_DOCUMENTS,
    docs: docs ?? NO_DOCS,
    sort: space ? getDocSort(space) : "custom",
    order: space ? getDocOrder(space) : undefined,
    live: true,
    // See All lists the whole folder, the files its Docs show included.
    withEmbedded: true,
  })
  return useMemo(() => {
    const childrenOf = (path: string) =>
      path ? (findTreeNode(trees.active, path)?.children ?? []) : trees.active
    const node = folder ? findTreeNode(trees.active, folder) : undefined
    return {
      label: folder
        ? (node?.label ?? folder.split("/").at(-1) ?? folder)
        : (space?.name ?? ""),
      items: childrenOf(folder),
      parentItems: folder ? childrenOf(parentFolder(folder)) : [],
      loading: isLoading,
    }
  }, [trees.active, folder, space, isLoading])
}

/**
 * Opens a folder at its first document with its list beside it, in one
 * navigation. A folder of folders, or a narrow screen, opens its page.
 */
function FolderLink({
  spaceId,
  path,
  items,
  className,
  label,
  children,
}: {
  spaceId: string
  path: string
  items: readonly TreeNode[]
  className: string
  label?: string
  children: ReactNode
}) {
  const fits = useFolderColumnFits()
  const opens = fits ? openingDocument(items) : null
  // The list opened this, so the sidebar's tree holds still for it.
  const onClick = () => {
    markTreeNavigation()
    browseFolder(spaceId, path)
  }
  return opens ? (
    <Link
      to="/spaces/$spaceId/documents/$"
      params={{ spaceId, _splat: opens }}
      onClick={onClick}
      aria-label={label}
      className={className}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/spaces/$spaceId/folders/$"
      params={{ spaceId, _splat: path }}
      onClick={onClick}
      aria-label={label}
      className={className}
    >
      {children}
    </Link>
  )
}

/** One line per row, as in the sidebar. */
const rowClass =
  "flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors duration-180 sm:min-h-0"

function DocumentRow({
  spaceId,
  node,
  active,
}: {
  spaceId: string
  node: TreeNode
  active: boolean
}) {
  return (
    <Link
      to="/spaces/$spaceId/documents/$"
      params={{ spaceId, _splat: node.path }}
      onClick={markTreeNavigation}
      className={cn(
        rowClass,
        active
          ? "bg-sidebar-accent font-medium text-primary"
          : "text-foreground/80 hover:bg-accent hover:text-foreground"
      )}
      aria-current={active ? "page" : undefined}
      data-active={active ? "" : undefined}
    >
      <DocumentNodeIcon
        node={node}
        className={cn(
          "size-4 shrink-0",
          active ? "text-primary" : "text-muted-foreground/60"
        )}
      />
      <TruncatedText text={node.label} className="min-w-0 flex-1" />
      {node.temporary && (
        // Its hover target overhangs the row's padding, so every row is one height.
        <TemporaryMark archiveOn={node.temporary.archiveOn} className="-my-1 -mr-1.5" />
      )}
    </Link>
  )
}

/**
 * Whether a branch of the list is unfolded: as the person left it on this
 * device, and open by itself while the open document is inside it.
 */
function useBranchOpen(spaceId: string, node: TreeNode, openPath: string | null) {
  const key = `list:${spaceId}:${node.path}`
  const holdsOpen = openPath !== node.path && pathIsAtOrBelow(openPath, node.path)
  const [open, setOpenState] = useState(
    () => holdsOpen || (rememberedOpen("folder", key) ?? false)
  )
  // Following the open document is not the person's choice, so it isn't kept.
  const [followed, setFollowed] = useState(holdsOpen)
  if (holdsOpen !== followed) {
    setFollowed(holdsOpen)
    if (holdsOpen && !open) setOpenState(true)
  }
  const onOpenChange = (next: boolean, details?: { event?: Event }) => {
    const set = () => {
      rememberOpen("folder", key, next)
      setOpenState(next)
    }
    const target = details?.event?.target
    const root =
      target instanceof Element ? target.closest('[data-slot="collapsible"]') : null
    if (!root) return set()
    transitionSidebar(root, set, () => collapsiblePanel(root))
  }
  return [open, onOpenChange] as const
}

/**
 * A folder inside the list. It unfolds in place, as folders do in the
 * sidebar, and stays open on this device; it opens by itself when the
 * open document is inside it.
 */
function FolderBranch({
  spaceId,
  node,
  openPath,
}: {
  spaceId: string
  node: TreeNode
  openPath: string | null
}) {
  const [open, onOpenChange] = useBranchOpen(spaceId, node, openPath)
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger
        className={cn(rowClass, "text-foreground/80 hover:bg-accent hover:text-foreground")}
        render={<button type="button" aria-expanded={open} data-tree-path={node.path} />}
      >
        {open ? (
          <FolderOpen className="size-4 shrink-0 text-primary/60" />
        ) : (
          <Folder className="size-4 shrink-0 text-primary/60" />
        )}
        <TruncatedText text={node.label} className="min-w-0 flex-1" />
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-instant">
        <div className="ml-4 pl-2">
          <FolderItems spaceId={spaceId} items={node.children} openPath={openPath} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * A document that holds others, such as a Doc with its files: its name
 * opens it, and its chevron unfolds what it holds, as in the sidebar.
 */
function DocumentBranch({
  spaceId,
  node,
  openPath,
}: {
  spaceId: string
  node: TreeNode
  openPath: string | null
}) {
  const [open, onOpenChange] = useBranchOpen(spaceId, node, openPath)
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="flex min-w-0 items-center">
        <DocumentRow spaceId={spaceId} node={node} active={openPath === node.path} />
        <CollapsibleTrigger
          className="ml-0.5 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          render={
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? `Collapse ${node.label}` : `Expand ${node.label}`}
              data-tree-path={node.path}
            />
          }
        >
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="collapsible-instant">
        <div className="ml-4 pl-2">
          <FolderItems spaceId={spaceId} items={node.children} openPath={openPath} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function FolderItems({
  spaceId,
  items,
  openPath,
}: {
  spaceId: string
  items: readonly TreeNode[]
  openPath: string | null
}) {
  return (
    <div className="flex flex-col gap-0.5">
      {items.map((node) =>
        node.isFolder && node.kind === "folder" ? (
          <FolderBranch
            key={`f:${node.path}`}
            spaceId={spaceId}
            node={node}
            openPath={openPath}
          />
        ) : node.isFolder && node.children.length > 0 ? (
          <DocumentBranch
            key={`d:${node.path}`}
            spaceId={spaceId}
            node={node}
            openPath={openPath}
          />
        ) : (
          <DocumentRow
            key={`l:${node.path}`}
            spaceId={spaceId}
            node={node}
            active={openPath === node.path}
          />
        )
      )}
    </div>
  )
}

/**
 * A folder's whole list, its folders unfolding in place. Beside a page
 * (`column`), or as the page itself on a narrow screen (`page`).
 */
export function FolderList({
  spaceId,
  folder,
  variant,
}: {
  spaceId: string
  folder: string
  variant: "column" | "page"
}) {
  const { label, items, parentItems, loading } = useFolder(spaceId, folder)
  // Outside Folders Only the list opened from See All, so it can close.
  const layout = useSidebarLayout()
  const closable = variant === "column" && layout !== "folders"
  const openPath = useRouterState({
    select: (state) => {
      const place = routePlace(state.location.pathname, spaceId)
      return place?.kind === "document" ? place.path : null
    },
  })
  const asideRef = useRef<HTMLElement>(null)
  // Another folder starts at its top, with its open document in view; moving
  // between documents in one folder leaves the list where it was.
  useLayoutEffect(() => {
    const list = asideRef.current?.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    if (!list) return
    list.scrollTop = 0
    list.querySelector("[data-active]")?.scrollIntoView({ block: "nearest" })
  }, [folder, loading])
  // Beside a page the breadcrumb names the folder, marked as the list's;
  // the bar keeps only Up and Close. A narrow screen's page names it.
  const titled = variant === "page"
  const header = (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1",
        titled ? "mb-4" : "h-10 shrink-0 px-3"
      )}
    >
      {folder && (
        <FolderLink
          spaceId={spaceId}
          path={parentFolder(folder)}
          items={parentItems}
          label="Up"
          className="-ml-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
        </FolderLink>
      )}
      {titled && (
        <h1 className="min-w-0 truncate font-display text-2xl font-semibold text-foreground">
          {label}
        </h1>
      )}
      {closable && (
        <button
          type="button"
          aria-label="Close list"
          onClick={() => browseFolder(spaceId, null)}
          className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      )}
    </div>
  )
  const list = loading ? null : items.length === 0 ? (
    <p className="px-3 py-2 text-sm text-muted-foreground">Nothing here yet.</p>
  ) : (
    <nav aria-label={label}>
      <FolderItems spaceId={spaceId} items={items} openPath={openPath} />
    </nav>
  )
  if (variant === "page") {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-8">
        {header}
        {list}
      </div>
    )
  }
  return (
    <aside
      ref={asideRef}
      aria-label="Folder"
      className="sticky top-0 flex h-[calc(100dvh-3rem-env(safe-area-inset-top,0px))] w-72 flex-col border-r border-border/60 bg-background"
    >
      {folder || closable ? header : <div className="h-2 shrink-0" />}
      {/* Scrolls, fades and unfolds as the sidebar does. */}
      <ScrollFadeArea
        fadeSize={24}
        className="min-h-0 flex-1 [&_[data-slot=scroll-area-scrollbar]]:opacity-0 [&_[data-slot=scroll-area-scrollbar]]:transition-opacity [&_[data-slot=scroll-area-scrollbar]]:duration-300 [&:hover_[data-slot=scroll-area-scrollbar]]:opacity-100"
      >
        <div className="px-2 pb-4">{list}</div>
      </ScrollFadeArea>
    </aside>
  )
}

/**
 * A folder's page. On a wide screen the folder's list sits beside the page,
 * which opens its first document; a folder of folders shows only the list.
 * A narrow screen shows the list as the page.
 */
export function FolderPage({ spaceId, folder }: { spaceId: string; folder: string }) {
  const fits = useFolderColumnFits()
  const { label, items, loading } = useFolder(spaceId, folder)
  const opens = fits && !loading ? openingDocument(items) : null
  // Before the document opens, so its page keeps this list beside it, and
  // the tree holds still for this hop as it did for the press.
  useLayoutEffect(() => {
    browseFolder(spaceId, folder)
    if (opens) markTreeNavigation()
  }, [spaceId, folder, opens])
  if (fits) {
    if (loading) return null
    return opens ? (
      <Navigate
        to="/spaces/$spaceId/documents/$"
        params={{ spaceId, _splat: opens }}
        replace
      />
    ) : (
      // Only folders inside: the list beside says what is here.
      <div className="flex h-full min-h-[60vh] flex-col items-center justify-center gap-3 text-muted-foreground/70">
        <FolderOpen className="size-8 stroke-[1.5] text-primary/40" />
        <p className="text-sm">{label}</p>
      </div>
    )
  }
  return <FolderList spaceId={spaceId} folder={folder} variant="page" />
}

/** The folder route's page, for the folder its address names. */
export function FolderRoutePage() {
  const { spaceId, _splat } = useParams({ from: "/spaces/$spaceId/folders/$" })
  return <FolderPage spaceId={spaceId} folder={(_splat ?? "").replace(/\/$/, "")} />
}
