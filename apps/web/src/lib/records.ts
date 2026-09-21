import { toast } from "@worktable/ui/components/sonner"
import type { RecordCollectionSchema, RecordField, RecordFile, RecordPredicateOp, RecordQueryResult } from "@worktable/types"
import { normalizeRecordFieldType, parseDocumentReference } from "@worktable/types"

/** A grid/peek column: schema fields in declared order, then any keys present
 *  in the loaded data that the schema doesn't know (schemaless collections,
 *  hand-edited YAML). Unschema'd keys render as read-only json-ish values. */
export interface RecordFieldColumn {
  key: string
  field: RecordField | null
  /** Normalized type (`enum`→`select`, `reference`→`relation`); "unknown" without a schema. */
  type: string
}

/** Merge server query warnings across loaded pages and aggregate queries. */
export function collectRecordQueryWarnings(
  results: readonly (Pick<RecordQueryResult, "warnings"> | undefined)[]
): string[] {
  return [...new Set(results.flatMap((result) => result?.warnings ?? []))]
}

export function recordFieldColumns(schema: RecordCollectionSchema | undefined, records: RecordFile[]): RecordFieldColumn[] {
  const columns: RecordFieldColumn[] = []
  const seen = new Set<string>()
  for (const [key, field] of Object.entries(schema?.fields ?? {})) {
    columns.push({ key, field, type: normalizeRecordFieldType(field.type) })
    seen.add(key)
  }
  for (const record of records) {
    for (const key of Object.keys(record.data)) {
      if (seen.has(key)) continue
      seen.add(key)
      columns.push({ key, field: null, type: "unknown" })
    }
  }
  return columns
}

export interface RecordDetailSections {
  title: RecordFieldColumn | null
  narrative: RecordFieldColumn[]
  primary: RecordFieldColumn[]
  secondary: RecordFieldColumn[]
  sources: RecordFieldColumn[]
  unmodeled: RecordFieldColumn[]
}

/** Index integrity warnings by their rendered record field while preserving
 * target-level precision for multi-relation values. */
export function indexDanglingRelations(
  warnings: Array<{ recordId: string; field: string; target: string }>
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  for (const warning of warnings) {
    const key = `${warning.recordId}:${warning.field}`
    if (!map.has(key)) map.set(key, new Set())
    map.get(key)!.add(warning.target)
  }
  return map
}

/** Resolve stored document aliases before assigning rows to aggregate-backed
 * group buckets, so old and current paths share one visible group. */
export function resolveDocumentGroupValue(value: unknown, identities: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return identities.get(value) ?? value
  if (Array.isArray(value)) {
    return value.map((entry) => typeof entry === "string" ? identities.get(entry) ?? entry : entry)
  }
  return value
}

export function documentPathIsSelected(selected: string[], candidate: string, identities: ReadonlyMap<string, string>): boolean {
  const candidateIdentity = identities.get(candidate) ?? candidate
  return selected.some((path) => (identities.get(path) ?? path) === candidateIdentity)
}

export function toggleDocumentPath(selected: string[], candidate: string, identities: ReadonlyMap<string, string>): string[] {
  const candidateIdentity = identities.get(candidate) ?? candidate
  return documentPathIsSelected(selected, candidate, identities)
    ? selected.filter((path) => (identities.get(path) ?? path) !== candidateIdentity)
    : [...selected, candidate]
}

export function normalizeDocumentPickerSearch(search: string): { fallbackPath: string | null; normalizedSearch: string } {
  const parsed = parseDocumentReference(search)
  const fallbackPath = typeof parsed.path === "string" ? parsed.path : null
  return {
    fallbackPath,
    normalizedSearch: (fallbackPath ?? search).toLocaleLowerCase(),
  }
}

export function canApplyFilterValue(needsValue: boolean, value: unknown): boolean {
  return !needsValue || (value !== undefined && value !== null && value !== "")
}

/**
 * Turn a generic schema into a predictable record-detail hierarchy. The
 * schema still owns order; this only assigns spatial roles so a detail view
 * does not render every value as one undifferentiated stack.
 */
export function recordDetailSections(
  schema: RecordCollectionSchema | undefined,
  record: RecordFile,
  primaryLimit = 5
): RecordDetailSections {
  const columns = recordFieldColumns(schema, [record])
  const titleKey = recordTitleKey(schema)
  const title = titleKey ? (columns.find((column) => column.key === titleKey) ?? null) : null
  const modeled = columns.filter((column) => column.field && column.key !== titleKey)
  const narrative = modeled.filter((column) => column.type === "text")
  const sources = modeled.filter((column) => column.type === "document")
  const properties = modeled.filter((column) => column.type !== "text" && column.type !== "document")

  return {
    title,
    narrative,
    primary: properties.slice(0, primaryLimit),
    secondary: properties.slice(primaryLimit),
    sources,
    unmodeled: columns.filter((column) => !column.field),
  }
}

/** The field recordTitle reads: title/name, else the first required string field. */
export function recordTitleKey(schema: RecordCollectionSchema | undefined): string | null {
  if (!schema) return null
  for (const key of ["title", "name"]) {
    const field = schema.fields[key]
    if (field && normalizeRecordFieldType(field.type) === "string") return key
  }
  for (const [key, field] of Object.entries(schema.fields)) {
    if (field.required && normalizeRecordFieldType(field.type) === "string") return key
  }
  return null
}

/** Display title for a record: an explicit title/name field, else the first
 *  required string field with a value, else the record id. */
export function recordTitle(record: RecordFile, schema?: RecordCollectionSchema): string {
  const direct = record.data["title"] ?? record.data["name"]
  if (typeof direct === "string" && direct.trim()) return direct
  if (schema) {
    const key = recordTitleKey(schema)
    if (key) {
      const value = record.data[key]
      if (typeof value === "string" && value.trim()) return value
    }
  }
  return record.id
}

/** Human label for a field key (schemas keep slug keys; the UI titles them). */
export function fieldLabel(key: string): string {
  const cleaned = key.replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2").replace(/[-_]+/g, " ").trim()
  return cleaned.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase())
}

/** Display label for a field: the schema's display `name` when set (M4
 *  schema editor), else the humanized slug key. */
export function columnLabel(column: { key: string; field?: RecordField | null }): string {
  const name = column.field?.name?.trim()
  return name || fieldLabel(column.key)
}

/** Stable select-option dot color: hash the option value onto the chart ramp.
 *  Chips themselves stay neutral (bronze is reserved for material accents,
 *  cobalt for actions); only the dot differentiates. */
export function optionColorClass(value: string): string {
  const palette = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"]
  let hash = 0
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0
  return palette[Math.abs(hash) % palette.length]
}

/** Relation values are a single id or an id list in YAML; normalize for display. */
export function relationIds(value: unknown): string[] {
  if (typeof value === "string" && value) return [value]
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string")
  return []
}

/** Required booleans toggle; optional booleans cycle through yes, no, unset. */
export function nextBooleanValue(value: unknown, required: boolean): boolean | null {
  if (required) return value !== true
  if (value === true) return false
  if (value === false) return null
  return true
}

/** Toast helper shared by record mutations: surface the server's message
 *  (validation errors name the offending field) instead of a generic failure. */
export function toastRecordError(err: unknown, fallback: string) {
  const message = err instanceof Error && err.message ? err.message : fallback
  toast.error(message)
}

// ── Filters (M3 table controls) ──────────────────────────────

/** One filter chip: a predicate-AST leaf with compact keys for the URL. */
export interface RecordFilter {
  f: string
  op: RecordPredicateOp
  v?: unknown
}

/** Compile chips to the server's predicate tree. ALWAYS wrapped in `and`,
 *  even for one filter: a bare `{field, op, value}` object at the top level
 *  reads as a legacy flat where-map on fields named "field"/"op"/"value". */
export function compileFilters(filters: RecordFilter[]): Record<string, unknown> | undefined {
  if (filters.length === 0) return undefined
  return { and: filters.map((filter) => ({ field: filter.f, op: filter.op, ...(filter.v !== undefined ? { value: filter.v } : {}) })) }
}

export const FILTER_OPS: RecordPredicateOp[] = ["eq", "neq", "in", "contains", "has", "gt", "gte", "lt", "lte", "isEmpty"]

export const FILTER_OP_LABELS: Record<RecordPredicateOp, string> = {
  eq: "is",
  neq: "is not",
  in: "is any of",
  contains: "contains",
  has: "has",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  isEmpty: "is empty",
}

/** Which operators make sense per (normalized) field type. Array-valued
 *  fields (multi_select, many-relations) use `has`: exact membership in the
 *  query grammar. `contains` is substring and would make option "art" match
 *  a record tagged "cart". */
export function filterOpsForType(type: string, field?: RecordField | null): RecordPredicateOp[] {
  switch (type) {
    case "number":
      return ["eq", "neq", "gt", "gte", "lt", "lte", "isEmpty"]
    case "date":
    case "datetime":
      return ["gte", "lte", "eq", "isEmpty"]
    case "boolean":
      return ["eq"]
    case "select":
      return ["eq", "neq", "isEmpty"]
    case "multi_select":
      return ["has", "isEmpty"]
    case "relation":
      return field?.many ? ["has", "isEmpty"] : ["eq", "isEmpty"]
    case "document":
      return field?.many ? ["has", "isEmpty"] : ["eq", "neq", "isEmpty"]
    case "json":
      return ["isEmpty"]
    default:
      // string, text, url, email, person, unknown
      return ["contains", "eq", "neq", "isEmpty"]
  }
}

/** Structural validation for one filter: does the value shape fit the
 *  operator? Malformed chips (shared URLs, stale localStorage) must be
 *  dropped BEFORE compiling, or the server 400s the whole grid query. */
export function isValidFilter(filter: RecordFilter): boolean {
  if (!filter.f || !FILTER_OPS.includes(filter.op)) return false
  switch (filter.op) {
    case "isEmpty":
      return filter.v === undefined || typeof filter.v === "boolean"
    case "contains":
      return typeof filter.v === "string"
    case "has":
      return ["string", "number", "boolean"].includes(typeof filter.v)
    case "in":
      return Array.isArray(filter.v) && filter.v.every((entry) => ["string", "number", "boolean"].includes(typeof entry))
    case "gt":
    case "gte":
    case "lt":
    case "lte":
      return typeof filter.v === "string" || typeof filter.v === "number"
    default:
      // eq / neq
      return ["string", "number", "boolean"].includes(typeof filter.v)
  }
}

/** isEmpty chips render as "is empty" / "is not empty" via the value. */
export function filterLabel(filter: RecordFilter): string {
  if (filter.op === "isEmpty") return filter.v === false ? "is not empty" : "is empty"
  return FILTER_OP_LABELS[filter.op]
}

// ── Column prefs (M3 table controls) ─────────────────────────

export interface ColumnPrefs {
  hidden: string[]
  order: string[]
  widths: Record<string, number>
}

/** Order columns by saved prefs: known keys in saved order first, then any
 *  new fields in their natural position at the end. */
export function applyColumnOrder(columns: RecordFieldColumn[], order: string[]): RecordFieldColumn[] {
  if (order.length === 0) return columns
  const byKey = new Map(columns.map((column) => [column.key, column]))
  const ordered: RecordFieldColumn[] = []
  for (const key of order) {
    const column = byKey.get(key)
    if (column) {
      ordered.push(column)
      byKey.delete(key)
    }
  }
  return [...ordered, ...byKey.values()]
}

/** Field types the grid edits in place. Relations edit through the peek's
 *  picker; json through the peek's text editor; unknown types stay read-only. */
export const INLINE_EDITABLE_TYPES = new Set([
  "string",
  "text",
  "number",
  "boolean",
  "date",
  "datetime",
  "url",
  "email",
  "person",
  "select",
  "multi_select",
  "document",
])

/**
 * Convert raw editor input (strings from inputs, arrays from chip toggles)
 * into the typed value the server validates. Shared by the new-record dialog,
 * inline cells, and the peek editors. Empty input returns `{ value: null }` —
 * PATCH merges shallowly, so clearing a field needs an explicit null.
 */
export function coerceFieldInput(
  column: { type: string; field: RecordField | null },
  raw: unknown
): { value?: unknown; error?: string } {
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "") || (Array.isArray(raw) && raw.length === 0)) {
    return { value: null }
  }
  switch (column.type) {
    case "number": {
      const parsed = Number(String(raw).trim())
      // isFinite, not just isNaN: 1e309 parses to Infinity, which JSON
      // serializes to null and would silently blank the field.
      if (!Number.isFinite(parsed)) return { error: "Must be a number" }
      return { value: parsed }
    }
    case "json": {
      if (typeof raw !== "string") return { value: raw }
      try {
        return { value: JSON.parse(raw) }
      } catch {
        return { error: "Must be valid JSON" }
      }
    }
    case "relation": {
      if (column.field?.many) {
        const ids = Array.isArray(raw)
          ? raw.filter((entry): entry is string => typeof entry === "string")
          : String(raw)
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean)
        return { value: ids.length > 0 ? ids : null }
      }
      return { value: typeof raw === "string" ? raw.trim() : raw }
    }
    case "document": {
      const inputs = column.field?.many
        ? Array.isArray(raw)
          ? raw
          : String(raw).split(",").map((entry) => entry.trim()).filter(Boolean)
        : [raw]
      const paths: string[] = []
      for (const input of inputs) {
        const parsed = parseDocumentReference(input)
        if ("error" in parsed) return { error: parsed.error }
        paths.push(parsed.path)
      }
      return { value: column.field?.many ? paths : paths[0] }
    }
    case "multi_select": {
      // Optionless multi_select fields collect a comma-separated string.
      if (typeof raw === "string") {
        const values = raw
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
        return { value: values.length > 0 ? values : null }
      }
      return { value: raw }
    }
    case "datetime": {
      // Editor input is a LOCAL datetime-local string; store canonical ISO so
      // agent-written and UI-written values share one format. Unparseable
      // strings pass through (the server accepts any string for datetime).
      const parsed = new Date(String(raw))
      return Number.isNaN(parsed.getTime()) ? { value: raw } : { value: parsed.toISOString() }
    }
    case "string":
    case "text":
    case "url":
    case "email":
    case "person":
      return { value: typeof raw === "string" ? raw : String(raw) }
    default:
      return { value: raw }
  }
}

/**
 * The string an input editor starts from. date/datetime need conversion: a
 * stored ISO timestamp with a timezone suffix makes a datetime-local input
 * sanitize its value to EMPTY, so merely opening the editor and blurring
 * would clear the field. Round trip: local seed → coerceFieldInput → the
 * same ISO, so an untouched blur is a no-op commit.
 */
export function fieldEditorSeed(column: { type: string }, value: unknown): unknown {
  if (column.type === "document" && Array.isArray(value)) return value.join(", ")
  if (column.type === "multi_select" && Array.isArray(value)) return value.join(", ")
  if (column.type === "datetime" && typeof value === "string" && value) {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    const pad = (n: number) => String(n).padStart(2, "0")
    const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
    return date.getSeconds() > 0 ? `${base}:${pad(date.getSeconds())}` : base
  }
  if (column.type === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    // A full timestamp in a date field would blank a type=date input too.
    return value.slice(0, 10)
  }
  return value
}
