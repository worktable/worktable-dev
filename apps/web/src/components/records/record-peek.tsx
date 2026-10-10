import { useRef, useState } from "react"
import { Archive, ChevronDown, ChevronLeft, ChevronRight, Copy, FileText, Hash, Info, Loader2, Maximize2, MoreVertical, ExternalLink, RotateCcw, SearchX, Trash, X } from "lucide-react"
import { Link } from "@tanstack/react-router"
import { Badge } from "@worktable/ui/components/badge"
import { Button, buttonVariants } from "@worktable/ui/components/button"
import { Card, CardContent } from "@worktable/ui/components/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@worktable/ui/components/collapsible"
import { ResizeHandle } from "@worktable/ui/components/resize-handle"
import { useResizable } from "@worktable/ui/hooks/use-resizable"
import { cn } from "@worktable/ui/lib/utils"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@worktable/ui/components/drawer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import type { RecordCollectionSchema, RecordFile } from "@worktable/types"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { DesktopContextPanel } from "@/components/desktop-context-panel"
import {
  coerceFieldInput,
  isSafeHttpUrl,
  columnLabel,
  fieldEditorSeed,
  recordActorName,
  recordDetailSections,
  recordTitle,
  INLINE_EDITABLE_TYPES,
  type RecordFieldColumn,
} from "@/lib/records"
import { RelativeTime } from "@/lib/time"
import { useActivityAgents } from "@/lib/activity"
import { copyText } from "@/lib/clipboard"
import { toast } from "@worktable/ui/components/sonner"
import { FieldValue, type ExpandedRecords } from "./field-value"
import { Popover, PopoverTrigger } from "@worktable/ui/components/popover"
import { DocumentPicker, JsonEditor, MultiSelectEditor, RelationPicker, SelectEditor, TextishEditor, BooleanEditor, FieldEditorScope, FieldPopoverContent, fieldSurfaceClass, fieldSurfaceRestingClass } from "./field-editor"

/** Types the peek can edit: the grid's inline set plus its own richer
 *  editors. A whitelist, not a blocklist — a field type from a NEWER
 *  Worktable must stay display-only here, never fall through to a text
 *  input that would PATCH an arbitrary string into data this build does
 *  not understand. */
const PEEK_EDITABLE_TYPES = new Set([...INLINE_EDITABLE_TYPES, "relation", "document", "json"])

export interface RecordPeekActions {
  onCommitField: (recordId: string, key: string, value: unknown) => Promise<void>
  onDuplicate: (record: RecordFile) => void
  onArchive: (recordId: string) => void
  onRestore: (recordId: string) => void
  /** Opens the route-level confirm dialog; the route owns the actual delete. */
  onDelete: (recordId: string) => void
}

export interface RecordPeekNavigation {
  position: number
  total: number
  onPrevious?: () => void
  onNext?: () => void
}

/**
 * Record detail and editor: a right rail on wide desktop, a bottom drawer below xl
 * (same coexistence pattern as the widget annotations rail). Every field is
 * editable in place; relations get a search picker, json an explicit-save
 * text editor.
 */
export function RecordPeek({
  spaceId,
  schema,
  record,
  missing = false,
  expanded,
  danglingByRecordField,
  actions,
  navigation,
  open,
  drawerMode,
  onClose,
}: {
  spaceId: string
  schema: RecordCollectionSchema | undefined
  record: RecordFile | undefined
  /** The fallback point read failed: the deep-linked record does not exist. */
  missing?: boolean
  expanded?: ExpandedRecords
  /** `recordId:field` → dangling `collection/recordId` targets, same map the grid uses. */
  danglingByRecordField?: ReadonlyMap<string, ReadonlySet<string>>
  actions: RecordPeekActions
  navigation?: RecordPeekNavigation
  open: boolean
  drawerMode: boolean
  onClose: () => void
}) {
  const [drawerContainer, setDrawerContainer] = useState<HTMLDivElement | null>(null)
  const railResize = useResizable({
    edge: "left",
    defaultSize: 500,
    minSize: 360,
    maxSize: 720,
    storageKey: "worktable-record-detail-width-v2",
  })
  const body = record ? (
    <RecordDetailBody
      key={record.id}
      spaceId={spaceId}
      schema={schema}
      record={record}
      expanded={expanded}
      danglingByRecordField={danglingByRecordField}
      actions={actions}
      navigation={navigation}
      onClose={onClose}
    />
  ) : (
    <PeekPlaceholder missing={missing} onClose={onClose} />
  )

  if (drawerMode) {
    return (
      <Drawer open={open} onOpenChange={(o) => !o && onClose()} repositionInputs={false}>
        <DrawerContent
          ref={setDrawerContainer}
          className="data-[vaul-drawer-direction=bottom]:max-h-[86dvh]"
          onEscapeKeyDown={(event) => {
            // Vaul handles Escape in capture, before a field can cancel its draft.
            const target = event.target
            if ((target instanceof Element && target.closest("input, textarea")) || drawerContainer?.querySelector('[data-slot="popover-content"][data-open]')) event.preventDefault()
          }}
        >
          <DrawerTitle className="sr-only">Record details</DrawerTitle>
          <DrawerDescription className="sr-only">Fields and provenance for this record.</DrawerDescription>
          <FieldEditorScope container={drawerContainer}><div className="flex max-h-[calc(86dvh-1.5rem)] min-h-0 flex-col">{body}</div></FieldEditorScope>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
    <DesktopContextPanel
      open={open}
      width={railResize.size}
      resizing={railResize.isResizing}
      resizeHandle={
        open ? (
          <ResizeHandle
            {...railResize.handleProps}
            className="-left-1"
            aria-label="Resize record details"
          />
        ) : null
      }
    >
      <div className="h-full">{body}</div>
    </DesktopContextPanel>
  )
}

function PeekPlaceholder({ missing, onClose }: { missing: boolean; onClose: () => void }) {
  return (
    <div className="flex h-full min-h-40 flex-col">
      <div className="flex shrink-0 justify-end px-4 pt-4">
        <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close record details">
          <X className="size-4" />
        </Button>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 pb-8 text-center text-sm text-muted-foreground">
        {missing ? (
          <>
            <SearchX className="size-6 text-muted-foreground/60" />
            <p>This record no longer exists.</p>
          </>
        ) : (
          <>
            <Loader2 className="size-5 animate-spin text-muted-foreground/60" />
            <p>Loading record…</p>
          </>
        )}
      </div>
    </div>
  )
}

export function RecordDetailBody({
  spaceId,
  schema,
  record,
  expanded,
  danglingByRecordField,
  actions,
  navigation,
  surface = "rail",
  onClose,
}: {
  spaceId: string
  schema: RecordCollectionSchema | undefined
  record: RecordFile
  expanded?: ExpandedRecords
  danglingByRecordField?: ReadonlyMap<string, ReadonlySet<string>>
  actions: RecordPeekActions
  navigation?: RecordPeekNavigation
  surface?: "rail" | "page"
  onClose: () => void
}) {
  const [moreOpen, setMoreOpen] = useState(false)
  const scrollRef = useScrollFade<HTMLDivElement>()
  const sections = recordDetailSections(schema, record)
  const archived = Boolean(record.archive)
  const moreCount = sections.unmodeled.length
  const { data: agentData } = useActivityAgents()
  const agents = agentData?.agents

  const narrativeContent = sections.narrative.length > 0 ? (
    <section aria-label="Overview">
      <dl className="space-y-6">
        {sections.narrative.map((column) => (
          <PeekFieldRow
            key={`${record.id}:${column.key}`}
            spaceId={spaceId}
            column={column}
            record={record}
            expanded={expanded}
            danglingTargets={danglingByRecordField?.get(`${record.id}:${column.key}`)}
            onCommitField={actions.onCommitField}
            editingEnabled
            layout="narrative"
          />
        ))}
      </dl>
    </section>
  ) : null

  const propertiesContent = sections.properties.length > 0 ? (
    <DetailCard title="Properties">
      {sections.properties.map((column) => (
        <PeekFieldRow
          key={`${record.id}:${column.key}`}
          spaceId={spaceId}
          column={column}
          record={record}
          expanded={expanded}
          danglingTargets={danglingByRecordField?.get(`${record.id}:${column.key}`)}
          onCommitField={actions.onCommitField}
          editingEnabled
        />
      ))}
    </DetailCard>
  ) : null

  const sourcesContent = sections.sources.length > 0 ? (
    <DetailCard title="Sources" description="Documents connected to this record" icon={<FileText className="size-4 text-primary-text" />}>
      {sections.sources.map((column) => (
        <PeekFieldRow
          key={`${record.id}:${column.key}`}
          spaceId={spaceId}
          column={column}
          record={record}
          expanded={expanded}
          onCommitField={actions.onCommitField}
          editingEnabled
        />
      ))}
    </DetailCard>
  ) : null

  // Fields in the file that the schema does not describe stay readable but
  // out of the way; every schema field is shown above.
  const moreContent = moreCount > 0 ? (
    <Collapsible open={moreOpen} onOpenChange={setMoreOpen}>
      <Card className="gap-0 py-0">
        <CollapsibleTrigger className="flex min-h-12 w-full items-center gap-3 rounded-xl px-4 py-3 text-left outline-none transition-colors hover:bg-muted/30 focus-visible:ring-3 focus-visible:ring-ring/50">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground">Other fields</span>
            <span className="block text-xs text-muted-foreground">Not in this collection’s schema</span>
          </span>
          <Badge variant="outline" className="font-mono text-[10px]">{moreCount}</Badge>
          <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", moreOpen && "rotate-180")} />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="px-0 pb-1">
            <dl className="divide-y divide-border/60 border-t border-border/60">
              {sections.unmodeled.map((column) => (
                <PeekFieldRow
                  key={`${record.id}:${column.key}`}
                  spaceId={spaceId}
                  column={column}
                  record={record}
                  expanded={expanded}
                  onCommitField={actions.onCommitField}
                  editingEnabled={false}
                />
              ))}
            </dl>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  ) : null

  const provenanceContent = (
    <Card className="gap-0 bg-muted/15 py-0">
      <CardContent className="space-y-3 px-4 py-4 text-xs text-muted-foreground">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <Info className="size-4 text-accent-bronze-ink" />
          Record information
        </div>
        <ProvenanceRow label="Created" by={recordActorName(record.createdBy, agents)} at={record.createdAt} />
        <ProvenanceRow label="Updated" by={recordActorName(record.updatedBy ?? record.createdBy, agents)} at={record.updatedAt} />
      </CardContent>
    </Card>
  )

  const header = (
    <RecordDetailHeader
      spaceId={spaceId}
      record={record}
      schema={schema}
      actions={actions}
      archived={archived}
      titleColumn={sections.title ?? undefined}
      navigation={navigation}
      surface={surface}
      onClose={onClose}
    />
  )

  const archiveNotice = archived && record.archive ? (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/25 px-3.5 py-3 text-xs text-muted-foreground">
      <Archive className="size-3.5 shrink-0 text-accent-bronze-ink" />
      <span>
        Archived <RelativeTime iso={record.archive.archivedAt} />
      </span>
    </div>
  ) : null

  if (surface === "page") {
    // Long-form and document fields take the main column with properties
    // alongside; without them, properties are the page.
    const hasMain = Boolean(narrativeContent || sourcesContent)
    return (
      <div className="min-h-full">
        {header}
        {hasMain ? (
          <div className="grid gap-8 px-5 pb-12 sm:px-8 lg:grid-cols-[minmax(0,1fr)_21rem] lg:px-10 xl:gap-12">
            <div className="min-w-0 space-y-8">
              {archiveNotice}
              {narrativeContent}
              {sourcesContent}
            </div>
            <aside className="min-w-0 space-y-4 lg:sticky lg:top-6 lg:self-start">
              {propertiesContent}
              {moreContent}
              {provenanceContent}
            </aside>
          </div>
        ) : (
          <div className="max-w-3xl space-y-4 px-5 pb-12 sm:px-8 lg:px-10">
            {archiveNotice}
            {propertiesContent}
            {moreContent}
            {provenanceContent}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {header}
      <div ref={scrollRef} className="scroll-fade min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-px">
        <div className="space-y-6">
          {archiveNotice}
          {narrativeContent}
          {propertiesContent}
          {sourcesContent}
          {moreContent}
          {provenanceContent}
          {!narrativeContent && !propertiesContent && !sourcesContent && moreCount === 0 && <p className="text-sm text-muted-foreground">No fields.</p>}
        </div>
      </div>
    </div>
  )
}

function RecordDetailHeader({
  spaceId,
  schema,
  record,
  actions,
  archived,
  titleColumn,
  navigation,
  surface,
  onClose,
}: {
  spaceId: string
  schema: RecordCollectionSchema | undefined
  record: RecordFile
  actions: RecordPeekActions
  archived: boolean
  titleColumn?: RecordFieldColumn
  navigation?: RecordPeekNavigation
  surface: "rail" | "page"
  onClose: () => void
}) {
  return (
    <header className={cn("shrink-0", surface === "page" ? "px-5 pb-8 pt-6 sm:px-8 lg:px-10" : "px-4 pb-6 pt-3")}>
      <div className="mb-5 flex min-h-9 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-1">
          {navigation ? (
            <>
              <Button variant="ghost" size="icon-sm" onClick={navigation.onPrevious} disabled={!navigation.onPrevious} aria-label="Previous record">
                <ChevronLeft className="size-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={navigation.onNext} disabled={!navigation.onNext} aria-label="Next record">
                <ChevronRight className="size-4" />
              </Button>
              <span className="ml-1 whitespace-nowrap font-mono text-[11px] text-muted-foreground">{navigation.position} of {navigation.total}</span>
            </>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {surface === "rail" && (
            <Button nativeButton={false} variant="ghost" size="sm" render={<Link to="/spaces/$spaceId/records/$collectionId/$recordId" params={{ spaceId, collectionId: record.collectionId, recordId: record.id }} />} aria-label="Open full record page">
              <Maximize2 className="size-4" />
              Open
            </Button>
          )}
          <RecordActionsMenu record={record} actions={actions} archived={archived} />
          {surface === "rail" && (
            <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close record details">
              <X className="size-4" />
            </Button>
          )}
        </div>
      </div>

      <div className={cn("max-w-3xl", surface === "page" && "pt-2")}>
        <div className={cn("font-display text-[1.8rem] leading-[1.08] tracking-[-0.02em] text-foreground", surface === "page" && "text-4xl sm:text-5xl")}>
          {titleColumn ? <DetailFieldValue spaceId={spaceId} column={titleColumn} record={record} onCommitField={actions.onCommitField} editingEnabled title /> : <h1>{recordTitle(record, schema)}</h1>}
        </div>
      </div>
    </header>
  )
}

function RecordActionsMenu({ record, actions, archived }: { record: RecordFile; actions: RecordPeekActions; archived: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Record actions" />}>
        <MoreVertical className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuItem
          onClick={() => {
            void copyText(record.id).then(
              () => toast.success("Copied record ID"),
              () => toast.error("Couldn’t copy the record ID. Try again."),
            )
          }}
        >
          <Hash className="mr-2 size-4" />
          Copy Record ID
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => actions.onDuplicate(record)}>
          <Copy className="mr-2 size-4" />
          Duplicate
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => (archived ? actions.onRestore(record.id) : actions.onArchive(record.id))}>
          {archived ? <RotateCcw className="mr-2 size-4" /> : <Archive className="mr-2 size-4" />}
          {archived ? "Restore" : "Archive"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => actions.onDelete(record.id)}>
          <Trash className="mr-2 size-4" />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DetailCard({ title, description, icon, children }: { title: string; description?: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-2 px-4 pb-2 pt-4">
        {icon && <span className="mt-0.5">{icon}</span>}
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
      </div>
      <CardContent className="px-0 pb-1"><dl className="divide-y divide-border/60">{children}</dl></CardContent>
    </Card>
  )
}

/** One editable field row: click the value to edit. Editor choice mirrors the
 *  grid cells, plus the peek-only editors (Textarea for text, relation picker,
 *  explicit-save json). Unknown types stay read-only. */
function PeekFieldRow({
  spaceId,
  column,
  record,
  expanded,
  danglingTargets,
  onCommitField,
  editingEnabled,
  layout = "property",
}: {
  spaceId: string
  column: RecordFieldColumn
  record: RecordFile
  expanded?: ExpandedRecords
  danglingTargets?: ReadonlySet<string>
  onCommitField: (recordId: string, key: string, value: unknown) => Promise<void>
  editingEnabled: boolean
  layout?: "property" | "narrative"
}) {
  return (
    <div className={cn("min-w-0", layout === "narrative" ? "px-1" : "grid grid-cols-[minmax(6.5rem,0.38fr)_minmax(0,1fr)] items-start gap-4 px-4 py-3")}>
      <dt
        className={cn(
          "min-w-0 text-muted-foreground",
          layout === "narrative"
            ? "mb-2 text-[11px] font-medium uppercase tracking-[0.11em]"
            : "pt-0.5 text-xs leading-5"
        )}
        title={column.type === "unknown" ? "Unmodeled field" : `${columnLabel(column)} · ${column.type}`}
      >
        <span className="truncate">{columnLabel(column)}</span>
      </dt>
      <dd
        className={cn(
          "min-w-0 text-foreground",
          layout === "narrative" ? "text-[15px] leading-7" : "text-sm leading-6",
        )}
      >
        <DetailFieldValue spaceId={spaceId} column={column} record={record} expanded={expanded} danglingTargets={danglingTargets} onCommitField={onCommitField} editingEnabled={editingEnabled} />
      </dd>
    </div>
  )
}

function DetailFieldValue({
  spaceId,
  column,
  record,
  expanded,
  danglingTargets,
  onCommitField,
  editingEnabled,
  title = false,
}: {
  spaceId: string
  column: RecordFieldColumn
  record: RecordFile
  expanded?: ExpandedRecords
  danglingTargets?: ReadonlySet<string>
  onCommitField: (recordId: string, key: string, value: unknown) => Promise<void>
  editingEnabled: boolean
  title?: boolean
}) {
  const [editing, setEditing] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const value = record.data[column.key]
  const done = (restoreFocus = false) => {
    setEditing(false)
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const editable = editingEnabled && PEEK_EDITABLE_TYPES.has(column.type)

  const commitRaw = async (raw: unknown) => {
    const { value: next, error } = coerceFieldInput(column, raw)
    if (error) throw new Error(error)
    if (JSON.stringify(next) === JSON.stringify(value ?? null)) return
    await onCommitField(record.id, column.key, next)
  }

  const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)
  const display = title && !empty ? <span className="whitespace-pre-wrap break-words">{String(value)}</span> : empty && editable ? <span className="text-muted-foreground">{title ? "Add title…" : "Add…"}</span> : (
    <FieldValue
      column={column}
      value={value}
      spaceId={spaceId}
      expanded={expanded}
      danglingTargets={danglingTargets}
      linksDisabled={editable}
      mode="detail"
    />
  )

  const valueBody = (() => {
    if (!editable) return display

    if (column.type === "boolean") {
      return <BooleanEditor column={column} value={value} onCommit={commitRaw}>{display}</BooleanEditor>
    }
    if (column.type === "relation") {
      return (
        <RelationPicker spaceId={spaceId} column={column} value={value} open={editing} onOpenChange={setEditing} onCommit={commitRaw}>
          {display}
        </RelationPicker>
      )
    }
    if (column.type === "document") {
      return (
        <DocumentPicker spaceId={spaceId} column={column} value={value} open={editing} onOpenChange={setEditing} onCommit={commitRaw}>
          {display}
        </DocumentPicker>
      )
    }
    if (column.type === "select" && column.field?.values?.length) {
      return (
        <SelectEditor column={column} value={value} open={editing} onOpenChange={setEditing} onCommit={commitRaw}>
          {display}
        </SelectEditor>
      )
    }
    if (column.type === "multi_select" && column.field?.values?.length) {
      return (
        <MultiSelectEditor column={column} value={value} open={editing} onOpenChange={setEditing} onCommit={commitRaw}>
          {display}
        </MultiSelectEditor>
      )
    }
    if (column.type === "json" && editing) {
      return <JsonEditor initial={value} onCommit={commitRaw} onDone={() => done(true)} />
    }
    // Text-like (string/number/date/datetime/url/email/person and optionless
    // selects). The editor takes the resting value's exact box, so starting
    // to edit only reveals the field edge; `text` keeps line breaks.
    if (editing) {
      return (
        <TextishEditor
          column={column}
          initial={fieldEditorSeed(column, value)}
          onCommit={commitRaw}
          onDone={done}
          multiline={column.type === "text"}
        />
      )
    }
    return (
      <button ref={triggerRef} type="button" className={cn(fieldSurfaceClass, fieldSurfaceRestingClass, "cursor-text")} onClick={() => setEditing(true)} aria-label={`Edit ${column.key}`}>
        {display}
      </button>
    )
  })()

  if (title) return editing ? valueBody : <h1 aria-label={empty ? "Untitled record" : String(value)}>{valueBody}</h1>

  return <div className="flex min-w-0 items-start gap-3">
    <div className="min-w-0 flex-1">{valueBody}</div>
    {editable && !empty && column.type === "url" && isSafeHttpUrl(String(value)) && <a className={cn(buttonVariants({ size: "icon-xs", variant: "ghost" }), "-my-1")} href={String(value)} target="_blank" rel="noopener noreferrer" aria-label={`Open ${columnLabel(column)}`}><ExternalLink className="size-3.5" /></a>}
    {editable && !empty && column.type === "email" && <a className={cn(buttonVariants({ size: "icon-xs", variant: "ghost" }), "-my-1")} href={`mailto:${String(value)}`} aria-label={`Email ${String(value)}`}><ExternalLink className="size-3.5" /></a>}
    {editable && !empty && ["document", "relation"].includes(column.type) && <Popover>
      <PopoverTrigger render={<Button size="icon-xs" variant="ghost" className="-my-1" aria-label={`Open ${columnLabel(column)}`} />}><ExternalLink className="size-3.5" /></PopoverTrigger>
      <FieldPopoverContent align="end" aria-label={`Open ${columnLabel(column)}`}><FieldValue column={column} value={value} spaceId={spaceId} expanded={expanded} danglingTargets={danglingTargets} mode="detail" /></FieldPopoverContent>
    </Popover>}
  </div>
}

function ProvenanceRow({ label, by, at }: { label: string; by: string; at: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>
        {label} by <span className="text-foreground/80">{by}</span>
      </span>
      <RelativeTime iso={at} />
    </div>
  )
}
