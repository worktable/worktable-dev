import { DeferredMount } from "@worktable/ui/components/deferred-mount"
import { formatGroupLabel, getSpaceArchiveInfo } from "@/lib/spaces"
import { DrawingUnsavedError } from "@/lib/drawing-drafts"
import {
  lazy,
  memo,
  useCallback,
  useState,
  useEffect,
  useMemo,
  useRef,
  type Ref,
} from "react"
import {
  Link,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"
import {
  ChevronRight,
  ChevronDown,
  File,
  FilePlus,
  History,
  Folder,
  AlertTriangle,
  LayoutDashboard,
  Plus,
  Briefcase,
  Rocket,
  Church,
  Target,
  LayoutGrid,
  Check,
  Archive,
  Clock3,
  AppWindow,
  Copy,
  Database,
  MessageCircle,
  MoreVertical,
  Pencil,
  RotateCcw,
  Settings,
  Trash,
} from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@worktable/ui/components/collapsible"
import { ScrollFadeArea } from "@/components/scroll-fade-area"
import { WorktableAppIcon } from "@/components/worktable-app-icon"
import { ProvenanceChip } from "@/components/provenance-chip"
import { resolveIcon } from "@/lib/icons"
import {
  useSpaces,
  useRecordCollections,
  useSpace,
  queryKeys,
} from "@/lib/queries"
import type { WidgetListEntry } from "@/lib/widgets-api"
import { useSpaceDocs } from "@/lib/docs-queries"
import { useLiveSpaceCatalog } from "@/hooks/use-live-space-catalog"
import { useSpaceEvents } from "@/hooks/use-space-events"
import { useSidebar } from "@/hooks/use-sidebar"
import { useIsMobile } from "@/hooks/use-mobile"
import { useStableCallback } from "@/hooks/use-stable-callback"
import { flattenTreeOrder } from "@/lib/tree"
import type { DocSortMode } from "@/lib/tree"
import {
  createSpace,
  updateSpace,
  updateDocOrder,
  deleteSpace,
  archiveSpace,
  restoreSpace,
} from "@/lib/api"
const NewSpaceDialog = lazy(() =>
  import("@/components/spaces/new-space-dialog").then((module) => ({
    default: module.NewSpaceDialog,
  }))
)
import {
  SidebarSearchInput,
  SidebarSearchResults,
  type SidebarSearchResultsHandle,
} from "@/components/sidebar-search"
import { openSettings } from "@/lib/settings-open"
import { useUpdateWaiting } from "@/hooks/use-update-availability"
import { UpdateIndicatorDot } from "@/components/update-indicator"
import { SpaceContextMenuButton } from "@/components/spaces/space-context-menu"
import { SpaceNewMenu } from "@/components/spaces/space-new-menu"
import { DocumentFormatIcon } from "@/components/document-format-icon"
import { useNewDoc } from "@/hooks/use-new-doc"
import { DocContextMenuButton } from "@/components/docs/doc-context-menu"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogBody,
  ResponsiveDialogFooter,
} from "@worktable/ui/components/responsive-dialog"
import { Button } from "@worktable/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { RenameDialog } from "@/components/docs/rename-dialog"
import { DeleteDialog } from "@/components/docs/delete-dialog"
import {
  renameDoc,
  deleteDoc,
  archiveDoc,
  restoreDoc,
  exportDocMarkdown,
  downloadDocMarkdown,
} from "@/lib/docs-api"
import { copyText } from "@/lib/clipboard"
import {
  archiveWidget,
  deleteWidget,
  exportWidgetHtml,
  moveWidget,
  restoreWidget,
} from "@/lib/widgets-api"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "@worktable/ui/components/sonner"
import type {
  DocListEntry,
  DocumentListItem,
  SpaceFile,
  WidgetFile,
} from "@worktable/types"
import type { TreeNode } from "@/lib/tree"
import {
  mutateDocument,
  archiveDocumentFolder,
  deleteDocumentFolder,
  moveDocumentFolder,
  restoreDocumentFolder,
} from "@/lib/documents-api"
import { documentQueryKeys, useDocuments } from "@/lib/documents-queries"
import {
  documentPathIsAtOrBelow,
  specializedDocumentView,
} from "@/lib/document-views"
import { canonicalConflictPath, HttpError } from "@/lib/http"
import { DocumentNodeIcon } from "@/components/document-node-icon"
import {
  documentListItemArchived,
  getDocOrder,
  getDocSort,
  isTemporaryDocument,
  spaceDocumentIndex,
  spaceDocumentTrees,
  type SpaceDocumentIndex,
} from "@/lib/space-document-tree"

// ── Group Definitions ────────────────────────────────────────

// Icon hints for known group slugs; unknown groups use LayoutGrid
const GROUP_ICONS: Record<string, typeof Briefcase> = {
  work: Briefcase,
  "main-quest": Target,
  "side-quests": Rocket,
  church: Church,
}

function getGroupDef(id: string) {
  return {
    id,
    label: formatGroupLabel(id),
    icon: GROUP_ICONS[id] ?? LayoutGrid,
  }
}

function isSpaceArchived(space: SpaceFile) {
  return !!getSpaceArchiveInfo(space)
}

function folderLifecycleError(error: unknown, fallback: string): string {
  return error instanceof HttpError && [404, 409].includes(error.status)
    ? error.message
    : fallback
}

// ── Active route ─────────────────────────────────────────────
// Each row selects only how the current route relates to it, so a navigation
// re-renders the rows it leaves and enters instead of the whole sidebar.

type RouteRelation = "self" | "inside" | null

function routeRelation(pathname: string, route: string): RouteRelation {
  if (pathname === route) return "self"
  return pathname.startsWith(`${route}/`) ? "inside" : null
}

function useRouteRelation(route: string): RouteRelation {
  return useRouterState({
    select: (state) => routeRelation(state.location.pathname, route),
  })
}

function useIsCurrentRoute(route: string): boolean {
  return useRouterState({
    select: (state) => state.location.pathname === route,
  })
}

function documentRoutePrefix(spaceId: string): string {
  return `/spaces/${spaceId}/documents/`
}

/** The document path the route opens in this Space, if any. */
function routeDocumentPath(pathname: string, spaceId: string): string | null {
  const prefix = documentRoutePrefix(spaceId)
  return pathname.startsWith(prefix) ? pathname.slice(prefix.length) : null
}

const NO_DOCS: DocListEntry[] = []
const NO_DOCUMENTS: DocumentListItem[] = []
const NO_WIDGETS: WidgetFile[] = []

async function atCurrentHtmlDocumentPath<T>(
  attemptedPath: string,
  action: (path: string) => Promise<T>
): Promise<{ path: string; result: T }> {
  try {
    return { path: attemptedPath, result: await action(attemptedPath) }
  } catch (error) {
    const canonicalPath = canonicalConflictPath(error, attemptedPath)
    if (!canonicalPath) throw error
    return { path: canonicalPath, result: await action(canonicalPath) }
  }
}

// ── Settings entry point (sidebar footer) ────────────────────

function SettingsButton() {
  // Passive (cache-only) signal — a dot on the entry point is the durable
  // "an update is waiting" indicator; the one-time toast lives in the shell.
  const updateAvailable = useUpdateWaiting()
  const settingsLabel = updateAvailable
    ? "Settings, update available"
    : "Settings"

  return (
    <button
      type="button"
      onClick={() => openSettings()}
      aria-label={settingsLabel}
      title={settingsLabel}
      className="relative flex size-10 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/50 transition-all duration-180 hover:bg-sidebar-hover hover:text-sidebar-foreground"
    >
      <Settings className="size-4" />
      {updateAvailable && (
        <UpdateIndicatorDot className="absolute top-2 right-2" />
      )}
    </button>
  )
}

// ── Group Switcher (bottom of sidebar) ───────────────────────

function GroupSwitcher({
  activeGroup,
  onGroupChange,
}: {
  activeGroup: string | null
  onGroupChange: (group: string | null) => void
}) {
  const { data: spaces } = useSpaces()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Derive groups dynamically from spaces data
  const availableGroups = (() => {
    const groups = new Set<string>()
    if (spaces) {
      for (const s of spaces) {
        if (s.group) groups.add(s.group)
      }
    }
    return [...groups].sort()
  })()

  // Close on outside click
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [open])

  const activeDef = activeGroup ? getGroupDef(activeGroup) : null
  const ActiveIcon = activeDef?.icon ?? LayoutGrid
  const activeLabel = activeDef?.label ?? "All Spaces"

  return (
    <div ref={ref} className="relative">
      {/* Dropdown menu (opens upward) */}
      {open && (
        <div className="overlay-floating absolute right-0 bottom-full left-0 mb-1.5 animate-in overflow-hidden rounded-lg bg-popover duration-150 fade-in slide-in-from-bottom-2">
          <div className="p-1.5">
            {/* All option */}
            <button
              type="button"
              onClick={() => {
                onGroupChange(null)
                setOpen(false)
              }}
              className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-all duration-150 ${
                activeGroup === null
                  ? "bg-accent text-accent-foreground"
                  : "text-popover-foreground/70 hover:bg-accent/50 hover:text-popover-foreground"
              }`}
            >
              <LayoutGrid className="size-4 shrink-0" />
              <span className="flex-1 text-left font-medium">All Spaces</span>
              {activeGroup === null && (
                <Check className="size-3.5 text-sidebar-primary" />
              )}
            </button>

            <div className="my-1.5 border-t border-border/50" />

            {/* Group options */}
            {availableGroups.map((groupId) => {
              const def = getGroupDef(groupId)
              const Icon = def.icon
              const isActive = activeGroup === groupId
              return (
                <button
                  key={groupId}
                  type="button"
                  onClick={() => {
                    onGroupChange(groupId)
                    setOpen(false)
                  }}
                  className={`flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-all duration-150 ${
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-popover-foreground/70 hover:bg-accent/50 hover:text-popover-foreground"
                  }`}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="flex-1 text-left font-medium">
                    {def.label}
                  </span>
                  {isActive && (
                    <Check className="size-3.5 text-sidebar-primary" />
                  )}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="sidebar-selector flex w-full items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm font-medium text-sidebar-space-foreground transition-all duration-180"
      >
        <ActiveIcon className="size-4 shrink-0 text-sidebar-primary" />
        <span className="flex-1 truncate text-left">{activeLabel}</span>
        <ChevronDown
          className={`size-3.5 shrink-0 text-sidebar-foreground/40 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
    </div>
  )
}

// ── Space Section ────────────────────────────────────────────

const SpaceSection = memo(function SpaceSection({
  space,
}: {
  space: SpaceFile & { widgets?: WidgetFile[] }
}) {
  const isMobile = useIsMobile()
  const { setOpen } = useSidebar()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const router = useRouter()
  const archived = isSpaceArchived(space)

  const spaceRoute = `/spaces/${space.id}`
  const relation = useRouteRelation(spaceRoute)
  const isInSpace = relation !== null
  const [expanded, setExpanded] = useState(isInSpace)
  const userCollapsedRef = useRef(false)

  useEffect(() => {
    if (isInSpace && !expanded && !userCollapsedRef.current) {
      setExpanded(true)
    }
    // Reset manual collapse flag when navigating away from the space
    if (!isInSpace) {
      userCollapsedRef.current = false
    }
  }, [isInSpace, expanded])

  const handleToggleExpanded = (open: boolean) => {
    if (!open && isInSpace) {
      userCollapsedRef.current = true
    }
    setExpanded(open)
  }

  const handleNavigate = useCallback(() => {
    if (isMobile) setOpen(false)
  }, [isMobile, setOpen])

  const handleRename = async (newName: string) => {
    try {
      await updateSpace(space.id, { name: newName })
      await queryClient.invalidateQueries({
        queryKey: queryKeys.spaces,
        exact: true,
      })
      toast.success("Space renamed")
    } catch (err) {
      toast.error("Failed to rename space")
      console.error("Failed to rename space:", err)
    }
  }

  const handleChangeGroup = async (group: string | undefined) => {
    try {
      await updateSpace(space.id, { group: group ?? "" })
      await queryClient.invalidateQueries({
        queryKey: queryKeys.spaces,
        exact: true,
      })
    } catch (err) {
      toast.error("Failed to change group")
      console.error("Failed to change group:", err)
    }
  }

  const handleDelete = async () => {
    try {
      await deleteSpace(space.id)
      await queryClient.invalidateQueries({
        queryKey: queryKeys.spaces,
        exact: true,
      })
      if (routeRelation(router.state.location.pathname, spaceRoute)) {
        navigate({ to: "/" })
      }
      toast.success("Space moved to trash")
    } catch (err) {
      toast.error("Failed to delete space")
      console.error("Failed to delete space:", err)
    }
  }

  const handleArchive = async () => {
    try {
      await archiveSpace(space.id)
      await queryClient.invalidateQueries({
        queryKey: queryKeys.spaces,
        exact: true,
      })
      toast.success("Space archived")
    } catch (err) {
      toast.error("Failed to archive space")
      console.error("Failed to archive space:", err)
    }
  }

  const handleRestore = async () => {
    try {
      await restoreSpace(space.id)
      await queryClient.invalidateQueries({
        queryKey: queryKeys.spaces,
        exact: true,
      })
      toast.success("Space restored")
    } catch (err) {
      toast.error("Failed to restore space")
      console.error("Failed to restore space:", err)
    }
  }

  const handleChangeDocSort = async (sort: DocSortMode) => {
    try {
      await updateDocOrder(space.id, { sort })
      await queryClient.invalidateQueries({
        queryKey: queryKeys.spaces,
        exact: true,
      })
    } catch (err) {
      toast.error("Failed to change sort order")
      console.error("Failed to change doc sort:", err)
    }
  }

  // Creation lives on the space row (hover-revealed +) so the tree below starts
  // immediately — no toolbar row between the space header and its content.
  const afterCreate = () => {
    setExpanded(true)
    if (isMobile) setOpen(false)
  }
  const newDoc = useNewDoc(space.id, afterCreate)
  const handleNewDoc = useStableCallback(newDoc)

  return (
    <>
      <Collapsible open={expanded} onOpenChange={handleToggleExpanded}>
        <div className="group/space relative flex items-center rounded-md transition-colors duration-180 hover:bg-sidebar-hover">
          {/* The chevron toggles the tree; the name opens the Space overview. */}
          <div className="flex min-h-10 min-w-0 flex-1 items-center sm:min-h-0">
            <CollapsibleTrigger
              className="flex min-w-10 shrink-0 items-center self-stretch py-2 pr-1 pl-3 sm:min-w-0"
              render={
                <button
                  type="button"
                  aria-label={
                    expanded ? `Collapse ${space.name}` : `Expand ${space.name}`
                  }
                />
              }
            >
              <ChevronRight
                className={`size-4 shrink-0 text-sidebar-foreground/40 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
              />
            </CollapsibleTrigger>
            <Link
              to="/spaces/$spaceId"
              params={{ spaceId: space.id }}
              onClick={handleNavigate}
              className={`flex min-w-0 flex-1 items-center gap-2.5 py-2 pr-3 pl-1 text-sm font-medium ${
                relation === "self"
                  ? "text-sidebar-primary"
                  : "text-sidebar-space-foreground"
              }`}
            >
              {resolveIcon(space.icon, "size-4")}
              <span className="min-w-0 truncate">{space.name}</span>
            </Link>
          </div>
          {/* Always visible on touch (no hover exists) and on keyboard focus;
            hover-revealed on desktop pointers. This cluster is the primary
            create entry point now that the tabs toolbar is gone. */}
          <div className="flex shrink-0 items-center pr-1 opacity-100 transition-opacity focus-within:opacity-100 has-[[data-popup-open]]:opacity-100 sm:opacity-0 sm:group-hover/space:opacity-100">
            <SpaceNewMenu
              spaceId={space.id}
              onCreated={afterCreate}
              trigger={
                <button
                  type="button"
                  title="New"
                  className="flex size-9 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/35 transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground has-[[data-popup-open]]:bg-sidebar-accent sm:size-6"
                >
                  <Plus className="size-3.5 transition-transform duration-200 active:scale-90" />
                </button>
              }
            />
            <SpaceContextMenuButton
              spaceName={space.name}
              spaceIcon={space.icon}
              currentGroup={space.group}
              archived={archived}
              docSort={getDocSort(space)}
              onChangeDocSort={handleChangeDocSort}
              onRename={handleRename}
              onChangeIcon={async (icon: string) => {
                try {
                  await updateSpace(space.id, { icon })
                  await queryClient.invalidateQueries({
                    queryKey: queryKeys.spaces,
                    exact: true,
                  })
                } catch {
                  toast.error("Failed to change icon")
                }
              }}
              onChangeGroup={handleChangeGroup}
              onArchive={handleArchive}
              onRestore={handleRestore}
              onDelete={handleDelete}
            />
          </div>
        </div>

        <CollapsibleContent>
          <div className="ml-4 pl-2">
            <SpaceContent
              space={space}
              onNavigate={handleNavigate}
              onNewDoc={handleNewDoc}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
    </>
  )
})

// ── Space Content (merged doc + widget tree) ────────────────

const SpaceContent = memo(function SpaceContent({
  space,
  onNavigate,
  onNewDoc,
}: {
  space: SpaceFile & { widgets?: WidgetFile[] }
  onNavigate: () => void
  onNewDoc: (folder?: string) => void
}) {
  const spaceId = space.id
  const { data: docs, refetch } = useSpaceDocs(spaceId)
  const {
    data: documents,
    isLoading: documentsLoading,
    isError: documentsError,
    refetch: refetchDocuments,
  } = useDocuments(spaceId)
  const queryClient = useQueryClient()
  useLiveSpaceCatalog(spaceId)

  // HTML Docs are listed with the Space's documents; pins come with the
  // Space itself.
  const refreshWidgets = useStableCallback(async (widgetId?: string) => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.space(spaceId),
        exact: true,
      }),
      queryClient.invalidateQueries({ queryKey: ["search"] }),
      queryClient.invalidateQueries({
        queryKey: documentQueryKeys.list(spaceId),
        exact: true,
      }),
      ...(widgetId
        ? [
            queryClient.invalidateQueries({
              queryKey: queryKeys.widget(spaceId, widgetId),
              exact: true,
            }),
          ]
        : []),
    ])
  })
  const handleRefresh = useStableCallback(async () => {
    await Promise.all([refetch(), refetchDocuments()])
  })

  return (
    <div className="mt-1 animate-in duration-200 fade-in">
      <PinnedSidebarSection spaceId={spaceId} onNavigate={onNavigate} />
      <SpaceTreeSection
        space={space}
        documents={documents ?? NO_DOCUMENTS}
        docs={docs ?? NO_DOCS}
        widgets={space.widgets ?? NO_WIDGETS}
        isLoading={documentsLoading}
        loadFailed={documentsError}
        onNewDoc={onNewDoc}
        onNavigate={onNavigate}
        onRefresh={handleRefresh}
        onWidgetRefresh={refreshWidgets}
      />
      <RecordsSidebarSection spaceId={spaceId} onNavigate={onNavigate} />
      <ThreadsSidebarEntry spaceId={spaceId} onNavigate={onNavigate} />
    </div>
  )
})

/** A Space's pinned docs, above its tree, with a label separating the two. */
function PinnedSidebarSection({
  spaceId,
  onNavigate,
}: {
  spaceId: string
  onNavigate: () => void
}) {
  const { data } = useSpace(spaceId)
  const pins = (data?.pins ?? []).filter((pin) => pin.status === "active")
  if (pins.length === 0) return null
  return (
    <div className="mb-2">
      <p className="px-3 py-1 text-[10px] font-semibold tracking-wider text-sidebar-foreground/40 uppercase">
        Pinned
      </p>
      <nav aria-label="Pinned" className="space-y-0.5">
        {pins.map((pin) => (
          <PinnedLink
            key={pin.path}
            spaceId={spaceId}
            path={pin.path}
            title={pin.title ?? pin.path}
            formatId={pin.format?.id}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
      <p className="mt-2 px-3 py-1 text-[10px] font-semibold tracking-wider text-sidebar-foreground/40 uppercase">
        Docs
      </p>
    </div>
  )
}

const PinnedLink = memo(function PinnedLink({
  spaceId,
  path,
  title,
  formatId,
  onNavigate,
}: {
  spaceId: string
  path: string
  title: string
  formatId?: string
  onNavigate: () => void
}) {
  const isActive = useIsCurrentRoute(`${documentRoutePrefix(spaceId)}${path}`)
  return (
    <Link
      to="/spaces/$spaceId/documents/$"
      params={{ spaceId, _splat: path }}
      onClick={onNavigate}
      className={`flex min-h-10 min-w-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-all duration-180 sm:min-h-0 ${
        isActive
          ? "bg-sidebar-accent font-medium text-sidebar-primary"
          : "text-sidebar-item-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground"
      }`}
    >
      <DocumentFormatIcon
        formatId={formatId}
        className={`size-4 shrink-0 ${isActive ? "text-sidebar-primary" : "text-sidebar-foreground/30"}`}
      />
      <span className="min-w-0 truncate">{title}</span>
    </Link>
  )
})

function ThreadsSidebarEntry({
  spaceId,
  onNavigate,
}: {
  spaceId: string
  onNavigate: () => void
}) {
  const isActive = useRouteRelation(`/spaces/${spaceId}/threads`) !== null
  return (
    <div className="mt-2">
      <p className="px-3 py-1 text-[10px] font-semibold tracking-wider text-sidebar-foreground/40 uppercase">
        Conversations
      </p>
      <Link
        to="/spaces/$spaceId/threads/$"
        params={{ spaceId, _splat: "" }}
        onClick={onNavigate}
        className={`flex min-h-10 min-w-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-all duration-180 sm:min-h-0 ${
          isActive
            ? "bg-sidebar-accent font-medium text-sidebar-primary"
            : "text-sidebar-item-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground"
        }`}
      >
        <MessageCircle
          className={`size-4 shrink-0 ${
            isActive ? "text-sidebar-primary" : "text-sidebar-foreground/30"
          }`}
        />
        <span>Threads</span>
      </Link>
    </div>
  )
}

// ── Records section (collections under the doc/widget tree) ─

function RecordsSidebarSection({
  spaceId,
  onNavigate,
}: {
  spaceId: string
  onNavigate: () => void
}) {
  // Only fires for expanded spaces (this component mounts inside the
  // collapsible).
  const { data: collections } = useRecordCollections(spaceId)
  if (!collections || collections.length === 0) return null

  return (
    <div className="mt-2">
      <p className="px-3 py-1 text-[10px] font-semibold tracking-wider text-sidebar-foreground/40 uppercase">
        Records
      </p>
      <nav className="space-y-0.5">
        {collections.map((collection) => (
          <CollectionLink
            key={collection.id}
            spaceId={spaceId}
            collectionId={collection.id}
            name={collection.name}
            count={collection.count}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
    </div>
  )
}

const CollectionLink = memo(function CollectionLink({
  spaceId,
  collectionId,
  name,
  count,
  onNavigate,
}: {
  spaceId: string
  collectionId: string
  name: string
  count: number
  onNavigate: () => void
}) {
  const isActive = useIsCurrentRoute(
    `/spaces/${spaceId}/records/${collectionId}`
  )
  return (
    <Link
      to="/spaces/$spaceId/records/$"
      params={{ spaceId, _splat: collectionId }}
      onClick={onNavigate}
      className={`flex min-h-10 min-w-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-all duration-180 sm:min-h-0 ${
        isActive
          ? "bg-sidebar-accent font-medium text-sidebar-primary"
          : "text-sidebar-item-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground"
      }`}
    >
      <Database
        className={`size-4 shrink-0 ${isActive ? "text-sidebar-primary" : "text-sidebar-foreground/30"}`}
      />
      <span className="min-w-0 truncate">{name}</span>
      <span className="ml-auto shrink-0 text-[11px] text-sidebar-foreground/35 tabular-nums">
        {count}
      </span>
    </Link>
  )
})

function WidgetDeleteDialog({
  open,
  onClose,
  widgetName,
  onConfirm,
}: {
  open: boolean
  onClose: () => void
  widgetName: string
  onConfirm: () => Promise<void>
}) {
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (open) setPending(false)
  }, [open])

  const handleConfirm = async () => {
    setPending(true)
    try {
      await onConfirm()
      onClose()
    } finally {
      setPending(false)
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-destructive/10">
            <Trash className="h-5 w-5 text-destructive" />
          </div>
          <ResponsiveDialogTitle>Delete HTML doc</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Delete{" "}
            <span className="font-medium text-foreground">{widgetName}</span>{" "}
            from this space?
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <p className="text-sm text-muted-foreground">
            This removes the HTML doc files and cannot be undone. Archive it
            instead if you may need it later.
          </p>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={pending}
          >
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

// ── Widget Tree Item ────────────────────────────────────────

function WidgetTreeActions({
  spaceId,
  widgetId,
  documentName,
  archived,
  onRefresh,
  onNewDoc,
  onRenameFolder,
  folderArchived,
  onArchiveFolder,
  onRestoreFolder,
  onDeleteFolder,
}: {
  spaceId: string
  widgetId: string
  documentName: string
  archived: boolean
  onRefresh: (widgetId?: string) => Promise<void>
  onNewDoc?: () => void
  onRenameFolder?: () => void
  folderArchived?: boolean
  onArchiveFolder?: () => void
  onRestoreFolder?: () => void
  onDeleteFolder?: () => void
}) {
  const navigate = useNavigate()
  const router = useRouter()
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const isOpen = () =>
    router.state.location.pathname ===
    `${documentRoutePrefix(spaceId)}${widgetId}`

  const handleCopyHtml = async () => {
    try {
      const html = await exportWidgetHtml(spaceId, widgetId)
      await copyText(html)
      toast.success("Copied HTML")
    } catch (err) {
      toast.error("Failed to copy HTML")
      console.error("Failed to copy HTML doc source:", err)
    }
  }

  const handleRename = async (newPath: string) => {
    try {
      const wasOpen = isOpen()
      const result = await moveWidget(spaceId, widgetId, newPath)
      await onRefresh()
      if (wasOpen) {
        void navigate({
          to: "/spaces/$spaceId/documents/$",
          params: { spaceId, _splat: result.to },
        })
      }
      toast.success("HTML doc renamed")
      return true
    } catch (err) {
      toast.error("Failed to rename HTML doc")
      console.error("Failed to rename HTML doc:", err)
      return false
    }
  }

  const handleArchive = async () => {
    try {
      const archivedDocument = await atCurrentHtmlDocumentPath(
        widgetId,
        (path) => archiveWidget(spaceId, path)
      )
      await onRefresh(archivedDocument.path)
      toast.success("HTML doc archived")
    } catch (err) {
      toast.error("Failed to archive HTML doc")
      console.error("Failed to archive HTML doc:", err)
    }
  }

  const handleRestore = async () => {
    try {
      const restoredDocument = await atCurrentHtmlDocumentPath(
        widgetId,
        (path) => restoreWidget(spaceId, path)
      )
      await onRefresh(restoredDocument.path)
      toast.success("HTML doc restored")
    } catch (err) {
      toast.error("Failed to restore HTML doc")
      console.error("Failed to restore HTML doc:", err)
    }
  }

  const handleDelete = async () => {
    try {
      const wasOpen = isOpen()
      await deleteWidget(spaceId, widgetId)
      await onRefresh()
      if (wasOpen)
        void navigate({ to: "/spaces/$spaceId", params: { spaceId } })
      toast.success("HTML doc deleted")
    } catch (err) {
      toast.error("Failed to delete HTML doc")
      console.error("Failed to delete HTML doc:", err)
    }
  }

  return (
    <>
      <WidgetContextMenuButton
        documentName={documentName}
        archived={archived}
        onNewDoc={onNewDoc}
        onRenameFolder={onRenameFolder}
        folderArchived={folderArchived}
        onArchiveFolder={onArchiveFolder}
        onRestoreFolder={onRestoreFolder}
        onDeleteFolder={onDeleteFolder}
        onCopyHtml={handleCopyHtml}
        onRename={() => setRenameOpen(true)}
        onArchive={handleArchive}
        onRestore={handleRestore}
        onDelete={() => setDeleteOpen(true)}
      />
      <RenameDialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        onRename={handleRename}
        currentPath={widgetId}
        pathInput
      />
      <WidgetDeleteDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        widgetName={documentName}
        onConfirm={handleDelete}
      />
    </>
  )
}

function WidgetTreeItem({
  node,
  spaceId,
  widget,
  onNavigate,
  onRefresh,
  reorder,
}: {
  node: TreeNode
  spaceId: string
  widget: WidgetListEntry
  onNavigate: () => void
  onRefresh: (widgetId?: string) => Promise<void>
  reorder?: DocReorder
}) {
  const isActive = useIsCurrentRoute(
    `${documentRoutePrefix(spaceId)}${widget.id}`
  )
  const archived = !!widget.archive
  const { dragProps, dropIndicator, isDragging } = treeDragPresentation(
    node,
    reorder
  )

  return (
    <>
      <div
        className={`group/widget relative flex items-center rounded-md transition-all duration-180 ${
          isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-hover"
        } ${isDragging ? "opacity-50" : ""}`}
        {...dragProps}
      >
        {dropIndicator}
        <Link
          to="/spaces/$spaceId/documents/$"
          params={{ spaceId, _splat: widget.id }}
          onClick={onNavigate}
          draggable={false}
          className={`flex min-h-10 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-sm sm:min-h-0 ${
            isActive
              ? "font-medium text-sidebar-primary"
              : "text-sidebar-item-foreground hover:text-sidebar-foreground"
          }`}
        >
          <AppWindow
            className={`size-4 shrink-0 ${isActive ? "text-sidebar-primary" : "text-sidebar-foreground/30"}`}
          />
          <span className="truncate">{widget.name}</span>
        </Link>
        <div className="shrink-0 pr-1 opacity-0 transition-opacity group-hover/widget:opacity-100 has-[[data-popup-open]]:opacity-100">
          <WidgetTreeActions
            key={widget.id}
            spaceId={spaceId}
            widgetId={widget.id}
            documentName={widget.name}
            archived={archived}
            onRefresh={onRefresh}
          />
        </div>
      </div>
    </>
  )
}

function WidgetContextMenuButton({
  documentName,
  archived,
  onNewDoc,
  onRenameFolder,
  folderArchived,
  onArchiveFolder,
  onRestoreFolder,
  onDeleteFolder,
  onCopyHtml,
  onRename,
  onArchive,
  onRestore,
  onDelete,
}: {
  documentName: string
  archived?: boolean
  onNewDoc?: () => void
  onRenameFolder?: () => void
  folderArchived?: boolean
  onArchiveFolder?: () => void
  onRestoreFolder?: () => void
  onDeleteFolder?: () => void
  onCopyHtml: () => void
  onRename: () => void
  onArchive: () => void
  onRestore: () => void
  onDelete: () => void
}) {
  const hasFolderActions = Boolean(
    onNewDoc ||
    onRenameFolder ||
    onArchiveFolder ||
    onRestoreFolder ||
    onDeleteFolder
  )
  const isHybridPath = folderArchived !== undefined

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex size-9 items-center justify-center rounded-md text-sidebar-foreground/30 transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground sm:size-6"
        render={
          <button type="button" aria-label={`Actions for ${documentName}`} />
        }
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-44">
        {onNewDoc && (
          <DropdownMenuItem onClick={onNewDoc}>
            <FilePlus className="mr-2 h-4 w-4" />
            New Doc
          </DropdownMenuItem>
        )}
        {onRenameFolder && (
          <DropdownMenuItem onClick={onRenameFolder}>
            <Pencil className="mr-2 h-4 w-4" />
            Rename Folder
          </DropdownMenuItem>
        )}
        {(folderArchived ? onRestoreFolder : onArchiveFolder) && (
          <DropdownMenuItem
            onClick={folderArchived ? onRestoreFolder : onArchiveFolder}
          >
            {folderArchived ? (
              <RotateCcw className="mr-2 h-4 w-4" />
            ) : (
              <Archive className="mr-2 h-4 w-4" />
            )}
            {folderArchived ? "Restore Folder" : "Archive Folder"}
          </DropdownMenuItem>
        )}
        {onDeleteFolder && (
          <DropdownMenuItem variant="destructive" onClick={onDeleteFolder}>
            <Trash className="mr-2 h-4 w-4" />
            Delete Folder
          </DropdownMenuItem>
        )}
        {hasFolderActions && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={onCopyHtml}>
          <Copy className="mr-2 h-4 w-4" />
          Copy HTML
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onRename}>
          <Pencil className="mr-2 h-4 w-4" />
          {isHybridPath ? "Rename HTML Doc" : "Rename"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={archived ? onRestore : onArchive}>
          {archived ? (
            <RotateCcw className="mr-2 h-4 w-4" />
          ) : (
            <Archive className="mr-2 h-4 w-4" />
          )}
          {archived
            ? isHybridPath
              ? "Restore HTML Doc"
              : "Restore"
            : isHybridPath
              ? "Archive HTML Doc"
              : "Archive"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash className="mr-2 h-4 w-4" />
          {isHybridPath ? "Delete HTML Doc" : "Delete"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ── Space Docs Sub-Section ───────────────────────────────────

/** Drag-reorder state and callbacks shared by every row of one doc tree. */
interface DocReorder {
  dragPath: string | null
  dropHint: { path: string; after: boolean } | null
  canDrop: (target: TreeNode) => boolean
  onDragStart: (node: TreeNode) => void
  onDragOver: (node: TreeNode, after: boolean) => void
  onClearHint: () => void
  onDrop: () => void
  onEnd: () => void
}

function treeDragPresentation(node: TreeNode, reorder?: DocReorder) {
  const isDragging = reorder?.dragPath === node.path
  const dropHere =
    reorder?.dropHint?.path === node.path ? reorder.dropHint : null
  const dragProps = reorder
    ? {
        draggable: true,
        onDragStart: (event: React.DragEvent) => {
          event.dataTransfer.effectAllowed = "move"
          event.dataTransfer.setData("text/plain", node.path)
          reorder.onDragStart(node)
        },
        onDragOver: (event: React.DragEvent) => {
          if (!reorder.canDrop(node)) {
            reorder.onClearHint()
            return
          }
          event.preventDefault()
          event.dataTransfer.dropEffect = "move"
          const rect = event.currentTarget.getBoundingClientRect()
          reorder.onDragOver(node, event.clientY > rect.top + rect.height / 2)
        },
        onDrop: (event: React.DragEvent) => {
          event.preventDefault()
          if (reorder.canDrop(node) && reorder.dropHint?.path === node.path) {
            reorder.onDrop()
          }
          reorder.onEnd()
        },
        onDragEnd: () => reorder.onEnd(),
      }
    : {}
  const dropIndicator = dropHere && (
    <span
      className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-sidebar-primary ${
        dropHere.after ? "-bottom-px" : "-top-px"
      }`}
    />
  )
  return { dragProps, dropIndicator, isDragging }
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/")
  return i === -1 ? "" : path.slice(0, i)
}

function findSiblings(nodes: TreeNode[], parent: string): TreeNode[] | null {
  if (parent === "") return nodes
  for (const n of nodes) {
    if (n.path === parent) return n.children
    if (parent.startsWith(n.path + "/")) return findSiblings(n.children, parent)
  }
  return null
}

/** A copy of the tree with `parent`'s children replaced; the tree is shared. */
function withSiblings(
  nodes: TreeNode[],
  parent: string,
  siblings: TreeNode[]
): TreeNode[] {
  if (parent === "") return siblings
  return nodes.map((n) =>
    n.path === parent
      ? { ...n, children: siblings }
      : parent.startsWith(n.path + "/")
        ? { ...n, children: withSiblings(n.children, parent, siblings) }
        : n
  )
}

function SpecializedDocumentLink({
  spaceId,
  path,
  onClick,
  className,
  children,
}: {
  spaceId: string
  path: string
  onClick: () => void
  className: string
  children: React.ReactNode
}) {
  return (
    <Link
      to="/spaces/$spaceId/documents/$"
      params={{ spaceId, _splat: path }}
      onClick={onClick}
      draggable={false}
      className={className}
    >
      {children}
    </Link>
  )
}

function SpaceTreeSection({
  space,
  documents,
  docs,
  widgets,
  isLoading,
  loadFailed,
  onNewDoc,
  onNavigate,
  onRefresh,
  onWidgetRefresh,
}: {
  space: SpaceFile
  documents: DocumentListItem[]
  docs: DocListEntry[]
  widgets: WidgetListEntry[]
  isLoading: boolean
  loadFailed: boolean
  onNewDoc: (folder?: string) => void
  onNavigate: () => void
  onRefresh: () => Promise<void>
  onWidgetRefresh: (widgetId?: string) => Promise<void>
}) {
  const spaceId = space.id
  const queryClient = useQueryClient()
  const docOrder = useMemo(() => getDocOrder(space), [space])
  const docSort = getDocSort(space)
  // Optimistic overrides: applied on drop, dropped again once the refetched
  // space settings carry the saved values (or on save failure).
  const [localOrder, setLocalOrder] = useState<string[] | null>(null)
  const [localSort, setLocalSort] = useState<DocSortMode | null>(null)
  const prefsKey = `${docSort} ${docOrder?.join("\n") ?? ""}`
  useEffect(() => {
    setLocalOrder(null)
    setLocalSort(null)
  }, [prefsKey])
  const effectiveOrder = localOrder ?? docOrder
  const effectiveSort = localSort ?? docSort

  const [drag, setDrag] = useState<{ path: string; isFolder: boolean } | null>(
    null
  )
  const [dropHint, setDropHint] = useState<{
    path: string
    after: boolean
  } | null>(null)
  const dragPath = drag?.path ?? null
  const pendingSaveRef = useRef<string[] | null>(null)
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())

  // Temporary documents are supporting work: they leave the main tree for
  // their own section until they are kept or archive on their date. Both the
  // trees and the row lookups are built once per catalog read.
  const {
    active: tree,
    temporary: temporaryTree,
    archived: archivedTree,
  } = spaceDocumentTrees({
    documents,
    docs,
    widgets,
    sort: effectiveSort,
    order: effectiveOrder,
    separateTemporary: true,
  })
  const index = spaceDocumentIndex({ documents, docs, widgets })
  const { temporaryCount, temporaryPaths, archivedPaths } = useMemo(() => {
    const temporary = documents.filter(
      (item) => !documentListItemArchived(item) && isTemporaryDocument(item)
    )
    const archivedDocumentPaths = documents.flatMap((item) =>
      item.kind === "document" && documentListItemArchived(item)
        ? [item.path]
        : []
    )
    return {
      temporaryCount: temporary.length,
      temporaryPaths: new Set(
        temporary.flatMap((item) =>
          item.kind === "document" ? [item.path] : []
        )
      ),
      archivedPaths: new Set(archivedDocumentPaths),
    }
  }, [documents])

  const canDrop = useStableCallback(
    (target: TreeNode) =>
      drag !== null &&
      target.path !== drag.path &&
      parentOf(target.path) === parentOf(drag.path) &&
      // Folders stay grouped before leaves, so cross-group drops would have no
      // visible effect. Every common document format otherwise shares ordering.
      target.isFolder === drag.isFolder
  )

  const handleDrop = useStableCallback(() => {
    if (!dragPath || !dropHint) return
    const parent = parentOf(dragPath)
    const siblings = findSiblings(tree, parent)
    if (!siblings) return
    const moved = siblings.find((n) => n.path === dragPath)
    if (!moved || dropHint.path === dragPath) return
    const rest = siblings.filter((n) => n.path !== dragPath)
    const targetIdx = rest.findIndex((n) => n.path === dropHint.path)
    if (targetIdx === -1) return
    rest.splice(targetIdx + (dropHint.after ? 1 : 0), 0, moved)

    // A drag always lands in custom mode: the captured order is exactly the
    // display order the user just arranged, whatever mode produced it.
    // Entries not in the visible active tree (archived docs) keep their
    // original positions: walk the previous order, emitting untouched
    // entries as-is and active entries in their newly dragged sequence.
    const activeOrder = flattenTreeOrder(withSiblings(tree, parent, rest))
    const activeSet = new Set(activeOrder)
    const prevOrder = effectiveOrder ?? []
    const merged: string[] = []
    let nextActive = 0
    for (const path of prevOrder) {
      if (activeSet.has(path)) {
        if (nextActive < activeOrder.length)
          merged.push(activeOrder[nextActive++])
      } else {
        merged.push(path)
      }
    }
    while (nextActive < activeOrder.length)
      merged.push(activeOrder[nextActive++])
    const seen = new Set<string>()
    const newOrder = merged.filter((p) =>
      seen.has(p) ? false : (seen.add(p), true)
    )

    setLocalOrder(newOrder)
    setLocalSort("custom")
    // Rapid consecutive drops each carry the FULL order, so an earlier PUT
    // finishing after a later one would overwrite the final arrangement.
    // Latest-wins queue: remember only the newest pending order and chain
    // saves so at most one request is in flight.
    pendingSaveRef.current = newOrder
    saveChainRef.current = saveChainRef.current.then(async () => {
      const order = pendingSaveRef.current
      if (!order) return
      pendingSaveRef.current = null
      try {
        await updateDocOrder(spaceId, { order, sort: "custom" })
        await queryClient.invalidateQueries({
          queryKey: queryKeys.spaces,
          exact: true,
        })
      } catch (err) {
        console.error("Failed to save doc order:", err)
        toast.error("Failed to save order")
        setLocalOrder(null)
        setLocalSort(null)
      }
    })
  })

  // Stable while nothing is being dragged, so rows skip re-rendering.
  const reorder = useMemo<DocReorder>(
    () => ({
      dragPath,
      dropHint,
      canDrop,
      onDragStart: (node) =>
        setDrag({ path: node.path, isFolder: node.isFolder }),
      onDragOver: (node, after) => {
        setDropHint((prev) =>
          prev?.path === node.path && prev.after === after
            ? prev
            : { path: node.path, after }
        )
      },
      onClearHint: () => setDropHint(null),
      onDrop: handleDrop,
      onEnd: () => {
        setDrag(null)
        setDropHint(null)
      },
    }),
    [dragPath, dropHint, canDrop, handleDrop]
  )
  // Use the common catalog so every archived format keeps its current row visible.
  const hasArchivedCurrent = useRouterState({
    select: (state) =>
      archivedPaths.has(
        routeDocumentPath(state.location.pathname, spaceId) ?? ""
      ),
  })
  const [archivedOpen, setArchivedOpen] = useState(hasArchivedCurrent)
  const hasTemporaryCurrent = useRouterState({
    select: (state) =>
      temporaryPaths.has(
        routeDocumentPath(state.location.pathname, spaceId) ?? ""
      ),
  })
  const [temporaryOpen, setTemporaryOpen] = useState(hasTemporaryCurrent)

  useEffect(() => {
    if (hasTemporaryCurrent) setTemporaryOpen(true)
  }, [hasTemporaryCurrent])

  useEffect(() => {
    if (hasArchivedCurrent) {
      setArchivedOpen(true)
    }
  }, [hasArchivedCurrent])

  const hasContent =
    !isLoading &&
    (tree.length > 0 || temporaryTree.length > 0 || archivedTree.length > 0)
  const rowProps = {
    spaceId,
    index,
    onNewDoc,
    onNavigate,
    onRefresh,
    onWidgetRefresh,
  }

  return (
    <>
      {loadFailed ? (
        <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
          <p className="text-sidebar-foreground/40">Couldn’t load docs</p>
          <button
            type="button"
            className="shrink-0 text-sidebar-item-foreground hover:text-sidebar-foreground"
            onClick={onRefresh}
          >
            Try again
          </button>
        </div>
      ) : hasContent ? (
        <div className="space-y-2">
          {tree.length > 0 && (
            <nav aria-label="Active documents" className="space-y-0.5">
              {tree.map((node) => (
                <TreeItem
                  key={`${node.kind}:${node.isFolder ? "f" : "l"}:${node.path}`}
                  node={node}
                  {...rowProps}
                  folderArchived={false}
                  reorder={reorder}
                />
              ))}
            </nav>
          )}

          {temporaryTree.length > 0 && (
            <Collapsible open={temporaryOpen} onOpenChange={setTemporaryOpen}>
              <div className="px-3">
                <CollapsibleTrigger
                  className="flex min-h-8 w-full items-center gap-2 py-1 text-[10px] font-semibold tracking-wider text-sidebar-foreground/40 uppercase sm:min-h-0"
                  render={<button type="button" />}
                >
                  <ChevronRight
                    className={`size-3 shrink-0 transition-transform ${temporaryOpen ? "rotate-90" : ""}`}
                  />
                  <Clock3 className="size-3 shrink-0" />
                  <span>Temporary</span>
                  <span className="font-normal">{temporaryCount}</span>
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent>
                <nav aria-label="Temporary documents" className="space-y-0.5">
                  {temporaryTree.map((node) => (
                    <TreeItem
                      key={`${node.kind}:${node.isFolder ? "f" : "l"}:${node.path}`}
                      node={node}
                      {...rowProps}
                      folderArchived={false}
                    />
                  ))}
                </nav>
              </CollapsibleContent>
            </Collapsible>
          )}

          {archivedTree.length > 0 && (
            <Collapsible open={archivedOpen} onOpenChange={setArchivedOpen}>
              <div className="px-3">
                <CollapsibleTrigger
                  className="flex min-h-8 w-full items-center gap-2 py-1 text-[10px] font-semibold tracking-wider text-sidebar-foreground/40 uppercase sm:min-h-0"
                  render={<button type="button" />}
                >
                  <ChevronRight
                    className={`size-3 shrink-0 transition-transform ${archivedOpen ? "rotate-90" : ""}`}
                  />
                  <Archive className="size-3 shrink-0" />
                  <span>Archived</span>
                </CollapsibleTrigger>
              </div>
              <CollapsibleContent>
                <nav aria-label="Archived documents" className="space-y-0.5">
                  {archivedTree.map((node) => (
                    <TreeItem
                      key={`${node.kind}:${node.isFolder ? "f" : "l"}:${node.path}`}
                      node={node}
                      {...rowProps}
                      folderArchived
                    />
                  ))}
                </nav>
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      ) : !isLoading ? (
        <p className="px-3 py-2 text-xs text-sidebar-foreground/30">
          No docs yet
        </p>
      ) : null}
    </>
  )
}

// ── Tree Item dispatcher (doc/folder vs widget leaf) ────────

interface TreeRowProps {
  node: TreeNode
  spaceId: string
  index: SpaceDocumentIndex
  depth?: number
  onNewDoc?: (folder?: string) => void
  onNavigate: () => void
  onRefresh: () => Promise<void>
  onWidgetRefresh: (widgetId?: string) => Promise<void>
  folderArchived: boolean
  reorder?: DocReorder
}

/**
 * One tree row. Memoized with stable props, so a row re-renders only when its
 * own node, the catalog, a drag, or its relation to the route changes.
 */
const TreeItem = memo(function TreeItem(props: TreeRowProps) {
  const { node, spaceId, index, onNavigate, onWidgetRefresh, reorder } = props
  const view = specializedDocumentView(node)
  if (view === "html" && !node.isFolder) {
    const widget = index.widget(node.path, node.archived)
    if (widget) {
      return (
        <WidgetTreeItem
          node={node}
          spaceId={spaceId}
          widget={widget}
          onNavigate={onNavigate}
          onRefresh={onWidgetRefresh}
          reorder={reorder}
        />
      )
    }
  }
  if (view === "doc" && !node.isFolder && index.doc(node.path, node.archived)) {
    return <DocTreeItem {...props} />
  }
  if (
    !node.isFolder &&
    !(node.format?.id === "worktable.quickdraw" && node.health === "supported")
  ) {
    return (
      <UnavailableDocumentTreeItem
        node={node}
        spaceId={spaceId}
        onNavigate={onNavigate}
        reorder={reorder}
      />
    )
  }
  return <DocTreeItem {...props} />
})

function UnavailableDocumentTreeItem({
  node,
  spaceId,
  onNavigate,
  reorder,
}: {
  node: TreeNode
  spaceId: string
  onNavigate: () => void
  reorder?: DocReorder
}) {
  const { dragProps, dropIndicator, isDragging } = treeDragPresentation(
    node,
    reorder
  )
  // An entry without a working view reads as a plain file, whatever its format.
  const StateIcon = node.kind === "conflict" ? AlertTriangle : File
  const isActive = useIsCurrentRoute(
    `${documentRoutePrefix(spaceId)}${node.path}`
  )
  return (
    <div
      className={`relative rounded-md transition-colors ${
        isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-hover"
      } ${isDragging ? "opacity-50" : ""}`}
      {...dragProps}
    >
      {dropIndicator}
      <Link
        to="/spaces/$spaceId/documents/$"
        params={{ spaceId, _splat: node.path }}
        onClick={onNavigate}
        draggable={false}
        className={`flex min-h-10 min-w-0 items-center gap-2 px-3 py-2 text-sm sm:min-h-0 ${
          isActive
            ? "font-medium text-sidebar-primary"
            : "text-sidebar-item-foreground"
        }`}
      >
        <StateIcon
          className={`size-4 shrink-0 ${isActive ? "text-sidebar-primary" : "text-sidebar-foreground/30"}`}
        />
        <span className="truncate">{node.label}</span>
      </Link>
    </div>
  )
}

// ── Doc Tree Item ────────────────────────────────────────────

function DocTreeItem({
  node,
  spaceId,
  index,
  depth = 0,
  onNewDoc,
  onNavigate,
  onRefresh,
  onWidgetRefresh,
  folderArchived,
  reorder,
}: TreeRowProps) {
  const navigate = useNavigate()
  const router = useRouter()

  const view = specializedDocumentView(node)
  const docEntry =
    view === "doc" ? index.doc(node.path, node.archived) : undefined
  const documentFullPath = `${documentRoutePrefix(spaceId)}${node.path}`
  // A folder auto-expands when the current route lives under it — the active
  // item may be a doc OR a widget nested inside this folder.
  const relation = useRouteRelation(documentFullPath)
  const isActive = relation === "self"
  const containsCurrent = relation === "inside"
  // An HTML doc open below this folder, read when a folder action needs it.
  const openWidgetUnderNode = () => {
    const openPath = routeDocumentPath(router.state.location.pathname, spaceId)
    return openPath !== null &&
      index.hasWidget(openPath) &&
      documentPathIsAtOrBelow(openPath, node.path)
      ? openPath
      : undefined
  }
  const hasDocumentAtFolder = node.isFolder && node.kind !== "folder"
  const folderMoveUnavailable =
    node.isFolder && !index.folderSupports(node.path, "move")
  const folderArchiveUnavailable =
    node.isFolder && !index.folderSupports(node.path, "archive")
  const folderDeleteUnavailable =
    node.isFolder && !index.folderSupports(node.path, "delete")
  const exactDocumentArchived = (docEntry?.archived ?? node.archived) === true
  const archived = node.isFolder ? folderArchived : exactDocumentArchived
  const [open, setOpenState] = useState(containsCurrent || isActive)
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const userCollapsedNodeRef = useRef(false)

  useEffect(() => {
    if (
      node.isFolder &&
      (containsCurrent || isActive) &&
      !open &&
      !userCollapsedNodeRef.current
    ) {
      setOpenState(true)
    }
    if (!containsCurrent && !isActive) {
      userCollapsedNodeRef.current = false
    }
  }, [containsCurrent, isActive, open, node.isFolder])

  const handleToggleNode = (nextOpen: boolean) => {
    if (!nextOpen && (containsCurrent || isActive)) {
      userCollapsedNodeRef.current = true
    }
    setOpenState(nextOpen)
  }

  const handleRename = async (newPath: string) => {
    const openPath = router.state.location.pathname
    try {
      // The server slugifies the target, so follow its from→to mapping rather
      // than the human-typed newPath when re-navigating an open document.
      const result = node.isFolder
        ? await moveDocumentFolder(spaceId, node.path, newPath)
        : node.format?.id === "worktable.quickdraw"
          ? await mutateDocument(spaceId, "move", node.path, newPath).then(
              (result) => ({
                renamed: [{ from: node.path, to: result.to ?? newPath }],
              })
            )
          : await renameDoc(spaceId, node.path, newPath, "document")
      await Promise.all([
        onRefresh(),
        ...(node.isFolder ? [onWidgetRefresh()] : []),
      ])
      if (routeRelation(openPath, documentFullPath)) {
        const oldOpenPath = `${node.path}${openPath.slice(documentFullPath.length)}`
        const target = result.renamed?.find((r) => r.from === oldOpenPath)?.to
        if (target) {
          void navigate({
            to: "/spaces/$spaceId/documents/$",
            params: { spaceId, _splat: target },
          })
        }
      }
      toast.success(node.isFolder ? "Folder renamed" : "Doc renamed")
      return true
    } catch (error) {
      toast.error(
        error instanceof DrawingUnsavedError
          ? error.message
          : node.isFolder
            ? "Failed to rename folder"
            : "Failed to rename doc"
      )
      return false
    }
  }

  const handleDelete = async (): Promise<boolean> => {
    try {
      const openRelation = routeRelation(
        router.state.location.pathname,
        documentFullPath
      )
      const navigateAfterDelete = node.isFolder
        ? openRelation !== null
        : openRelation === "self"
      if (node.isFolder) {
        await deleteDocumentFolder(spaceId, node.path)
      } else {
        if (node.format?.id === "worktable.quickdraw")
          await mutateDocument(spaceId, "delete", node.path)
        else await deleteDoc(spaceId, node.path)
      }
      if (navigateAfterDelete) {
        await navigate({ to: "/spaces/$spaceId", params: { spaceId } })
      }
      if (node.isFolder) {
        await Promise.all([onRefresh(), onWidgetRefresh()])
      } else {
        await onRefresh()
      }
      toast.success(node.isFolder ? "Folder deleted" : "Doc deleted")
      return true
    } catch (error) {
      toast.error(
        node.isFolder
          ? folderLifecycleError(error, "Couldn’t delete folder. Try again.")
          : "Couldn’t delete this doc. Try again."
      )
      return false
    }
  }

  const handleArchive = async () => {
    try {
      if (node.format?.id === "worktable.quickdraw")
        await mutateDocument(spaceId, "archive", node.path)
      else await archiveDoc(spaceId, node.path)
      await onRefresh()
      toast.success("Doc archived")
    } catch {
      toast.error("Failed to archive doc")
    }
  }

  const handleRestore = async () => {
    try {
      if (node.format?.id === "worktable.quickdraw")
        await mutateDocument(spaceId, "restore", node.path)
      else await restoreDoc(spaceId, node.path)
      await onRefresh()
      toast.success("Doc restored")
    } catch {
      toast.error("Failed to restore doc")
    }
  }

  const handleArchiveFolder = async () => {
    const openWidget = openWidgetUnderNode()
    try {
      await archiveDocumentFolder(spaceId, node.path)
      await Promise.all([onRefresh(), onWidgetRefresh(openWidget)])
      toast.success("Folder archived")
    } catch (error) {
      toast.error(folderLifecycleError(error, "Failed to archive folder"))
    }
  }

  const handleRestoreFolder = async () => {
    const openWidget = openWidgetUnderNode()
    try {
      await restoreDocumentFolder(spaceId, node.path)
      await Promise.all([onRefresh(), onWidgetRefresh(openWidget)])
      toast.success("Folder restored")
    } catch (error) {
      toast.error(folderLifecycleError(error, "Failed to restore folder"))
    }
  }

  const handleCopyMarkdown = async () => {
    try {
      const markdown = await exportDocMarkdown(spaceId, node.path)
      await copyText(markdown)
      toast.success("Copied as Markdown")
    } catch (err) {
      toast.error("Couldn’t copy this doc. Try again.")
      console.error("Failed to copy doc:", err)
    }
  }

  const handleDownload = async () => {
    try {
      await downloadDocMarkdown(spaceId, node.path)
    } catch (err) {
      toast.error("Couldn’t download this doc. Try again.")
      console.error("Failed to download doc:", err)
    }
  }

  const { dragProps, dropIndicator, isDragging } = treeDragPresentation(
    node,
    reorder
  )

  if (node.isFolder) {
    return (
      <>
        <Collapsible open={open} onOpenChange={handleToggleNode}>
          <div
            className={`group/folder relative flex items-center rounded-md transition-colors duration-180 ${
              isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-hover"
            } ${isDragging ? "opacity-50" : ""}`}
            {...dragProps}
          >
            {dropIndicator}
            {hasDocumentAtFolder ? (
              // A document can also own a path with descendants: the chevron
              // toggles the folder while the label opens its common page.
              <div className="flex min-h-10 min-w-0 flex-1 items-center sm:min-h-0">
                <CollapsibleTrigger
                  className="flex h-full shrink-0 items-center py-2 pr-1 pl-3"
                  render={
                    <button
                      type="button"
                      aria-label={open ? "Collapse folder" : "Expand folder"}
                    />
                  }
                >
                  <ChevronRight
                    className={`size-3.5 shrink-0 text-sidebar-foreground/30 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
                  />
                </CollapsibleTrigger>
                <SpecializedDocumentLink
                  spaceId={spaceId}
                  path={node.path}
                  onClick={onNavigate}
                  className={`flex min-w-0 flex-1 items-center gap-2 py-2 pr-3 pl-1 text-sm ${
                    isActive
                      ? "font-medium text-sidebar-primary"
                      : "text-sidebar-item-foreground"
                  }`}
                >
                  <DocumentNodeIcon
                    node={node}
                    className={`size-4 shrink-0 ${node.kind === "conflict" ? "text-sidebar-foreground/40" : "text-sidebar-primary/60"}`}
                  />
                  <span className="truncate">{node.label}</span>
                </SpecializedDocumentLink>
              </div>
            ) : (
              <CollapsibleTrigger
                className="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-sm text-sidebar-item-foreground sm:min-h-0"
                render={<button type="button" />}
              >
                <ChevronRight
                  className={`size-3.5 shrink-0 text-sidebar-foreground/30 transition-transform duration-200 ${open ? "rotate-90" : ""}`}
                />
                <Folder className="size-4 shrink-0 text-sidebar-primary/60" />
                <span className="truncate">{node.label}</span>
              </CollapsibleTrigger>
            )}
            <div className="shrink-0 pr-1 opacity-0 transition-opacity group-hover/folder:opacity-100 has-[[data-popup-open]]:opacity-100">
              {view === "html" ? (
                <WidgetTreeActions
                  key={`${node.path}:${exactDocumentArchived ? "archived" : "active"}`}
                  spaceId={spaceId}
                  widgetId={node.path}
                  documentName={node.label}
                  archived={exactDocumentArchived}
                  onRefresh={onWidgetRefresh}
                  onNewDoc={onNewDoc ? () => onNewDoc(node.path) : undefined}
                  onRenameFolder={
                    folderMoveUnavailable
                      ? undefined
                      : () => setRenameOpen(true)
                  }
                  folderArchived={folderArchived}
                  onArchiveFolder={
                    folderArchiveUnavailable ? undefined : handleArchiveFolder
                  }
                  onRestoreFolder={
                    folderArchiveUnavailable ? undefined : handleRestoreFolder
                  }
                  onDeleteFolder={
                    folderDeleteUnavailable
                      ? undefined
                      : () => setDeleteOpen(true)
                  }
                />
              ) : (
                <DocContextMenuButton
                  documentName={node.label}
                  isFolder
                  archived={archived}
                  onRename={
                    folderMoveUnavailable
                      ? undefined
                      : () => setRenameOpen(true)
                  }
                  onDelete={
                    folderDeleteUnavailable
                      ? undefined
                      : () => setDeleteOpen(true)
                  }
                  onNewDoc={onNewDoc ? () => onNewDoc(node.path) : undefined}
                  onArchive={
                    folderArchiveUnavailable ? undefined : handleArchiveFolder
                  }
                  onRestore={
                    folderArchiveUnavailable ? undefined : handleRestoreFolder
                  }
                  onCopyMarkdown={docEntry ? handleCopyMarkdown : undefined}
                  onDownload={docEntry ? handleDownload : undefined}
                />
              )}
            </div>
          </div>
          <CollapsibleContent>
            <div className="ml-4 pl-2">
              {node.children.map((child) => (
                <TreeItem
                  key={`${child.kind}:${child.isFolder ? "f" : "l"}:${child.path}`}
                  node={child}
                  spaceId={spaceId}
                  index={index}
                  depth={depth + 1}
                  onNewDoc={onNewDoc}
                  onNavigate={onNavigate}
                  onRefresh={onRefresh}
                  onWidgetRefresh={onWidgetRefresh}
                  folderArchived={folderArchived}
                  reorder={reorder}
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
        <RenameDialog
          open={renameOpen}
          onClose={() => setRenameOpen(false)}
          onRename={handleRename}
          currentPath={node.path}
          isFolder
        />
        <DeleteDialog
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          onConfirm={handleDelete}
          itemName={node.name}
          isFolder
        />
      </>
    )
  }

  return (
    <>
      <div
        className={`group/doc relative flex items-center rounded-md transition-all duration-180 ${
          isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-hover"
        } ${isDragging ? "opacity-50" : ""}`}
        {...dragProps}
      >
        {dropIndicator}
        <Link
          to="/spaces/$spaceId/documents/$"
          params={{ spaceId, _splat: node.path }}
          onClick={onNavigate}
          draggable={false}
          className={`flex min-h-10 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-sm sm:min-h-0 ${
            isActive
              ? "font-medium text-sidebar-primary"
              : "text-sidebar-item-foreground"
          }`}
        >
          <DocumentNodeIcon
            node={node}
            className={`size-4 shrink-0 ${isActive ? "text-sidebar-primary" : "text-sidebar-foreground/30"}`}
          />
          <span className="truncate">{node.label}</span>
        </Link>
        <div className="shrink-0 pr-1 opacity-0 transition-opacity group-hover/doc:opacity-100 has-[[data-popup-open]]:opacity-100">
          <DocContextMenuButton
            documentName={node.label}
            isFolder={false}
            archived={archived}
            onRename={() => setRenameOpen(true)}
            onDelete={() => setDeleteOpen(true)}
            onArchive={handleArchive}
            onRestore={handleRestore}
            onCopyMarkdown={
              node.format?.id === "worktable.quickdraw"
                ? undefined
                : handleCopyMarkdown
            }
            onDownload={
              node.format?.id === "worktable.quickdraw"
                ? undefined
                : handleDownload
            }
          />
        </div>
      </div>
      <RenameDialog
        open={renameOpen}
        onClose={() => setRenameOpen(false)}
        onRename={handleRename}
        currentPath={node.path}
      />
      <DeleteDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        itemName={node.name}
      />
    </>
  )
}

// ── Main Sidebar Component ───────────────────────────────────

const STORAGE_KEY = "worktable-active-group"

type ShellSection = "home" | "threads" | "activity" | null

function shellSection(pathname: string): ShellSection {
  if (pathname === "/") return "home"
  if (pathname.startsWith("/threads")) return "threads"
  return pathname === "/activity" ? "activity" : null
}

/**
 * Auto-switch group when navigating to a space in a different group.
 * Only triggers on path changes (not manual group switches) by tracking
 * the previous path. This prevents the effect from fighting the user
 * when they switch groups while viewing a doc in the old group. Its own
 * component, so following the route does not re-render the sidebar.
 */
function FollowSpaceGroup({
  spaces,
  activeGroup,
  onGroupChange,
}: {
  spaces: SpaceFile[] | undefined
  activeGroup: string | null
  onGroupChange: (group: string) => void
}) {
  const currentPath = useRouterState({ select: (s) => s.location.pathname })
  const prevPathRef = useRef(currentPath)
  useEffect(() => {
    if (currentPath === prevPathRef.current) return
    prevPathRef.current = currentPath
    if (!spaces || !activeGroup) return
    const match = currentPath.match(/^\/spaces\/([^/]+)/)
    if (!match) return
    const spaceId = match[1]
    const space = spaces.find((s) => s.id === spaceId)
    if (space?.group && space.group !== activeGroup) {
      onGroupChange(space.group)
    }
  }, [currentPath, spaces, activeGroup, onGroupChange])
  return null
}

function SidebarSearchPanel({
  query,
  onNavigate,
  ref,
}: {
  query: string
  onNavigate: () => void
  ref?: Ref<SidebarSearchResultsHandle>
}) {
  const currentPath = useRouterState({ select: (s) => s.location.pathname })
  return (
    <SidebarSearchResults
      ref={ref}
      query={query}
      currentPath={currentPath}
      onNavigate={onNavigate}
    />
  )
}

export function AppSidebar() {
  const { data: spaces, isLoading: spacesLoading } = useSpaces()
  // Select only what the shell shows, so navigating between documents does
  // not re-render the sidebar: rows follow the route themselves.
  const section = useRouterState({
    select: (s) => shellSection(s.location.pathname),
  })
  const currentSpaceId = useRouterState({
    select: (s) => s.location.pathname.match(/^\/spaces\/([^/]+)/)?.[1] ?? null,
  })
  const isMobile = useIsMobile()
  const { setOpen } = useSidebar()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [newSpaceOpen, setNewSpaceOpen] = useState(false)
  // Kept across navigation so multiple results can be triaged; cleared only
  // via the input's clear button or Escape.
  const [searchQuery, setSearchQuery] = useState("")
  const searching = searchQuery.trim().length > 0
  const searchResultsRef = useRef<SidebarSearchResultsHandle>(null)

  // Active group filter (persisted in localStorage)
  const [activeGroup, setActiveGroup] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
  })

  const handleGroupChange = useCallback((group: string | null) => {
    setActiveGroup(group)
    try {
      if (group) {
        localStorage.setItem(STORAGE_KEY, group)
      } else {
        localStorage.removeItem(STORAGE_KEY)
      }
    } catch {
      // localStorage unavailable
    }
  }, [])

  // Every Space socket hears spaces_changed; keeping the first Space's socket
  // open lets the shared socket refresh the Spaces list when any Space changes.
  const firstSpaceId = spaces?.[0]?.id
  useSpaceEvents(firstSpaceId)

  // Filter spaces by active group
  const filteredSpaces = spaces
    ? activeGroup
      ? spaces.filter((s) => s.group === activeGroup)
      : spaces
    : undefined
  const activeSpaces =
    filteredSpaces?.filter((space) => !isSpaceArchived(space as SpaceFile)) ??
    []
  const archivedSpaces =
    filteredSpaces?.filter((space) => isSpaceArchived(space as SpaceFile)) ?? []
  const [archivedSpacesOpen, setArchivedSpacesOpen] = useState(
    !!currentSpaceId &&
      archivedSpaces.some((space) => space.id === currentSpaceId)
  )

  useEffect(() => {
    if (
      currentSpaceId &&
      archivedSpaces.some((space) => space.id === currentSpaceId)
    ) {
      setArchivedSpacesOpen(true)
    }
  }, [archivedSpaces, currentSpaceId])

  const handleNavigateHome = () => {
    if (isMobile) setOpen(false)
  }

  const handleCreateSpace = async (data: {
    name: string
    icon?: string
    group?: string
  }) => {
    try {
      const { spaceId } = await createSpace(data)
      await queryClient.invalidateQueries({
        queryKey: queryKeys.spaces,
        exact: true,
      })
      navigate({ to: "/spaces/$spaceId", params: { spaceId } })
      if (isMobile) setOpen(false)
    } catch (err) {
      console.error("Failed to create space:", err)
    }
  }

  return (
    // select-none: the sidebar is navigation chrome — a page-wide Cmd+A must
    // select the doc content, never the sidebar tree.
    <div
      data-worktable-sidebar-root
      className="flex h-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground select-none"
      style={{
        paddingTop: "env(safe-area-inset-top, 0px)",
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
      }}
    >
      <FollowSpaceGroup
        spaces={spaces}
        activeGroup={activeGroup}
        onGroupChange={handleGroupChange}
      />
      {/* Header */}
      <div
        data-tauri-drag-region="deep"
        data-worktable-sidebar-header
        className="flex h-12 shrink-0 items-center px-3"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to="/"
            onClick={handleNavigateHome}
            className="flex items-center gap-2.5 text-sm font-semibold tracking-tight transition-all duration-180 hover:opacity-80"
          >
            <WorktableAppIcon className="size-6" />
            <span>Worktable</span>
          </Link>
          <ProvenanceChip />
        </div>
      </div>

      {/* Workspace search (global scope, not group-filtered) */}
      <div className="shrink-0 px-3 pt-3 pb-1">
        <SidebarSearchInput
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onSubmit={() => searchResultsRef.current?.openTopResult()}
        />
      </div>

      {/* Content */}
      <ScrollFadeArea
        fadeSize={24}
        className="min-h-0 flex-1 [&_[data-slot=scroll-area-scrollbar]]:opacity-0 [&_[data-slot=scroll-area-scrollbar]]:transition-opacity [&_[data-slot=scroll-area-scrollbar]]:duration-300 [&:hover_[data-slot=scroll-area-scrollbar]]:opacity-100"
      >
        {searching ? (
          <div className="px-2 py-3">
            <SidebarSearchPanel
              ref={searchResultsRef}
              query={searchQuery}
              onNavigate={() => {
                if (isMobile) setOpen(false)
              }}
            />
          </div>
        ) : (
          <div className="px-2 py-3">
            {/* Home link */}
            <Link
              to="/"
              onClick={handleNavigateHome}
              className={`mx-1 mb-0.5 flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-all duration-180 ${
                section === "home"
                  ? "bg-sidebar-accent font-medium text-sidebar-primary"
                  : "text-sidebar-item-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground"
              }`}
            >
              <LayoutDashboard className="size-4 shrink-0" />
              <span>Home</span>
            </Link>

            <Link
              to="/threads/$"
              params={{ _splat: "" }}
              search={{ location: "all" }}
              onClick={() => {
                if (isMobile) setOpen(false)
              }}
              className={`mx-1 flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-all duration-180 ${
                section === "threads"
                  ? "bg-sidebar-accent font-medium text-sidebar-primary"
                  : "text-sidebar-item-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground"
              }`}
            >
              <MessageCircle className="size-4 shrink-0" />
              <span>Threads</span>
            </Link>

            <Link
              to="/activity"
              onClick={() => {
                if (isMobile) setOpen(false)
              }}
              className={`mx-1 mb-3 flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-all duration-180 ${
                section === "activity"
                  ? "bg-sidebar-accent font-medium text-sidebar-primary"
                  : "text-sidebar-item-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground"
              }`}
            >
              <History className="size-4 shrink-0" />
              <span>Activity</span>
            </Link>

            {/* Section label */}
            <div className="mb-2 flex items-center justify-between px-3 pr-1">
              <p className="text-[10px] font-semibold tracking-wider text-sidebar-foreground/40 uppercase">
                Spaces
              </p>
              <button
                type="button"
                className="flex size-6 items-center justify-center rounded-md text-sidebar-foreground/30 transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground"
                aria-label="Create new space"
                title="New space"
                onClick={() => setNewSpaceOpen(true)}
              >
                <Plus className="size-3.5" />
              </button>
            </div>

            {/* Spaces */}
            {spacesLoading && (
              <div className="flex flex-col gap-2 px-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-7 animate-pulse rounded-md bg-sidebar-accent/50"
                  />
                ))}
              </div>
            )}

            {filteredSpaces && filteredSpaces.length === 0 && (
              <div className="px-2 py-6 text-center">
                <p className="text-xs text-sidebar-foreground/40">
                  {activeGroup ? "No spaces in this group" : "No spaces yet"}
                </p>
                <p className="mt-1 text-[11px] text-sidebar-foreground/30">
                  Ask your AI agent to create one
                </p>
              </div>
            )}

            {filteredSpaces && filteredSpaces.length > 0 && (
              <div className="space-y-2">
                {activeSpaces.length > 0 && (
                  <div className="space-y-0.5">
                    {activeSpaces.map((space) => (
                      <SpaceSection key={space.id} space={space} />
                    ))}
                  </div>
                )}

                {archivedSpaces.length > 0 && (
                  <Collapsible
                    open={archivedSpacesOpen}
                    onOpenChange={setArchivedSpacesOpen}
                  >
                    <div className="px-3">
                      <CollapsibleTrigger
                        className="flex w-full items-center gap-2 py-1 text-[10px] font-semibold tracking-wider text-sidebar-foreground/40 uppercase"
                        render={<button type="button" />}
                      >
                        <ChevronRight
                          className={`size-3 shrink-0 transition-transform ${archivedSpacesOpen ? "rotate-90" : ""}`}
                        />
                        <Archive className="size-3 shrink-0" />
                        <span>Archived</span>
                      </CollapsibleTrigger>
                    </div>
                    <CollapsibleContent>
                      <div className="space-y-0.5">
                        {archivedSpaces.map((space) => (
                          <SpaceSection key={space.id} space={space} />
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </div>
            )}
          </div>
        )}
      </ScrollFadeArea>

      {/* Footer: group switcher takes the row, settings rides along as an
          icon so the footer is one composed line instead of stacked rows. */}
      <div
        className="flex shrink-0 items-center gap-1.5 px-3 py-2.5"
        style={{
          paddingBottom: "calc(0.625rem + env(safe-area-inset-bottom, 0px))",
        }}
      >
        <div className="min-w-0 flex-1">
          <GroupSwitcher
            activeGroup={activeGroup}
            onGroupChange={handleGroupChange}
          />
        </div>
        <SettingsButton />
      </div>

      {/* New space dialog */}
      <DeferredMount active={newSpaceOpen}>
        <NewSpaceDialog
          open={newSpaceOpen}
          onClose={() => setNewSpaceOpen(false)}
          onCreate={handleCreateSpace}
          defaultGroup={activeGroup}
        />
      </DeferredMount>
    </div>
  )
}
