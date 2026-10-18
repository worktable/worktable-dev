import { useState, type ReactNode } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Bookmark, History, RotateCcw, X } from "lucide-react"
import {
  sourceCategory,
  type ActivityActor,
  type DocumentProvenance,
} from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@worktable/ui/components/drawer"
import { Input } from "@worktable/ui/components/input"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"
import { DesktopContextPanel } from "@/components/desktop-context-panel"
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
import { useThreadParticipants } from "@/lib/threads-queries"
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

function listKey({ kind, spaceId, path, revision }: HistoryLocation) {
  return versionHistoryKeys.list(kind, spaceId, path, revision)
}

function namedVersion(version: DocVersionEntry): boolean {
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
  if (namedVersion(version)) return "Saved version"
  if (version.source === "version-restore") return "Restored version"
  return version.operation === "create" ? "Created document" : "Edited document"
}

/** Resolve stored author references through the same directory as activity. */
function useVersionIdentity(
  version?: Pick<DocVersionEntry, "createdBy" | "source" | "checkpoint">,
  currentActor?: ActivityActor
) {
  const { data: directory } = useThreadParticipants()
  const { data: workspace } = useWorkspace()
  const raw = version?.createdBy ?? ""
  const id = currentActor?.id ?? (raw.startsWith("agent:") ? raw.slice(6) : raw)
  const localPerson = !browserTeamMemberId() && ["user", "human"].includes(id)
  const resolvedId = localPerson ? "local:owner" : id
  const presentation = directory?.presentations?.[resolvedId]
  const participant = directory?.participants.find(
    (person) => person.id === (presentation?.id ?? resolvedId)
  )
  const category =
    version?.checkpoint?.sourceCategory ?? sourceCategory(version?.source, raw)
  const kind =
    currentActor?.kind ??
    (localPerson ||
    category === "human" ||
    participant?.kind === "human" ||
    (presentation?.id !== undefined &&
      presentation.id === workspace?.person?.id)
      ? "person"
      : raw.startsWith("agent:") ||
          category === "agent" ||
          participant?.kind === "agent"
        ? "agent"
        : "system")
  const name =
    presentation?.name ??
    participant?.name ??
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
  const named = version && namedVersion(version)
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
            {current ? label : named ? label : identity.label}
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
          {named && <Bookmark className="size-3 shrink-0" aria-hidden="true" />}
          {current || named ? identity.label : label}
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
  selectedVersionId,
  currentActor,
  provenance,
  onSelect,
  onClose,
}: HistoryLocation & {
  open: boolean
  drawerMode: boolean
  selectedVersionId: string | null
  currentActor?: ActivityActor
  provenance?: DocumentProvenance
  onSelect: (id: string | null) => void
  onClose: () => void
}) {
  const location = { kind, spaceId, path, revision }
  const queryClient = useQueryClient()
  const { data: space } = useSpace(spaceId)
  const canEdit = Boolean(space && space.space.permissions?.edit !== false)
  const [filter, setFilter] = useState<"all" | "named">("all")
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState("")
  const [saving, setSaving] = useState(false)
  const scrollRef = useScrollFade<HTMLDivElement>()
  const versions = useQuery({
    queryKey: listKey(location),
    queryFn: () =>
      kind === "doc"
        ? listDocVersions(spaceId, path, true)
        : listWidgetVersions(spaceId, path, true),
    enabled: open,
    staleTime: Infinity,
  })
  const entries = (versions.data ?? []).filter((version, index) => {
    const currentSnapshot =
      index === 0 &&
      version.after.contentHash === provenance?.contentHash &&
      !namedVersion(version)
    return !currentSnapshot && (filter === "all" || namedVersion(version))
  })
  const groups = groupByDay(
    entries.map((version) => ({ ...version, at: version.createdAt }))
  )
  const saveNamedVersion = async () => {
    if (saving || !name.trim()) return
    setSaving(true)
    try {
      await (kind === "doc"
        ? createDocCheckpoint(spaceId, path, name.trim())
        : createWidgetCheckpoint(spaceId, path, name.trim()))
      setNaming(false)
      toast.success("Version named")
      await queryClient.invalidateQueries({
        queryKey: listKey(location),
        exact: true,
      })
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
      <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-4 pb-3">
        <h2 className="text-sm font-medium text-foreground">Version history</h2>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Close version history"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 pb-3">
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
            variant={filter === "named" ? "secondary" : "ghost"}
            aria-pressed={filter === "named"}
            onClick={() => setFilter("named")}
          >
            Named
          </Button>
        </div>
        {canEdit && (
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setName("")
              setNaming(true)
            }}
          >
            <Bookmark className="size-3.5" />
            Name version
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
            {filter === "named"
              ? "No named versions yet. Name the current version to mark a moment you want to keep."
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
        <DesktopContextPanel open={open} width={384}>
          {content}
        </DesktopContextPanel>
      )}
      <ResponsiveDialog open={naming} onOpenChange={setNaming}>
        <ResponsiveDialogContent>
          <ResponsiveDialogHeader>
            <ResponsiveDialogTitle>Name current version</ResponsiveDialogTitle>
            <ResponsiveDialogDescription>
              Keep a named version you can return to later.
            </ResponsiveDialogDescription>
          </ResponsiveDialogHeader>
          <ResponsiveDialogBody>
            <label className="space-y-2 text-sm font-medium">
              <span>Name</span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ready for review"
                disabled={saving}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    void saveNamedVersion()
                  }
                }}
              />
            </label>
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button
              variant="outline"
              disabled={saving}
              onClick={() => setNaming(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={saving || !name.trim()}
              onClick={saveNamedVersion}
            >
              {saving ? "Saving…" : "Save version"}
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
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
}: HistoryLocation & { version: DocVersionEntry; onRestored: () => void }) {
  const { data: space } = useSpace(spaceId)
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [restoring, setRestoring] = useState(false)
  if (!space || space.space.permissions?.edit === false) return null
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
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
            await queryClient.invalidateQueries({
              queryKey: listKey({ kind, spaceId, path, revision }),
              exact: true,
            })
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
  children,
}: HistoryLocation & {
  version?: DocVersionEntry
  error: boolean
  onRetry: () => void
  onBack: () => void
  onHistory: () => void
  onRestored: () => void
  children: ReactNode
}) {
  const identity = useVersionIdentity(version)
  return (
    <section
      aria-label="Version preview"
      className="flex min-w-0 flex-1 flex-col overflow-hidden print:hidden"
    >
      <header className="shrink-0 border-b border-border px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button size="sm" variant="ghost" onClick={onBack}>
            <ArrowLeft className="size-4" />
            Back to current
          </Button>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              className="xl:hidden"
              onClick={onHistory}
            >
              <History className="size-4" />
              History
            </Button>
            {version && (
              <RestoreVersionButton
                kind={kind}
                spaceId={spaceId}
                path={path}
                revision={revision}
                version={version}
                onRestored={onRestored}
              />
            )}
          </div>
        </div>
        <div className="mt-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-medium text-foreground">
              {version
                ? versionLabel(version)
                : error
                  ? "Version unavailable"
                  : "Loading version…"}
            </h2>
            {version && (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {identity.label} ·{" "}
                {new Date(version.createdAt).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </p>
            )}
          </div>
          <span className="shrink-0 rounded-full bg-surface-tint px-2 py-1 text-xs text-muted-foreground">
            Read only
          </span>
        </div>
      </header>
      {error ? (
        <p className="px-6 py-8 text-sm text-muted-foreground">
          Couldn’t load this version.{" "}
          <button
            className="text-primary-text hover:underline"
            type="button"
            onClick={onRetry}
          >
            Try again
          </button>
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      )}
    </section>
  )
}
