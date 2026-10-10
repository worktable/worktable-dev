import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Check, Loader2, Plus, Search, X } from "lucide-react"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import { Textarea } from "@worktable/ui/components/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@worktable/ui/components/popover"
import { cn } from "@worktable/ui/lib/utils"
import { useQuery } from "@tanstack/react-query"
import { documentReferenceFallbackTitle, type RecordFile } from "@worktable/types"
import { queryKeys } from "@/lib/queries"
import { queryRecords } from "@/lib/records-api"
import { documentPathIsSelected, fieldEditorSeed, normalizeDocumentPickerSearch, optionColorClass, recordTitle, relationIds, toggleDocumentPath, type RecordFieldColumn } from "@/lib/records"
import { documentReferencesQueryOptions, useSpaceDocs } from "@/lib/docs-queries"

// Keep nested pickers within a modal drawer's focus and accessibility boundary.
const FieldPortalContext = createContext<HTMLElement | null | undefined>(undefined)

export function FieldEditorScope({ container, children }: { container: HTMLElement | null; children: React.ReactNode }) {
  return <FieldPortalContext.Provider value={container}>{children}</FieldPortalContext.Provider>
}

export function FieldPopoverContent(props: React.ComponentProps<typeof PopoverContent>) {
  const container = useContext(FieldPortalContext)
  return <PopoverContent {...props} container={container} />
}

/** A commit resolves only after persistence; rejection keeps the local draft. */
type FieldCommit<T = unknown> = (raw: T) => void | Promise<void>

function useFieldSave<T>(onCommit: FieldCommit<T>, open?: boolean) {
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const errorId = useId()
  useEffect(() => { setError(undefined) }, [open])
  const save = async (raw: T) => {
    if (busy.current) return false
    busy.current = true
    setPending(true)
    setError(undefined)
    try {
      await onCommit(raw)
      return true
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save this value.")
      return false
    } finally {
      busy.current = false
      setPending(false)
    }
  }
  return { save, pending, error, errorId }
}

function SaveFeedback({ state, onRetry }: { state: Pick<ReturnType<typeof useFieldSave>, "pending" | "error" | "errorId">; onRetry?: () => void }) {
  if (state.pending) return <span role="status" className="text-xs text-muted-foreground">Saving…</span>
  if (!state.error) return null
  return <div className="space-y-1">
    <p id={state.errorId} role="alert" className="text-xs text-destructive">{state.error}</p>
    {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}
  </div>
}

/** Errors only: text drafts show pending inside the field, so a save never
 *  pushes the surrounding layout down and back. */
function SaveError({ state, onRetry }: { state: Pick<ReturnType<typeof useFieldSave>, "error" | "errorId">; onRetry?: () => void }) {
  if (!state.error) return null
  return <div className="mt-1 space-y-1">
    <p id={state.errorId} role="alert" className="text-xs text-destructive">{state.error}</p>
    {onRetry && <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>}
  </div>
}

/**
 * One box for a value at rest and while editing. The border is always there
 * (transparent at rest) and the negative margins cancel the padding, so the
 * text sits where unboxed values do and editing only reveals the field edge.
 * Sizes derive from the text's own line height (`lh`), so padding stays even
 * around one line in the grid, the panel, and the title alike. Touch screens
 * grow the box to a 44px target symmetrically, leaving the text in place.
 */
export const fieldSurfaceClass = "-mx-2 my-[-4px] w-[calc(100%+1rem)] min-w-0 rounded-md border px-[7px] py-[3px] text-left outline-none max-sm:my-[min(-4px,calc((1lh-2.75rem)/2))] max-sm:py-[max(3px,calc((2.75rem-1lh-2px)/2))]"
/** Resting, editable value: the field hover from the design system, centered
 *  so chips and single lines sit in the middle of the box. */
export const fieldSurfaceRestingClass = "flex min-h-[calc(1lh+8px)] items-center border-transparent transition-colors hover:border-(--input-hover) hover:bg-(--well-hover-bg) focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11"
/** One quiet edge, not a border plus halo: the value is already in place, so
 *  the field only needs to say it is live. */
const fieldSurfaceEditingClass = "relative border-ring bg-(--well-bg) has-[[aria-invalid=true]]:border-destructive"

const pickerTriggerClass = cn(fieldSurfaceClass, fieldSurfaceRestingClass, "cursor-pointer")

/** Types whose editor is a single-line native input: they need its picker or
 *  keyboard. Everything else edits in a wrapping textarea. */
const NATIVE_INPUT_TYPES = new Set(["number", "date", "datetime"])

/**
 * Text draft control. Borderless and transparent, it inherits the
 * surrounding type, so it occupies exactly the text it replaces; the
 * enclosing field surface draws the edge. Text grows with its content.
 */
function DraftControl({ column, value, onValueChange, multiline, state, ...props }: {
  column: RecordFieldColumn
  value: string
  onValueChange: (value: string) => void
  multiline: boolean
  state: Pick<ReturnType<typeof useFieldSave>, "pending" | "error" | "errorId">
  onKeyDown: (event: React.KeyboardEvent) => void
  onBlur?: (event: React.FocusEvent) => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const element = textareaRef.current
    if (!element) return
    const fit = () => {
      element.style.height = "auto"
      // Whole lines: tight display leading lets glyphs overhang the line box,
      // which would otherwise make the field taller than the text it replaces.
      const line = parseFloat(getComputedStyle(element).lineHeight)
      element.style.height = `${Number.isFinite(line) ? Math.max(1, Math.round(element.scrollHeight / line)) * line : element.scrollHeight}px`
    }
    fit()
    // Popover widths settle after the first layout; refit when they do.
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [value])
  const shared = {
    autoFocus: true,
    value,
    readOnly: state.pending,
    "aria-label": `Edit ${column.key}`,
    "aria-invalid": Boolean(state.error),
    "aria-describedby": state.error ? state.errorId : undefined,
    ...props,
  }
  const bare = "block w-full min-w-0 border-0 bg-transparent p-0 font-[inherit] text-[length:inherit] leading-[inherit] tracking-[inherit] text-inherit outline-none placeholder:text-muted-foreground"
  if (NATIVE_INPUT_TYPES.has(column.type)) {
    return <input
      {...shared}
      type={inputTypeFor(column.type)}
      inputMode={column.type === "number" ? "decimal" : undefined}
      onChange={(event) => onValueChange(event.target.value)}
      className={cn(bare, "h-[1lh]", column.type === "number" && "font-mono text-[13px] tabular-nums")}
    />
  }
  return <textarea
    {...shared}
    ref={textareaRef}
    rows={1}
    inputMode={column.type === "email" ? "email" : column.type === "url" ? "url" : undefined}
    // Start at the end of the text, where a click on the value lands the eye.
    onFocus={(event) => event.currentTarget.setSelectionRange(event.currentTarget.value.length, event.currentTarget.value.length)}
    // Single-line fields keep pasted line breaks out, as an input would.
    onChange={(event) => onValueChange(multiline ? event.target.value : event.target.value.replace(/\r?\n/g, " "))}
    className={cn(bare, "max-h-80 min-h-[1lh] resize-none overflow-y-auto")}
  />
}

function draftKeyAction(event: React.KeyboardEvent, multiline: boolean): "commit" | "cancel" | undefined {
  if (event.nativeEvent.isComposing) return undefined
  if (event.key === "Escape") return "cancel"
  if (event.key === "Enter" && (!multiline || event.metaKey || event.ctrlKey)) return "commit"
  return undefined
}

function PendingMark({ pending }: { pending: boolean }) {
  if (!pending) return null
  return <>
    <span role="status" className="sr-only">Saving…</span>
    <Loader2 aria-hidden className="pointer-events-none absolute right-1.5 top-1.5 size-3.5 animate-spin text-muted-foreground" />
  </>
}

/**
 * Shared editors for record field values, used by the grid's inline cells and
 * the peek panel. Every editor commits through `onCommit(raw)` — coercion and
 * the PATCH happen in the caller — and closes via `onDone`.
 */

/** In-place text editor for detail surfaces. It replaces a resting value
 *  drawn with `fieldSurfaceClass`, so nothing moves when editing starts.
 *  Enter commits short text; multiline uses Cmd/Ctrl+Enter. Escape cancels.
 *  Blur saves, but failed validation or persistence leaves the draft available. */
export function TextishEditor({ column, initial, onCommit, onDone, multiline = false }: {
  column: RecordFieldColumn
  initial: unknown
  onCommit: FieldCommit<string>
  onDone: (restoreFocus?: boolean) => void
  multiline?: boolean
}) {
  const [value, setValue] = useState(initial === undefined || initial === null ? "" : String(initial))
  const settled = useRef(false)
  const editorRef = useRef<HTMLDivElement>(null)
  const state = useFieldSave(onCommit)
  const settle = async (commit: boolean, restoreFocus = false) => {
    if (settled.current || state.pending) return
    settled.current = true
    if (!commit || await state.save(value)) onDone(restoreFocus && Boolean(editorRef.current?.contains(document.activeElement)))
    else settled.current = false
  }
  return <div ref={editorRef} className="min-w-0" aria-busy={state.pending} onClick={(event) => event.stopPropagation()}>
    <div className={cn(fieldSurfaceClass, fieldSurfaceEditingClass)}>
      <DraftControl
        column={column}
        value={value}
        onValueChange={setValue}
        multiline={multiline}
        state={state}
        onKeyDown={(event) => {
          const action = draftKeyAction(event, multiline)
          if (!action) return
          event.preventDefault()
          event.stopPropagation()
          void settle(action === "commit", true)
        }}
        onBlur={(event) => {
          if (!editorRef.current?.contains(event.relatedTarget as Node | null)) void settle(true)
        }}
      />
      <PendingMark pending={state.pending} />
    </div>
    <SaveError state={state} onRetry={() => void settle(true, true)} />
  </div>
}

/**
 * Grid text editor: the value opens in a field laid over its cell, wide
 * enough to read and growing downward with the text. The draft starts where
 * the cell text sits, so only the field edge and extra lines appear.
 * Clicking away saves; Escape cancels; Tab saves and moves to the next cell.
 */
export function CellTextEditor({ column, value, open, onOpenChange, onCommit, children }: {
  column: RecordFieldColumn
  value: unknown
  open: boolean
  onOpenChange: (open: boolean) => void
  onCommit: FieldCommit<string>
  children: React.ReactNode
}) {
  const multiline = column.type === "text"
  const seed = fieldEditorSeed(column, value)
  const [draft, setDraft] = useState(seed === undefined || seed === null ? "" : String(seed))
  const state = useFieldSave(onCommit, open)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const nextFocus = useRef<HTMLElement | null>(null)
  const [width, setWidth] = useState<number>()
  useEffect(() => {
    if (open) {
      setDraft(seed === undefined || seed === null ? "" : String(seed))
      nextFocus.current = null
      // Widen to a readable measure, but only into the room to the right:
      // shifting the field left would move the text away from the cell.
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect) setWidth(Math.max(rect.width, Math.min(320, window.innerWidth - rect.left - 8)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reseed only when opening
  }, [open])
  const close = async (commit: boolean) => {
    if (state.pending) return
    if (commit && !await state.save(draft)) return
    onOpenChange(false)
  }
  const aimFocus = (step: 1 | -1) => {
    const trigger = triggerRef.current
    const triggers = [...(trigger?.closest("tr")?.querySelectorAll<HTMLElement>("[data-field-editor]") ?? [])]
    nextFocus.current = trigger ? (triggers[triggers.indexOf(trigger) + step] ?? null) : null
  }
  return (
    <Popover open={open} onOpenChange={(next, details) => { if (next) onOpenChange(true); else void close(details?.reason !== "escape-key") }}>
      <PopoverTrigger ref={triggerRef} data-field-editor="" className={cn(fieldSurfaceClass, fieldSurfaceRestingClass, "cursor-text data-popup-open:*:invisible")} aria-label={`Edit ${column.key}`} onClick={(event) => event.stopPropagation()}>
        {children}
      </PopoverTrigger>
      <FieldPopoverContent
        align="start"
        sideOffset={({ anchor }) => -anchor.height}
        finalFocus={() => nextFocus.current ?? true}
        aria-busy={state.pending}
        style={{ width }}
        className="w-auto gap-0 rounded-md p-0 data-open:animate-none data-closed:animate-none"
        onClick={(event) => event.stopPropagation()}
      >
        {/* The edge sits over the popup's own border, keeping the text exactly
            where the cell drew it. */}
        <div className="relative -m-px min-h-[calc(1lh+8px)] rounded-md border border-ring px-[7px] py-[3px] has-[[aria-invalid=true]]:border-destructive max-sm:py-[max(3px,calc((2.75rem-1lh-2px)/2))]">
          <DraftControl
            column={column}
            value={draft}
            onValueChange={setDraft}
            multiline={multiline}
            state={state}
            onKeyDown={(event) => {
              if (event.key === "Tab" && !event.nativeEvent.isComposing) {
                event.preventDefault()
                aimFocus(event.shiftKey ? -1 : 1)
                void close(true)
                return
              }
              const action = draftKeyAction(event, multiline)
              if (!action) return
              event.preventDefault()
              event.stopPropagation()
              void close(action === "commit")
            }}
          />
          <PendingMark pending={state.pending} />
        </div>
        {state.error && <div className="border-t border-border/60 px-2 pb-2"><SaveError state={state} onRetry={() => void close(true)} /></div>}
      </FieldPopoverContent>
    </Popover>
  )
}

function inputTypeFor(type: string): string {
  switch (type) {
    case "number":
      return "number"
    case "date":
      return "date"
    case "datetime":
      return "datetime-local"
    case "email":
      return "email"
    case "url":
      return "url"
    default:
      return "text"
  }
}

/** Option list for select fields (popover: portaled, opaque per the design
 *  system). Optionless select fields edit as free text instead. */
export function SelectEditor({
  column,
  value,
  open,
  onOpenChange,
  onCommit,
  children,
}: {
  column: RecordFieldColumn
  value: unknown
  open: boolean
  onOpenChange: (open: boolean) => void
  onCommit: FieldCommit<string | null>
  children: React.ReactNode
}) {
  const options = column.field?.values ?? []
  const state = useFieldSave(onCommit, open)
  const pick = async (next: string | null) => {
    if (await state.save(next)) onOpenChange(false)
  }
  return (
    <Popover open={open} onOpenChange={(next) => { if (!state.pending) onOpenChange(next) }}>
      <PopoverTrigger data-field-editor="" className={pickerTriggerClass} aria-label={`Edit ${column.key}`} onClick={(event) => event.stopPropagation()}>
        {children}
      </PopoverTrigger>
      <FieldPopoverContent align="start" className="w-56 gap-0.5 p-1.5" onClick={(e) => e.stopPropagation()}>
        <fieldset disabled={state.pending} className="contents">
          {options.map((option) => {
            const active = value === option
            return (
              <button
                key={option}
                aria-pressed={active}
                type="button"
                className="flex min-h-8 w-full items-center gap-2 rounded-md max-sm:min-h-11 px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50"
                onClick={() => {
                  void pick(active && !column.field?.required ? null : option)
                }}
              >
                <span className={`size-1.5 shrink-0 rounded-full ${optionColorClass(option)}`} />
                <span className="min-w-0 flex-1 truncate">{option}</span>
                {active && <Check className="size-3.5 shrink-0 text-primary" />}
              </button>
            )
          })}
          {!column.field?.required && value !== undefined && value !== null && value !== "" && (
            <button
              type="button"
              className="flex min-h-8 w-full items-center gap-2 rounded-md max-sm:min-h-11 px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50"
              onClick={() => {
                void pick(null)
              }}
            >
              <X className="size-3.5 shrink-0" />
              Clear
            </button>
          )}
        </fieldset>
        <SaveFeedback state={state} />
      </FieldPopoverContent>
    </Popover>
  )
}

/** Toggle chips for multi_select fields. Toggles build a LOCAL draft; the
 *  field commits once when the popover closes — per-toggle PATCHes would race
 *  each other (an earlier full-array write landing after a later one). */
export function MultiSelectEditor({
  column,
  value,
  open,
  onOpenChange,
  onCommit,
  children,
}: {
  column: RecordFieldColumn
  value: unknown
  open: boolean
  onOpenChange: (open: boolean) => void
  onCommit: FieldCommit<string[]>
  children: React.ReactNode
}) {
  const options = column.field?.values ?? []
  const committed = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
  const [draft, setDraft] = useState<string[]>(committed)
  const state = useFieldSave(onCommit, open)
  useEffect(() => {
    if (open) setDraft(committed)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reseed only when opening
  }, [open])

  const handleOpenChange = async (next: boolean, details?: { reason: string }) => {
    if (state.pending) return
    if (!next && details?.reason !== "escape-key" && !sameStringSet(draft, committed)) {
      if (!await state.save(draft)) return
    }
    onOpenChange(next)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger data-field-editor="" className={pickerTriggerClass} aria-label={`Edit ${column.key}`} onClick={(event) => event.stopPropagation()}>
        {children}
      </PopoverTrigger>
      <FieldPopoverContent align="start" className="w-56 gap-0.5 p-1.5" onClick={(e) => e.stopPropagation()}>
        <fieldset disabled={state.pending} className="contents">
          {options.map((option) => {
            const active = draft.includes(option)
            return (
              <button
                key={option}
                aria-pressed={active}
                type="button"
                className="flex min-h-8 w-full items-center gap-2 rounded-md max-sm:min-h-11 px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50"
                onClick={() => setDraft(active ? draft.filter((entry) => entry !== option) : [...draft, option])}
              >
                <span className={`size-1.5 shrink-0 rounded-full ${optionColorClass(option)}`} />
                <span className="min-w-0 flex-1 truncate">{option}</span>
                {active && <Check className="size-3.5 shrink-0 text-primary" />}
              </button>
            )
          })}
        </fieldset>
        <SaveFeedback state={state} onRetry={() => void handleOpenChange(false)} />
      </FieldPopoverContent>
    </Popover>
  )
}

function sameStringSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry === b[i])
}

/**
 * Relation picker: searches the target collection (FTS via the query API)
 * and sets/toggles record ids. Single relations close on pick; many-relations
 * stay open for multi-select.
 */
export function RelationPicker({
  spaceId,
  column,
  value,
  open,
  onOpenChange,
  onCommit,
  children,
}: {
  spaceId: string
  column: RecordFieldColumn
  value: unknown
  open: boolean
  onOpenChange: (open: boolean) => void
  onCommit: FieldCommit<string[] | string | null>
  children: React.ReactNode
}) {
  const target = column.field?.references
  const many = column.field?.many ?? false
  const committed = relationIds(value)
  // Many-relations build a local draft and commit once on close: per-toggle
  // PATCHes of the full id array would race each other in flight.
  const [draft, setDraft] = useState<string[]>(committed)
  const state = useFieldSave(onCommit, open)
  const [search, setSearch] = useState("")
  useEffect(() => {
    if (open) {
      setSearch("")
      setDraft(relationIds(value))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reseed only when opening
  }, [open])
  const selected = many ? draft : committed

  const { data, isLoading } = useQuery({
    queryKey: [...queryKeys.records(spaceId, target ?? ""), "picker", search],
    queryFn: () =>
      queryRecords(spaceId, target ?? "", {
        ...(search.trim() ? { search: search.trim() } : {}),
        limit: 20,
      }),
    enabled: open && Boolean(target),
    staleTime: 15_000,
  })
  const candidates = useMemo(() => data?.records ?? [], [data])

  const pick = async (record: RecordFile) => {
    if (many) {
      setDraft(selected.includes(record.id) ? selected.filter((id) => id !== record.id) : [...selected, record.id])
    } else {
      if (await state.save(selected[0] === record.id && !column.field?.required ? null : record.id)) onOpenChange(false)
    }
  }

  const resultsRef = useScrollFade<HTMLDivElement>()

  const handleOpenChange = async (next: boolean, details?: { reason: string }) => {
    if (state.pending) return
    if (!next && details?.reason !== "escape-key" && many && !sameStringSet(draft, committed)) {
      if (!await state.save(draft)) return
    }
    onOpenChange(next)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger data-field-editor="" className={pickerTriggerClass} aria-label={`Edit ${column.key}`} onClick={(event) => event.stopPropagation()}>
        {children}
      </PopoverTrigger>
      <FieldPopoverContent align="start" className="w-72 gap-1.5 p-1.5" onClick={(e) => e.stopPropagation()}>
        <fieldset disabled={state.pending} className="contents">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              autoFocus
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={target ? `Search ${target}…` : "No target collection"}
              className="h-8 pl-8 text-sm"
              disabled={!target}
            />
          </div>
          <div ref={resultsRef} className="scroll-fade max-h-64 overflow-y-auto">
            {isLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="size-4 animate-spin text-muted-foreground/60" />
              </div>
            ) : candidates.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                {target ? "No matching records." : "This relation has no target collection in its schema."}
              </p>
            ) : (
              candidates.map((record) => {
                const active = selected.includes(record.id)
                return (
                  <button
                    key={record.id}
                    aria-pressed={active}
                    type="button"
                    className="flex min-h-8 w-full items-center gap-2 rounded-md max-sm:min-h-11 px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50"
                    onClick={() => pick(record)}
                  >
                    <span className={`size-1.5 shrink-0 rounded-full ${active ? "bronze-knob" : "bg-muted-foreground/30"}`} />
                    <span className="min-w-0 flex-1 truncate">{recordTitle(record)}</span>
                    {active && <Check className="size-3.5 shrink-0 text-primary" />}
                  </button>
                )
              })
            )}
          </div>
          {selected.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="justify-start text-muted-foreground"
              onClick={() => {
                if (many) {
                  setDraft([])
                } else {
                  void state.save(null).then((saved) => { if (saved) onOpenChange(false) })
                }
              }}
            >
              <X className="mr-1.5 size-3.5" />
              Clear
            </Button>
          )}
        </fieldset>
        <SaveFeedback state={state} onRetry={many ? () => void handleOpenChange(false) : undefined} />
      </FieldPopoverContent>
    </Popover>
  )
}

/** Same-space document picker with title/path search and a portable free-path
 * fallback. Many fields keep a draft and commit once when the popover closes. */
export function DocumentPicker({
  spaceId,
  column,
  value,
  open,
  onOpenChange,
  onCommit,
  children,
}: {
  spaceId: string
  column: RecordFieldColumn
  value: unknown
  open: boolean
  onOpenChange: (open: boolean) => void
  onCommit: FieldCommit<string[] | string | null>
  children: React.ReactNode
}) {
  const many = column.field?.many ?? false
  const committed = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
  const [draft, setDraft] = useState<string[]>(committed)
  const state = useFieldSave(onCommit, open)
  const [search, setSearch] = useState("")
  const { data: docs = [], isLoading: docsLoading } = useSpaceDocs(spaceId)
  const { data: committedReferences, isLoading: committedReferencesLoading } = useQuery(documentReferencesQueryOptions(spaceId, committed))
  const committedIdentities = useMemo(
    () => new Map(committedReferences?.map((reference) => [reference.storedPath, reference.resolvedPath ?? reference.storedPath]) ?? []),
    [committedReferences]
  )
  const scrollRef = useScrollFade<HTMLDivElement>()
  useEffect(() => {
    if (!open) return
    setDraft(committed)
    setSearch("")
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reseed only on open
  }, [open])
  const { fallbackPath, normalizedSearch } = normalizeDocumentPickerSearch(search)
  const candidates = docs
    .filter((doc) => {
      const title = doc.headings?.[0] || documentReferenceFallbackTitle(doc.path)
      return !normalizedSearch || doc.path.toLocaleLowerCase().includes(normalizedSearch) || title.toLocaleLowerCase().includes(normalizedSearch)
    })
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 40)
  const pick = async (path: string) => {
    if (many) {
      setDraft(toggleDocumentPath(draft, path, committedIdentities))
    }
    else {
      if (await state.save(documentPathIsSelected(committed, path, committedIdentities) && !column.field?.required ? null : path)) onOpenChange(false)
    }
  }
  const handleOpenChange = async (next: boolean, details?: { reason: string }) => {
    if (state.pending) return
    if (!next && details?.reason !== "escape-key" && many && !sameStringSet(draft, committed)) {
      if (!await state.save(draft)) return
    }
    onOpenChange(next)
  }
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger data-field-editor="" className={pickerTriggerClass} aria-label={`Edit ${column.key}`} onClick={(event) => event.stopPropagation()}>
        {children}
      </PopoverTrigger>
      <FieldPopoverContent align="start" className="w-80 gap-1.5 p-1.5" onClick={(event) => event.stopPropagation()}>
        <fieldset disabled={state.pending} className="contents">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <Input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search documents or enter a path…" className="h-8 pl-8 text-sm" />
          </div>
          <div ref={scrollRef} className="scroll-fade max-h-64 overflow-y-auto">
            {docsLoading || committedReferencesLoading ? <div className="flex justify-center py-6"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div> : candidates.map((doc) => {
              const active = documentPathIsSelected(many ? draft : committed, doc.path, committedIdentities)
              return (
                <button key={doc.path} aria-pressed={active} type="button" className="flex min-h-8 w-full items-center gap-2 rounded-md max-sm:min-h-11 px-2 py-1.5 text-left hover:bg-accent/50" onClick={() => pick(doc.path)}>
                  <span className={`size-1.5 shrink-0 rounded-full ${doc.archived ? "bg-muted-foreground/40" : active ? "bronze-knob" : "bg-primary/50"}`} />
                  <span className="min-w-0 flex-1"><span className="block truncate text-sm">{doc.headings?.[0] || documentReferenceFallbackTitle(doc.path)}</span><span className="block truncate font-mono text-[10px] text-muted-foreground">{doc.path}{doc.archived ? " · archived" : ""}</span></span>
                  {active && <Check className="size-3.5 shrink-0 text-primary" />}
                </button>
              )
            })}
            {fallbackPath && !docs.some((doc) => doc.path === fallbackPath) && (
              <button type="button" className="flex min-h-8 w-full items-center gap-2 rounded-md max-sm:min-h-11 px-2 py-2 text-left hover:bg-accent/50" onClick={() => pick(fallbackPath)}>
                <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0"><span className="block text-sm">Link this path</span><span className="block truncate font-mono text-[10px] text-muted-foreground">{fallbackPath} · target may be missing</span></span>
              </button>
            )}
          </div>
          {(many ? draft : committed).length > 0 && <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={() => many ? setDraft([]) : void state.save(null).then((saved) => { if (saved) onOpenChange(false) })}><X className="mr-1.5 size-3.5" />Clear</Button>}
        </fieldset>
        <SaveFeedback state={state} onRetry={many ? () => void handleOpenChange(false) : undefined} />
      </FieldPopoverContent>
    </Popover>
  )
}

/** Block editor for json values (peek only): textarea with explicit save so a
 *  half-typed structure never commits on blur. */
export function JsonEditor({
  initial,
  onCommit,
  onDone,
}: {
  initial: unknown
  onCommit: FieldCommit<string>
  onDone: () => void
}) {
  const [value, setValue] = useState(() => {
    try {
      return initial === undefined || initial === null ? "" : JSON.stringify(initial, null, 2)
    } catch {
      return String(initial)
    }
  })
  const state = useFieldSave(onCommit)

  return (
    <div className="space-y-1.5">
      <Textarea
        autoFocus
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation()
            if (!state.pending) onDone()
          }
        }}
        className="min-h-24 font-mono text-xs"
        readOnly={state.pending}
        aria-invalid={Boolean(state.error)}
        aria-describedby={state.error ? state.errorId : undefined}
        aria-label="Edit JSON value"
      />
      <SaveFeedback state={state} />
      <div className="flex gap-1.5">
        <Button
          size="sm"
          disabled={state.pending}
          onClick={async () => {
            if (await state.save(value)) onDone()
          }}
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" disabled={state.pending} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

export function BooleanEditor({ column, value, onCommit, children }: { column: RecordFieldColumn; value: unknown; onCommit: (raw: unknown) => Promise<void>; children: React.ReactNode }) {
  const state = useFieldSave(onCommit)
  return <div aria-busy={state.pending}>
    <div className="flex items-start gap-1">
      <button type="button" disabled={state.pending} data-field-editor="" className={cn(pickerTriggerClass, "mr-0 w-auto flex-1")} onClick={() => void state.save(value !== true)} aria-label={`Toggle ${column.key}`} aria-pressed={value == null ? "mixed" : value === true}>{children}</button>
      {!column.field?.required && value != null && <Button size="icon-xs" variant="ghost" className="-my-1" disabled={state.pending} onClick={() => void state.save(null)} aria-label={`Clear ${column.key}`}><X className="size-3" /></Button>}
    </div>
    <SaveError state={state} />
  </div>
}
