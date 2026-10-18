import type { SpaceView } from "@/lib/api"
import { browserTeamMemberId } from "@/lib/team-context"
import { DeferredMount } from "@worktable/ui/components/deferred-mount"
import { getSpaceArchiveInfo } from "@/lib/spaces"
import { DrawingUnsavedError } from "@/lib/drawing-drafts"
import {
  createContext,
  lazy,
  memo,
  useCallback,
  useContext,
  useState,
  useEffect,
  useMemo,
  useRef,
  type Ref,
  type ReactNode,
} from "react"
import {
  Link,
  useNavigate,
  useRouter,
  useRouterState,
} from "@tanstack/react-router"
import {
  ChevronRight,
  File,
  History,
  Folder,
  FolderOpen,
  AlertTriangle,
  LayoutDashboard,
  Plus,
  Pin,
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
import { WorktableHeader } from "@/components/sidebar/worktable-header"
import { SpaceIcon } from "@/components/spaces/space-icon"
import { ProfileMenu } from "@/components/sidebar/profile-menu"
import {
  GroupActions,
  NewSpaceOrGroupButton,
  SectionHeading,
} from "@/components/sidebar/space-groups"
import { rememberedOpen, rememberOpen } from "@/lib/sidebar-open-state"
import {
  collapsiblePanel,
  transitionOpenChange,
  transitionSidebar,
} from "@/lib/sidebar-transition"
import {
  addGroup,
  moveToGroup,
  newGroupId,
  removeGroup,
  renameGroup,
  restoreGroup,
  sortedGroups,
  togglePin,
  usePersonalNavigation,
} from "@/lib/personal-navigation"
import type { PersonalGroup } from "@worktable/types"
import { recognitionColor } from "@worktable/types/recognition"
import {
  useSpaces,
  useRecordCollections,
  useSpace,
  queryKeys,
  recordCollectionsQueryOptions,
  spaceQueryOptions,
} from "@/lib/queries"
import { spaceDocsQueryOptions, useSpaceDocs } from "@/lib/docs-queries"
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
// Loaded when first opened, like New Space.
const GroupNameDialog = lazy(() =>
  import("@/components/sidebar/group-name-dialog").then((module) => ({
    default: module.GroupNameDialog,
  }))
)
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
import {
  NewMenu,
  NewSubmenu,
  SpaceNewActions,
} from "@/components/spaces/space-new-menu"
import { DocumentFormatIcon } from "@/components/document-format-icon"
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
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { RenameDialog } from "@/components/docs/rename-dialog"
import { DeleteDialog } from "@/components/docs/delete-dialog"
import {
  renameDoc,
  retitleDoc,
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
import { useQueryClient, type QueryClient } from "@tanstack/react-query"
import { GettingStartedRow } from "@/components/sidebar/getting-started-row"
import { useGettingStartedShortcut } from "@/lib/setup"
import { toast } from "@worktable/ui/components/sonner"
import type {
  DocListEntry,
  DocumentListItem,
  SpaceFile,
} from "@worktable/types"
import type { TreeNode } from "@/lib/tree"
import {
  mutateDocument,
  archiveDocumentFolder,
  deleteDocumentFolder,
  moveDocumentFolder,
  restoreDocumentFolder,
} from "@/lib/documents-api"
import {
  documentQueryKeys,
  documentsQueryOptions,
  useDocuments,
} from "@/lib/documents-queries"
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

function isSpaceArchived(space: SpaceFile) {
  return !!getSpaceArchiveInfo(space)
}

function folderLifecycleError(error: unknown, fallback: string): string {
  return error instanceof HttpError && [404, 409].includes(error.status)
    ? error.message
    : fallback
}

/** Why a rename failed when the name is already taken, for the dialog. */
function takenNameError(
  error: unknown,
  newPath: string,
  kind: "doc" | "folder"
): string | null {
  if (
    !(error instanceof HttpError) ||
    error.status !== 409 ||
    !error.message.startsWith("Target path already exists")
  ) {
    return null
  }
  return `A ${kind} named ${newPath.split("/").at(-1)} already exists here.`
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
      className="relative flex size-10 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/50 transition-colors duration-180 hover:bg-sidebar-hover hover:text-sidebar-foreground"
    >
      <Settings className="size-4" />
      {updateAvailable && (
        <UpdateIndicatorDot className="absolute top-2 right-2" />
      )}
    </button>
  )
}

// ── Space Section ────────────────────────────────────────────

/** What an opened Space shows at once: its pins, Docs and record collections. */
const spaceContents = (spaceId: string) =>
  [
    spaceQueryOptions(spaceId),
    spaceDocsQueryOptions(spaceId),
    documentsQueryOptions(spaceId),
    recordCollectionsQueryOptions(spaceId),
  ] as const

function spaceContentsLoaded(queryClient: QueryClient, spaceId: string) {
  return spaceContents(spaceId).every(
    (options) => queryClient.getQueryData(options.queryKey) !== undefined
  )
}

function loadSpaceContents(queryClient: QueryClient, spaceId: string) {
  return Promise.all([
    queryClient.ensureQueryData(spaceQueryOptions(spaceId)),
    queryClient.ensureQueryData(spaceDocsQueryOptions(spaceId)),
    queryClient.ensureQueryData(documentsQueryOptions(spaceId)),
    queryClient.ensureQueryData(recordCollectionsQueryOptions(spaceId)),
  ]).then(
    () => undefined,
    // The opened Space shows its own error states.
    () => undefined
  )
}

/** How long a Space waits for its contents before opening without them. */
const OPEN_WAIT_MS = 500
/** How long the pointer rests on a Space before its contents load. */
const INTENT_MS = 80

type RowNewActionsProps = {
  spaceId: string
  folder?: string
  label: string
  onCreated: () => void
  /** Renders the row's own menu, given the creation choices it should list. */
  children: (newItems: ReactNode | undefined) => ReactNode
}

/**
 * A Space or folder row's + and its menu. On phones the actions always show,
 * so the + would repeat on every row; its choices open from the menu instead.
 */
function RowNewActions({
  canCreate,
  ...props
}: RowNewActionsProps & { canCreate: boolean }) {
  if (!canCreate) return <>{props.children(undefined)}</>
  return <EditableRowNewActions {...props} />
}

function EditableRowNewActions({
  spaceId,
  folder,
  label,
  onCreated,
  children,
}: RowNewActionsProps) {
  const isMobile = useIsMobile()
  return (
    <SpaceNewActions spaceId={spaceId} folder={folder} onCreated={onCreated}>
      {(items) => (
        <>
          {!isMobile && (
            <NewMenu
              trigger={
                <button
                  type="button"
                  aria-label={label}
                  title="New"
                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/35 transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground data-[popup-open]:bg-sidebar-accent data-[popup-open]:text-sidebar-foreground"
                >
                  <Plus className="size-3.5 transition-transform duration-200 active:scale-90" />
                </button>
              }
            >
              {items}
            </NewMenu>
          )}
          {children(isMobile ? items : undefined)}
        </>
      )}
    </SpaceNewActions>
  )
}

/** Which copies of each Space are open: a pinned Space is listed twice. */
const openSpaceCopies = new Map<string, Set<string>>()

const SpaceSection = memo(function SpaceSection({
  space,
  followRoute = true,
  copy = "list",
  onNewGroup,
}: {
  space: SpaceView
  /** Which listing this row is, for remembering whether it was left open. */
  copy?: "pinned" | "list"
  /**
   * A pinned Space is listed twice. Only one copy opens itself when the
   * route enters the Space, so its tree is not shown twice.
   */
  followRoute?: boolean
  /** Opens New Group for this Space, when the person has groups to keep. */
  onNewGroup?: (spaceId: string) => void
}) {
  const { navigation, update } = usePersonalNavigation()
  const pinned = navigation?.pins.includes(space.id) ?? false
  const isMobile = useIsMobile()
  const { setOpen } = useSidebar()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const router = useRouter()
  const archived = isSpaceArchived(space)

  const spaceRoute = `/spaces/${space.id}`
  const relation = useRouteRelation(spaceRoute)
  const isInSpace = relation !== null
  const openKey = `${copy}:${space.id}`
  // Entering a Space opens its pinned copy, or its only copy, unless the
  // person already opened a copy of it; a copy they opened stays open.
  const anotherCopyOpen = () =>
    copy === "pinned" &&
    (openSpaceCopies.get(space.id)?.has("list") === true ||
      rememberedOpen("space", `list:${space.id}`) === true)
  const [expanded, setExpandedState] = useState(
    () =>
      rememberedOpen("space", openKey) ??
      (followRoute && isInSpace && !anotherCopyOpen())
  )
  const setExpanded = useCallback(
    (open: boolean) => {
      rememberOpen("space", openKey, open)
      setExpandedState(open)
    },
    [openKey]
  )
  const userCollapsedRef = useRef(false)

  useEffect(() => {
    if (!expanded) return
    const copies = openSpaceCopies.get(space.id) ?? new Set<string>()
    copies.add(copy)
    openSpaceCopies.set(space.id, copies)
    return () => {
      copies.delete(copy)
    }
  }, [expanded, space.id, copy])

  useEffect(() => {
    // Following the route is not the person's choice, so it isn't kept.
    if (
      followRoute &&
      isInSpace &&
      !expanded &&
      !userCollapsedRef.current &&
      !anotherCopyOpen()
    ) {
      setExpandedState(true)
    }
    // Reset manual collapse flag when navigating away from the space
    if (!isInSpace) {
      userCollapsedRef.current = false
    }
    // anotherCopyOpen reads the copies as they are when the route changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followRoute, isInSpace, expanded])

  // The panel takes the height of what it holds when it opens. Opening
  // once the contents are in lets it grow to the whole tree in one motion
  // instead of easing to a placeholder and jumping when the tree arrives.
  const opening = useRef(false)
  const intent = useRef<number | undefined>(undefined)
  const rowRef = useRef<HTMLDivElement>(null)
  // Building the tree takes as long as loading it on a phone, so it builds
  // hidden while its contents load; opening then only reveals it. Resting
  // the pointer only loads what is missing: a hidden tree would refetch
  // whatever is stale, for Spaces that may never open.
  const [prepared, setPrepared] = useState(false)
  const preload = () => void loadSpaceContents(queryClient, space.id)
  const prepare = () => {
    setPrepared(true)
    preload()
  }
  const animateExpanded = (open: boolean) => {
    const root = rowRef.current?.parentElement
    if (!root) return setExpanded(open)
    transitionSidebar(
      root,
      () => setExpanded(open),
      () => collapsiblePanel(root)
    )
  }
  const handleToggleExpanded = (open: boolean) => {
    if (!open) {
      if (isInSpace) userCollapsedRef.current = true
      animateExpanded(false)
      setPrepared(false)
      return
    }
    if (prepared && spaceContentsLoaded(queryClient, space.id)) {
      animateExpanded(true)
      return
    }
    // Keyboard and assistive opens start here; pointers prepared on press.
    if (!prepared) setPrepared(true)
    if (opening.current) return
    opening.current = true
    void Promise.race([
      loadSpaceContents(queryClient, space.id),
      new Promise((resolve) => setTimeout(resolve, OPEN_WAIT_MS)),
    ]).then(() =>
      // A frame later the hidden tree has rendered what just arrived.
      requestAnimationFrame(() => {
        opening.current = false
        animateExpanded(true)
      })
    )
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
    // Shows the new document; like following the route, it isn't kept.
    setExpandedState(true)
    if (isMobile) setOpen(false)
  }

  return (
    <>
      <Collapsible open={expanded} onOpenChange={handleToggleExpanded}>
        <div
          ref={rowRef}
          className="group/space relative flex items-center rounded-md transition-colors duration-180 hover:bg-sidebar-hover"
        >
          {/* The whole row folds and unfolds the Space; its overview is the
            first row inside. */}
          <CollapsibleTrigger
            className={`flex min-h-10 min-w-0 flex-1 items-center gap-2.5 py-2 pr-2 pl-2.5 text-left text-sm font-medium sm:min-h-0 ${
              isInSpace ? "text-sidebar-foreground" : "text-sidebar-space-foreground"
            }`}
            render={<button type="button" aria-expanded={expanded} />}
            onPointerEnter={(event) => {
              if (event.pointerType !== "mouse" || expanded) return
              intent.current = window.setTimeout(preload, INTENT_MS)
            }}
            onPointerLeave={(event) => {
              window.clearTimeout(intent.current)
              // A finger "leaves" as it lifts, before its tap; only a mouse
              // moving away means the Space won't open.
              if (event.pointerType !== "mouse") return
              if (!expanded && !opening.current) setPrepared(false)
            }}
            onPointerCancel={() => {
              // A touch that turns into a scroll won't open the Space.
              if (!expanded && !opening.current) setPrepared(false)
            }}
            onPointerDown={() => {
              if (!expanded) prepare()
            }}
          >
            <SpaceIcon space={space} />
            <span className="min-w-0 truncate">{space.name}</span>
          </CollapsibleTrigger>
          {/* Always visible on touch (no hover exists) and on keyboard focus;
            hover-revealed on desktop pointers. This cluster is the primary
            create entry point now that the tabs toolbar is gone. */}
          <div className="flex shrink-0 items-center pr-1 opacity-100 transition-opacity focus-within:opacity-100 has-[[data-popup-open]]:opacity-100 sm:opacity-0 sm:group-hover/space:opacity-100">
            {navigation && (
              // Touch screens keep Pin in the menu instead.
              <button
                type="button"
                aria-label={pinned ? `Unpin ${space.name}` : `Pin ${space.name}`}
                title={pinned ? "Unpin" : "Pin"}
                aria-pressed={pinned}
                onClick={() => void update(togglePin(space.id))}
                className="hidden size-6 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/35 transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground sm:flex"
              >
                <Pin className={`size-3.5 ${pinned ? "fill-current" : ""}`} />
              </button>
            )}
            <RowNewActions
              spaceId={space.id}
              label={`New in ${space.name}`}
              canCreate={space.permissions?.edit !== false}
              onCreated={afterCreate}
            >
              {(newItems) => (
                <SpaceContextMenuButton
                  newItems={newItems}
                  spaceId={space.id}
                  canEdit={space.permissions?.edit !== false}
                  canManageAccess={Boolean(browserTeamMemberId() && space.permissions?.manage)}
                  spaceName={space.name}
                  spaceIcon={space.icon}
                  spaceColor={recognitionColor(space.settings?.color, space.id)}
                  archived={archived}
                  personal={
                    navigation && onNewGroup
                      ? {
                          pinned,
                          groups: navigation.groups,
                          groupId: navigation.spaceGroups[space.id] ?? null,
                          onTogglePin: () => void update(togglePin(space.id)),
                          onChangeGroup: (groupId) =>
                            void update(moveToGroup(space.id, groupId)),
                          onNewGroup: () => onNewGroup(space.id),
                        }
                      : undefined
                  }
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
                  onChangeColor={async (color) => {
                    try {
                      await updateSpace(space.id, { color })
                      await queryClient.invalidateQueries({
                        queryKey: queryKeys.spaces,
                        exact: true,
                      })
                    } catch {
                      toast.error("Failed to change color")
                    }
                  }}
                  onArchive={handleArchive}
                  onRestore={handleRestore}
                  onDelete={handleDelete}
                />
              )}
            </RowNewActions>
          </div>
        </div>

        <CollapsibleContent
          className="collapsible-instant"
          keepMounted={prepared}
        >
          <div className="ml-4 pl-2">
            <SpaceContent space={space} onNavigate={handleNavigate} />
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
}: {
  space: SpaceView
  onNavigate: () => void
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
      // An open HTML doc shows its name and archive state from its page check.
      ...(widgetId
        ? [
            queryClient.invalidateQueries({
              queryKey: queryKeys.widget(spaceId, widgetId),
              exact: true,
            }),
            queryClient.invalidateQueries({
              queryKey: documentQueryKeys.page(spaceId, widgetId),
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
    <div className="sidebar-reveal mt-1">
      <SpaceOverviewLink spaceId={spaceId} onNavigate={onNavigate} />
      <PinnedSidebarSection spaceId={spaceId} onNavigate={onNavigate} />
      <SpaceTreeSection
        space={space}
        documents={documents ?? NO_DOCUMENTS}
        docs={docs ?? NO_DOCS}
        isLoading={documentsLoading}
        loadFailed={documentsError}
        onNavigate={onNavigate}
        onRefresh={handleRefresh}
        onWidgetRefresh={refreshWidgets}
      />
      <RecordsSidebarSection spaceId={spaceId} onNavigate={onNavigate} />
      <ThreadsSidebarEntry spaceId={spaceId} onNavigate={onNavigate} />
    </div>
  )
})

/** The Space's own page, first inside it now that its row only folds. */
function SpaceOverviewLink({
  spaceId,
  onNavigate,
}: {
  spaceId: string
  onNavigate: () => void
}) {
  const isActive = useIsCurrentRoute(`/spaces/${spaceId}`)
  return (
    <Link
      to="/spaces/$spaceId"
      params={{ spaceId }}
      onClick={onNavigate}
      className={`mb-1 flex min-h-10 min-w-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors duration-180 sm:min-h-0 ${
        isActive
          ? "bg-sidebar-accent font-medium text-sidebar-primary"
          : "text-sidebar-item-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground"
      }`}
    >
      <LayoutDashboard
        className={`size-4 shrink-0 ${isActive ? "text-sidebar-primary" : "text-sidebar-foreground/30"}`}
      />
      <span className="min-w-0 truncate">Space Home</span>
    </Link>
  )
}

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
      className={`flex min-h-10 min-w-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors duration-180 sm:min-h-0 ${
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
        className={`flex min-h-10 min-w-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors duration-180 sm:min-h-0 ${
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
      className={`flex min-h-10 min-w-0 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors duration-180 sm:min-h-0 ${
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
  onRenameFolder,
  folderArchived,
  onArchiveFolder,
  onRestoreFolder,
  onDeleteFolder,
  newItems,
}: {
  spaceId: string
  widgetId: string
  documentName: string
  archived: boolean
  onRefresh: (widgetId?: string) => Promise<void>
  onRenameFolder?: () => void
  folderArchived?: boolean
  onArchiveFolder?: () => void
  onRestoreFolder?: () => void
  onDeleteFolder?: () => void
  newItems?: ReactNode
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
        newItems={newItems}
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
      <DeferredMount active={renameOpen}>
        <RenameDialog
          open={renameOpen}
          onClose={() => setRenameOpen(false)}
          onRename={handleRename}
          currentPath={widgetId}
          pathInput
        />
      </DeferredMount>
      <DeferredMount active={deleteOpen}>
        <WidgetDeleteDialog
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          widgetName={documentName}
          onConfirm={handleDelete}
        />
      </DeferredMount>
    </>
  )
}

function WidgetTreeItem({
  node,
  spaceId,
  onNavigate,
  onRefresh,
  reorder,
}: {
  node: TreeNode
  spaceId: string
  onNavigate: () => void
  onRefresh: (widgetId?: string) => Promise<void>
  reorder?: DocReorder
}) {
  const isActive = useIsCurrentRoute(
    `${documentRoutePrefix(spaceId)}${node.path}`
  )
  const archived = !!node.archived
  const { dragProps, dropIndicator, isDragging } = treeDragPresentation(
    node,
    reorder
  )

  return (
    <>
      <div
        className={`group/widget relative flex items-center rounded-md transition-[background-color,opacity] duration-180 ${
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
              : "text-sidebar-item-foreground hover:text-sidebar-foreground"
          }`}
        >
          <AppWindow
            className={`size-4 shrink-0 ${isActive ? "text-sidebar-primary" : "text-sidebar-foreground/30"}`}
          />
          <span className="truncate">{node.label}</span>
        </Link>
        <div className="shrink-0 pr-1 opacity-100 transition-opacity focus-within:opacity-100 has-[[data-popup-open]]:opacity-100 sm:opacity-0 sm:group-hover/widget:opacity-100">
          <WidgetTreeActions
            key={node.path}
            spaceId={spaceId}
            widgetId={node.path}
            documentName={node.label}
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
  newItems,
}: {
  documentName: string
  archived?: boolean
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
  newItems?: ReactNode
}) {
  const hasFolderActions = Boolean(
    onRenameFolder || onArchiveFolder || onRestoreFolder || onDeleteFolder
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex size-9 items-center justify-center rounded-md text-sidebar-foreground/30 transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground data-[popup-open]:bg-sidebar-accent data-[popup-open]:text-sidebar-foreground sm:size-6"
        render={
          <button type="button" aria-label={`Actions for ${documentName}`} />
        }
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="min-w-44">
        {newItems && <NewSubmenu>{newItems}</NewSubmenu>}
        {/* A path can hold an HTML Doc and docs inside it; each has its own
          actions, so the menu names which one they act on. */}
        <DropdownMenuGroup>
          {hasFolderActions && <DropdownMenuLabel>HTML Doc</DropdownMenuLabel>}
          <DropdownMenuItem onClick={onCopyHtml}>
            <Copy className="mr-2 h-4 w-4" />
            Copy HTML
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onRename}>
            <Pencil className="mr-2 h-4 w-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onClick={archived ? onRestore : onArchive}>
            {archived ? (
              <RotateCcw className="mr-2 h-4 w-4" />
            ) : (
              <Archive className="mr-2 h-4 w-4" />
            )}
            {archived ? "Restore" : "Archive"}
          </DropdownMenuItem>
          {!hasFolderActions && <DropdownMenuSeparator />}
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash className="mr-2 h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {hasFolderActions && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Folder</DropdownMenuLabel>
              {onRenameFolder && (
                <DropdownMenuItem onClick={onRenameFolder}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Rename
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
                  {folderArchived ? "Restore" : "Archive"}
                </DropdownMenuItem>
              )}
              {onDeleteFolder && (
                <DropdownMenuItem variant="destructive" onClick={onDeleteFolder}>
                  <Trash className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
          </>
        )}
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
  isLoading,
  loadFailed,
  onNavigate,
  onRefresh,
  onWidgetRefresh,
}: {
  space: SpaceView
  documents: DocumentListItem[]
  docs: DocListEntry[]
  isLoading: boolean
  loadFailed: boolean
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
    sort: effectiveSort,
    order: effectiveOrder,
    separateTemporary: true,
  })
  const index = spaceDocumentIndex({ documents, docs })
  const { temporaryCount, temporaryPaths, archivedCount, archivedPaths } = useMemo(() => {
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
      archivedCount: documents.filter(documentListItemArchived).length,
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
    onNavigate,
    onRefresh,
    onWidgetRefresh,
    canEdit: space.permissions?.edit !== false,
  }
  const { data: detail } = useSpace(spaceId)
  const currentPath = useRouterState({
    select: (state) => routeDocumentPath(state.location.pathname, spaceId),
  })
  const revealCurrent =
    !currentPath ||
    !(detail?.pins ?? []).some(
      (pin) => pin.status === "active" && pin.path === currentPath
    )

  return (
    <RevealCurrent.Provider value={revealCurrent}>
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
        <div className="space-y-0.5">
          {tree.length > 0 && (
            <nav aria-label="Active documents" className="space-y-0.5">
              {tree.map((node) => (
                <TreeItem
                  key={`${node.kind}:${node.isFolder ? "f" : "l"}:${node.path}`}
                  node={node}
                  {...rowProps}
                  folderArchived={false}
                  reorder={space.permissions?.edit !== false ? reorder : undefined}
                />
              ))}
            </nav>
          )}

          {temporaryTree.length > 0 && (
            <TreeSection
              label="Temporary"
              icon={Clock3}
              count={temporaryCount}
              open={temporaryOpen}
              onOpenChange={transitionOpenChange(setTemporaryOpen)}
            >
              {temporaryTree.map((node) => (
                <TreeItem
                  key={`${node.kind}:${node.isFolder ? "f" : "l"}:${node.path}`}
                  node={node}
                  {...rowProps}
                  folderArchived={false}
                />
              ))}
            </TreeSection>
          )}

          {archivedTree.length > 0 && (
            <TreeSection
              label="Archived"
              icon={Archive}
              count={archivedCount}
              open={archivedOpen}
              onOpenChange={transitionOpenChange(setArchivedOpen)}
              dimmed
            >
              {archivedTree.map((node) => (
                <TreeItem
                  key={`${node.kind}:${node.isFolder ? "f" : "l"}:${node.path}`}
                  node={node}
                  {...rowProps}
                  folderArchived
                />
              ))}
            </TreeSection>
          )}
        </div>
      ) : !isLoading ? (
        <p className="px-3 py-2 text-xs text-sidebar-foreground/30">
          No docs yet
        </p>
      ) : null}
    </RevealCurrent.Provider>
  )
}

/**
 * Temporary and Archived: folder-like rows at the end of a Space's tree, so
 * they read as part of the Space rather than as sidebar headings.
 */
function TreeSection({
  label,
  icon: Icon,
  count,
  open,
  onOpenChange,
  dimmed = false,
  children,
}: {
  label: string
  icon: typeof Archive
  count: number
  /** Quiets the rows inside, except the open one and the one under the pointer. */
  dimmed?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger
        className="flex min-h-10 w-full min-w-0 items-center gap-2 rounded-md px-3 py-2 text-sm text-sidebar-foreground/50 transition-colors duration-180 hover:bg-sidebar-hover hover:text-sidebar-foreground sm:min-h-0"
        render={<button type="button" />}
      >
        <Icon className="size-4 shrink-0 text-sidebar-foreground/30" />
        <span className="min-w-0 truncate">{label}</span>
        {!open && (
          <span className="ml-auto shrink-0 text-[11px] text-sidebar-foreground/35 tabular-nums">
            {count}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-instant">
        <nav
          aria-label={`${label} documents`}
          className={`ml-4 space-y-0.5 pl-2 ${
            dimmed
              ? "[&>*]:opacity-60 [&>*]:transition-opacity [&>*:has([aria-current=page])]:opacity-100 [&>*:hover]:opacity-100"
              : ""
          }`}
        >
          {children}
        </nav>
      </CollapsibleContent>
    </Collapsible>
  )
}

/**
 * Whether folders open to show the open document. Not when it already shows
 * among the Space's pins, so it doesn't take two places in the sidebar.
 */
const RevealCurrent = createContext(true)

// ── Tree Item dispatcher (doc/folder vs widget leaf) ────────

interface TreeRowProps {
  node: TreeNode
  spaceId: string
  index: SpaceDocumentIndex
  depth?: number
  onNavigate: () => void
  onRefresh: () => Promise<void>
  onWidgetRefresh: (widgetId?: string) => Promise<void>
  folderArchived: boolean
  reorder?: DocReorder
  /** Whether this person can create in the Space (false for read access). */
  canEdit: boolean
}

/**
 * One tree row. Memoized with stable props, so a row re-renders only when its
 * own node, the catalog, a drag, or its relation to the route changes.
 */
const TreeItem = memo(function TreeItem(props: TreeRowProps) {
  const { node, spaceId, index, onNavigate, onWidgetRefresh, reorder } = props
  const view = specializedDocumentView(node)
  if (view === "html" && !node.isFolder) {
    return (
      <WidgetTreeItem
        node={node}
        spaceId={spaceId}
        onNavigate={onNavigate}
        onRefresh={onWidgetRefresh}
        reorder={reorder}
      />
    )
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
  onNavigate,
  onRefresh,
  onWidgetRefresh,
  folderArchived,
  reorder,
  canEdit,
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
      index.isHtmlDocument(openPath) &&
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
  const folderKey = `${spaceId}:${node.path}`
  const revealCurrent = useContext(RevealCurrent)
  const [open, setOpenStored] = useState(
    () =>
      (containsCurrent && revealCurrent) ||
      isActive ||
      (node.isFolder && (rememberedOpen("folder", folderKey) ?? false))
  )
  const setOpenState = (next: boolean) => {
    if (node.isFolder) rememberOpen("folder", folderKey, next)
    setOpenStored(next)
  }
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const userCollapsedNodeRef = useRef(false)

  useEffect(() => {
    if (
      node.isFolder &&
      ((containsCurrent && revealCurrent) || isActive) &&
      !open &&
      !userCollapsedNodeRef.current
    ) {
      // Like a Space, a folder opened by the route is not kept open.
      setOpenStored(true)
    }
    if (!containsCurrent && !isActive) {
      userCollapsedNodeRef.current = false
    }
  }, [containsCurrent, isActive, open, node.isFolder, revealCurrent])

  const folderRowRef = useRef<HTMLDivElement>(null)
  const handleToggleNode = (nextOpen: boolean) => {
    if (!nextOpen && (containsCurrent || isActive)) {
      userCollapsedNodeRef.current = true
    }
    const root = folderRowRef.current?.parentElement
    if (!root) return setOpenState(nextOpen)
    transitionSidebar(
      root,
      () => setOpenState(nextOpen),
      () => collapsiblePanel(root)
    )
  }

  // A Doc's name is its title; other documents are named by their path.
  const namedByTitle =
    !node.isFolder &&
    (node.format?.id === "worktable.rich-text" ||
      node.format?.id === "worktable.markdown")
  const handleRename = async (newPath: string) => {
    const openPath = router.state.location.pathname
    // Keep an open document on screen where it now lives.
    const follow = async (renamed: Array<{ from: string; to: string }>) => {
      await Promise.all([
        onRefresh(),
        ...(node.isFolder ? [onWidgetRefresh()] : []),
      ])
      if (!routeRelation(openPath, documentFullPath)) return
      const oldOpenPath = `${node.path}${openPath.slice(documentFullPath.length)}`
      const target = renamed.find((r) => r.from === oldOpenPath)?.to
      if (target && target !== oldOpenPath) {
        void navigate({
          to: "/spaces/$spaceId/documents/$",
          params: { spaceId, _splat: target },
        })
      }
    }
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
          : namedByTitle
            ? await retitleDoc(spaceId, node.path, newPath)
            : await renameDoc(spaceId, node.path, newPath, "document")
      await follow(result.renamed ?? [])
      toast.success(node.isFolder ? "Folder renamed" : "Doc renamed")
      return true
    } catch (error) {
      // A doc can move before setting its title fails.
      const moved =
        error instanceof HttpError &&
        Array.isArray((error.body as { renamed?: unknown } | null)?.renamed)
          ? ((error.body as { renamed: Array<{ from: string; to: string }> })
              .renamed)
          : []
      if (moved.length > 0) await follow(moved)
      const taken = takenNameError(
        error,
        newPath,
        node.isFolder ? "folder" : "doc"
      )
      if (taken) return taken
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
            ref={folderRowRef}
            className={`group/folder relative flex items-center rounded-md transition-colors duration-180 ${
              isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-hover"
            } ${isDragging ? "opacity-50" : ""}`}
            {...dragProps}
          >
            {dropIndicator}
            {hasDocumentAtFolder ? (
              // A document can also own a path with descendants: its icon folds
              // them, and its name opens the document and unfolds them.
              <div className="flex min-h-10 min-w-0 flex-1 items-center sm:min-h-0">
                <CollapsibleTrigger
                  className="flex h-full shrink-0 items-center py-2 pr-1 pl-3"
                  render={
                    <button
                      type="button"
                      aria-label={open ? `Collapse ${node.label}` : `Expand ${node.label}`}
                    />
                  }
                >
                  <DocumentNodeIcon
                    node={node}
                    className={`size-4 shrink-0 ${node.kind === "conflict" ? "text-sidebar-foreground/40" : "text-sidebar-primary/60"}`}
                  />
                </CollapsibleTrigger>
                <SpecializedDocumentLink
                  spaceId={spaceId}
                  path={node.path}
                  onClick={() => {
                    // The page changes too, so this opens without a transition.
                    setOpenState(true)
                    onNavigate()
                  }}
                  className={`flex min-w-0 flex-1 items-center py-2 pr-3 pl-1 text-sm ${
                    isActive
                      ? "font-medium text-sidebar-primary"
                      : "text-sidebar-item-foreground"
                  }`}
                >
                  <span className="truncate">{node.label}</span>
                </SpecializedDocumentLink>
              </div>
            ) : (
              <CollapsibleTrigger
                className="flex min-h-10 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-sm text-sidebar-item-foreground sm:min-h-0"
                render={<button type="button" />}
              >
                {open ? (
                  <FolderOpen className="size-4 shrink-0 text-sidebar-primary/60" />
                ) : (
                  <Folder className="size-4 shrink-0 text-sidebar-primary/60" />
                )}
                <span className="truncate">{node.label}</span>
              </CollapsibleTrigger>
            )}
            <div className="flex shrink-0 items-center pr-1 opacity-100 transition-opacity focus-within:opacity-100 has-[[data-popup-open]]:opacity-100 sm:opacity-0 sm:group-hover/folder:opacity-100">
              <RowNewActions
                spaceId={spaceId}
                folder={node.path}
                label={`New in ${node.label}`}
                canCreate={canEdit}
                onCreated={onNavigate}
              >
                {(newItems) =>
                  view === "html" ? (
                    <WidgetTreeActions
                      key={`${node.path}:${exactDocumentArchived ? "archived" : "active"}`}
                      spaceId={spaceId}
                      widgetId={node.path}
                      documentName={node.label}
                      archived={exactDocumentArchived}
                      onRefresh={onWidgetRefresh}
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
                      newItems={newItems}
                    />
                  ) : (
                    <DocContextMenuButton
                      documentName={node.label}
                      newItems={newItems}
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
                      onArchive={
                        folderArchiveUnavailable ? undefined : handleArchiveFolder
                      }
                      onRestore={
                        folderArchiveUnavailable ? undefined : handleRestoreFolder
                      }
                      onCopyMarkdown={docEntry ? handleCopyMarkdown : undefined}
                      onDownload={docEntry ? handleDownload : undefined}
                    />
                  )
                }
              </RowNewActions>
            </div>
          </div>
          <CollapsibleContent className="collapsible-instant">
            <div className="ml-4 pl-2">
              {node.children.map((child) => (
                <TreeItem
                  key={`${child.kind}:${child.isFolder ? "f" : "l"}:${child.path}`}
                  node={child}
                  spaceId={spaceId}
                  index={index}
                  depth={depth + 1}
                  onNavigate={onNavigate}
                  onRefresh={onRefresh}
                  onWidgetRefresh={onWidgetRefresh}
                  folderArchived={folderArchived}
                  reorder={reorder}
                  canEdit={canEdit}
                />
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
        <DeferredMount active={renameOpen}>
          <RenameDialog
            open={renameOpen}
            onClose={() => setRenameOpen(false)}
            onRename={handleRename}
            currentPath={node.path}
            isFolder
          />
        </DeferredMount>
        <DeferredMount active={deleteOpen}>
          <DeleteDialog
            open={deleteOpen}
            onClose={() => setDeleteOpen(false)}
            onConfirm={handleDelete}
            itemName={node.name}
            isFolder
          />
        </DeferredMount>
      </>
    )
  }

  return (
    <>
      <div
        className={`group/doc relative flex items-center rounded-md transition-[background-color,opacity] duration-180 ${
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
        <div className="shrink-0 pr-1 opacity-100 transition-opacity focus-within:opacity-100 has-[[data-popup-open]]:opacity-100 sm:opacity-0 sm:group-hover/doc:opacity-100">
          <DocContextMenuButton
            documentName={node.label}
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
      <DeferredMount active={renameOpen}>
        <RenameDialog
          open={renameOpen}
          onClose={() => setRenameOpen(false)}
          onRename={handleRename}
          currentPath={node.path}
          title={namedByTitle ? node.label : undefined}
        />
      </DeferredMount>
      <DeferredMount active={deleteOpen}>
        <DeleteDialog
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          onConfirm={handleDelete}
          itemName={node.name}
        />
      </DeferredMount>
    </>
  )
}

// ── Main Sidebar Component ───────────────────────────────────

type ShellSection = "home" | "threads" | "activity" | null

function shellSection(pathname: string): ShellSection {
  if (pathname === "/") return "home"
  if (pathname.startsWith("/threads")) return "threads"
  return pathname === "/activity" ? "activity" : null
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

type GroupDialogState =
  | { mode: "new"; spaceId?: string }
  | { mode: "rename"; group: PersonalGroup }
  | null

export function AppSidebar() {
  const { data: spaces, isLoading: spacesLoading } = useSpaces()
  const { navigation, update } = usePersonalNavigation()
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
  const [newSpace, setNewSpace] = useState<{ groupId: string | null } | null>(
    null
  )
  const [groupDialog, setGroupDialog] = useState<GroupDialogState>(null)
  // Which sections are folded, remembered on this device.
  const [sectionOpen, setSectionOpen] = useState<Record<string, boolean>>({})
  // Kept across navigation so multiple results can be triaged; cleared only
  // via the input's clear button or Escape.
  const [searchQuery, setSearchQuery] = useState("")
  const searching = searchQuery.trim().length > 0
  const searchResultsRef = useRef<SidebarSearchResultsHandle>(null)

  // Every Space socket hears spaces_changed; keeping the first Space's socket
  // open lets the shared socket refresh the Spaces list when any Space changes.
  const firstSpaceId = spaces?.[0]?.id
  useSpaceEvents(firstSpaceId)

  const groupOf = (spaceId: string) =>
    navigation?.spaceGroups[spaceId] ?? null
  // Getting Started sits above the list while the person keeps it pinned.
  const gettingStarted = useGettingStartedShortcut(spaces)
  const activeSpaces =
    spaces?.filter(
      (space) =>
        !isSpaceArchived(space as SpaceFile) &&
        space.id !== gettingStarted?.space.id
    ) ?? []
  const archivedSpaces =
    spaces?.filter((space) => isSpaceArchived(space as SpaceFile)) ?? []
  const pinnedSpaces = navigation
    ? navigation.pins.flatMap(
        (id) => activeSpaces.find((space) => space.id === id) ?? []
      )
    : []
  const isPinned = (space: SpaceView) => pinnedSpaces.includes(space)
  const groups = navigation ? sortedGroups(navigation.groups) : []
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

  const handleCreateSpace = async (data: { name: string; icon?: string }) => {
    try {
      const { spaceId } = await createSpace(data)
      await queryClient.invalidateQueries({
        queryKey: queryKeys.spaces,
        exact: true,
      })
      navigate({ to: "/spaces/$spaceId", params: { spaceId } })
      if (isMobile) setOpen(false)
      return spaceId
    } catch (err) {
      toast.error("Failed to create space")
      console.error("Failed to create space:", err)
      return undefined
    }
  }

  const openNewGroup = useStableCallback((spaceId?: string) =>
    setGroupDialog({ mode: "new", spaceId })
  )

  const isSectionOpen = (key: string) =>
    sectionOpen[key] ?? rememberedOpen("section", key) ?? true
  const toggleSection = (key: string) => {
    const next = !isSectionOpen(key)
    rememberOpen("section", key, next)
    setSectionOpen((state) => ({ ...state, [key]: next }))
  }

  const handleRemoveGroup = (group: PersonalGroup) => {
    if (!navigation) return
    const index = navigation.groups.findIndex(({ id }) => id === group.id)
    const spaceIds = Object.entries(navigation.spaceGroups).flatMap(
      ([spaceId, groupId]) => (groupId === group.id ? [spaceId] : [])
    )
    void update(removeGroup(group.id))
    toast(`${group.name} removed`, {
      action: {
        label: "Undo",
        onClick: () => void update(restoreGroup(group, index, spaceIds)),
      },
    })
  }

  const spaceRow = (space: SpaceView, key = space.id) => (
    <SpaceSection
      key={key}
      space={space}
      followRoute={!isPinned(space)}
      onNewGroup={navigation ? openNewGroup : undefined}
    />
  )

  const ungrouped = activeSpaces.filter((space) => {
    const groupId = groupOf(space.id)
    return !groupId || !groups.some((group) => group.id === groupId)
  })

  // Pinned, the person's groups and Spaces for the rest are one run of
  // sections that look alike; with no groups it is Pinned and Spaces.
  const renderSection = (
    key: string,
    label: string,
    members: SpaceView[],
    actions?: ReactNode,
    options: { revealActions?: boolean; pinned?: boolean; emptyHint?: boolean } = {}
  ) => {
    const open = isSectionOpen(key)
    return (
      <div key={key}>
        <SectionHeading
          label={label}
          count={members.length}
          open={open}
          onToggle={() => toggleSection(key)}
          actions={actions}
          revealActions={options.revealActions}
        />
        {open &&
          (members.length > 0 ? (
            <div className="space-y-0.5">
              {members.map((space) =>
                options.pinned ? (
                  <SpaceSection
                    key={`pinned:${space.id}`}
                    space={space}
                    copy="pinned"
                    onNewGroup={navigation ? openNewGroup : undefined}
                  />
                ) : (
                  spaceRow(space)
                )
              )}
            </div>
          ) : options.emptyHint === false ? null : (
            <p className="px-3 py-1 text-[11px] text-sidebar-foreground/30">
              No Spaces
            </p>
          ))}
      </div>
    )
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
      <WorktableHeader />

      {/* Workspace search (every Space, whatever the list shows) */}
      <div className="shrink-0 px-3 pt-1 pb-1">
        <SidebarSearchInput
          query={searchQuery}
          onQueryChange={setSearchQuery}
          onSubmit={() => searchResultsRef.current?.openTopResult()}
        />
      </div>

      {/* Content */}
      <ScrollFadeArea
        fadeSize={24}
        className="min-h-0 flex-1 [&_[data-slot=scroll-area-scrollbar]]:opacity-0 [&_[data-slot=scroll-area-scrollbar]]:transition-opacity [&_[data-slot=scroll-area-scrollbar]]:duration-300 [&:hover_[data-slot=scroll-area-scrollbar]]:opacity-100 [&[data-scrollbar-held]_[data-slot=scroll-area-scrollbar]]:opacity-100"
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
              className={`mx-1 mb-0.5 flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors duration-180 ${
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
              className={`mx-1 flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors duration-180 ${
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
              className={`mx-1 mb-3 flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors duration-180 ${
                section === "activity"
                  ? "bg-sidebar-accent font-medium text-sidebar-primary"
                  : "text-sidebar-item-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground"
              }`}
            >
              <History className="size-4 shrink-0" />
              <span>Activity</span>
            </Link>

            {gettingStarted && (
              <GettingStartedRow
                space={gettingStarted.space}
                progress={gettingStarted.progress}
                active={currentSpaceId === gettingStarted.space.id}
                onNavigate={() => {
                  if (isMobile) setOpen(false)
                }}
              />
            )}

            {pinnedSpaces.length > 0 &&
              renderSection("pinned", "Pinned", pinnedSpaces, undefined, {
                pinned: true,
              })}
            {groups.map((group) =>
              renderSection(
                `group:${group.id}`,
                group.name,
                activeSpaces.filter((space) => groupOf(space.id) === group.id),
                <GroupActions
                  name={group.name}
                  onNewSpace={() => setNewSpace({ groupId: group.id })}
                  onRename={() => setGroupDialog({ mode: "rename", group })}
                  onRemove={() => handleRemoveGroup(group)}
                />
              )
            )}
            {renderSection(
              "spaces",
              "Spaces",
              ungrouped,
              <>
                <NewSpaceOrGroupButton
                  onNewSpace={() => setNewSpace({ groupId: null })}
                  onNewGroup={navigation ? () => openNewGroup() : null}
                />
                {/* Keeps the + in the rows' + column, beside their menus. */}
                {!isMobile && <span aria-hidden className="w-6" />}
              </>,
              // The list's own empty state covers a Worktable with no Spaces.
              { revealActions: false, emptyHint: false }
            )}

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

            {spaces && spaces.length === 0 && (
              <div className="px-2 py-6 text-center">
                <p className="text-xs text-sidebar-foreground/40">
                  No spaces yet
                </p>
                <p className="mt-1 text-[11px] text-sidebar-foreground/30">
                  Ask your AI agent to create one
                </p>
              </div>
            )}

            {spaces && spaces.length > 0 && (
              <div className="space-y-2">

                {archivedSpaces.length > 0 && (
                  <Collapsible
                    open={archivedSpacesOpen}
                    onOpenChange={transitionOpenChange(setArchivedSpacesOpen)}
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
                    <CollapsibleContent className="collapsible-instant">
                      <div className="space-y-0.5">
                        {archivedSpaces.map((space) => spaceRow(space))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </div>
            )}
          </div>
        )}
      </ScrollFadeArea>

      <div
        data-sidebar-motion-cover=""
        className="flex shrink-0 items-center gap-1.5 bg-sidebar px-3 py-2.5"
        style={{
          paddingBottom: "calc(0.625rem + env(safe-area-inset-bottom, 0px))",
        }}
      >
        <ProfileMenu />
        <SettingsButton />
      </div>

      {/* New space dialog */}
      <DeferredMount active={newSpace !== null}>
        <NewSpaceDialog
          open={newSpace !== null}
          onClose={() => setNewSpace(null)}
          onCreate={handleCreateSpace}
          defaultGroup={newSpace?.groupId ?? null}
        />
      </DeferredMount>

      {navigation && (
        <DeferredMount active={groupDialog !== null}>
        <GroupNameDialog
          open={groupDialog !== null}
          group={groupDialog?.mode === "rename" ? groupDialog.group : undefined}
          groups={navigation.groups}
          onClose={() => setGroupDialog(null)}
          onSubmit={(name) => {
            if (!groupDialog) return
            void update(
              groupDialog.mode === "rename"
                ? renameGroup(groupDialog.group.id, name)
                : addGroup(newGroupId(), name, groupDialog.spaceId)
            )
          }}
        />
        </DeferredMount>
      )}
    </div>
  )
}
