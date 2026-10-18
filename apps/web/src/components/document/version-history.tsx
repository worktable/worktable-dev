import { useState, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Bookmark,
  ChevronDown,
  ChevronUp,
  ChevronsLeft,
  ChevronsRight,
  History,
  RotateCcw,
  Save,
  X,
} from "lucide-react"
import type { ActivityActor, DocumentProvenance } from "@worktable/types"
import { sourceCategory } from "@worktable/types/doc-source"
import { Button } from "@worktable/ui/components/button"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@worktable/ui/components/drawer"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"
import {
  ContextPanelHeader,
  DesktopContextPanel,
} from "@/components/desktop-context-panel"
import { RelativeTime } from "@/lib/time"
import { ActorBadge } from "@/components/home/activity-feed"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { clockTime, groupByDay } from "@/lib/activity-format"
import {
  createDocCheckpoint,
  listDocVersions,
  restoreDocVersion,
  type DocVersionEntry,
} from "@/lib/docs-api"
import { useSpace, useWorkspace } from "@/lib/queries"
import { browserTeamMemberId } from "@/lib/team-context"
import {
  createWidgetCheckpoint,
  listWidgetVersions,
  restoreWidgetVersion,
} from "@/lib/widgets-api"

import { versionHistoryKeys, type HistoryKind } from "@/lib/version-history"

interface HistoryLocation {
  kind: HistoryKind
  spaceId: string
  path: string
  revision: string
}

function listKey(
  { kind, spaceId, path, revision }: HistoryLocation,
  all = false
) {
  return versionHistoryKeys.list(kind, spaceId, path, revision, all)
}

function savedVersion(version: DocVersionEntry): boolean {
  return (
    version.checkpoint?.kind === "manual" ||
    version.checkpoint?.kind === "review"
  )
}

function versionLabel(version: DocVersionEntry): string {
  if (
    version.checkpoint?.label &&
    version.checkpoint.label !== "Manual Checkpoint"
  )
    return version.checkpoint.label
  if (savedVersion(version)) return "Saved version"
  if (version.source === "version-restore") return "Restored version"
  return version.operation === "create" ? "Created document" : "Edited document"
}

/** Resolve stored author references through the same directory as activity. */
function useVersionIdentity(
  version?: Pick<DocVersionEntry, "createdBy" | "source" | "checkpoint">,
  currentActor?: ActivityActor
) {
  const { data: workspace } = useWorkspace()
  const raw = version?.createdBy ?? ""
  const id = currentActor?.id ?? (raw.startsWith("agent:") ? raw.slice(6) : raw)
  const localPerson = !browserTeamMemberId() && ["user", "human"].includes(id)
  const resolvedId = localPerson ? "local:owner" : id
  const presentation = workspace?.presentations?.[resolvedId]
  const category =
    version?.checkpoint?.sourceCategory ?? sourceCategory(version?.source, raw)
  const kind =
    currentActor?.kind ??
    (localPerson || category === "human" || presentation?.id !== undefined
      ? "person"
      : raw.startsWith("agent:") ||
          category === "agent" ||
          // Presentations retain agents that are no longer Thread recipients.
          presentation !== undefined
        ? "agent"
        : "system")
  const name =
    presentation?.name ??
    currentActor?.name ??
    (kind === "agent"
      ? "An agent"
      : category === "external"
        ? "Files"
        : localPerson
          ? workspace?.person?.name
          : "Unknown author")
  const actor: ActivityActor = { kind, id: resolvedId || "unknown", name }
  const own =
    kind === "person" &&
    (localPerson ||
      (presentation?.id ?? resolvedId) === workspace?.person?.id ||
      resolvedId === browserTeamMemberId())
  return { actor, label: own ? "You" : (name ?? "Unknown author") }
}

function VersionRow({
  version,
  current,
  currentActor,
  provenance,
  active,
  onSelect,
}: {
  version?: DocVersionEntry
  current?: boolean
  currentActor?: ActivityActor
  provenance?: DocumentProvenance
  active: boolean
  onSelect: () => void
}) {
  const identity = useVersionIdentity(
    version ??
      (provenance
        ? { createdBy: provenance.updatedBy, source: provenance.source }
        : undefined),
    currentActor
  )
  const at = current ? provenance?.updatedAt : version?.createdAt
  const saved = version && savedVersion(version)
  const label = current ? "Current version" : versionLabel(version!)
  const reason =
    version?.source !== "version-restore" &&
    version?.reason !== label &&
    version?.reason !== "Manual checkpoint"
      ? version?.reason
      : undefined
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        active && "bg-surface-selected"
      )}
    >
      <ActorBadge actor={identity.actor} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {current ? label : saved ? label : identity.label}
          </span>
          {at && (
            <time
              dateTime={at}
              title={new Date(at).toLocaleString()}
              className="shrink-0 text-xs text-muted-foreground tabular-nums"
            >
              {clockTime(at)}
            </time>
          )}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-xs leading-5 text-muted-foreground">
          {saved && <Bookmark className="size-3 shrink-0" aria-hidden="true" />}
          {current || saved ? identity.label : label}
        </span>
        {reason && (
          <span className="mt-1 line-clamp-2 block text-xs leading-5 text-muted-foreground">
            {reason}
          </span>
        )}
      </span>
    </button>
  )
}

export function VersionHistoryPanel({
  kind,
  spaceId,
  path,
  revision,
  open,
  drawerMode,
  canEdit: canEditDocument,
  selectedVersionId,
  currentActor,
  provenance,
  onSelect,
  onClose,
}: HistoryLocation & {
  open: boolean
  drawerMode: boolean
  canEdit: boolean
  selectedVersionId: string | null
  currentActor?: ActivityActor
  provenance?: DocumentProvenance
  onSelect: (id: string | null) => void
  onClose: () => void
}) {
  const location = { kind, spaceId, path, revision }
  const queryClient = useQueryClient()
  const { data: space } = useSpace(spaceId)
  const canEdit =
    canEditDocument && Boolean(space && space.space.permissions?.edit !== false)
  const [filter, setFilter] = useState<"all" | "saved">("saved")
  const [collapsed, setCollapsed] = useState(false)
  const [saving, setSaving] = useState(false)
  const scrollRef = useScrollFade<HTMLDivElement>()
  const versions = useQuery({
    queryKey: listKey(location, filter === "all"),
    queryFn: () =>
      kind === "doc"
        ? listDocVersions(spaceId, path, filter === "all")
        : listWidgetVersions(spaceId, path, filter === "all"),
    enabled: open,
    staleTime: Infinity,
  })
  const entries = (versions.data ?? []).filter((version, index) => {
    const currentSnapshot =
      index === 0 &&
      version.after.contentHash === provenance?.contentHash &&
      !savedVersion(version)
    return !currentSnapshot
  })
  const selectedIndex = entries.findIndex(
    (version) => version.id === selectedVersionId
  )
  const groups = groupByDay(
    entries.map((version) => ({ ...version, at: version.createdAt }))
  )
  const saveVersion = async () => {
    if (saving) return
    setSaving(true)
    try {
      await (kind === "doc"
        ? createDocCheckpoint(spaceId, path)
        : createWidgetCheckpoint(spaceId, path))
      toast.success("Version saved")
      await Promise.all(
        [false, true].map((all) =>
          queryClient.invalidateQueries({
            queryKey: listKey(location, all),
            exact: true,
          })
        )
      )
    } catch {
      toast.error("Couldn’t save this version")
    } finally {
      setSaving(false)
    }
  }
  const content = (
    <aside
      aria-label="Version history"
      className="flex h-full min-h-0 flex-col"
    >
      <ContextPanelHeader
        title="Version history"
        icon={<History className="size-4 shrink-0 text-primary" />}
        actions={
          <>
            {selectedVersionId && !drawerMode && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Collapse version history"
                onClick={() => setCollapsed(true)}
              >
                <ChevronsRight className="size-4" />
              </Button>
            )}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Close version history"
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          </>
        }
      />
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 pb-2">
        <div className="flex gap-1" role="group" aria-label="Filter versions">
          <Button
            size="xs"
            variant={filter === "all" ? "secondary" : "ghost"}
            aria-pressed={filter === "all"}
            onClick={() => setFilter("all")}
          >
            All versions
          </Button>
          <Button
            size="xs"
            variant={filter === "saved" ? "secondary" : "ghost"}
            aria-pressed={filter === "saved"}
            onClick={() => setFilter("saved")}
          >
            Saved
          </Button>
        </div>
        {canEdit && (
          <Button
            size="xs"
            variant="outline"
            disabled={saving}
            onClick={() => void saveVersion()}
          >
            <Save className="size-3.5" />
            {saving ? "Saving…" : "Save version"}
          </Button>
        )}
      </div>
      <div
        ref={scrollRef}
        className="scroll-fade min-h-0 flex-1 overflow-y-auto px-2 pb-3"
      >
        <VersionRow
          current
          currentActor={currentActor}
          provenance={provenance}
          active={!selectedVersionId}
          onSelect={() => onSelect(null)}
        />
        {versions.isPending ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            Loading versions…
          </p>
        ) : versions.isError ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            Couldn’t load versions.{" "}
            <button
              type="button"
              className="text-primary-text hover:underline"
              onClick={() => void versions.refetch()}
            >
              Try again
            </button>
          </p>
        ) : entries.length === 0 ? (
          <p className="px-3 py-4 text-sm leading-6 text-muted-foreground">
            {filter === "saved"
              ? "No saved versions yet. Save a version to keep this point in the document."
              : "Saved versions will appear here as you edit."}
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <h3 className="px-3 pt-4 pb-1 text-xs font-medium text-muted-foreground">
                {group.label}
              </h3>
              {group.items.map((version) => (
                <VersionRow
                  key={version.id}
                  version={version}
                  active={version.id === selectedVersionId}
                  onSelect={() => onSelect(version.id)}
                />
              ))}
            </section>
          ))
        )}
      </div>
    </aside>
  )
  return (
    <>
      {drawerMode ? (
        <Drawer
          open={open}
          onOpenChange={(value) => {
            if (!value) onClose()
          }}
          repositionInputs={false}
        >
          <DrawerContent className="data-[vaul-drawer-direction=bottom]:h-[86dvh]">
            <DrawerTitle className="sr-only">Version history</DrawerTitle>
            <DrawerDescription className="sr-only">
              Saved versions of this document.
            </DrawerDescription>
            <div className="flex min-h-0 flex-1 flex-col">{content}</div>
          </DrawerContent>
        </Drawer>
      ) : (
        <DesktopContextPanel
          open={open}
          width={collapsed && selectedVersionId ? 48 : 384}
        >
          {collapsed && selectedVersionId ? (
            <aside
              aria-label="Version history"
              className="flex h-full flex-col items-center gap-2 py-4"
            >
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Expand version history"
                onClick={() => setCollapsed(false)}
              >
                <ChevronsLeft className="size-4" />
              </Button>
              <div className="flex flex-1 items-center [writing-mode:vertical-rl]">
                <span className="text-xs text-muted-foreground">
                  Version history
                </span>
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Older version"
                disabled={
                  selectedIndex < 0 || selectedIndex >= entries.length - 1
                }
                onClick={() => onSelect(entries[selectedIndex + 1].id)}
              >
                <ChevronUp className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Newer version"
                disabled={selectedIndex <= 0}
                onClick={() => onSelect(entries[selectedIndex - 1].id)}
              >
                <ChevronDown className="size-4" />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Close version history"
                onClick={onClose}
              >
                <X className="size-4" />
              </Button>
            </aside>
          ) : (
            content
          )}
        </DesktopContextPanel>
      )}
    </>
  )
}

function RestoreVersionButton({
  kind,
  spaceId,
  path,
  revision,
  version,
  onRestored,
  inline = false,
  canEdit,
}: HistoryLocation & {
  version: DocVersionEntry
  onRestored: () => void
  inline?: boolean
  canEdit: boolean
}) {
  const { data: space } = useSpace(spaceId)
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  if (!canEdit || !space || space.space.permissions?.edit === false) return null
  return (
    <>
      <Button
        size={inline ? "xs" : "sm"}
        className={inline ? "h-9 xl:h-7" : undefined}
        variant="outline"
        onClick={() => setConfirming(true)}
      >
        Restore
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Restore this version?"
        description="This version will become the current document."
        confirmLabel="Restore"
        loading={restoring}
        icon={<RotateCcw className="size-5 text-primary" />}
        onConfirm={async () => {
          setRestoring(true)
          try {
            await (kind === "doc"
              ? restoreDocVersion(spaceId, path, version.id)
              : restoreWidgetVersion(spaceId, path, version.id))
            setConfirming(false)
            toast.success("Version restored")
            onRestored()
            await Promise.all(
              [false, true].map((all) =>
                queryClient.invalidateQueries({
                  queryKey: listKey({ kind, spaceId, path, revision }, all),
                  exact: true,
                })
              )
            )
          } catch {
            toast.error("Couldn’t restore this version")
          } finally {
            setRestoring(false)
          }
        }}
      >
        <p className="text-sm text-muted-foreground">
          Your current version will be saved first, so you can return to it.
        </p>
      </ConfirmDialog>
    </>
  )
}

export function VersionPreview({
  kind,
  spaceId,
  path,
  revision,
  version,
  error,
  onRetry,
  onBack,
  onHistory,
  onRestored,
  canEdit,
  children,
}: HistoryLocation & {
  version?: DocVersionEntry
  error: boolean
  onRetry: () => void
  onBack: () => void
  onHistory: () => void
  onRestored: () => void
  canEdit: boolean
  children: ReactNode | ((byline: ReactNode) => ReactNode)
}) {
  const identity = useVersionIdentity(version)
  const inline = typeof children === "function"
  const controls = (
    <div className="flex shrink-0 items-center gap-1">
      <Button
        size="icon-sm"
        variant="ghost"
        className={cn("xl:hidden", inline && "size-9")}
        aria-label="Choose version"
        onClick={onHistory}
      >
        <History className="size-4" />
      </Button>
      {version && (
        <RestoreVersionButton
          kind={kind}
          spaceId={spaceId}
          path={path}
          revision={revision}
          version={version}
          onRestored={onRestored}
          inline={inline}
          canEdit={canEdit}
        />
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        className={inline ? "size-9 xl:size-7" : undefined}
        aria-label="Exit compare"
        onClick={onBack}
      >
        <X className="size-4" />
      </Button>
    </div>
  )
  const byline = (
    <div className="worktable-doc-byline" data-doc-byline>
      <div className="flex min-h-7 items-center justify-between gap-2">
        {version && (
          <span
            className="inline-flex h-7 min-w-0 items-center gap-2"
            title={`${versionLabel(version)} · ${new Date(version.createdAt).toLocaleString()}`}
          >
            <ActorBadge actor={identity.actor} />
            <span className="truncate">
              {identity.label} saved <RelativeTime iso={version.createdAt} />
            </span>
          </span>
        )}
        {controls}
      </div>
    </div>
  )
  return (
    <section
      aria-label="Version preview"
      className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface-inset xl:flex-[1_1_50%] print:hidden"
    >
      {!inline && (
        <header className="flex shrink-0 items-center justify-between gap-3 px-6 pt-4 pb-2 text-xs">
          <div className="min-w-0">
            <h2 className="truncate font-medium text-foreground">
              {version
                ? versionLabel(version)
                : error
                  ? "Version unavailable"
                  : "Loading version…"}
            </h2>
            {version && (
              <p className="truncate text-muted-foreground">
                {identity.label} ·{" "}
                {new Date(version.createdAt).toLocaleString()}
              </p>
            )}
          </div>
          {controls}
        </header>
      )}
      {error ? (
        <div className="space-y-3 px-6 py-8 text-sm text-muted-foreground">
          <p>
            Couldn’t load this version.{" "}
            <button
              className="text-primary-text hover:underline"
              type="button"
              onClick={onRetry}
            >
              Try again
            </button>
          </p>
          {inline && controls}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          {typeof children === "function" ? children(byline) : children}
        </div>
      )}
    </section>
  )
}
