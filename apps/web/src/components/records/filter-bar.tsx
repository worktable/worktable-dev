import { useEffect, useMemo, useState } from "react"
import { ListFilter, X } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@worktable/ui/components/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@worktable/ui/components/tooltip"
import type { RecordPredicateOp } from "@worktable/types"
import { queryKeys } from "@/lib/queries"
import { queryRecords } from "@/lib/records-api"
import { DocumentPicker } from "./field-editor"
import { FieldValue } from "./field-value"
import {
  FILTER_OP_LABELS,
  canApplyFilterValue,
  columnLabel,
  filterLabel,
  filterOpsForType,
  recordTitle,
  type RecordFieldColumn,
  type RecordFilter,
} from "@/lib/records"

/**
 * Local-view filter bar: chips compiled to the predicate AST (flat AND).
 * State lives in the route's URL search params; this component only renders
 * and edits the chip list.
 */
interface FilterControlsProps {
  spaceId: string
  columns: RecordFieldColumn[]
  filters: RecordFilter[]
  onChange: (filters: RecordFilter[]) => void
}

function filterableColumns(columns: RecordFieldColumn[]) {
  // Dotted keys are excluded: the predicate grammar reads "a.b" as a one-hop
  // relation path, so a literal data key containing a dot can't be filtered.
  // Unschema'd ("unknown") fields stay filterable with text-like operators —
  // users can see and sort those values, so they must be able to filter them.
  return columns.filter((column) => !column.key.includes("."))
}

/** Compact table-view control. Active filters are rendered separately below. */
export function FilterButton({
  spaceId,
  columns,
  filters,
  onChange,
}: FilterControlsProps) {
  const [addOpen, setAddOpen] = useState(false)
  const availableColumns = filterableColumns(columns)
  if (availableColumns.length === 0) return null

  return (
    <Popover open={addOpen} onOpenChange={setAddOpen}>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <PopoverTrigger
            render={
              <Button
                className="relative"
                variant={filters.length > 0 ? "secondary" : "outline"}
                size="icon-sm"
                aria-label={
                  filters.length > 0
                    ? `Add filter, ${filters.length} active`
                    : "Add filter"
                }
                aria-pressed={filters.length > 0}
              />
            }
          >
            <ListFilter className="size-4" />
            {filters.length > 0 && (
              <span className="absolute -top-1 -right-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 font-semibold text-primary-foreground">
                {filters.length}
              </span>
            )}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Add filter</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72">
        <FilterForm
          spaceId={spaceId}
          columns={availableColumns}
          onApply={(next) => {
            onChange([...filters, next])
            setAddOpen(false)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** URL-backed active filter state, kept visible so shared stale filters remain removable. */
export function FilterChips({
  spaceId,
  columns,
  filters,
  onChange,
}: FilterControlsProps) {
  const [editIndex, setEditIndex] = useState<number | null>(null)
  const availableColumns = filterableColumns(columns)
  const labelFor = (key: string) =>
    columnLabel(
      columns.find((column) => column.key === key) ?? { key, field: null }
    )
  if (filters.length === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {filters.map((filter, index) => {
        const column = columns.find((entry) => entry.key === filter.f)
        return (
          <Popover
            key={`${filter.f}:${index}`}
            open={editIndex === index}
            onOpenChange={(open) => setEditIndex(open ? index : null)}
          >
            <PopoverTrigger
              render={
                <button
                  type="button"
                  className="inline-flex max-w-72 items-center gap-1 rounded-full border border-primary/30 bg-surface-tint py-1 pr-1 pl-2.5 text-xs text-foreground transition-colors hover:bg-surface-tint"
                />
              }
            >
              <span className="truncate">
                <span className="font-medium">{labelFor(filter.f)}</span>{" "}
                <span className="text-muted-foreground">
                  {filterLabel(filter)}
                </span>
                {filter.op !== "isEmpty" && filter.v !== undefined && (
                  <span> {formatFilterValue(filter.v)}</span>
                )}
              </span>
              <span
                role="button"
                tabIndex={0}
                aria-label={`Remove ${labelFor(filter.f)} filter`}
                className="flex size-4.5 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
                onClick={(e) => {
                  e.stopPropagation()
                  onChange(filters.filter((_, i) => i !== index))
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.stopPropagation()
                    onChange(filters.filter((_, i) => i !== index))
                  }
                }}
              >
                <X className="size-3" />
              </span>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72">
              {column && availableColumns.length > 0 && (
                <FilterForm
                  spaceId={spaceId}
                  columns={availableColumns}
                  initial={filter}
                  onApply={(next) => {
                    onChange(
                      filters.map((entry, i) => (i === index ? next : entry))
                    )
                    setEditIndex(null)
                  }}
                />
              )}
            </PopoverContent>
          </Popover>
        )
      })}

      {filters.length > 1 && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => onChange([])}
        >
          Clear all
        </button>
      )}
    </div>
  )
}

function FilterForm({
  spaceId,
  columns,
  initial,
  onApply,
}: {
  spaceId: string
  columns: RecordFieldColumn[]
  initial?: RecordFilter
  onApply: (filter: RecordFilter) => void
}) {
  const [field, setField] = useState(initial?.f ?? columns[0]?.key ?? "")
  const column = columns.find((entry) => entry.key === field)
  const ops = filterOpsForType(column?.type ?? "string", column?.field)
  const [op, setOp] = useState<RecordPredicateOp>(initial?.op ?? ops[0])
  const [value, setValue] = useState<unknown>(initial?.v)

  // Changing the field resets the operator and value to that type's defaults.
  useEffect(() => {
    if (initial && field === initial.f) return
    setOp(filterOpsForType(column?.type ?? "string", column?.field)[0])
    setValue(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on field change only
  }, [field])

  const needsValue = op !== "isEmpty"
  const canApply = canApplyFilterValue(needsValue, value)

  const apply = () => {
    if (!canApply) return
    const coerced = coerceFilterValue(column?.type ?? "string", value)
    // isEmpty carries an optional boolean: v:false means "is not empty"
    // (shared URLs / persisted table state). Editing such a chip must not silently
    // drop the false and invert the query.
    const emptyValue =
      initial?.op === "isEmpty" && initial.v === false && op === "isEmpty"
        ? { v: false }
        : {}
    onApply({
      f: field,
      op,
      ...(op === "isEmpty" ? emptyValue : { v: coerced }),
    })
  }

  return (
    <div className="space-y-2.5">
      <div className="grid grid-cols-2 gap-2">
        <Select
          value={field}
          onValueChange={(next) => next !== null && setField(next)}
        >
          <SelectTrigger className="h-8 text-xs" aria-label="Filter field">
            <SelectValue>
              {columnLabel(
                columns.find((entry) => entry.key === field) ?? {
                  key: field,
                  field: null,
                }
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {columns.map((entry) => (
              <SelectItem key={entry.key} value={entry.key}>
                {columnLabel(entry)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={op}
          onValueChange={(next) =>
            next !== null && setOp(next as RecordPredicateOp)
          }
        >
          <SelectTrigger className="h-8 text-xs" aria-label="Filter operator">
            <SelectValue>{FILTER_OP_LABELS[op]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {ops.map((entry) => (
              <SelectItem key={entry} value={entry}>
                {FILTER_OP_LABELS[entry]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {needsValue && column && (
        <FilterValueEditor
          spaceId={spaceId}
          column={column}
          value={value}
          onChange={setValue}
          onSubmit={apply}
        />
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={apply} disabled={!canApply}>
          {initial ? "Update" : "Add filter"}
        </Button>
      </div>
    </div>
  )
}

function FilterValueEditor({
  spaceId,
  column,
  value,
  onChange,
  onSubmit,
}: {
  spaceId: string
  column: RecordFieldColumn
  value: unknown
  onChange: (value: unknown) => void
  onSubmit: () => void
}) {
  const [documentOpen, setDocumentOpen] = useState(false)
  switch (column.type) {
    case "boolean":
      return (
        <OptionList
          options={[
            { value: true, label: "Yes" },
            { value: false, label: "No" },
          ]}
          selected={value}
          onPick={onChange}
        />
      )
    case "select":
    case "multi_select": {
      const options = column.field?.values ?? []
      if (options.length > 0) {
        return (
          <OptionList
            options={options.map((entry) => ({ value: entry, label: entry }))}
            selected={value}
            onPick={onChange}
          />
        )
      }
      break
    }
    case "relation":
      return (
        <RelationValuePicker
          spaceId={spaceId}
          column={column}
          selected={value}
          onPick={onChange}
        />
      )
    case "document": {
      const pickerColumn = {
        ...column,
        field: column.field ? { ...column.field, many: undefined } : null,
      }
      return (
        <DocumentPicker
          spaceId={spaceId}
          column={pickerColumn}
          value={value}
          open={documentOpen}
          onOpenChange={setDocumentOpen}
          onCommit={onChange}
        >
          <button
            type="button"
            className="flex min-h-8 w-full items-center rounded-md border border-input bg-background px-2 text-left text-sm"
          >
            {typeof value === "string" && value ? (
              <FieldValue
                column={pickerColumn}
                value={value}
                spaceId={spaceId}
                linksDisabled
              />
            ) : (
              <span className="text-muted-foreground">Choose a document…</span>
            )}
          </button>
        </DocumentPicker>
      )
    }
    default:
      break
  }
  return (
    <Input
      autoFocus
      type={
        column.type === "number"
          ? "number"
          : column.type === "date"
            ? "date"
            : column.type === "datetime"
              ? "datetime-local"
              : "text"
      }
      value={
        typeof value === "string" || typeof value === "number"
          ? String(value)
          : ""
      }
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit()
      }}
      className="h-8 text-sm"
      aria-label="Filter value"
    />
  )
}

function OptionList({
  options,
  selected,
  onPick,
}: {
  options: Array<{ value: unknown; label: string }>
  selected: unknown
  onPick: (value: unknown) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          // Value, not label: two relation targets can share a display title.
          key={String(option.value)}
          type="button"
          aria-pressed={selected === option.value}
          className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
            selected === option.value
              ? "border-primary/50 bg-surface-tint text-foreground"
              : "border-border text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          }`}
          onClick={() => onPick(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/** Candidate list for relation filter values (title-labeled, id-valued),
 *  searchable — a target collection past the page size would otherwise make
 *  records outside the first slice impossible to filter for. */
function RelationValuePicker({
  spaceId,
  column,
  selected,
  onPick,
}: {
  spaceId: string
  column: RecordFieldColumn
  selected: unknown
  onPick: (value: unknown) => void
}) {
  const target = column.field?.references
  const [search, setSearch] = useState("")
  const scrollRef = useScrollFade<HTMLDivElement>()
  const { data } = useQuery({
    // Distinct from the field editor's "picker" key: that one fetches
    // limit 20, and sharing the cache entry would trim this list to it.
    queryKey: [
      ...queryKeys.records(spaceId, target ?? ""),
      "filter-picker",
      search,
    ],
    queryFn: () =>
      queryRecords(spaceId, target ?? "", {
        ...(search.trim() ? { search: search.trim() } : {}),
        limit: 50,
      }),
    enabled: Boolean(target),
    staleTime: 15_000,
  })
  const options = useMemo(
    () =>
      (data?.records ?? []).map((record) => ({
        value: record.id,
        label: recordTitle(record),
      })),
    [data]
  )
  if (!target)
    return (
      <p className="text-xs text-muted-foreground">
        This relation has no target collection.
      </p>
    )
  return (
    <div className="space-y-2">
      <Input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={`Search ${target}…`}
        className="h-8 text-sm"
        aria-label="Search relation targets"
      />
      <div ref={scrollRef} className="scroll-fade max-h-48 overflow-y-auto">
        <OptionList options={options} selected={selected} onPick={onPick} />
      </div>
    </div>
  )
}

function formatFilterValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No"
  return String(value)
}

function coerceFilterValue(type: string, value: unknown): unknown {
  if (type === "number" && typeof value === "string") {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : value
  }
  if (type === "datetime" && typeof value === "string" && value) {
    // Stored datetimes are canonical ISO (coerceFieldInput writes them that
    // way); the datetime-local input yields a local string, and the server's
    // eq is strict string equality — normalize or "is" never matches.
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return value
}
