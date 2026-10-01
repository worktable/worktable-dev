import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react"
import { Check, Loader2, Plus, Search, X } from "lucide-react"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import { Textarea } from "@worktable/ui/components/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@worktable/ui/components/popover"
import { useQuery } from "@tanstack/react-query"
import { documentReferenceFallbackTitle, type RecordFile } from "@worktable/types"
import { queryKeys } from "@/lib/queries"
import { queryRecords } from "@/lib/records-api"
import { documentPathIsSelected, normalizeDocumentPickerSearch, optionColorClass, recordTitle, relationIds, toggleDocumentPath, type RecordFieldColumn } from "@/lib/records"
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

const pickerTriggerClass = "flex min-h-6 w-full cursor-pointer items-center rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11"

/**
 * Shared editors for record field values, used by the grid's inline cells and
 * the peek panel. Every editor commits through `onCommit(raw)` — coercion and
 * the PATCH happen in the caller — and closes via `onDone`.
 */

/** Enter commits short text; multiline uses Cmd/Ctrl+Enter. Escape cancels.
 * Blur saves, but failed validation or persistence leaves the draft available. */
export function TextishEditor({ column, initial, onCommit, onDone, className, multiline = false }: {
  column: RecordFieldColumn
  initial: unknown
  onCommit: FieldCommit<string>
  onDone: (restoreFocus?: boolean) => void
  className?: string
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
  const shared = {
    autoFocus: true,
    value,
    readOnly: state.pending,
    "aria-label": `Edit ${column.key}`,
    "aria-invalid": Boolean(state.error),
    "aria-describedby": state.error ? state.errorId : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValue(e.target.value),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.nativeEvent.isComposing) return
      if (e.key === "Escape" || (e.key === "Enter" && (!multiline || e.metaKey || e.ctrlKey))) {
        e.preventDefault()
        e.stopPropagation()
        void settle(e.key !== "Escape", true)
      }
    },
    onBlur: (e: React.FocusEvent) => {
      if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null)) void settle(true)
    },
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  }
  return <div ref={editorRef} className="space-y-1" aria-busy={state.pending}>
    {multiline ? <Textarea {...shared} className="min-h-24 text-sm" /> : <Input {...shared} type={inputTypeFor(column.type)} inputMode={column.type === "number" ? "decimal" : undefined} className={className ?? "h-7 px-2 py-0 text-sm"} />}
    <SaveFeedback state={state} onRetry={() => void settle(true, true)} />
  </div>
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
 *  system). Optionless select fields use TextishEditor instead. */
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
      <PopoverTrigger className={pickerTriggerClass} aria-label={`Edit ${column.key}`} onClick={(event) => event.stopPropagation()}>
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
      <PopoverTrigger className={pickerTriggerClass} aria-label={`Edit ${column.key}`} onClick={(event) => event.stopPropagation()}>
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
      <PopoverTrigger className={pickerTriggerClass} aria-label={`Edit ${column.key}`} onClick={(event) => event.stopPropagation()}>
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
      <PopoverTrigger className={pickerTriggerClass} aria-label={`Edit ${column.key}`} onClick={(event) => event.stopPropagation()}>
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

export function TextareaEditor(props: Omit<React.ComponentProps<typeof TextishEditor>, "multiline">) {
  return <TextishEditor {...props} multiline />
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
  return <div className="space-y-1" aria-busy={state.pending}>
    <div className="flex items-center gap-1">
      <button type="button" disabled={state.pending} className="flex min-h-6 flex-1 items-center rounded-md max-sm:min-h-11 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => void state.save(value !== true)} aria-label={`Toggle ${column.key}`} aria-pressed={value == null ? "mixed" : value === true}>{children}</button>
      {!column.field?.required && value != null && <Button size="icon-sm" variant="ghost" disabled={state.pending} onClick={() => void state.save(null)} aria-label={`Clear ${column.key}`}><X className="size-3" /></Button>}
    </div>
    <SaveFeedback state={state} />
  </div>
}
