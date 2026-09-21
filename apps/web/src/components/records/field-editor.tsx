import { useEffect, useMemo, useRef, useState } from "react"
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

/**
 * Shared editors for record field values, used by the grid's inline cells and
 * the peek panel. Every editor commits through `onCommit(raw)` — coercion and
 * the PATCH happen in the caller — and closes via `onDone`.
 */

/** Single-line input for text-like and date/number types. Enter commits,
 *  Escape cancels, blur commits (the least surprising grid behavior). */
export function TextishEditor({
  column,
  initial,
  onCommit,
  onDone,
  className,
}: {
  column: RecordFieldColumn
  initial: unknown
  onCommit: (raw: string) => void
  onDone: () => void
  className?: string
}) {
  const [value, setValue] = useState(initial === undefined || initial === null ? "" : String(initial))
  // Commit-on-blur must not double-fire after Enter/Escape already settled it.
  const settledRef = useRef(false)

  const settle = (commit: boolean) => {
    if (settledRef.current) return
    settledRef.current = true
    if (commit) onCommit(value)
    onDone()
  }

  return (
    <Input
      autoFocus
      type={inputTypeFor(column.type)}
      inputMode={column.type === "number" ? "decimal" : undefined}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") settle(true)
        if (e.key === "Escape") settle(false)
      }}
      onBlur={() => settle(true)}
      onClick={(e) => e.stopPropagation()}
      className={className ?? "h-7 px-2 py-0 text-sm"}
      aria-label={`Edit ${column.key}`}
    />
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
  onCommit: (raw: string | null) => void
  children: React.ReactNode
}) {
  const options = column.field?.values ?? []
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger nativeButton={false} render={<span className="flex min-h-6 w-full cursor-pointer items-center" onClick={(e) => e.stopPropagation()} />}>
        {children}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 gap-0.5 p-1.5" onClick={(e) => e.stopPropagation()}>
        {options.map((option) => {
          const active = value === option
          return (
            <button
              key={option}
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50"
              onClick={() => {
                onCommit(active ? null : option)
                onOpenChange(false)
              }}
            >
              <span className={`size-1.5 shrink-0 rounded-full ${optionColorClass(option)}`} />
              <span className="min-w-0 flex-1 truncate">{option}</span>
              {active && <Check className="size-3.5 shrink-0 text-primary" />}
            </button>
          )
        })}
        {value !== undefined && value !== null && value !== "" && (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50"
            onClick={() => {
              onCommit(null)
              onOpenChange(false)
            }}
          >
            <X className="size-3.5 shrink-0" />
            Clear
          </button>
        )}
      </PopoverContent>
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
  onCommit: (raw: string[]) => void
  children: React.ReactNode
}) {
  const options = column.field?.values ?? []
  const committed = Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
  const [draft, setDraft] = useState<string[]>(committed)
  useEffect(() => {
    if (open) setDraft(committed)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reseed only when opening
  }, [open])

  const handleOpenChange = (next: boolean) => {
    if (!next && !sameStringSet(draft, committed)) onCommit(draft)
    onOpenChange(next)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger nativeButton={false} render={<span className="flex min-h-6 w-full cursor-pointer items-center" onClick={(e) => e.stopPropagation()} />}>
        {children}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 gap-0.5 p-1.5" onClick={(e) => e.stopPropagation()}>
        {options.map((option) => {
          const active = draft.includes(option)
          return (
            <button
              key={option}
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50"
              onClick={() => setDraft(active ? draft.filter((entry) => entry !== option) : [...draft, option])}
            >
              <span className={`size-1.5 shrink-0 rounded-full ${optionColorClass(option)}`} />
              <span className="min-w-0 flex-1 truncate">{option}</span>
              {active && <Check className="size-3.5 shrink-0 text-primary" />}
            </button>
          )
        })}
      </PopoverContent>
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
  onCommit: (raw: string[] | string | null) => void
  children: React.ReactNode
}) {
  const target = column.field?.references
  const many = column.field?.many ?? false
  const committed = relationIds(value)
  // Many-relations build a local draft and commit once on close: per-toggle
  // PATCHes of the full id array would race each other in flight.
  const [draft, setDraft] = useState<string[]>(committed)
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

  const pick = (record: RecordFile) => {
    if (many) {
      setDraft(selected.includes(record.id) ? selected.filter((id) => id !== record.id) : [...selected, record.id])
    } else {
      onCommit(selected[0] === record.id ? null : record.id)
      onOpenChange(false)
    }
  }

  const resultsRef = useScrollFade<HTMLDivElement>()

  const handleOpenChange = (next: boolean) => {
    if (!next && many && !sameStringSet(draft, committed)) onCommit(draft)
    onOpenChange(next)
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger nativeButton={false} render={<span className="flex min-h-6 w-full cursor-pointer items-center" onClick={(e) => e.stopPropagation()} />}>
        {children}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 gap-1.5 p-1.5" onClick={(e) => e.stopPropagation()}>
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
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50"
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
                onCommit(null)
                onOpenChange(false)
              }
            }}
          >
            <X className="mr-1.5 size-3.5" />
            Clear
          </Button>
        )}
      </PopoverContent>
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
  onCommit: (raw: string[] | string | null) => void
  children: React.ReactNode
}) {
  const many = column.field?.many ?? false
  const committed = typeof value === "string" ? [value] : Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
  const [draft, setDraft] = useState<string[]>(committed)
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
  const pick = (path: string) => {
    if (many) {
      setDraft(toggleDocumentPath(draft, path, committedIdentities))
    }
    else {
      onCommit(documentPathIsSelected(committed, path, committedIdentities) ? null : path)
      onOpenChange(false)
    }
  }
  const handleOpenChange = (next: boolean) => {
    if (!next && many && !sameStringSet(draft, committed)) onCommit(draft)
    onOpenChange(next)
  }
  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger nativeButton={false} render={<span className="flex min-h-6 w-full cursor-pointer items-center" onClick={(event) => event.stopPropagation()} />}>
        {children}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-1.5 p-1.5" onClick={(event) => event.stopPropagation()}>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <Input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search documents or enter a path…" className="h-8 pl-8 text-sm" />
        </div>
        <div ref={scrollRef} className="scroll-fade max-h-64 overflow-y-auto">
          {docsLoading || committedReferencesLoading ? <div className="flex justify-center py-6"><Loader2 className="size-4 animate-spin text-muted-foreground" /></div> : candidates.map((doc) => {
            const active = documentPathIsSelected(many ? draft : committed, doc.path, committedIdentities)
            return (
              <button key={doc.path} type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent/50" onClick={() => pick(doc.path)}>
                <span className={`size-1.5 shrink-0 rounded-full ${doc.archived ? "bg-muted-foreground/40" : active ? "bronze-knob" : "bg-primary/50"}`} />
                <span className="min-w-0 flex-1"><span className="block truncate text-sm">{doc.headings?.[0] || documentReferenceFallbackTitle(doc.path)}</span><span className="block truncate font-mono text-[10px] text-muted-foreground">{doc.path}{doc.archived ? " · archived" : ""}</span></span>
                {active && <Check className="size-3.5 shrink-0 text-primary" />}
              </button>
            )
          })}
          {fallbackPath && !docs.some((doc) => doc.path === fallbackPath) && (
            <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-accent/50" onClick={() => pick(fallbackPath)}>
              <Plus className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0"><span className="block text-sm">Link this path</span><span className="block truncate font-mono text-[10px] text-muted-foreground">{fallbackPath} · target may be missing</span></span>
            </button>
          )}
        </div>
        {(many ? draft : committed).length > 0 && <Button variant="ghost" size="sm" className="justify-start text-muted-foreground" onClick={() => many ? setDraft([]) : (onCommit(null), onOpenChange(false))}><X className="mr-1.5 size-3.5" />Clear</Button>}
      </PopoverContent>
    </Popover>
  )
}

/** Multiline editor for `text` fields (peek only): Enter inserts a newline,
 *  Cmd/Ctrl+Enter or blur commits, Escape cancels. */
export function TextareaEditor({
  column,
  initial,
  onCommit,
  onDone,
}: {
  column: RecordFieldColumn
  initial: unknown
  onCommit: (raw: string) => void
  onDone: () => void
}) {
  const [value, setValue] = useState(initial === undefined || initial === null ? "" : String(initial))
  const settledRef = useRef(false)
  const settle = (commit: boolean) => {
    if (settledRef.current) return
    settledRef.current = true
    if (commit) onCommit(value)
    onDone()
  }
  return (
    <Textarea
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) settle(true)
        if (e.key === "Escape") settle(false)
      }}
      onBlur={() => settle(true)}
      className="min-h-20 text-sm"
      aria-label={`Edit ${column.key}`}
    />
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
  onCommit: (raw: string) => boolean
  onDone: () => void
}) {
  const [value, setValue] = useState(() => {
    try {
      return initial === undefined || initial === null ? "" : JSON.stringify(initial, null, 2)
    } catch {
      return String(initial)
    }
  })
  const [invalid, setInvalid] = useState(false)

  return (
    <div className="space-y-1.5">
      <Textarea
        autoFocus
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          setInvalid(false)
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone()
        }}
        className="min-h-24 font-mono text-xs"
        aria-label="Edit JSON value"
      />
      {invalid && <p className="text-xs text-destructive">Must be valid JSON.</p>}
      <div className="flex gap-1.5">
        <Button
          size="sm"
          onClick={() => {
            if (onCommit(value)) onDone()
            else setInvalid(true)
          }}
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
