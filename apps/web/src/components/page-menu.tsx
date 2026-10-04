import { Fragment, useState } from "react"
import type { ReactNode } from "react"
import { Link, useRouterState } from "@tanstack/react-router"
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  Database,
  FileText,
  Folder,
  House,
  MessageCircle,
  MessageSquareText,
  Share2,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
} from "@worktable/ui/components/collapsible"
import {
  HeaderSheet,
  HeaderSheetContent,
  HeaderSheetTrigger,
} from "@worktable/ui/components/header-sheet"
import { cn } from "@worktable/ui/lib/utils"
import { CrumbLink, PageDetailsSummary } from "@/components/breadcrumb"
import { DocumentNodeIcon } from "@/components/document-node-icon"
import { DocumentLifetimeControls } from "@/components/document-organize"
import { ShareDocumentAction } from "@/components/share-document-action"
import { useBreadcrumbs } from "@/hooks/use-breadcrumbs"
import { useDocumentSharingAvailable } from "@/hooks/use-deployment-info"
import { useDocumentShareStatus } from "@/hooks/use-document-share"
import {
  useDocumentOrganizeActions,
  useTemporaryArchiveLabel,
} from "@/hooks/use-document-organize"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { narrowHeaderAction, usePageMeta } from "@/hooks/use-page-meta"
import type { PageOverflowAction } from "@/hooks/use-page-meta"
import type { Breadcrumb } from "@/lib/breadcrumbs"
import { documentPathIsAtOrBelow } from "@/lib/document-views"
import { resolveIcon } from "@/lib/icons"
import type { TreeNode } from "@/lib/tree"

const rowClass =
  "flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg px-3 text-left text-sm text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent active:bg-accent"
const iconClass = "size-4 shrink-0 text-muted-foreground"

type PageMenuAction = PageOverflowAction & { detail?: string }

/**
 * Narrow-screen header: the page title opens one sheet holding where the page
 * lives and everything the page can do, except its main action.
 */
export function PageMenu() {
  const crumbs = useBreadcrumbs()
  const { pageMeta } = usePageMeta()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const [open, setOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  // Any navigation closes the sheet and its share dialog, including the
  // browser's back gesture.
  const [shownPath, setShownPath] = useState(pathname)
  if (shownPath !== pathname) {
    setShownPath(pathname)
    setOpen(false)
    setShareOpen(false)
  }
  // Set when a chosen action takes over. The closing sheet then leaves focus
  // to the action instead of returning it to the title behind a new drawer.
  const [handingOff, setHandingOff] = useState(false)
  const document = pageMeta?.document
  // A lifetime change in flight keeps its document's sheet open, like the
  // header chip. Keyed by document so a save that outlives navigation never
  // blocks another page.
  const [pendingDocument, setPendingDocument] = useState<string | null>(null)
  const documentKey = document ? `${document.spaceId}:${document.path}` : null
  const lifetimePending =
    documentKey !== null && pendingDocument === documentKey
  const sharingAvailable = useDocumentSharingAvailable()
  const shared = useDocumentShareStatus(pageMeta?.shareTarget).data?.share
  const scrollRef = useScrollFade<HTMLDivElement>()
  if (crumbs.length === 0) return null

  // Panes that title themselves leave the header to name their location.
  const title =
    [...crumbs].reverse().find((crumb) => !crumb.mobileHidden) ?? crumbs[0]!
  const close = () => setOpen(false)
  const select = (action: () => void) => () => {
    setHandingOff(true)
    close()
    action()
  }

  const pageActions: PageMenuAction[] = []
  // Everything except the header's one action lives here.
  if (
    pageMeta?.secondaryAction &&
    narrowHeaderAction(pageMeta) !== "secondary"
  ) {
    const { label, icon, onClick, disabled, pending } = pageMeta.secondaryAction
    pageActions.push({
      id: "secondary",
      label,
      icon,
      onSelect: onClick,
      disabled: disabled || pending,
    })
  }
  const annotations = pageMeta?.annotations
  if (annotations) {
    pageActions.push({
      id: "annotations",
      label: "Annotations",
      detail: String(annotations.count),
      icon: MessageSquareText,
      onSelect: annotations.onToggle,
    })
  }
  const shareTarget = pageMeta?.shareTarget
  if (shareTarget && sharingAvailable) {
    pageActions.push({
      id: "share",
      label: "Share",
      detail: shared ? "Link active" : undefined,
      icon: Share2,
      onSelect: () => setShareOpen(true),
    })
  }
  const overflowActions = pageMeta?.overflowActions ?? []

  return (
    <>
      <HeaderSheet
        open={open}
        onOpenChange={(next) => {
          if (!next && lifetimePending) return
          if (next) setHandingOff(false)
          setOpen(next)
        }}
      >
        <HeaderSheetTrigger
          render={<button type="button" />}
          // The whole stretch between the logo and the actions opens it.
          className="group/title flex min-h-11 w-full min-w-0 items-center gap-1 rounded-md text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <span className="truncate">{title.label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-popup-open/title:rotate-180" />
        </HeaderSheetTrigger>
        <HeaderSheetContent
          anchor={() =>
            window.document.querySelector("[data-worktable-app-header]")
          }
          aria-label="Page"
          onDismiss={close}
          dismissible={!lifetimePending}
          finalFocus={!handingOff}
          aria-busy={lifetimePending}
        >
          <div
            ref={scrollRef}
            className="scroll-fade min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            {/* One wrapper, so the fade sees the content grow as rows expand. */}
            <div className="p-2">
              {/* Nothing else runs while a lifetime change is saving. */}
              <nav aria-label="Breadcrumb" inert={lifetimePending}>
                <PathTrail
                  crumbs={crumbs}
                  index={0}
                  depth={0}
                  onNavigate={close}
                />
              </nav>
              {pageMeta?.updatedAtLabel && pageMeta.provenanceLabel && (
                <div className="px-3 pt-2 pb-1">
                  <PageDetailsSummary
                    updatedAtLabel={pageMeta.updatedAtLabel}
                    provenanceLabel={pageMeta.provenanceLabel}
                  />
                </div>
              )}
              {pageActions.length > 0 && (
                <ActionGroup
                  actions={pageActions}
                  select={select}
                  disabled={lifetimePending}
                />
              )}
              {document ? (
                <DocumentActions
                  key={documentKey}
                  spaceId={document.spaceId}
                  path={document.path}
                  overflowActions={overflowActions}
                  select={select}
                  onDone={close}
                  pending={lifetimePending}
                  onPendingChange={(pending) => {
                    const key = `${document.spaceId}:${document.path}`
                    setPendingDocument((current) =>
                      pending ? key : current === key ? null : current
                    )
                  }}
                />
              ) : (
                overflowActions.length > 0 && (
                  <ActionGroup actions={overflowActions} select={select} />
                )
              )}
            </div>
          </div>
        </HeaderSheetContent>
      </HeaderSheet>
      {shareTarget && (
        <ShareDocumentAction
          key={`${shareTarget.kind}:${shareTarget.spaceId}:${shareTarget.artifactKey}`}
          target={shareTarget}
          showTrigger={false}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      )}
    </>
  )
}

/** Lifetime and organizing actions for the open document. */
function DocumentActions({
  spaceId,
  path,
  overflowActions,
  select,
  onDone,
  pending,
  onPendingChange,
}: {
  spaceId: string
  path: string
  overflowActions: PageOverflowAction[]
  select: (action: () => void) => () => void
  onDone: () => void
  pending: boolean
  onPendingChange: (pending: boolean) => void
}) {
  const archiveLabel = useTemporaryArchiveLabel(spaceId, path)
  const organizeActions = useDocumentOrganizeActions(spaceId, path)
  const actions = [
    ...overflowActions,
    // The lifetime row already offers Keep.
    ...organizeActions
      .filter((action) => !(archiveLabel && action.id === "keep"))
      .map((action, index) => ({
        ...action,
        separatorBefore: index === 0 && overflowActions.length > 0,
      })),
  ]
  return (
    <>
      {archiveLabel && (
        <div className="mt-2 border-t border-border/60 pt-2">
          <LifetimeRow
            spaceId={spaceId}
            path={path}
            label={archiveLabel}
            onDone={onDone}
            onPendingChange={onPendingChange}
          />
        </div>
      )}
      {actions.length > 0 && (
        <ActionGroup actions={actions} select={select} disabled={pending} />
      )}
    </>
  )
}

function ActionGroup({
  actions,
  select,
  disabled = false,
}: {
  actions: PageMenuAction[]
  select: (action: () => void) => () => void
  disabled?: boolean
}) {
  return (
    <div className="mt-2 border-t border-border/60 pt-2">
      {actions.map((action, index) => (
        <Fragment key={action.id}>
          {/* Desktop's More menu separates these groups the same way. */}
          {action.separatorBefore && index > 0 && (
            <div
              role="separator"
              className="mx-3 my-2 border-t border-border/60"
            />
          )}
          <button
            type="button"
            disabled={disabled || action.disabled}
            onClick={select(action.onSelect)}
            className={cn(
              rowClass,
              "disabled:pointer-events-none disabled:opacity-50",
              action.tone === "destructive" &&
                "text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10 active:bg-destructive/10"
            )}
          >
            <action.icon
              className={cn(
                iconClass,
                action.tone === "destructive" && "text-destructive"
              )}
            />
            <span className="min-w-0 flex-1 truncate">{action.label}</span>
            {action.detail && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {action.detail}
              </span>
            )}
          </button>
        </Fragment>
      ))}
    </div>
  )
}

function LifetimeRow({
  spaceId,
  path,
  label,
  onDone,
  onPendingChange,
}: {
  spaceId: string
  path: string
  label: string
  onDone: () => void
  onPendingChange: (pending: boolean) => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className={rowClass}
      >
        <Clock3 className={iconClass} />
        <span className="min-w-0 flex-1 truncate">
          Temporary
          <span className="text-muted-foreground"> · {label}</span>
        </span>
        <Disclosure expanded={expanded} />
      </button>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 px-3 pt-1 pb-2">
          <DocumentLifetimeControls
            spaceId={spaceId}
            path={path}
            onDone={onDone}
            onPendingChange={onPendingChange}
            heading={(step) =>
              step === "date" && (
                <p className="text-xs text-muted-foreground">
                  Edits, moves, and comments can extend this date.
                </p>
              )
            }
          />
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * The route as an indented trail. Folders on the trail reveal the rest of
 * their contents around the entry that leads to the current page.
 */
function PathTrail({
  crumbs,
  index,
  depth,
  onNavigate,
}: {
  crumbs: Breadcrumb[]
  index: number
  depth: number
  onNavigate: () => void
}) {
  const crumb = crumbs[index]
  if (!crumb) return null
  const next = (
    <PathTrail
      crumbs={crumbs}
      index={index + 1}
      depth={depth + 1}
      onNavigate={onNavigate}
    />
  )
  if (crumb.kind === "folder" && index < crumbs.length - 1) {
    return (
      <FolderTrail
        node={crumb.node}
        spaceId={crumb.spaceId}
        currentPath={crumb.currentPath}
        depth={depth}
        onNavigate={onNavigate}
      >
        {next}
      </FolderTrail>
    )
  }
  return (
    <>
      <CrumbRow
        crumb={crumb}
        current={index === crumbs.length - 1}
        depth={depth}
        onNavigate={onNavigate}
      />
      {next}
    </>
  )
}

function CrumbRow({
  crumb,
  current,
  depth,
  onNavigate,
}: {
  crumb: Breadcrumb
  current: boolean
  depth: number
  onNavigate: () => void
}) {
  const icon = <CrumbIcon crumb={crumb} current={current} />
  const label = <span className="truncate">{crumb.label}</span>
  if (current) {
    return (
      <div
        aria-current="page"
        className={cn(
          rowClass,
          "bg-surface-selected font-medium hover:bg-surface-selected"
        )}
        style={indent(depth)}
      >
        {icon}
        {label}
      </div>
    )
  }
  if (crumb.kind === "link") {
    return (
      <CrumbLink
        target={crumb.target}
        onClick={onNavigate}
        className={rowClass}
        style={indent(depth)}
      >
        {icon}
        {label}
      </CrumbLink>
    )
  }
  return (
    <div className={cn(rowClass, "hover:bg-transparent")} style={indent(depth)}>
      {icon}
      {label}
    </div>
  )
}

function CrumbIcon({
  crumb,
  current,
}: {
  crumb: Breadcrumb
  current: boolean
}) {
  const className = cn(iconClass, current && "text-primary-text")
  if (crumb.role === "space") {
    return (
      <span className={cn(className, "[&>svg]:size-4")}>
        {resolveIcon(crumb.icon)}
      </span>
    )
  }
  if (crumb.node) {
    return <DocumentNodeIcon node={crumb.node} className={className} />
  }
  const RoleIcon: LucideIcon =
    crumb.role === "home"
      ? House
      : crumb.role === "collection"
        ? Database
        : crumb.role === "threads" || crumb.role === "thread"
          ? MessageCircle
          : crumb.role === "folder"
            ? Folder
            : FileText
  return <RoleIcon className={className} />
}

/** A folder on the trail; expanding it reveals its other entries in place. */
function FolderTrail({
  node,
  spaceId,
  currentPath,
  depth,
  onNavigate,
  children,
}: {
  node: TreeNode
  spaceId: string
  currentPath: string
  depth: number
  onNavigate: () => void
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const trailIndex = node.children.findIndex((child) =>
    documentPathIsAtOrBelow(currentPath, child.path)
  )
  const before =
    trailIndex < 0 ? node.children : node.children.slice(0, trailIndex)
  const after = trailIndex < 0 ? [] : node.children.slice(trailIndex + 1)
  return (
    <>
      <FolderRow
        node={node}
        spaceId={spaceId}
        depth={depth}
        expandable={before.length + after.length > 0}
        expanded={expanded}
        onExpandedChange={setExpanded}
        onNavigate={onNavigate}
      />
      <TreeRows
        nodes={before}
        open={expanded}
        spaceId={spaceId}
        currentPath={currentPath}
        depth={depth + 1}
        onNavigate={onNavigate}
      />
      {children}
      <TreeRows
        nodes={after}
        open={expanded}
        spaceId={spaceId}
        currentPath={currentPath}
        depth={depth + 1}
        onNavigate={onNavigate}
      />
    </>
  )
}

function TreeRows({
  nodes,
  open,
  spaceId,
  currentPath,
  depth,
  onNavigate,
}: {
  nodes: TreeNode[]
  open: boolean
  spaceId: string
  currentPath: string
  depth: number
  onNavigate: () => void
}) {
  if (nodes.length === 0) return null
  return (
    <Collapsible open={open}>
      <CollapsibleContent>
        {nodes.map((node) =>
          node.isFolder && node.children.length > 0 ? (
            <TreeFolder
              key={node.path}
              node={node}
              spaceId={spaceId}
              currentPath={currentPath}
              depth={depth}
              onNavigate={onNavigate}
            />
          ) : (
            <DocumentRow
              key={node.path}
              node={node}
              spaceId={spaceId}
              current={node.path === currentPath}
              depth={depth}
              onNavigate={onNavigate}
            />
          )
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function TreeFolder({
  node,
  spaceId,
  currentPath,
  depth,
  onNavigate,
}: {
  node: TreeNode
  spaceId: string
  currentPath: string
  depth: number
  onNavigate: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <FolderRow
        node={node}
        spaceId={spaceId}
        depth={depth}
        expanded={expanded}
        onExpandedChange={setExpanded}
        onNavigate={onNavigate}
      />
      <TreeRows
        nodes={node.children}
        open={expanded}
        spaceId={spaceId}
        currentPath={currentPath}
        depth={depth + 1}
        onNavigate={onNavigate}
      />
    </>
  )
}

/**
 * Folders toggle their contents. A folder that is also a page opens it from
 * its label, like the sidebar, and toggles from its chevron.
 */
function FolderRow({
  node,
  spaceId,
  depth,
  expandable = true,
  expanded,
  onExpandedChange,
  onNavigate,
}: {
  node: TreeNode
  spaceId: string
  depth: number
  /** False when the folder holds nothing beyond the entry on the trail. */
  expandable?: boolean
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  onNavigate: () => void
}) {
  const icon = (
    <DocumentNodeIcon
      node={node}
      className={cn(iconClass, "text-primary/60")}
    />
  )
  if (node.kind === "folder" && !expandable) {
    return (
      <div
        className={cn(rowClass, "hover:bg-transparent")}
        style={indent(depth)}
      >
        {icon}
        <span className="truncate">{node.label}</span>
      </div>
    )
  }
  if (node.kind === "folder") {
    return (
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => onExpandedChange(!expanded)}
        className={rowClass}
        style={indent(depth)}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{node.label}</span>
        <Disclosure expanded={expanded} />
      </button>
    )
  }
  return (
    <div className="flex min-w-0 items-center">
      <Link
        to="/spaces/$spaceId/documents/$"
        params={{ spaceId, _splat: node.path }}
        onClick={onNavigate}
        className={cn(rowClass, "flex-1")}
        style={indent(depth)}
      >
        {icon}
        <span className="truncate">{node.label}</span>
      </Link>
      {expandable && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={
            expanded ? `Collapse ${node.label}` : `Expand ${node.label}`
          }
          onClick={() => onExpandedChange(!expanded)}
          className="flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors outline-none hover:bg-accent focus-visible:bg-accent active:bg-accent"
        >
          <Disclosure expanded={expanded} />
        </button>
      )}
    </div>
  )
}

function DocumentRow({
  node,
  spaceId,
  current,
  depth,
  onNavigate,
}: {
  node: TreeNode
  spaceId: string
  current: boolean
  depth: number
  onNavigate: () => void
}) {
  return (
    <Link
      to="/spaces/$spaceId/documents/$"
      params={{ spaceId, _splat: node.path }}
      onClick={onNavigate}
      aria-current={current ? "page" : undefined}
      className={cn(rowClass, current && "font-medium")}
      style={indent(depth)}
    >
      <DocumentNodeIcon node={node} className={iconClass} />
      <span className="truncate">{node.label}</span>
    </Link>
  )
}

function Disclosure({ expanded }: { expanded: boolean }) {
  return (
    <ChevronRight
      className={cn(
        "ml-auto size-4 shrink-0 text-muted-foreground/60 transition-transform duration-250 ease-[cubic-bezier(0.33,1,0.68,1)]",
        expanded && "rotate-90"
      )}
    />
  )
}

/** Each trail level steps in so the route reads top to bottom. */
function indent(depth: number) {
  return { paddingLeft: `${0.75 + depth * 1}rem` }
}
