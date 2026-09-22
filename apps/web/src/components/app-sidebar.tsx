import { DeferredMount } from "@worktable/ui/components/deferred-mount"
import { DrawingUnsavedError } from "@/lib/drawing-drafts"
import {
  lazy,
  Suspense,
  useState,
  useEffect,
  useMemo,
  useRef,
} from "react"
import { Link, useNavigate, useRouterState } from "@tanstack/react-router"
import {
  ChevronRight,
  ChevronDown,
  File,
  FilePlus,
  FileText,
  Folder,
  LayoutDashboard,
  Plus,
  Briefcase,
  Rocket,
  Church,
  Target,
  LayoutGrid,
  Check,
  Archive,
  AlertTriangle,
  AppWindow,
  Copy,
  Database,
  Monitor,
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
  useSpace,
  useWorkspace,
  useRecordCollections,
  recordCollectionsQueryOptions,
  queryKeys,
} from "@/lib/queries"
import { createRecordCollection } from "@/lib/records-api"
const NewCollectionDialog = lazy(() =>
  import("@/components/records/new-collection-dialog").then((module) => ({
    default: module.NewCollectionDialog,
  }))
)
const NewDrawingDialog = lazy(() =>
  import("@/components/new-drawing-dialog").then((module) => ({
    default: module.NewDrawingDialog,
  }))
)
import type { WidgetListEntry } from "@/lib/widgets-api"
import { docQueryKeys, useSpaceDocs } from "@/lib/docs-queries"
import { useSpaceEvents } from "@/hooks/use-space-events"
import { useSidebar } from "@/hooks/use-sidebar"
import { useIsMobile } from "@/hooks/use-mobile"
import { buildTree, flattenTreeOrder } from "@/lib/tree"
import type { DocSortMode } from "@/lib/tree"
import { staleTitle } from "@/lib/doc-freshness"
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
import { useUpdateAvailability } from "@/hooks/use-update-availability"
import { UpdateIndicatorDot } from "@/components/update-indicator"
import { SpaceContextMenuButton } from "@/components/spaces/space-context-menu"
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
import { Input } from "@worktable/ui/components/input"
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
  createDoc,
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
  createWidget,
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
  supportsManagedFolderArchive,
  supportsManagedFolderDelete,
  supportsManagedFolderMove,
} from "@/lib/document-views"
import { canonicalConflictPath, HttpError } from "@/lib/http"

// ── Group Definitions ────────────────────────────────────────

// Icon hints for known group slugs; unknown groups use LayoutGrid
const GROUP_ICONS: Record<string, typeof Briefcase> = {
  work: Briefcase,
  "main-quest": Target,
  "side-quests": Rocket,
  church: Church,
}

function formatGroupLabel(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}

function getGroupDef(id: string) {
  return {
    id,
    label: formatGroupLabel(id),
    icon: GROUP_ICONS[id] ?? LayoutGrid,
  }
}

function getSpaceArchiveInfo(space: SpaceFile) {
  const value = space.settings["archive"]
  if (!value || typeof value !== "object") return undefined
  const candidate = value as Record<string, unknown>
  if (
    typeof candidate["archivedAt"] !== "string" ||
    typeof candidate["archivedBy"] !== "string"
  ) {
    return undefined
  }

  return {
    archivedAt: candidate["archivedAt"],
    archivedBy: candidate["archivedBy"],
    reason:
      typeof candidate["reason"] === "string" ? candidate["reason"] : undefined,
  }
}

function isSpaceArchived(space: SpaceFile) {
  return !!getSpaceArchiveInfo(space)
}

/** Manual sidebar doc order from space settings (untrusted on-disk data). */
function getDocOrder(space: SpaceFile): string[] | undefined {
  const value = space.settings["docOrder"]
  if (!Array.isArray(value)) return undefined
  const paths = value.filter((v): v is string => typeof v === "string")
  return paths.length > 0 ? paths : undefined
}

/** Sidebar doc sort mode from space settings; default is custom order. */
function getDocSort(space: SpaceFile): DocSortMode {
  const value = space.settings["docSort"]
  return value === "alphabetical" || value === "updated" ? value : "custom"
}

function documentListItemArchived(item: DocumentListItem): boolean {
  if (item.kind === "document") return item.archived === true
  const documents = item.claims.filter((claim) => claim.kind === "document")
  return (
    documents.length > 0 && documents.every((claim) => claim.archived === true)
  )
}

function documentFolderPaths(items: DocumentListItem[]): Set<string> {
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

function folderLifecycleError(error: unknown, fallback: string): string {
  return error instanceof HttpError && [404, 409].includes(error.status)
    ? error.message
    : fallback
}

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
  const updateAvailable = useUpdateAvailability() !== null
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

function SpaceSection({
  space,
  widgets,
  currentPath,
}: {
  space: SpaceFile
  widgets: WidgetFile[]
  currentPath: string
}) {
  const isMobile = useIsMobile()
  const { setOpen } = useSidebar()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const archived = isSpaceArchived(space)
  const { data: workspace } = useWorkspace()

  const isInSpace = currentPath.startsWith(`/spaces/${space.id}`)
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

  const handleNavigate = () => {
    if (isMobile) setOpen(false)
  }

  const handleRename = async (newName: string) => {
    try {
      await updateSpace(space.id, { name: newName })
      await queryClient.invalidateQueries({ queryKey: queryKeys.spaces })
      toast.success("Space renamed")
    } catch (err) {
      toast.error("Failed to rename space")
      console.error("Failed to rename space:", err)
    }
  }

  const handleChangeGroup = async (group: string | undefined) => {
    try {
      await updateSpace(space.id, { group: group ?? "" })
      await queryClient.invalidateQueries({ queryKey: queryKeys.spaces })
    } catch (err) {
      toast.error("Failed to change group")
      console.error("Failed to change group:", err)
    }
  }

  const handleDelete = async () => {
    try {
      await deleteSpace(space.id)
      await queryClient.invalidateQueries({ queryKey: queryKeys.spaces })
      if (currentPath.startsWith(`/spaces/${space.id}`)) {
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
      await queryClient.invalidateQueries({ queryKey: queryKeys.spaces })
      toast.success("Space archived")
    } catch (err) {
      toast.error("Failed to archive space")
      console.error("Failed to archive space:", err)
    }
  }

  const handleRestore = async () => {
    try {
      await restoreSpace(space.id)
      await queryClient.invalidateQueries({ queryKey: queryKeys.spaces })
      toast.success("Space restored")
    } catch (err) {
      toast.error("Failed to restore space")
      console.error("Failed to restore space:", err)
    }
  }

  const handleChangeDocSort = async (sort: DocSortMode) => {
    try {
      await updateDocOrder(space.id, { sort })
      await queryClient.invalidateQueries({ queryKey: queryKeys.spaces })
    } catch (err) {
      toast.error("Failed to change sort order")
      console.error("Failed to change doc sort:", err)
    }
  }

  // Creation lives on the space row (hover-revealed +) so the tree below starts
  // immediately — no toolbar row between the space header and its content.
  const [newDrawingOpen, setNewDrawingOpen] = useState(false)
  const [newWidgetOpen, setNewWidgetOpen] = useState(false)
  const [newCollectionOpen, setNewCollectionOpen] = useState(false)
  const createPendingRef = useRef(false)

  const handleCreateDoc = async (path: string) => {
    try {
      // `path` is the human-typed title (optionally "folder/Title"); the server
      // slugifies it per-segment and returns the canonical path to navigate to.
      const { path: created } = await createDoc(space.id, path)
      await queryClient.invalidateQueries({
        queryKey: docQueryKeys.docs(space.id),
      })
      await queryClient.invalidateQueries({
        queryKey: documentQueryKeys.list(space.id),
      })
      setExpanded(true)
      void navigate({
        to: "/spaces/$spaceId/documents/$",
        params: { spaceId: space.id, _splat: created },
      })
      if (isMobile) setOpen(false)
      toast.success("Doc created")
    } catch (err) {
      toast.error("Failed to create doc")
      console.error("Failed to create doc:", err)
    }
  }

  // No dialog: creating a doc should be instant. The server names it
  // untitled / untitled-2 / … and the sidebar label follows the doc's H1
  // once there is one. The ref guards double-clicks on the + button.
  const handleNewDoc = (folder?: string) => {
    if (createPendingRef.current) return
    createPendingRef.current = true
    void handleCreateDoc(folder ? `${folder}/Untitled` : "Untitled").finally(
      () => {
        createPendingRef.current = false
      }
    )
  }

  // Rethrows on failure: the dialog stays open so the entered name and
  // description survive a rejected create.
  const handleCreateCollection = async (name: string, description?: string) => {
    // The server route upserts by slug, so a colliding name would silently
    // edit the existing collection's schema — refuse it here instead.
    const slug =
      name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "collection"
    try {
      // staleTime 0 forces a network read: a 30s-stale cached list could miss
      // a collection another client just created and fall into the upsert.
      const existing = await queryClient.fetchQuery({
        ...recordCollectionsQueryOptions(space.id),
        staleTime: 0,
      })
      if (existing.some((collection) => collection.id === slug)) {
        toast.error(`A collection with id "${slug}" already exists`)
        throw new Error("duplicate collection id")
      }
      const collection = await createRecordCollection(space.id, {
        name,
        ...(description ? { description } : {}),
      })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.recordCollections(space.id),
      })
      setExpanded(true)
      void navigate({
        to: "/spaces/$spaceId/records/$",
        params: { spaceId: space.id, _splat: collection.id },
      })
      if (isMobile) setOpen(false)
      toast.success("Collection created")
    } catch (err) {
      if (
        !(err instanceof Error && err.message === "duplicate collection id")
      ) {
        // The strict-create 409 carries a specific message; surface it.
        const message =
          err instanceof Error && err.message.includes("already exists")
            ? err.message
            : "Failed to create collection"
        toast.error(message)
        console.error("Failed to create record collection:", err)
      }
      throw err
    }
  }

  const handleCreateWidgetShell = async (
    name: string,
    description?: string
  ) => {
    try {
      const result = await createWidget(space.id, {
        name,
        description,
        html: buildWidgetShellHtml(name),
        metadata: { source: "manual-shell" },
      })
      void queryClient.invalidateQueries({ queryKey: queryKeys.spaces })
      void queryClient.invalidateQueries({
        queryKey: queryKeys.space(space.id),
      })
      setExpanded(true)
      void navigate({
        to: "/spaces/$spaceId/documents/$",
        params: { spaceId: space.id, _splat: result.widgetId },
      })
      if (isMobile) setOpen(false)
      toast.success("HTML doc shell created")
    } catch (err) {
      toast.error("Failed to create HTML doc shell")
      console.error("Failed to create HTML doc shell:", err)
    }
  }

  return (
    <>
      <Collapsible open={expanded} onOpenChange={handleToggleExpanded}>
        <div className="group/space relative flex items-center rounded-md transition-colors duration-180 hover:bg-sidebar-hover">
          <CollapsibleTrigger
            className="flex min-h-10 min-w-0 flex-1 items-center gap-2.5 px-3 py-2 text-sm font-medium text-sidebar-space-foreground sm:min-h-0"
            render={<button type="button" />}
          >
            <ChevronRight
              className={`size-4 shrink-0 text-sidebar-foreground/40 transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
            />
            {resolveIcon(space.icon, "size-4")}
            <span className="min-w-0 truncate">{space.name}</span>
          </CollapsibleTrigger>
          {/* Always visible on touch (no hover exists) and on keyboard focus;
            hover-revealed on desktop pointers. This cluster is the primary
            create entry point now that the tabs toolbar is gone. */}
          <div className="flex shrink-0 items-center pr-1 opacity-100 transition-opacity focus-within:opacity-100 has-[[data-popup-open]]:opacity-100 sm:opacity-0 sm:group-hover/space:opacity-100">
            <DropdownMenu>
              <DropdownMenuTrigger
                className="flex size-9 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/35 transition-colors hover:bg-sidebar-hover hover:text-sidebar-foreground has-[[data-popup-open]]:bg-sidebar-accent sm:size-6"
                render={<button type="button" title="New" />}
              >
                <Plus className="size-3.5 transition-transform duration-200 active:scale-90" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                sideOffset={4}
                className="min-w-44"
              >
                <DropdownMenuItem onClick={() => handleNewDoc()}>
                  <FileText className="mr-2 h-4 w-4" />
                  New doc
                </DropdownMenuItem>
                {workspace?.storageVersion === 2 && (
                  <DropdownMenuItem onClick={() => setNewDrawingOpen(true)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    New drawing
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => setNewWidgetOpen(true)}>
                  <AppWindow className="mr-2 h-4 w-4" />
                  New HTML doc
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setNewCollectionOpen(true)}>
                  <Database className="mr-2 h-4 w-4" />
                  New record collection
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
              spaceId={space.id}
              widgets={widgets}
              currentPath={currentPath}
              onNavigate={handleNavigate}
              onNewDoc={handleNewDoc}
              docOrder={getDocOrder(space)}
              docSort={getDocSort(space)}
            />
          </div>
        </CollapsibleContent>
      </Collapsible>
      {newDrawingOpen && (
        <Suspense fallback={null}>
          <NewDrawingDialog
            spaceId={space.id}
            onClose={() => setNewDrawingOpen(false)}
            onCreated={() => {
              setExpanded(true)
              if (isMobile) setOpen(false)
            }}
          />
        </Suspense>
      )}
      <NewWidgetDialog
        open={newWidgetOpen}
        onClose={() => setNewWidgetOpen(false)}
        onCreate={handleCreateWidgetShell}
      />
      <DeferredMount active={newCollectionOpen}>
        <NewCollectionDialog
          open={newCollectionOpen}
          onClose={() => setNewCollectionOpen(false)}
          onCreate={handleCreateCollection}
        />
      </DeferredMount>
    </>
  )
}

// ── Space Content (merged doc + widget tree) ────────────────

function SpaceContent({
  spaceId,
  widgets,
  currentPath,
  onNavigate,
  onNewDoc,
  docOrder,
  docSort,
}: {
  spaceId: string
  widgets: WidgetFile[]
  currentPath: string
  onNavigate: () => void
  onNewDoc: (folder?: string) => void
  docOrder?: string[]
  docSort: DocSortMode
}) {
  const { data: docs, refetch } = useSpaceDocs(spaceId)
  const {
    data: documents,
    isLoading: documentsLoading,
    isError: documentsError,
    refetch: refetchDocuments,
  } = useDocuments(spaceId)
  // The all-spaces payload (the `widgets` prop) is UNDECORATED — only the
  // space-detail embed carries freshness. Layer freshness onto the prop list by
  // id so stale dots match the doc route, without changing the list source
  // (create/rename/archive still ride the all-spaces query). This query only
  // fires for an expanded space, and shares the overview/widget-route cache.
  const { data: spaceDetail } = useSpace(spaceId)
  const { subscribe } = useSpaceEvents(spaceId)
  const queryClient = useQueryClient()

  const freshnessById = useMemo(() => {
    const map = new Map<string, WidgetListEntry["freshness"]>()
    for (const widget of spaceDetail?.widgets ?? [])
      map.set(widget.id, widget.freshness)
    return map
  }, [spaceDetail])
  const decoratedWidgets = useMemo<WidgetListEntry[]>(
    () =>
      widgets.map((widget) => ({
        ...widget,
        freshness: freshnessById.get(widget.id),
      })),
    [widgets, freshnessById]
  )

  // Keep the merged tree live: a doc's sidebar label derives from its first
  // heading, so an edit that adds an H1 must show up without navigating away
  // and back. Widget events (create/rename/archive/delete) arrive as
  // widget_update / widget_deleted — the widget list rides on the spaces query,
  // so invalidate it. space_update carries settings changes (manual doc order,
  // sort mode) written by another client.
  useEffect(() => {
    return subscribe((msg) => {
      if (msg.type === "doc_update" || msg.type === "doc_deleted") {
        void refetch()
        void refetchDocuments()
      }
      if (
        msg.type === "space_update" ||
        msg.type === "widget_update" ||
        msg.type === "widget_moved" ||
        msg.type === "widget_deleted"
      ) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.spaces,
          exact: true,
        })
        // The per-space embed carries widget freshness (stale dots); refresh it
        // too so a review/edit elsewhere updates the sidebar marker live.
        void queryClient.invalidateQueries({
          queryKey: queryKeys.space(spaceId),
          exact: true,
        })
        // A background expanded Space may be the only subscriber for this
        // event. Refresh the exact HTML detail owner as well as its lists so a
        // previously visited doc cannot remain fresh with stale content or
        // metadata. For moves, widgetId is the canonical target; the mounted
        // old route is deliberately left to its redirect owner.
        if (
          msg.type !== "space_update" &&
          msg.type !== "widget_deleted" &&
          msg.widgetId
        ) {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.widget(spaceId, msg.widgetId),
            exact: true,
          })
        }
      }
      // Collection list + counts in the records section below the tree. The
      // recordCollections key is the prefix of every record query, so this
      // also refreshes an open grid when the space page isn't mounted.
      if (
        msg.type === "record_update" ||
        msg.type === "record_deleted" ||
        msg.type === "record_collection_update"
      ) {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.recordCollections(spaceId),
        })
      }
    })
  }, [subscribe, refetch, refetchDocuments, queryClient, spaceId])

  const activeDocs = (docs ?? []).filter((doc) => !doc.archived)
  const archivedDocs = (docs ?? []).filter((doc) => doc.archived)
  const activeWidgets = decoratedWidgets.filter((widget) => !widget.archive)
  const archivedWidgets = decoratedWidgets.filter((widget) => widget.archive)
  const activeDocuments = (documents ?? []).filter(
    (document) => !documentListItemArchived(document)
  )
  const archivedDocuments = (documents ?? []).filter(documentListItemArchived)

  // Widget mutations surface through the spaces query (the widget list is
  // embedded there); refresh both it and the per-space query.
  const refreshWidgets = async (widgetId?: string) => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.spaces,
        exact: true,
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.space(spaceId),
        exact: true,
      }),
      queryClient.invalidateQueries({ queryKey: ["search"] }),
      queryClient.invalidateQueries({
        queryKey: documentQueryKeys.list(spaceId),
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
  }

  return (
    <div className="mt-1 animate-in duration-200 fade-in">
      <SpaceTreeSection
        spaceId={spaceId}
        currentPath={currentPath}
        activeDocs={activeDocs}
        archivedDocs={archivedDocs}
        activeDocuments={activeDocuments}
        archivedDocuments={archivedDocuments}
        activeWidgets={activeWidgets}
        archivedWidgets={archivedWidgets}
        isLoading={documentsLoading}
        loadFailed={documentsError}
        onNewDoc={onNewDoc}
        onNavigate={onNavigate}
        onRefresh={async () => {
          await Promise.all([refetch(), refetchDocuments()])
        }}
        onWidgetRefresh={refreshWidgets}
        docOrder={docOrder}
        docSort={docSort}
      />
      <RecordsSidebarSection
        spaceId={spaceId}
        currentPath={currentPath}
        onNavigate={onNavigate}
      />
      <ThreadsSidebarEntry
        spaceId={spaceId}
        currentPath={currentPath}
        onNavigate={onNavigate}
      />
    </div>
  )
}

function ThreadsSidebarEntry({
  spaceId,
  currentPath,
  onNavigate,
}: {
  spaceId: string
  currentPath: string
  onNavigate: () => void
}) {
  const basePath = `/spaces/${spaceId}/threads`
  const isActive =
    currentPath === basePath || currentPath.startsWith(`${basePath}/`)
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
  currentPath,
  onNavigate,
}: {
  spaceId: string
  currentPath: string
  onNavigate: () => void
}) {
  // Only fires for expanded spaces (this component mounts inside the
  // collapsible), mirroring the useSpace freshness query above.
  const { data: collections } = useRecordCollections(spaceId)
  if (!collections || collections.length === 0) return null

  return (
    <div className="mt-2">
      <p className="px-3 py-1 text-[10px] font-semibold tracking-wider text-sidebar-foreground/40 uppercase">
        Records
      </p>
      <nav className="space-y-0.5">
        {collections.map((collection) => {
          const collectionPath = `/spaces/${spaceId}/records/${collection.id}`
          const isActive = currentPath === collectionPath
          return (
            <Link
              key={collection.id}
              to="/spaces/$spaceId/records/$"
              params={{ spaceId, _splat: collection.id }}
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
              <span className="min-w-0 truncate">{collection.name}</span>
              <span className="ml-auto shrink-0 text-[11px] text-sidebar-foreground/35 tabular-nums">
                {collection.count}
              </span>
            </Link>
          )
        })}
      </nav>
    </div>
  )
}

const INVALID_WIDGET_CHARS = /[<>:"|?*\\]/
const MAX_WIDGET_NAME_LENGTH = 80
const MAX_WIDGET_DESCRIPTION_LENGTH = 180

function sanitizeWidgetName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\.{2,}/g, ".")
}

function validateWidgetName(name: string): string | null {
  if (!name) return null
  if (INVALID_WIDGET_CHARS.test(name)) return "Name contains invalid characters"
  if (name.length > MAX_WIDGET_NAME_LENGTH)
    return `Name must be under ${MAX_WIDGET_NAME_LENGTH} characters`
  if (name === "." || name === "..") return "Invalid name"
  return null
}

function NewWidgetDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean
  onClose: () => void
  onCreate: (name: string, description?: string) => Promise<void>
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [pending, setPending] = useState(false)
  const isMobile = useIsMobile()

  useEffect(() => {
    if (open) {
      setName("")
      setDescription("")
      setPending(false)
    }
  }, [open])

  const sanitizedName = sanitizeWidgetName(name)
  const trimmedDescription = description.trim()
  const validationError = validateWidgetName(sanitizedName)
  const canCreate = sanitizedName.length > 0 && !validationError && !pending

  const handleCreate = async () => {
    if (!canCreate) return
    setPending(true)
    try {
      await onCreate(sanitizedName, trimmedDescription || undefined)
      onClose()
    } finally {
      setPending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && canCreate) {
      void handleCreate()
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-tint">
            <Monitor className="h-5 w-5 text-primary" />
          </div>
          <ResponsiveDialogTitle>New HTML doc</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Create an empty HTML doc shell an agent can fill in later.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody>
          <div className="space-y-2">
            <label htmlFor="widget-name" className="text-sm font-medium">
              HTML doc name
            </label>
            <Input
              id="widget-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Open Items"
              className="h-9"
              maxLength={MAX_WIDGET_NAME_LENGTH}
              autoFocus={!isMobile}
            />
            {validationError && name.trim() && (
              <p className="text-xs text-destructive">{validationError}</p>
            )}
          </div>

          <div className="space-y-2">
            <label htmlFor="widget-description" className="text-sm font-medium">
              Description{" "}
              <span className="font-normal text-muted-foreground">
                optional
              </span>
            </label>
            <Input
              id="widget-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What should this HTML doc help with?"
              className="h-9"
              maxLength={MAX_WIDGET_DESCRIPTION_LENGTH}
            />
          </div>
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!canCreate}>
            {pending ? "Creating…" : "Create HTML doc"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

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

function buildWidgetShellHtml(name: string): string {
  const escapedName = escapeHtml(name)
  return `<!doctype html>
<html data-theme="dark">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapedName}</title>
  <style>
    :root {
      color-scheme: light dark;
      --ad-bg: #f7f4ee;
      --ad-surface: rgba(255, 255, 255, 0.86);
      --ad-text: #20252d;
      --ad-muted: #667085;
      --ad-border: rgba(32, 37, 45, 0.13);
    }
    html[data-theme="dark"] {
      --ad-bg: #0d1117;
      --ad-surface: rgba(255, 255, 255, 0.035);
      --ad-text: #f4f7fb;
      --ad-muted: #9aa7b2;
      --ad-border: rgba(255, 255, 255, 0.12);
    }
    body {
      min-height: 100vh;
      margin: 0;
      display: grid;
      place-items: center;
      background: var(--ad-bg);
      color: var(--ad-text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      max-width: 520px;
      margin: 24px;
      padding: 20px;
      border: 1px dashed var(--ad-border);
      border-radius: 14px;
      background: var(--ad-surface);
      text-align: center;
    }
    h1 { margin: 0 0 6px; font-size: 16px; font-weight: 500; line-height: 1.3; }
    p { margin: 0; color: var(--ad-muted); font-size: 13px; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>${escapedName}</h1>
    <p>Empty HTML doc. Ask an agent to build it out.</p>
  </main>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

// ── Widget Tree Item ────────────────────────────────────────

function WidgetTreeActions({
  spaceId,
  widgetId,
  documentName,
  archived,
  currentPath,
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
  currentPath: string
  onRefresh: (widgetId?: string) => Promise<void>
  onNewDoc?: () => void
  onRenameFolder?: () => void
  folderArchived?: boolean
  onArchiveFolder?: () => void
  onRestoreFolder?: () => void
  onDeleteFolder?: () => void
}) {
  const navigate = useNavigate()
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const widgetPath = `/spaces/${spaceId}/documents/${widgetId}`
  const isActive = currentPath === widgetPath

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
      const result = await moveWidget(spaceId, widgetId, newPath)
      await onRefresh()
      if (isActive) {
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
      await deleteWidget(spaceId, widgetId)
      await onRefresh()
      if (isActive)
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
  currentPath,
  onRefresh,
  reorder,
}: {
  node: TreeNode
  spaceId: string
  widget: WidgetListEntry
  currentPath: string
  onRefresh: (widgetId?: string) => Promise<void>
  reorder?: DocReorder
}) {
  const isMobile = useIsMobile()
  const { setOpen } = useSidebar()
  const widgetPath = `/spaces/${spaceId}/documents/${widget.id}`
  const isActive = currentPath === widgetPath
  const archived = !!widget.archive
  const { dragProps, dropIndicator, isDragging } = treeDragPresentation(
    node,
    reorder
  )

  const handleNavigate = () => {
    if (isMobile) setOpen(false)
  }

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
          onClick={handleNavigate}
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
          {!archived && widget.freshness?.stale && (
            <span
              className="ml-auto size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
              title={staleTitle(widget.freshness)}
            />
          )}
        </Link>
        <div className="shrink-0 pr-1 opacity-0 transition-opacity group-hover/widget:opacity-100 has-[[data-popup-open]]:opacity-100">
          <WidgetTreeActions
            key={widget.id}
            spaceId={spaceId}
            widgetId={widget.id}
            documentName={widget.name}
            archived={archived}
            currentPath={currentPath}
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
            Rename folder
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
            {folderArchived ? "Restore folder" : "Archive folder"}
          </DropdownMenuItem>
        )}
        {onDeleteFolder && (
          <DropdownMenuItem variant="destructive" onClick={onDeleteFolder}>
            <Trash className="mr-2 h-4 w-4" />
            Delete folder
          </DropdownMenuItem>
        )}
        {hasFolderActions && <DropdownMenuSeparator />}
        <DropdownMenuItem onClick={onCopyHtml}>
          <Copy className="mr-2 h-4 w-4" />
          Copy HTML
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onRename}>
          <Pencil className="mr-2 h-4 w-4" />
          {isHybridPath ? "Rename HTML doc" : "Rename"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={archived ? onRestore : onArchive}>
          {archived ? (
            <RotateCcw className="mr-2 h-4 w-4" />
          ) : (
            <Archive className="mr-2 h-4 w-4" />
          )}
          {archived
            ? isHybridPath
              ? "Restore HTML doc"
              : "Restore"
            : isHybridPath
              ? "Archive HTML doc"
              : "Archive"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash className="mr-2 h-4 w-4" />
          {isHybridPath ? "Delete HTML doc" : "Delete"}
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
  spaceId,
  currentPath,
  activeDocs,
  archivedDocs,
  activeDocuments,
  archivedDocuments,
  activeWidgets,
  archivedWidgets,
  isLoading,
  loadFailed,
  onNewDoc,
  onNavigate,
  onRefresh,
  onWidgetRefresh,
  docOrder,
  docSort,
}: {
  spaceId: string
  currentPath: string
  activeDocs: DocListEntry[]
  archivedDocs: DocListEntry[]
  activeDocuments: DocumentListItem[]
  archivedDocuments: DocumentListItem[]
  activeWidgets: WidgetListEntry[]
  archivedWidgets: WidgetListEntry[]
  isLoading: boolean
  loadFailed: boolean
  onNewDoc: (folder?: string) => void
  onNavigate: () => void
  onRefresh: () => Promise<void>
  onWidgetRefresh: (widgetId?: string) => Promise<void>
  docOrder?: string[]
  docSort: DocSortMode
}) {
  const queryClient = useQueryClient()
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

  const docDetails = new Map(
    [...activeDocs, ...archivedDocs].map((doc) => [doc.path, doc])
  )
  const widgetDetails = new Map(
    [...activeWidgets, ...archivedWidgets].map((widget) => [widget.id, widget])
  )
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
  const documentToTreeInput = (item: DocumentListItem) => {
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
      freshness: doc?.freshness ?? widget?.freshness,
      updatedAt:
        doc?.provenance?.updatedAt ??
        (typeof doc?.updatedAt === "number"
          ? new Date(doc.updatedAt).toISOString()
          : (widget?.updatedAt ?? item.updatedAt)),
    }
  }
  const treeSort = { mode: effectiveSort, order: effectiveOrder }
  const allDocuments = [...activeDocuments, ...archivedDocuments]
  const sharedFolderPaths = documentFolderPaths(allDocuments)
  const tree = buildTree(activeDocuments.map(documentToTreeInput), treeSort, {
    folderPaths: sharedFolderPaths,
  })
  const archivedTree = buildTree(
    archivedDocuments.map(documentToTreeInput),
    treeSort,
    { folderPaths: sharedFolderPaths }
  )
  const folderMoveUnavailablePaths = allDocuments.flatMap((item) => {
    if (item.kind === "conflict") return [item.pathKey]
    return supportsManagedFolderMove(item) ? [] : [item.path]
  })
  const folderArchiveUnavailablePaths = allDocuments.flatMap((item) => {
    if (item.kind === "conflict") return [item.pathKey]
    return supportsManagedFolderArchive(item) ? [] : [item.path]
  })
  const folderDeleteUnavailablePaths = allDocuments.flatMap((item) => {
    if (item.kind === "conflict") return [item.pathKey]
    return supportsManagedFolderDelete(item) ? [] : [item.path]
  })
  const allWidgets = [...activeWidgets, ...archivedWidgets]

  const canDrop = (target: TreeNode) =>
    drag !== null &&
    target.path !== drag.path &&
    parentOf(target.path) === parentOf(drag.path) &&
    // Folders stay grouped before leaves, so cross-group drops would have no
    // visible effect. Every common document format otherwise shares ordering.
    target.isFolder === drag.isFolder

  const handleDrop = () => {
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
    siblings.splice(0, siblings.length, ...rest)

    // A drag always lands in custom mode: the captured order is exactly the
    // display order the user just arranged, whatever mode produced it.
    // Entries not in the visible active tree (archived docs) keep their
    // original positions: walk the previous order, emitting untouched
    // entries as-is and active entries in their newly dragged sequence.
    const activeOrder = flattenTreeOrder(tree)
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
        await queryClient.invalidateQueries({ queryKey: queryKeys.spaces })
      } catch (err) {
        console.error("Failed to save doc order:", err)
        toast.error("Failed to save order")
        setLocalOrder(null)
        setLocalSort(null)
      }
    })
  }

  const reorder: DocReorder = {
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
  }
  // Use the common catalog so every archived format keeps its current row visible.
  const hasArchivedCurrent = archivedDocuments.some(
    (item) =>
      item.kind === "document" &&
      currentPath === `/spaces/${spaceId}/documents/${item.path}`
  )
  const [archivedOpen, setArchivedOpen] = useState(hasArchivedCurrent)

  useEffect(() => {
    if (hasArchivedCurrent) {
      setArchivedOpen(true)
    }
  }, [hasArchivedCurrent])

  const hasContent = !isLoading && (tree.length > 0 || archivedTree.length > 0)

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
                  spaceId={spaceId}
                  currentPath={currentPath}
                  onNewDoc={onNewDoc}
                  onNavigate={onNavigate}
                  onRefresh={onRefresh}
                  onWidgetRefresh={onWidgetRefresh}
                  docs={activeDocs}
                  widgets={allWidgets}
                  folderMoveUnavailablePaths={folderMoveUnavailablePaths}
                  folderArchiveUnavailablePaths={folderArchiveUnavailablePaths}
                  folderDeleteUnavailablePaths={folderDeleteUnavailablePaths}
                  folderArchived={false}
                  reorder={reorder}
                />
              ))}
            </nav>
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
                      spaceId={spaceId}
                      currentPath={currentPath}
                      onNewDoc={onNewDoc}
                      onNavigate={onNavigate}
                      onRefresh={onRefresh}
                      onWidgetRefresh={onWidgetRefresh}
                      docs={archivedDocs}
                      widgets={allWidgets}
                      folderMoveUnavailablePaths={folderMoveUnavailablePaths}
                      folderArchiveUnavailablePaths={
                        folderArchiveUnavailablePaths
                      }
                      folderDeleteUnavailablePaths={
                        folderDeleteUnavailablePaths
                      }
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

function TreeItem({
  node,
  spaceId,
  currentPath,
  depth,
  onNewDoc,
  onNavigate,
  onRefresh,
  onWidgetRefresh,
  docs,
  widgets,
  folderMoveUnavailablePaths,
  folderArchiveUnavailablePaths,
  folderDeleteUnavailablePaths,
  folderArchived,
  reorder,
}: {
  node: TreeNode
  spaceId: string
  currentPath: string
  depth?: number
  onNewDoc?: (folder?: string) => void
  onNavigate: () => void
  onRefresh: () => Promise<void>
  onWidgetRefresh: (widgetId?: string) => Promise<void>
  docs: DocListEntry[]
  widgets: WidgetListEntry[]
  folderMoveUnavailablePaths: string[]
  folderArchiveUnavailablePaths: string[]
  folderDeleteUnavailablePaths: string[]
  folderArchived: boolean
  reorder?: DocReorder
}) {
  const view = specializedDocumentView(node)
  if (view === "html" && !node.isFolder) {
    const widget = widgets.find(
      (entry) => entry.id === node.path && !!entry.archive === !!node.archived
    )
    if (widget) {
      return (
        <WidgetTreeItem
          node={node}
          spaceId={spaceId}
          widget={widget}
          currentPath={currentPath}
          onRefresh={onWidgetRefresh}
          reorder={reorder}
        />
      )
    }
  }
  if (view === "doc" && !node.isFolder) {
    const doc = docs.find(
      (entry) =>
        entry.path === node.path && !!entry.archived === !!node.archived
    )
    if (doc) {
      return (
        <DocTreeItem
          node={node}
          spaceId={spaceId}
          currentPath={currentPath}
          depth={depth}
          onNewDoc={onNewDoc}
          onNavigate={onNavigate}
          onRefresh={onRefresh}
          onWidgetRefresh={onWidgetRefresh}
          docs={docs}
          widgets={widgets}
          folderMoveUnavailablePaths={folderMoveUnavailablePaths}
          folderArchiveUnavailablePaths={folderArchiveUnavailablePaths}
          folderDeleteUnavailablePaths={folderDeleteUnavailablePaths}
          folderArchived={folderArchived}
          reorder={reorder}
        />
      )
    }
  }
  if (
    !node.isFolder &&
    !(node.format?.id === "worktable.quickdraw" && node.health === "supported")
  ) {
    return (
      <UnavailableDocumentTreeItem
        node={node}
        spaceId={spaceId}
        currentPath={currentPath}
        onNavigate={onNavigate}
        reorder={reorder}
      />
    )
  }
  return (
    <DocTreeItem
      node={node}
      spaceId={spaceId}
      currentPath={currentPath}
      depth={depth}
      onNewDoc={onNewDoc}
      onNavigate={onNavigate}
      onRefresh={onRefresh}
      onWidgetRefresh={onWidgetRefresh}
      docs={docs}
      widgets={widgets}
      folderMoveUnavailablePaths={folderMoveUnavailablePaths}
      folderArchiveUnavailablePaths={folderArchiveUnavailablePaths}
      folderDeleteUnavailablePaths={folderDeleteUnavailablePaths}
      folderArchived={folderArchived}
      reorder={reorder}
    />
  )
}

function UnavailableDocumentTreeItem({
  node,
  spaceId,
  currentPath,
  onNavigate,
  reorder,
}: {
  node: TreeNode
  spaceId: string
  currentPath: string
  onNavigate: () => void
  reorder?: DocReorder
}) {
  const { dragProps, dropIndicator, isDragging } = treeDragPresentation(
    node,
    reorder
  )
  const StateIcon = node.kind === "conflict" ? AlertTriangle : File
  const isActive = currentPath === `/spaces/${spaceId}/documents/${node.path}`
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
  currentPath,
  depth = 0,
  onNewDoc,
  onNavigate,
  onRefresh,
  onWidgetRefresh,
  docs,
  widgets,
  folderMoveUnavailablePaths,
  folderArchiveUnavailablePaths,
  folderDeleteUnavailablePaths,
  folderArchived,
  reorder,
}: {
  node: TreeNode
  spaceId: string
  currentPath: string
  depth?: number
  onNewDoc?: (folder?: string) => void
  onNavigate: () => void
  onRefresh: () => Promise<void>
  onWidgetRefresh: (widgetId?: string) => Promise<void>
  docs: DocListEntry[]
  widgets: WidgetListEntry[]
  folderMoveUnavailablePaths: string[]
  folderArchiveUnavailablePaths: string[]
  folderDeleteUnavailablePaths: string[]
  folderArchived: boolean
  reorder?: DocReorder
}) {
  const isMobile = useIsMobile()
  const { setOpen } = useSidebar()
  const navigate = useNavigate()

  const view = specializedDocumentView(node)
  const docEntry =
    view === "doc"
      ? docs.find(
          (doc) => doc.path === node.path && !!doc.archived === !!node.archived
        )
      : undefined
  const documentRoutePrefix = `/spaces/${spaceId}/documents/`
  const documentFullPath = `${documentRoutePrefix}${node.path}`
  const isActive = currentPath === documentFullPath
  // A folder auto-expands when the current route lives under it — the active
  // item may be a doc OR a widget nested inside this folder.
  const containsCurrent = currentPath.startsWith(`${documentFullPath}/`)
  const currentDocumentPath = currentPath.startsWith(documentRoutePrefix)
    ? currentPath.slice(documentRoutePrefix.length)
    : undefined
  const currentWidgetId = widgets.some(
    (widget) => widget.id === currentDocumentPath
  )
    ? currentDocumentPath
    : undefined
  const currentWidgetUnderNode =
    currentWidgetId && documentPathIsAtOrBelow(currentWidgetId, node.path)
      ? currentWidgetId
      : undefined
  const folderHasUnmovableDocuments =
    node.isFolder &&
    folderMoveUnavailablePaths.some((path) =>
      documentPathIsAtOrBelow(path, node.path)
    )
  const hasDocumentAtFolder = node.isFolder && node.kind !== "folder"
  const folderMoveUnavailable = folderHasUnmovableDocuments
  const folderHasUnarchivableDocuments =
    node.isFolder &&
    folderArchiveUnavailablePaths.some((path) =>
      documentPathIsAtOrBelow(path, node.path)
    )
  const folderArchiveUnavailable = folderHasUnarchivableDocuments
  const folderDeleteUnavailable =
    node.isFolder &&
    folderDeleteUnavailablePaths.some((path) =>
      documentPathIsAtOrBelow(path, node.path)
    )
  const exactDocumentArchived = (docEntry?.archived ?? node.archived) === true
  const archived = node.isFolder ? folderArchived : exactDocumentArchived
  const [open, setOpenState] = useState(containsCurrent || isActive)
  const [renameOpen, setRenameOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const userCollapsedNodeRef = useRef(false)

  useEffect(() => {
    if (
      (containsCurrent || isActive) &&
      !open &&
      !userCollapsedNodeRef.current
    ) {
      setOpenState(true)
    }
    if (!containsCurrent && !isActive) {
      userCollapsedNodeRef.current = false
    }
  }, [containsCurrent, isActive, open])

  const handleToggleNode = (nextOpen: boolean) => {
    if (!nextOpen && (containsCurrent || isActive)) {
      userCollapsedNodeRef.current = true
    }
    setOpenState(nextOpen)
  }

  const handleNavigate = () => {
    if (isMobile) setOpen(false)
  }

  const handleRename = async (newPath: string) => {
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
      if (isActive || containsCurrent) {
        const oldOpenPath = `${node.path}${currentPath.slice(documentFullPath.length)}`
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
      const navigateAfterDelete =
        (node.isFolder && (isActive || containsCurrent)) ||
        (!node.isFolder && currentPath === documentFullPath)
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
    try {
      await archiveDocumentFolder(spaceId, node.path)
      await Promise.all([onRefresh(), onWidgetRefresh(currentWidgetUnderNode)])
      toast.success("Folder archived")
    } catch (error) {
      toast.error(folderLifecycleError(error, "Failed to archive folder"))
    }
  }

  const handleRestoreFolder = async () => {
    try {
      await restoreDocumentFolder(spaceId, node.path)
      await Promise.all([onRefresh(), onWidgetRefresh(currentWidgetUnderNode)])
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
                  {node.kind === "conflict" ? (
                    <AlertTriangle className="size-4 shrink-0 text-sidebar-foreground/40" />
                  ) : (
                    <Folder className="size-4 shrink-0 text-sidebar-primary/60" />
                  )}
                  <span className="truncate">{node.label}</span>
                  {/* A path can be both a doc and a folder; keep its stale signal visible. */}
                  {!archived && node.freshness?.stale && (
                    <span
                      className="ml-auto size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
                      title={staleTitle(node.freshness)}
                    />
                  )}
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
                {!archived && node.freshness?.stale && (
                  <span
                    className="ml-auto size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
                    title={staleTitle(node.freshness)}
                  />
                )}
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
                  currentPath={currentPath}
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
                  currentPath={currentPath}
                  depth={depth + 1}
                  onNewDoc={onNewDoc}
                  onNavigate={onNavigate}
                  onRefresh={onRefresh}
                  onWidgetRefresh={onWidgetRefresh}
                  docs={docs}
                  widgets={widgets}
                  folderMoveUnavailablePaths={folderMoveUnavailablePaths}
                  folderArchiveUnavailablePaths={folderArchiveUnavailablePaths}
                  folderDeleteUnavailablePaths={folderDeleteUnavailablePaths}
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
          onClick={handleNavigate}
          draggable={false}
          className={`flex min-h-10 min-w-0 flex-1 items-center gap-2 px-3 py-2 text-sm sm:min-h-0 ${
            isActive
              ? "font-medium text-sidebar-primary"
              : "text-sidebar-item-foreground"
          }`}
        >
          {node.format?.id === "worktable.quickdraw" ? (
            <Pencil
              className={`size-4 shrink-0 ${isActive ? "text-sidebar-primary" : "text-sidebar-foreground/30"}`}
            />
          ) : node.format?.id === "worktable.markdown" ? (
            <File
              className={`size-4 shrink-0 ${isActive ? "text-sidebar-primary" : "text-sidebar-foreground/30"}`}
            />
          ) : (
            <FileText
              className={`size-4 shrink-0 ${isActive ? "text-sidebar-primary" : "text-sidebar-foreground/30"}`}
            />
          )}
          <span className="truncate">{node.label}</span>
          {!archived && node.freshness?.stale && (
            <span
              className="ml-auto size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
              title={staleTitle(node.freshness)}
            />
          )}
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

export function AppSidebar() {
  const { data: spaces, isLoading: spacesLoading } = useSpaces()
  const currentPath = useRouterState({
    select: (s) => s.location.pathname,
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
  const currentSpaceId = currentPath.match(/^\/spaces\/([^/]+)/)?.[1] ?? null

  // Active group filter (persisted in localStorage)
  const [activeGroup, setActiveGroup] = useState<string | null>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
  })

  const handleGroupChange = (group: string | null) => {
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
  }

  // Auto-switch group when navigating to a space in a different group.
  // Only triggers on path changes (not manual group switches) by tracking
  // the previous path. This prevents the effect from fighting the user
  // when they switch groups while viewing a doc in the old group.
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
      handleGroupChange(space.group)
    }
  }, [currentPath, spaces, activeGroup])

  // Subscribe to space events on the first available space to detect new spaces
  const firstSpaceId = spaces?.[0]?.id
  const { subscribe: subscribeSpaceEvents } = useSpaceEvents(firstSpaceId)

  useEffect(() => {
    const unsub = subscribeSpaceEvents((msg) => {
      // space_update covers settings changes (e.g. manual doc order) written
      // by another client — the watcher emits it when space.json changes.
      if (msg.type === "spaces_changed" || msg.type === "space_update") {
        void queryClient.invalidateQueries({ queryKey: queryKeys.spaces })
      }
    })
    return unsub
  }, [subscribeSpaceEvents, queryClient])

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
      await queryClient.invalidateQueries({ queryKey: queryKeys.spaces })
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
            <SidebarSearchResults
              ref={searchResultsRef}
              query={searchQuery}
              currentPath={currentPath}
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
                currentPath === "/"
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
              className={`mx-1 mb-3 flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-all duration-180 ${
                currentPath.startsWith("/threads")
                  ? "bg-sidebar-accent font-medium text-sidebar-primary"
                  : "text-sidebar-item-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground"
              }`}
            >
              <MessageCircle className="size-4 shrink-0" />
              <span>Threads</span>
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
                      <SpaceSectionWithViews
                        key={space.id}
                        space={space}
                        currentPath={currentPath}
                      />
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
                          <SpaceSectionWithViews
                            key={space.id}
                            space={space}
                            currentPath={currentPath}
                          />
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

// ── Space section adapter ─────────────────

function SpaceSectionWithViews({
  space,
  currentPath,
}: {
  space: SpaceFile & { widgets?: WidgetFile[] }
  currentPath: string
}) {
  return (
    <SpaceSection
      space={space}
      widgets={space.widgets ?? []}
      currentPath={currentPath}
    />
  )
}
