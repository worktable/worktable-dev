import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnSizingState,
  type Row,
  type SortingState,
} from "@tanstack/react-table"
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Copy,
  Database,
  Info,
  Layers,
  Loader2,
  MoreVertical,
  PanelRight,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  Trash,
  X,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@worktable/ui/components/button"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { Input } from "@worktable/ui/components/input"
import { Popover, PopoverContent, PopoverTrigger } from "@worktable/ui/components/popover"
import { ResizeHandle } from "@worktable/ui/components/resize-handle"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@worktable/ui/components/table"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@worktable/ui/components/tooltip"
import { CanonicalIdSchema, RecordPredicateOpSchema, type RecordFile, type RecordQuery } from "@worktable/types"
import { usePageMeta } from "@/hooks/use-page-meta"
import { queryKeys, useRecordCollectionHealth, useRecordCollections, useRecordGroups, useRecordPages } from "@/lib/queries"
import { documentReferencesQueryOptions } from "@/lib/docs-queries"
import { readRecord } from "@/lib/records-api"
import { useRecordMutations } from "@/lib/records-queries"
import { applyColumnOrder, collectRecordQueryWarnings, columnLabel, compileFilters, indexDanglingRelations, isValidFilter, recordFieldColumns, recordTitle, resolveDocumentGroupValue, type ColumnPrefs, type RecordFieldColumn, type RecordFilter } from "@/lib/records"
import { ColumnConfig } from "@/components/records/column-config"
import { EditableCell } from "@/components/records/editable-cell"
import { DocumentReferenceScope, FieldValue, type ExpandedRecords } from "@/components/records/field-value"
import { FilterButton, FilterChips } from "@/components/records/filter-bar"
import { NewRecordDialog } from "@/components/records/new-record-dialog"
import { RecordPeek, type RecordPeekActions, type RecordPeekNavigation } from "@/components/records/record-peek"
import { SchemaEditorDialog } from "@/components/records/schema-editor"

/** URL-carried table state (shareable); column prefs stay in localStorage. */
interface RecordsSearch {
  record?: string
  filters?: RecordFilter[]
  groupBy?: string
  sort?: Array<{ f: string; d?: "asc" | "desc" }>
}

function sanitizeFilters(input: unknown): RecordFilter[] | undefined {
  if (!Array.isArray(input)) return undefined
  // Structural AND per-operator value validation: a malformed chip from a
  // shared URL or stale localStorage would otherwise compile into /query and
  // 400 the whole grid instead of just being dropped.
  const filters = input.filter(
    (entry): entry is RecordFilter =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as RecordFilter).f === "string" &&
      RecordPredicateOpSchema.safeParse((entry as RecordFilter).op).success &&
      isValidFilter(entry as RecordFilter)
  )
  return filters.length > 0 ? filters : undefined
}

function sanitizeSort(input: unknown): Array<{ f: string; d?: "asc" | "desc" }> | undefined {
  if (!Array.isArray(input)) return undefined
  const sort = input.filter(
    (entry): entry is { f: string; d?: "asc" | "desc" } =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as { f?: unknown }).f === "string" &&
      ((entry as { d?: unknown }).d === undefined || (entry as { d?: unknown }).d === "asc" || (entry as { d?: unknown }).d === "desc")
  )
  return sort.length > 0 ? sort : undefined
}

// The query grammar resolves these top-level record properties BEFORE data
// fields, so a schema field with one of these names cannot be server-sorted
// by its displayed value — its header stays unsortable rather than lying.
const RECORD_TOP_LEVEL_KEYS = new Set([
  "version",
  "kind",
  "id",
  "collectionId",
  "createdAt",
  "updatedAt",
  "createdBy",
  "updatedBy",
  "archive",
  "metadata",
  "data",
])

export const Route = createFileRoute("/spaces/$spaceId/records/$")({
  ssr: false,
  // Only canonical record ids pass: the value interpolates into a REST path,
  // so a crafted deep link like ?record=../other/id must never survive.
  // Filters/sort/groupBy sanitize structurally; field names are only ever
  // used as query-grammar field references, never as paths.
  validateSearch: (search: Record<string, unknown>): RecordsSearch => {
    const filters = sanitizeFilters(search["filters"])
    const sort = sanitizeSort(search["sort"])
    return {
      ...(typeof search["record"] === "string" && CanonicalIdSchema.safeParse(search["record"]).success
        ? { record: search["record"] }
        : {}),
      ...(filters ? { filters } : {}),
      ...(typeof search["groupBy"] === "string" && search["groupBy"] ? { groupBy: search["groupBy"] } : {}),
      ...(sort ? { sort } : {}),
    }
  },
  component: RecordsPage,
})

function RecordsPage() {
  const { spaceId, _splat } = Route.useParams()
  const collectionId = _splat ?? ""
  // Belt and braces on top of validateSearch: the id reaches a REST path, so
  // anything non-canonical is treated as absent no matter how it arrived.
  const routeSearch = Route.useSearch()
  const rawPeekId = routeSearch.record
  const peekRecordId = rawPeekId && CanonicalIdSchema.safeParse(rawPeekId).success ? rawPeekId : undefined
  // Use-site sanitation, same as the record id above: validateSearch does not
  // reliably strip malformed params at runtime, and a bad chip compiled into
  // /query would 400 the whole grid.
  const filters = useMemo(() => sanitizeFilters(routeSearch.filters) ?? [], [routeSearch.filters])
  const groupBy = typeof routeSearch.groupBy === "string" && routeSearch.groupBy ? routeSearch.groupBy : undefined
  const urlSort = useMemo(() => sanitizeSort(routeSearch.sort), [routeSearch.sort])
  const navigate = Route.useNavigate()

  // Persistence writes only after the user (or the restore) actually touched
  // the table state in THIS collection visit. Without this, merely opening a
  // shared ?record= link (or any passive render) would save empty URL state
  // over the collection's remembered default.
  const tableStateTouchedRef = useRef(false)

  /** Patch the URL-carried table state (undefined removes a key). */
  const setTableState = (patch: Partial<Pick<RecordsSearch, "filters" | "groupBy" | "sort">>) => {
    tableStateTouchedRef.current = true
    void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
  }

  // Live updates ride the parent SpaceDetailPage's space subscription, which
  // already invalidates the record query prefix on record_* events.

  const { data: collections, isLoading: collectionsLoading } = useRecordCollections(spaceId)
  const collection = collections?.find((entry) => entry.id === collectionId)

  // Metadata read: schema plus diagnostics and integrity warnings, WITHOUT
  // the records payload (rows come from the paged query below). Once loaded
  // it is the schema authority — the summary cache can be up to 30s stale
  // after an external schema.yaml edit; the summary only bridges the load.
  const { data: health } = useRecordCollectionHealth(spaceId, collectionId)
  const schema = health !== undefined ? health.schema : collection?.schema

  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 300)
    return () => clearTimeout(timer)
  }, [searchInput])
  // Reset transient table state when switching collections (URL-carried
  // state clears on its own: sidebar links navigate without search params).
  useEffect(() => {
    setSearchInput("")
    setSearch("")
    setIncludeArchived(false)
    setEditCells(false)
    setShowUnmodeled(false)
  }, [collectionId])

  const [includeArchived, setIncludeArchived] = useState(false)
  const [editCells, setEditCells] = useState(false)
  const [showUnmodeled, setShowUnmodeled] = useState(false)

  // Column prefs (visibility + order) are personal defaults: localStorage
  // only, keyed per collection, alongside the persisted URL table state.
  const [colPrefs, setColPrefsState] = useState<ColumnPrefs>({ hidden: [], order: [], widths: {} })
  useEffect(() => {
    tableStateTouchedRef.current = false
    setColPrefsState(loadPersistedTableState(spaceId, collectionId)?.cols ?? { hidden: [], order: [], widths: {} })
  }, [spaceId, collectionId])
  const setColPrefs = (prefs: ColumnPrefs) => {
    tableStateTouchedRef.current = true
    setColPrefsState(prefs)
  }

  // With a bare URL, apply the last-used table state for this collection. A
  // record-only deep link counts as NOT bare: rewriting a shared ?record=
  // link with this machine's saved filters could hide the linked record.
  useEffect(() => {
    if (filters.length > 0 || groupBy || urlSort || rawPeekId) return
    const saved = loadPersistedTableState(spaceId, collectionId)
    if (!saved) return
    const patch: Partial<RecordsSearch> = {}
    if (sanitizeFilters(saved.filters)) patch.filters = sanitizeFilters(saved.filters)
    if (typeof saved.groupBy === "string" && saved.groupBy) patch.groupBy = saved.groupBy
    if (sanitizeSort(saved.sort)) patch.sort = sanitizeSort(saved.sort)
    if (Object.keys(patch).length > 0) {
      tableStateTouchedRef.current = true
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- restore once per collection
  }, [spaceId, collectionId])

  // Persist the current table state as this collection's default. The first flush
  // after a collection switch is SKIPPED: it runs before the restore
  // navigation and the colPrefs load re-render land, so persisting there
  // would overwrite persisted state with an empty one (and could write the
  // previous collection's column prefs under the new key).
  const persistReadyRef = useRef<string | null>(null)
  useEffect(() => {
    const key = `${spaceId}/${collectionId}`
    if (persistReadyRef.current !== key) {
      persistReadyRef.current = key
      return
    }
    // Untouched table state (e.g. a passive render while a ?record= link is open):
    // nothing the user chose, nothing to remember.
    if (!tableStateTouchedRef.current) return
    persistTableState(spaceId, collectionId, {
      ...(filters.length > 0 ? { filters } : {}),
      ...(groupBy ? { groupBy } : {}),
      ...(urlSort ? { sort: urlSort } : {}),
      cols: colPrefs,
    })
  }, [spaceId, collectionId, filters, groupBy, urlSort, colPrefs])

  // Expand every relation field so chips can show target titles in one query.
  const expand = useMemo<RecordQuery["expand"]>(() => {
    const relations = Object.entries(schema?.fields ?? {}).filter(
      ([, field]) => field.type === "relation" || field.type === "reference"
    )
    return relations.length > 0 ? Object.fromEntries(relations.map(([key]) => [key, true as const])) : undefined
  }, [schema])

  // Sort entries pass through unvalidated (validating against loaded columns
  // would be circular through the query, and schema-only validation broke
  // sorting on rendered unschema'd columns). A stale entry sorts harmlessly
  // (missing values, id tie-break) and gets a clearable chip in the view
  // controls row instead — see staleSortFields below.
  const sorting = useMemo<SortingState>(() => (urlSort ?? []).map((entry) => ({ id: entry.f, desc: entry.d === "desc" })), [urlSort])
  const orderBy = useMemo(
    () => sorting.map((entry) => ({ field: entry.id, dir: entry.desc ? ("desc" as const) : ("asc" as const) })),
    [sorting]
  )
  const where = useMemo(() => compileFilters(filters), [filters])

  const scopeParams = useMemo(
    () => ({
      ...(search ? { search } : {}),
      ...(where ? { where } : {}),
      ...(includeArchived ? { includeArchived: true } : {}),
    }),
    [search, where, includeArchived]
  )

  const pagesQuery = useRecordPages(spaceId, collectionId, {
    ...scopeParams,
    ...(orderBy.length > 0 ? { orderBy } : {}),
    ...(expand ? { expand } : {}),
  })

  const rows = useMemo(() => pagesQuery.data?.pages.flatMap((page) => page.records) ?? [], [pagesQuery.data])
  const expanded = useMemo<ExpandedRecords>(() => {
    const merged: ExpandedRecords = {}
    for (const page of pagesQuery.data?.pages ?? []) {
      for (const [targetCollection, byId] of Object.entries(page.expanded ?? {})) {
        merged[targetCollection] = { ...merged[targetCollection], ...byId }
      }
    }
    return merged
  }, [pagesQuery.data])

  const allFieldColumns = useMemo(() => recordFieldColumns(schema, rows), [schema, rows])
  const unmodeledCount = allFieldColumns.filter((column) => !column.field).length
  const fieldColumns = useMemo(() => allFieldColumns.filter((column) => column.field || showUnmodeled), [allFieldColumns, showUnmodeled])
  // Display order and visibility come from the column prefs; the ordered FULL
  // list feeds the config popover and filter/group field pickers.
  const orderedColumns = useMemo(() => applyColumnOrder(fieldColumns, colPrefs.order), [fieldColumns, colPrefs.order])
  // Filter and group field pickers exclude names the query grammar resolves
  // to record METADATA before data (same collision that blocks sorting them).
  const queryableColumns = useMemo(() => orderedColumns.filter((column) => !RECORD_TOP_LEVEL_KEYS.has(column.key)), [orderedColumns])
  const visibleColumns = useMemo(() => {
    const hidden = new Set(colPrefs.hidden)
    return orderedColumns.filter((column) => !hidden.has(column.key))
  }, [orderedColumns, colPrefs.hidden])

  // Merges into the existing search: the peek must not clobber filters/sort.
  const openPeek = (recordId: string | undefined) => {
    void navigate({
      search: (prev) => {
        const next = { ...prev }
        if (recordId) next.record = recordId
        else delete next.record
        return next
      },
      replace: true,
    })
  }

  // Grouped table: one aggregate query over the same scope for true group
  // totals; loaded rows are bucketed client-side beneath those headers.
  // Visible + queryable only: metadata-colliding names would sum the wrong
  // values server-side, and a hidden column must stay hidden in group
  // headers too.
  const numberColumns = useMemo(() => {
    const hidden = new Set(colPrefs.hidden)
    return queryableColumns
      .filter((column) => column.type === "number" && !hidden.has(column.key))
      .map((column) => column.key)
  }, [queryableColumns, colPrefs.hidden])
  // Sort fields with no VISIBLE column have no header to clear them from
  // (removed fields, but also columns hidden after sorting); they surface as
  // removable chips in the table controls row.
  const staleSortFields = useMemo(
    () =>
      fieldColumns.length === 0
        ? []
        : (urlSort ?? []).map((entry) => entry.f).filter((field) => !visibleColumns.some((column) => column.key === field)),
    [urlSort, fieldColumns.length, visibleColumns]
  )

  const groupsQuery = useRecordGroups(spaceId, collectionId, {
    ...scopeParams,
    ...(groupBy ? { groupBy } : {}),
    sums: numberColumns,
  })
  // Group keys normalize array VALUES order-insensitively: editors persist
  // multi-select picks in click order, so ["a","b"] and ["b","a"] are the
  // same group. The server aggregates them separately (raw keys), so totals
  // for the same normalized key MERGE (counts and sums add).
  const groupTotals = useMemo(() => {
    const map = new Map<string, Record<string, unknown>>()
    for (const group of groupsQuery.data?.groups ?? []) {
      const key = normalizeGroupKey(group["key"] ?? null)
      const existing = map.get(key)
      if (!existing) {
        map.set(key, { ...group })
        continue
      }
      for (const [alias, value] of Object.entries(group)) {
        if (alias === "key") continue
        if (typeof value === "number" && typeof existing[alias] === "number") {
          existing[alias] = (existing[alias] as number) + value
        }
      }
    }
    return map
  }, [groupsQuery.data])

  // The peeked record may sit beyond the loaded pages (deep link); fall back
  // to a point read, which is file-backed and can never lie.
  const peekFromRows = peekRecordId ? rows.find((row) => row.id === peekRecordId) : undefined
  const peekFallback = useQuery({
    queryKey: [...queryKeys.records(spaceId, collectionId), "record", peekRecordId ?? ""],
    queryFn: () => readRecord(spaceId, collectionId, peekRecordId ?? ""),
    enabled: Boolean(peekRecordId) && !peekFromRows && !pagesQuery.isLoading,
    staleTime: 30_000,
  })
  const peekRecord = peekFromRows ?? peekFallback.data
  const documentPaths = useMemo(() => {
    const keys = Object.entries(schema?.fields ?? {}).filter(([, field]) => field.type === "document").map(([key]) => key)
    const paths = new Set<string>()
    for (const record of [...rows, ...(peekRecord && !rows.includes(peekRecord) ? [peekRecord] : [])]) {
      for (const key of keys) {
        const value = record.data[key]
        if (typeof value === "string") paths.add(value)
        else if (Array.isArray(value)) for (const entry of value) if (typeof entry === "string") paths.add(entry)
      }
    }
    return [...paths].sort()
  }, [schema, rows, peekRecord])
  const { data: resolvedDocumentPaths } = useQuery(documentReferencesQueryOptions(spaceId, documentPaths))
  const documentGroupIdentities = useMemo(
    () => new Map(resolvedDocumentPaths?.map((reference) => [reference.storedPath, reference.resolvedPath ?? reference.storedPath]) ?? []),
    [resolvedDocumentPaths]
  )

  // A 500 px inspector needs enough room to preserve a useful grid beside it.
  // Below xl the detail becomes an overlay drawer instead of crushing columns.
  const [detailDrawer, setDetailDrawer] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 1279px)")
    const update = () => setDetailDrawer(mql.matches)
    update()
    mql.addEventListener("change", update)
    return () => mql.removeEventListener("change", update)
  }, [])

  const [newRecordOpen, setNewRecordOpen] = useState(false)
  const [schemaOpen, setSchemaOpen] = useState(false)
  const mutations = useRecordMutations(spaceId, collectionId)

  // Delete runs through one route-level confirm, whether triggered from a row
  // menu or the peek. A restrict 409 lists its blockers via the mutation toast.
  const [deleteTarget, setDeleteTarget] = useState<RecordFile | null>(null)
  const confirmDelete = async () => {
    if (!deleteTarget) return
    const targetId = deleteTarget.id
    try {
      await mutations.remove.mutateAsync(targetId)
      if (peekRecordId === targetId) openPeek(undefined)
    } catch {
      // Toasted by the mutation (the 409 message names the restricting records).
    } finally {
      setDeleteTarget(null)
    }
  }

  const duplicateRecord = async (record: RecordFile) => {
    try {
      const result = await mutations.duplicate.mutateAsync(record)
      openPeek(result.recordId)
    } catch {
      // Toasted by the mutation.
    }
  }

  const peekActions = useMemo<RecordPeekActions>(
    () => ({
      onCommitField: (recordId, key, value) => mutations.updateField.mutate({ recordId, data: { [key]: value } }),
      onDuplicate: (record) => void duplicateRecord(record),
      onArchive: (recordId) => mutations.archive.mutate(recordId),
      onRestore: (recordId) => mutations.restore.mutate(recordId),
      onDelete: (recordId) => {
        const record = rows.find((row) => row.id === recordId) ?? peekRecord
        if (record) setDeleteTarget(record)
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mutation objects are stable per collection
    [spaceId, collectionId, rows, peekRecord]
  )

  const diagnostics = health?.diagnostics ?? []
  const integrityWarnings = useMemo(() => health?.integrityWarnings ?? [], [health])
  // false means the sweep could not run (index off or warming) — unknown, not healthy.
  const integrityUnknown = health !== undefined && health.integrityWarningsComplete === false
  const projection = health?.projection
  const projectionDrifted = projection?.state === "drifted"
  const projectionIndexing = projection?.state === "indexing"
  const queryWarnings = useMemo(
    () => collectRecordQueryWarnings([...(pagesQuery.data?.pages ?? []), groupsQuery.data]),
    [pagesQuery.data, groupsQuery.data]
  )
  const dataHealthNotices: Array<{ label: string; detail: string }> = []
  if (diagnostics.length > 0) {
    dataHealthNotices.push({
      label: `${diagnostics.length} unreadable ${diagnostics.length === 1 ? "file" : "files"}`,
      detail: diagnostics.map((diagnostic) => `${diagnostic.file}: ${diagnostic.error}`).join("\n"),
    })
  }
  if (integrityWarnings.length > 0) {
    dataHealthNotices.push({
      label: `${integrityWarnings.length} dangling ${integrityWarnings.length === 1 ? "relation" : "relations"}`,
      detail: integrityWarnings.map((warning) => `${warning.recordId}.${warning.field} → ${warning.target}`).join("\n"),
    })
  }
  if (integrityUnknown) {
    dataHealthNotices.push({
      label: "Integrity check pending",
      detail: "The record index is unavailable or still warming up, so relation integrity has not been checked.",
    })
  }
  if (queryWarnings.length > 0) {
    dataHealthNotices.push({
      label: "Query results may be incomplete",
      detail: queryWarnings.join("\n"),
    })
  }
  if (projectionDrifted && projection) {
    dataHealthNotices.push({
      label: "Record projection is out of date",
      detail: `${projection.indexedFileCount} of ${projection.canonicalFileCount} files indexed. ${
        projection.lastReconciledAt
          ? `Last reconciled ${new Date(projection.lastReconciledAt).toLocaleString()}.`
          : "This collection has not completed a reconciliation yet."
      }`,
    })
  }
  if (projectionIndexing) {
    dataHealthNotices.push({
      label: "Record projection indexing",
      detail: "The projection is still being prepared. Query results may change when indexing completes.",
    })
  }
  const dataHealthNeedsAttention = diagnostics.length > 0 || integrityWarnings.length > 0 || queryWarnings.length > 0 || projectionDrifted
  // Per record+field, the set of `collection/recordId` targets flagged as
  // dangling — target-specific so one broken id in a multi-relation doesn't
  // mark its valid siblings.
  const danglingByRecordField = useMemo(() => indexDanglingRelations(integrityWarnings), [integrityWarnings])


  const columns = useMemo<ColumnDef<RecordFile>[]>(() => {
    if (fieldColumns.length === 0 && rows.length > 0) {
      // Schema-less records with empty data would otherwise render a table
      // with no cells at all — fall back to an id column so rows stay
      // visible and openable.
      return [
        {
          id: "id",
          accessorFn: (row) => row.id,
          header: () => <span className="whitespace-nowrap">Id</span>,
          cell: ({ row }) => <span className="font-mono text-xs">{row.original.id}</span>,
        },
      ]
    }
    return visibleColumns.map((column) => ({
      id: column.key,
      accessorFn: (row) => row.data[column.key],
      header: () => <ColumnHeaderLabel column={column} />,
      size: defaultColumnWidth(column),
      minSize: 120,
      maxSize: 560,
      cell: ({ row }) => (
        <EditableCell
          column={column}
          record={row.original}
          spaceId={spaceId}
          expanded={expanded}
          danglingTargets={danglingByRecordField.get(`${row.original.id}:${column.key}`)}
          onCommitField={peekActions.onCommitField}
          editingEnabled={editCells}
        />
      ),
    }))
  }, [visibleColumns, fieldColumns.length, rows.length, spaceId, expanded, danglingByRecordField, peekActions, editCells])

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnSizing: colPrefs.widths },
    onColumnSizingChange: (updater) => {
      const next: ColumnSizingState = typeof updater === "function" ? updater(colPrefs.widths) : updater
      setColPrefs({ ...colPrefs, widths: next })
    },
    columnResizeMode: "onChange",
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater
      setTableState({ sort: next.length > 0 ? next.map((entry) => ({ f: entry.id, ...(entry.desc ? { d: "desc" as const } : {}) })) : undefined })
    },
    manualSorting: true,
    enableMultiSort: true,
    getCoreRowModel: getCoreRowModel(),
  })

  // Grouped table sections: the UNION of the aggregate query's groups and the
  // loaded rows' buckets. Aggregate-first so every matching group shows its
  // header (with true totals) even before pagination loads any of its rows —
  // a whole status must never be invisible just because the first page
  // happened to hold other groups.
  const groupedRows = useMemo(() => {
    if (!groupBy) return null
    const groupColumn = fieldColumns.find((column) => column.key === groupBy)
    const buckets = new Map<string, { label: unknown; rows: Row<RecordFile>[] }>()
    for (const group of groupsQuery.data?.groups ?? []) {
      const label = group["key"] ?? null
      const key = normalizeGroupKey(label)
      if (!buckets.has(key)) buckets.set(key, { label, rows: [] })
    }
    for (const row of table.getRowModel().rows) {
      const rawValue = row.original.data[groupBy] ?? null
      const value = groupColumn?.type === "document"
        ? resolveDocumentGroupValue(rawValue, documentGroupIdentities)
        : rawValue
      const key = normalizeGroupKey(value)
      if (!buckets.has(key)) buckets.set(key, { label: value, rows: [] })
      buckets.get(key)!.rows.push(row)
    }
    return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- table row model derives from rows
  }, [groupBy, rows, table, groupsQuery.data, fieldColumns, documentGroupIdentities])

  // Not-found requires ALL evidence in: summary absent, no schema on disk,
  // and zero loaded rows — a schemaless collection created by an agent or a
  // file edit (stale summary cache, no schema.yaml) must not 404 while its
  // records are visible in the paged query.
  if (
    !collectionsLoading &&
    collections &&
    !collection &&
    health !== undefined &&
    !health.schema &&
    !pagesQuery.isLoading &&
    rows.length === 0
  ) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <div className="mb-5 flex size-14 items-center justify-center rounded-3xl bg-muted/40">
          <Database className="size-7 text-muted-foreground" />
        </div>
        <h2 className="text-lg font-medium text-foreground">Collection not found</h2>
        <p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
          No record collection named <span className="font-mono text-foreground">{collectionId}</span> exists in this space.
        </p>
      </div>
    )
  }

  // The summary count is the unfiltered active-record total: with a search or
  // filters narrowing the grid or includeArchived widening it, fall back to a
  // loaded count (with + while more pages remain) instead of misstating it.
  const scoped = Boolean(search) || filters.length > 0
  const totalLabel =
    collection !== undefined && !includeArchived && !scoped
      ? `${collection.count} ${collection.count === 1 ? "record" : "records"}`
      : `${rows.length}${pagesQuery.hasNextPage ? "+" : ""} loaded`
  const visibleRecordIds = (groupedRows
    ? groupedRows.flatMap(([, group]) => group.rows)
    : table.getRowModel().rows
  ).map((row) => row.original.id)
  const peekPosition = peekRecordId ? visibleRecordIds.indexOf(peekRecordId) : -1
  const peekNavigation: RecordPeekNavigation | undefined = peekPosition >= 0
    ? {
        position: peekPosition + 1,
        total: visibleRecordIds.length,
        ...(peekPosition > 0 ? { onPrevious: () => openPeek(visibleRecordIds[peekPosition - 1]) } : {}),
        ...(peekPosition < visibleRecordIds.length - 1 ? { onNext: () => openPeek(visibleRecordIds[peekPosition + 1]) } : {}),
      }
    : undefined
  const closePeek = () => {
    const closingId = peekRecordId
    openPeek(undefined)
    if (closingId) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-record-id="${closingId}"]`)?.focus())
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TooltipProvider delay={350}>
      <RecordsPageMeta name={collection?.name ?? schema?.name ?? collectionId} collectionId={collectionId} updatedAt={schema?.updatedAt} />
      <DocumentReferenceScope spaceId={spaceId} paths={documentPaths}>
      <div className="flex min-h-0 flex-1">
        <div
          className={`flex min-w-0 flex-1 flex-col px-4 pt-4 sm:px-6 ${peekRecordId && !detailDrawer ? "xl:pr-0" : ""}`}
        >
          {/* Toolbar */}
          <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
            <div className="relative min-w-40 flex-1 sm:max-w-64">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/60" />
              <Input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Search records…"
                className="h-9 w-full pl-9"
                aria-label="Search records"
              />
            </div>
            <div className="ml-auto flex items-center gap-1">
              <span className="hidden px-1.5 text-xs text-muted-foreground min-[1536px]:block">{totalLabel}</span>
              {schema?.description && (
                <Popover>
                  <Tooltip>
                    <TooltipTrigger render={<span className="inline-flex" />}>
                      <PopoverTrigger render={<Button variant="ghost" size="icon-xs" aria-label="About this collection" />}>
                          <Info className="size-4" />
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent>About this collection</TooltipContent>
                  </Tooltip>
                  <PopoverContent align="end" className="w-80">
                    <div className="space-y-1.5">
                      <p className="text-sm font-medium text-foreground">{schema.name}</p>
                      <p className="text-sm leading-5 text-muted-foreground">{schema.description}</p>
                    </div>
                  </PopoverContent>
                </Popover>
              )}
              {(schema || fieldColumns.length > 0 || filters.length > 0 || groupBy || staleSortFields.length > 0) && (
                <div className="flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant={editCells ? "secondary" : "outline"}
                          size="icon-sm"
                          onClick={() => setEditCells((value) => !value)}
                          aria-label={editCells ? "Stop editing table cells" : "Edit table cells"}
                          aria-pressed={editCells}
                        />
                      }
                    >
                      <Pencil className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent>{editCells ? "Stop editing table cells" : "Edit table cells"}</TooltipContent>
                  </Tooltip>
                  <FilterButton
                    spaceId={spaceId}
                    columns={queryableColumns}
                    filters={filters}
                    onChange={(next) => setTableState({ filters: next.length > 0 ? next : undefined })}
                  />
                  <GroupByPicker
                    columns={queryableColumns}
                    groupBy={groupBy}
                    onChange={(next) => setTableState({ groupBy: next })}
                  />
                  <ColumnConfig columns={orderedColumns} prefs={colPrefs} onChange={setColPrefs} />
                </div>
              )}
              <Button size="sm" onClick={() => setNewRecordOpen(true)}>
                <Plus className="mr-1.5 size-4" />
                New record
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Collection actions" title="Collection actions" />}>
                  <MoreVertical className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-48">
                  <DropdownMenuItem onClick={() => setSchemaOpen(true)}>
                    <Settings2 className="mr-2 size-4" />
                    Edit schema
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem checked={includeArchived} onCheckedChange={setIncludeArchived}>
                    <Archive className="mr-2 size-4" />
                    Include archived
                  </DropdownMenuCheckboxItem>
                  {unmodeledCount > 0 && (
                    <DropdownMenuCheckboxItem checked={showUnmodeled} onCheckedChange={setShowUnmodeled}>
                      <PanelRight className="mr-2 size-4" />
                      Show unmodeled fields
                    </DropdownMenuCheckboxItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Contextual state only appears when a filter or stale sort needs attention. */}
          {(filters.length > 0 || staleSortFields.length > 0) && (
            <div className="mb-3 flex shrink-0 flex-wrap items-start gap-2">
              <FilterChips
                spaceId={spaceId}
                columns={queryableColumns}
                filters={filters}
                onChange={(next) => setTableState({ filters: next.length > 0 ? next : undefined })}
              />
              {staleSortFields.map((field) => (
                <button
                  key={field}
                  type="button"
                  className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                  title="This sort field has no column here; click to remove it"
                  onClick={() =>
                    setTableState({
                      sort: (urlSort ?? []).filter((entry) => entry.f !== field).length > 0 ? (urlSort ?? []).filter((entry) => entry.f !== field) : undefined,
                    })
                  }
                >
                  Sorted by {columnLabel(fieldColumns.find((column) => column.key === field) ?? { key: field, field: null })}
                  <X className="size-3" />
                </button>
              ))}
            </div>
          )}

          {/* Temporary, consolidated collection health row. */}
          {dataHealthNotices.length > 0 && (
            <div className="mb-3 flex shrink-0 items-center gap-3 rounded-lg border border-border bg-muted/20 px-3 py-2">
              <Popover>
                <PopoverTrigger
                  render={
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      aria-label="Show data health details"
                    />
                  }
                >
                  {projectionIndexing && !dataHealthNeedsAttention ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <AlertTriangle className="size-4 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">
                      {dataHealthNeedsAttention ? "Data health needs attention" : "Data health check in progress"}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {dataHealthNotices.map((notice) => notice.label).join(" · ")}
                    </span>
                  </span>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-96 max-w-[calc(100vw-2rem)] p-4">
                  <p className="text-sm font-medium text-foreground">Data health</p>
                  <div className="mt-3 space-y-3">
                    {dataHealthNotices.map((notice) => (
                      <div key={notice.label}>
                        <p className="text-xs font-medium text-foreground">{notice.label}</p>
                        <p className="mt-1 whitespace-pre-line text-xs leading-5 text-muted-foreground">{notice.detail}</p>
                      </div>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              {projectionDrifted && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="shrink-0"
                  onClick={() => mutations.reconcile.mutate()}
                  disabled={mutations.reconcile.isPending}
                >
                  {mutations.reconcile.isPending ? (
                    <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1.5 size-3.5" />
                  )}
                  Reconcile
                </Button>
              )}
            </div>
          )}

          {/* Grid */}
          {pagesQuery.isLoading || collectionsLoading ? (
            <div className="space-y-2 py-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-9 animate-pulse rounded-lg bg-muted/20" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed border-border/80 px-6 py-16 text-center">
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-muted/40">
                <Database className="size-6 text-muted-foreground" />
              </div>
              <h2 className="text-base font-medium text-foreground">{scoped ? "No matching records" : "No records yet"}</h2>
              <p className="mt-1.5 max-w-sm text-sm leading-6 text-muted-foreground">
                {scoped
                  ? "Try a different search or adjust the filters."
                  : "Create the first record here, or let an agent fill the collection over MCP."}
              </p>
              {!scoped && (
                <Button size="sm" className="mt-5" onClick={() => setNewRecordOpen(true)}>
                  <Plus className="mr-1.5 size-4" />
                  New record
                </Button>
              )}
              {filters.length > 0 && (
                <Button size="sm" variant="outline" className="mt-5" onClick={() => setTableState({ filters: undefined })}>
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <>
              <div className="min-w-0 overflow-hidden rounded-xl border border-border bg-card">
                <div className="min-w-0 overflow-x-auto overscroll-x-contain">
                  <table className="border-separate border-spacing-0 caption-bottom text-sm" style={{ width: table.getTotalSize(), minWidth: "100%" }}>
                  <TableHeader className="[&_th]:border-b [&_th]:border-border/60">
                    {table.getHeaderGroups().map((headerGroup) => (
                      <TableRow key={headerGroup.id} className="border-0 hover:bg-transparent">
                        {headerGroup.headers.map((header) => {
                          const sortDir = header.column.getIsSorted()
                          // See RECORD_TOP_LEVEL_KEYS: the server would sort
                          // record metadata, not the displayed data field.
                          const sortable = !RECORD_TOP_LEVEL_KEYS.has(header.column.id)
                          if (!sortable) {
                            return (
                              <TableHead key={header.id} className="relative px-2 first:pl-1" style={{ width: header.getSize() }}>
                                <span
                                  className="flex h-8 items-center px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                                  title="This field name matches record metadata, so it cannot be sorted by its value"
                                >
                                  {flexRender(header.column.columnDef.header, header.getContext())}
                                </span>
                              </TableHead>
                            )
                          }
                          return (
                            <TableHead key={header.id} className="relative px-2 first:pl-1" style={{ width: header.getSize() }}>
                              <button
                                type="button"
                                className="group flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                                onClick={header.column.getToggleSortingHandler()}
                                title="Sort (shift-click to add)"
                              >
                                {flexRender(header.column.columnDef.header, header.getContext())}
                                {sortDir === "asc" ? (
                                  <ArrowUp className="size-3" />
                                ) : sortDir === "desc" ? (
                                  <ArrowDown className="size-3" />
                                ) : (
                                  <ArrowUpDown className="size-3 opacity-0 transition-opacity group-hover:opacity-40" />
                                )}
                              </button>
                              <ResizeHandle
                                role="separator"
                                aria-orientation="vertical"
                                aria-label={`Resize ${header.column.id} column`}
                                onMouseDown={header.getResizeHandler()}
                                onTouchStart={header.getResizeHandler()}
                                onDoubleClick={() => header.column.resetSize()}
                                data-resizing={header.column.getIsResizing() ? "" : undefined}
                                className="inset-y-1 -right-1"
                              />
                            </TableHead>
                          )
                        })}
                        <TableHead className="w-9 px-1" aria-label="Row actions" />
                      </TableRow>
                    ))}
                  </TableHeader>
                  <TableBody className="[&_tr:not([data-state=selected])_td]:border-b [&_tr:not([data-state=selected])_td]:border-border/60 [&_tr:last-child_td]:border-b-0">
                    {(() => {
                      const groupColumn = groupBy ? fieldColumns.find((column) => column.key === groupBy) : undefined
                      const renderedRows = groupedRows
                        ? groupedRows.flatMap(([, group]) => group.rows)
                        : table.getRowModel().rows
                      const renderRow = (row: Row<RecordFile>) => (
                        <TableRow
                          key={row.original.id}
                          onClick={() => openPeek(row.original.id)}
                          tabIndex={0}
                          data-record-id={row.original.id}
                          onKeyDown={(event) => {
                            if (event.target !== event.currentTarget) return
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault()
                              openPeek(row.original.id)
                              return
                            }
                            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
                            event.preventDefault()
                            const index = renderedRows.findIndex((entry) => entry.original.id === row.original.id)
                            const next = renderedRows[index + (event.key === "ArrowDown" ? 1 : -1)]
                            if (!next) return
                            openPeek(next.original.id)
                            requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-record-id="${next.original.id}"]`)?.focus())
                          }}
                          data-state={peekRecordId === row.original.id ? "selected" : undefined}
                          className={`group/row cursor-pointer border-0 outline-none data-[state=selected]:!bg-card focus-visible:ring-2 focus-visible:ring-primary/40 dark:data-[state=selected]:!bg-muted ${row.original.archive ? "opacity-55" : ""}`}
                        >
                          {row.getVisibleCells().map((cell) => (
                            <TableCell
                              key={cell.id}
                              className="overflow-hidden px-3 py-2 align-middle transition-colors group-data-[state=selected]/row:bg-muted/25 dark:group-data-[state=selected]/row:bg-muted/55"
                              style={{ width: cell.column.getSize(), maxWidth: cell.column.getSize() }}
                            >
                              {flexRender(cell.column.columnDef.cell, cell.getContext())}
                            </TableCell>
                          ))}
                          <TableCell className="w-9 px-1 py-2 align-middle transition-colors group-data-[state=selected]/row:bg-muted/25 dark:group-data-[state=selected]/row:bg-muted/55">
                            <RecordRowMenu
                              record={row.original}
                              onOpen={() => openPeek(row.original.id)}
                              onDuplicate={() => void duplicateRecord(row.original)}
                              onArchive={() => mutations.archive.mutate(row.original.id)}
                              onRestore={() => mutations.restore.mutate(row.original.id)}
                              onDelete={() => setDeleteTarget(row.original)}
                            />
                          </TableCell>
                        </TableRow>
                      )
                      if (!groupedRows) return renderedRows.map(renderRow)
                      return groupedRows.map(([key, group]) => {
                        const totals = groupTotals.get(key)
                        return (
                          <GroupSection
                            key={key}
                            colSpan={columns.length + 1}
                            column={groupColumn}
                            label={group.label}
                            totals={totals}
                            numberColumns={numberColumns}
                            labelFor={(field) => columnLabel(fieldColumns.find((entry) => entry.key === field) ?? { key: field, field: null })}
                            spaceId={spaceId}
                            expanded={expanded}
                          >
                            {group.rows.map(renderRow)}
                          </GroupSection>
                        )
                      })
                    })()}
                  </TableBody>
                  </table>
                </div>
              </div>

              {pagesQuery.hasNextPage && (
                <div className="flex shrink-0 justify-center py-4">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void pagesQuery.fetchNextPage()}
                    disabled={pagesQuery.isFetchingNextPage}
                  >
                    {pagesQuery.isFetchingNextPage ? (
                      <>
                        <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                        Loading…
                      </>
                    ) : (
                      `Load more (${rows.length} of ${totalLabel})`
                    )}
                  </Button>
                </div>
              )}
              <div className="h-6 shrink-0" />
            </>
          )}
        </div>

        <RecordPeek
          spaceId={spaceId}
          schema={schema}
          record={peekRecord}
          missing={peekFallback.isError}
          expanded={expanded}
          danglingByRecordField={danglingByRecordField}
          actions={peekActions}
          navigation={peekNavigation}
          open={Boolean(peekRecordId)}
          drawerMode={detailDrawer}
          onClose={closePeek}
        />
      </div>
      </DocumentReferenceScope>

      <NewRecordDialog
        open={newRecordOpen}
        spaceId={spaceId}
        schema={schema}
        onClose={() => setNewRecordOpen(false)}
        onCreate={async (data) => {
          const result = await mutations.create.mutateAsync(data)
          openPeek(result.recordId)
        }}
      />

      <SchemaEditorDialog
        open={schemaOpen}
        onClose={() => setSchemaOpen(false)}
        spaceId={spaceId}
        collectionId={collectionId}
        schema={schema}
        ready={health !== undefined}
        // schema.yaml present but unparseable — the editor must refuse to
        // seed an empty draft whose save would destroy the damaged schema.
        schemaError={
          health !== undefined && !health.schema
            ? (health.diagnostics?.find((diagnostic) => diagnostic.file === "schema.yaml")?.error ?? null)
            : null
        }
        collections={collections ?? []}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete record"
        variant="destructive"
        icon={<Trash className="h-5 w-5 text-destructive" />}
        description={
          <>
            Delete <span className="font-medium text-foreground">{deleteTarget ? recordTitle(deleteTarget, schema) : ""}</span>? This
            removes its YAML file and cannot be undone. Relations pointing at it follow their schema's delete policy.
          </>
        }
        confirmLabel="Delete"
        loading={mutations.remove.isPending}
        onConfirm={confirmDelete}
      />
      </TooltipProvider>
    </div>
  )
}

function ColumnHeaderLabel({ column }: { column: RecordFieldColumn }) {
  return <span className="whitespace-nowrap">{columnLabel(column)}</span>
}

/** Hover-revealed row actions. With every scalar cell owning its click for
 *  inline editing, "Open details" here is the explicit path to the peek
 *  (row clicks on non-editable areas still open it too). */
function RecordRowMenu({
  record,
  onOpen,
  onDuplicate,
  onArchive,
  onRestore,
  onDelete,
}: {
  record: RecordFile
  onOpen: () => void
  onDuplicate: () => void
  onArchive: () => void
  onRestore: () => void
  onDelete: () => void
}) {
  const archived = Boolean(record.archive)
  return (
    <span
      className="flex justify-end opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100 has-[[data-popup-open]]:opacity-100"
      onClick={(e) => e.stopPropagation()}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<button type="button" aria-label="Record actions" className="flex size-7 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted/50 hover:text-foreground" />}
        >
          <MoreVertical className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          <DropdownMenuItem onClick={onOpen}>
            <PanelRight className="mr-2 size-4" />
            Open details
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onDuplicate}>
            <Copy className="mr-2 size-4" />
            Duplicate
          </DropdownMenuItem>
          <DropdownMenuItem onClick={archived ? onRestore : onArchive}>
            {archived ? <RotateCcw className="mr-2 size-4" /> : <Archive className="mr-2 size-4" />}
            {archived ? "Restore" : "Archive"}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={onDelete}>
            <Trash className="mr-2 size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}

/** Group header + its rows. The header shows the group value (rendered with
 *  the field's own display), the TRUE total from the aggregate query, and
 *  sums for number fields. */
function GroupSection({
  colSpan,
  column,
  label,
  totals,
  numberColumns,
  labelFor,
  spaceId,
  expanded,
  children,
}: {
  colSpan: number
  column: RecordFieldColumn | undefined
  label: unknown
  totals: Record<string, unknown> | undefined
  numberColumns: string[]
  labelFor: (field: string) => string
  spaceId: string
  expanded: ExpandedRecords
  children: React.ReactNode
}) {
  const count = totals?.["count"]
  return (
    <>
      <TableRow className="border-b-0 hover:bg-transparent">
        <TableCell colSpan={colSpan} className="px-3 pb-1 pt-4">
          <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-sm font-medium text-foreground">
              {label === null || label === undefined || label === "" ? (
                <span className="text-muted-foreground">Empty</span>
              ) : column ? (
                <FieldValue column={column} value={label} spaceId={spaceId} expanded={expanded} />
              ) : (
                String(label)
              )}
            </span>
            {typeof count === "number" && <span className="text-xs text-muted-foreground">{count}</span>}
            {numberColumns.map((field) => {
              const sum = totals?.[`sum:${field}`]
              if (typeof sum !== "number" || sum === 0) return null
              return (
                <span key={field} className="text-xs text-muted-foreground">
                  {labelFor(field)} Σ {Number.isInteger(sum) ? sum.toLocaleString() : sum.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
              )
            })}
          </span>
        </TableCell>
      </TableRow>
      {children}
    </>
  )
}

// Field types that make sense as group keys (high-cardinality prose and
// opaque json/unknown values do not).
const GROUPABLE_TYPES = new Set(["string", "number", "boolean", "date", "datetime", "select", "multi_select", "relation", "document", "person", "url", "email"])

function GroupByPicker({
  columns,
  groupBy,
  onChange,
}: {
  columns: RecordFieldColumn[]
  groupBy: string | undefined
  onChange: (groupBy: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)
  const groupable = columns.filter((column) => GROUPABLE_TYPES.has(column.type))
  // An ACTIVE groupBy keeps the picker (and its Ungroup action) even when
  // nothing is currently groupable — stale persisted table state must stay escapable.
  if (groupable.length === 0 && !groupBy) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <PopoverTrigger
            render={<Button variant={groupBy ? "secondary" : "outline"} size="icon-sm" aria-label="Group records" aria-pressed={Boolean(groupBy)} />}
          >
              <Layers className="size-4" />
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>
          {groupBy
            ? `Grouped by ${columnLabel(columns.find((column) => column.key === groupBy) ?? { key: groupBy, field: null })}`
            : "Group records"}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-56 gap-0.5 p-1.5">
        {groupable.map((column) => (
          <button
            key={column.key}
            type="button"
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50 ${
              groupBy === column.key ? "text-foreground" : "text-muted-foreground"
            }`}
            onClick={() => {
              onChange(groupBy === column.key ? undefined : column.key)
              setOpen(false)
            }}
          >
            <span className="min-w-0 flex-1 truncate">{columnLabel(column)}</span>
            {groupBy === column.key && <span className="text-xs text-primary-text">on</span>}
          </button>
        ))}
        {groupBy && (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/50"
            onClick={() => {
              onChange(undefined)
              setOpen(false)
            }}
          >
            <X className="size-3.5" />
            Ungroup
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** Order-insensitive JSON key for group values: array order is editor click
 *  order, not identity. */
function normalizeGroupKey(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify([...value].map((entry) => String(entry)).sort())
  }
  return JSON.stringify(value ?? null)
}

// ── Browser-local table-state persistence (per collection) ────────────

interface PersistedTableState {
  filters?: RecordFilter[]
  groupBy?: string
  sort?: Array<{ f: string; d?: "asc" | "desc" }>
  cols?: ColumnPrefs
}

function tableStateStorageKey(spaceId: string, collectionId: string): string {
  // This key shipped in 0.0.28. Keep its legacy name so upgrades retain the
  // user's filters, grouping, sorting, and column preferences.
  return `worktable-records-view:${spaceId}:${collectionId}`
}

function loadPersistedTableState(spaceId: string, collectionId: string): PersistedTableState | null {
  try {
    const raw = localStorage.getItem(tableStateStorageKey(spaceId, collectionId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as PersistedTableState
    if (typeof parsed !== "object" || parsed === null) return null
    // Normalize cols: an entry from an older build (or hand-corrupted) may
    // miss the arrays, and applyColumnOrder would crash on order.length.
    const cols = parsed.cols
    parsed.cols = {
      hidden: Array.isArray(cols?.hidden) ? cols.hidden.filter((entry): entry is string => typeof entry === "string") : [],
      order: Array.isArray(cols?.order) ? cols.order.filter((entry): entry is string => typeof entry === "string") : [],
      widths: typeof cols?.widths === "object" && cols.widths !== null
        ? Object.fromEntries(Object.entries(cols.widths).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])))
        : {},
    }
    return parsed
  } catch {
    return null
  }
}

function defaultColumnWidth(column: RecordFieldColumn): number {
  if (column.type === "boolean") return 120
  if (column.type === "number" || column.type === "date" || column.type === "datetime") return 160
  if (column.type === "document" || column.type === "relation" || column.type === "text") return 260
  return 200
}

function persistTableState(spaceId: string, collectionId: string, state: PersistedTableState): void {
  try {
    localStorage.setItem(tableStateStorageKey(spaceId, collectionId), JSON.stringify(state))
  } catch {
    // Quota/private mode: persisted table defaults are best-effort.
  }
}

function RecordsPageMeta({ name, collectionId, updatedAt }: { name: string; collectionId: string; updatedAt?: string }) {
  const { setPageMeta } = usePageMeta()

  useEffect(() => {
    setPageMeta({
      updatedAtLabel: updatedAt ? formatUpdatedAt(updatedAt) : "Live",
      provenanceLabel: `Record collection · ${collectionId}`,
      titleOverride: name,
    })
    return () => setPageMeta(null)
  }, [setPageMeta, name, collectionId, updatedAt])

  return null
}

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return "Updated recently"
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}
