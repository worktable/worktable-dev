import { AlertTriangle, Archive, Check, FileText, Minus } from "lucide-react"
import { createContext, useContext, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { RecordFile, ResolvedDocumentReference } from "@worktable/types"
import type { RecordFieldColumn } from "@/lib/records"
import { optionColorClass, recordTitle, relationIds } from "@/lib/records"
import { documentReferencesQueryOptions } from "@/lib/docs-queries"

/** Merged `expanded` maps from every loaded query page, keyed collection → id. */
export type ExpandedRecords = Record<string, Record<string, RecordFile>>

const DocumentReferenceContext = createContext<{
  spaceId: string
  requestedPaths: ReadonlySet<string>
  references: Map<string, ResolvedDocumentReference> | null
} | null>(null)

/** Batch document resolution for a records surface. Cell renderers inside the
 * scope never fan out into one HTTP request per row. */
export function DocumentReferenceScope({ spaceId, paths, children }: { spaceId: string; paths: string[]; children: React.ReactNode }) {
  const { data } = useQuery(documentReferencesQueryOptions(spaceId, paths))
  const requestedPaths = useMemo(() => new Set(paths), [paths])
  const references = useMemo(() => data ? new Map(data.map((reference) => [reference.storedPath, reference])) : null, [data])
  return <DocumentReferenceContext.Provider value={{ spaceId, requestedPaths, references }}>{children}</DocumentReferenceContext.Provider>
}

/**
 * Single source of truth for rendering a record field value, shared by the
 * grid cells and the peek panel. Read-only in M1; inline editors wrap this
 * in M2.
 */
export function FieldValue({
  column,
  value,
  spaceId,
  expanded,
  danglingTargets,
  linksDisabled = false,
  mode = "cell",
}: {
  column: RecordFieldColumn
  value: unknown
  spaceId: string
  expanded?: ExpandedRecords
  /** `collection/recordId` targets the integrity sweep flagged for this record's field. */
  danglingTargets?: ReadonlySet<string>
  /** Render url/email as plain text: in edit contexts (the peek rows) the
   *  anchor's own click handling would swallow the click that should start
   *  editing. Relation chips keep navigating either way. */
  linksDisabled?: boolean
  /** Grid cells stay concise; detail surfaces preserve long-form content and
   * show every related object. */
  mode?: "cell" | "detail"
}) {
  if (value === undefined || value === null || value === "") {
    return <span className="text-muted-foreground/40">—</span>
  }

  switch (column.type) {
    case "boolean":
      // Strict: file-authored data isn't validated on read, so a quoted
      // "false" must not render as Yes — non-booleans show their raw value.
      if (value === true) return mode === "detail" ? <span className="inline-flex items-center gap-1.5"><Check className="size-4 text-success" />Yes</span> : <Check className="size-4 text-muted-foreground" aria-label="Yes" />
      if (value === false) return mode === "detail" ? <span className="inline-flex items-center gap-1.5 text-muted-foreground"><Minus className="size-4" />No</span> : <Minus className="size-4 text-muted-foreground/40" aria-label="No" />
      return (
        <span className="font-mono text-xs text-muted-foreground" title="Not a boolean value">
          {safeStringify(value)}
        </span>
      )
    case "number": {
      const text = typeof value === "number" ? formatNumber(value) : String(value)
      return (
        <span className="font-mono text-[13px] tabular-nums">
          {text}
          {column.field?.unit ? <span className="ml-1 text-muted-foreground">{column.field.unit}</span> : null}
        </span>
      )
    }
    case "date":
    case "datetime":
      return <span className="whitespace-nowrap text-muted-foreground">{formatDate(String(value), column.type === "datetime")}</span>
    case "url": {
      const href = String(value)
      // Record data is agent- and file-authored: only http(s) may render as a
      // clickable anchor, anything else (javascript:, data:, ...) stays text.
      if (!isSafeHttpUrl(href) || linksDisabled) {
        return <span className={mode === "detail" ? "break-all text-muted-foreground" : "truncate text-muted-foreground"} title={href}>{href}</span>
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className={mode === "detail" ? "break-all text-primary-text underline-offset-2 hover:underline" : "truncate text-primary-text underline-offset-2 hover:underline"}
          title={href}
        >
          {href.replace(/^https?:\/\//, "")}
        </a>
      )
    }
    case "email": {
      const email = String(value)
      if (linksDisabled) {
        return <span className={mode === "detail" ? "break-all text-muted-foreground" : "truncate text-muted-foreground"}>{email}</span>
      }
      return (
        <a
          href={`mailto:${email}`}
          onClick={(e) => e.stopPropagation()}
          className="truncate text-primary-text underline-offset-2 hover:underline"
        >
          {email}
        </a>
      )
    }
    case "select":
      return <SelectChip value={String(value)} />
    case "multi_select": {
      const values = Array.isArray(value) ? value.map(String) : [String(value)]
      const visible = mode === "cell" ? values.slice(0, 3) : values
      return (
        <span className="flex flex-wrap gap-1">
          {visible.map((entry) => (
            <SelectChip key={entry} value={entry} />
          ))}
          {visible.length < values.length && <OverflowCount count={values.length - visible.length} />}
        </span>
      )
    }
    case "relation": {
      const target = column.field?.references
      const ids = relationIds(value)
      if (ids.length === 0) return <span className="text-muted-foreground/40">—</span>
      const visible = mode === "cell" ? ids.slice(0, 2) : ids
      return (
        <span className="flex flex-wrap gap-1">
          {visible.map((id) => (
            <RelationChip
              key={id}
              spaceId={spaceId}
              collectionId={target}
              recordId={id}
              expanded={expanded}
              dangling={danglingTargets?.has(`${target}/${id}`) ?? false}
            />
          ))}
          {visible.length < ids.length && <OverflowCount count={ids.length - visible.length} />}
        </span>
      )
    }
    case "document":
      return <DocumentValue spaceId={spaceId} value={value} linksDisabled={linksDisabled} mode={mode} />
    case "person":
      return <span className={mode === "detail" ? "break-words" : "truncate"}>{String(value)}</span>
    case "json":
    case "unknown":
      return (
        <span className={mode === "detail" ? "block whitespace-pre-wrap break-words font-mono text-xs leading-5 text-muted-foreground" : "block max-w-72 truncate font-mono text-xs text-muted-foreground"} title={safeStringify(value)}>
          {safeStringify(value)}
        </span>
      )
    default:
      // string, text, and any type this build doesn't know (tolerant reader).
      return <span className={mode === "detail" ? "whitespace-pre-wrap break-words leading-6" : "line-clamp-2 break-words"}>{typeof value === "string" ? value : safeStringify(value)}</span>
  }
}

function DocumentValue({ spaceId, value, linksDisabled, mode }: { spaceId: string; value: unknown; linksDisabled: boolean; mode: "cell" | "detail" }) {
  const inputs: unknown[] = typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value
      : [value]
  const scope = useContext(DocumentReferenceContext)
  const coveredByScope = scope?.spaceId === spaceId
  const scopedReferences = coveredByScope ? scope?.references : null
  // Aggregate/group values can fall outside the currently loaded row page.
  // Resolve those scope misses locally, including when the scope's own batch
  // is empty. Non-string file drift always goes to the resolver as raw input
  // so it stays visibly invalid instead of becoming a plausible string path.
  const localIndexes = inputs.flatMap((input, index) =>
    typeof input !== "string" || !coveredByScope || !scope.requestedPaths.has(input) ? [index] : []
  )
  const localInputs = localIndexes.map((index) => inputs[index])
  const { data } = useQuery(documentReferencesQueryOptions(spaceId, localInputs))
  const localReferences = new Map(localIndexes.flatMap((inputIndex, resultIndex) => {
    const reference = data?.[resultIndex]
    return reference ? [[inputIndex, reference] as const] : []
  }))
  const references = inputs.map((input, index): ResolvedDocumentReference => {
    const path = typeof input === "string" ? input : null
    return (path ? scopedReferences?.get(path) : undefined) ?? localReferences.get(index) ?? (path ? {
      storedPath: path,
      resolvedPath: path,
      title: path.split("/").at(-1) || path,
      state: "available",
    } : {
      storedPath: safeStringify(input),
      resolvedPath: null,
      title: "Invalid document value",
      state: "invalid",
      error: "must be a document path string",
    })
  })
  const visible = mode === "cell" ? references.slice(0, 2) : references
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {visible.map((reference, index) => (
        <DocumentChip key={`${reference.storedPath}:${index}`} reference={reference} linksDisabled={linksDisabled} spaceId={spaceId} />
      ))}
      {visible.length < references.length && <OverflowCount count={references.length - visible.length} />}
    </span>
  )
}

function OverflowCount({ count }: { count: number }) {
  return <span className="inline-flex h-6 items-center rounded-full border border-border bg-muted/20 px-2 text-xs text-muted-foreground">+{count}</span>
}

function DocumentChip({ reference, linksDisabled, spaceId }: { reference: ResolvedDocumentReference; linksDisabled: boolean; spaceId: string }) {
  const stateLabel = reference.state === "available" ? "" : ` · ${reference.state}`
  const chip = (
    <span
      className={`inline-flex max-w-56 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
        reference.state === "invalid" || reference.state === "missing"
          ? "border-destructive/35 bg-destructive/5 text-destructive"
          : reference.state === "archived"
            ? "border-border bg-muted/40 text-muted-foreground"
            : "border-border bg-muted/30 text-foreground"
      }`}
      title={`${reference.storedPath}${reference.resolvedPath && reference.resolvedPath !== reference.storedPath ? ` → ${reference.resolvedPath}` : ""}${stateLabel}${reference.error ? ` · ${reference.error}` : ""}`}
    >
      {reference.state === "archived" ? <Archive className="size-3 shrink-0" /> : reference.state === "missing" || reference.state === "invalid" ? <AlertTriangle className="size-3 shrink-0" /> : <FileText className="size-3 shrink-0 text-primary-text" />}
      <span className="truncate">{reference.title}</span>
    </span>
  )
  if (linksDisabled || !reference.resolvedPath || reference.state === "missing" || reference.state === "invalid") return chip
  return (
    <Link
      to="/spaces/$spaceId/documents/$"
      params={{ spaceId, _splat: reference.resolvedPath }}
      onClick={(event) => event.stopPropagation()}
      className="transition-opacity hover:opacity-80"
    >
      {chip}
    </Link>
  )
}

/** Neutral chip with a hash-colored dot: bronze and cobalt stay reserved for
 *  material and action; the dot alone differentiates option values. */
function SelectChip({ value }: { value: string }) {
  return (
    <span className="inline-flex max-w-48 items-center gap-1.5 rounded-full border border-border bg-muted/30 px-2 py-0.5 text-xs">
      <span className={`size-1.5 shrink-0 rounded-full ${optionColorClass(value)}`} />
      <span className="truncate">{value}</span>
    </span>
  )
}

function RelationChip({
  spaceId,
  collectionId,
  recordId,
  expanded,
  dangling,
}: {
  spaceId: string
  collectionId: string | undefined
  recordId: string
  expanded?: ExpandedRecords
  dangling?: boolean
}) {
  // A missing expansion is NOT evidence of a dangling reference: expand
  // honors includeArchived, so a valid link to an archived record has no
  // target here. Only the server's integrity sweep marks a chip broken.
  const target = collectionId ? expanded?.[collectionId]?.[recordId] : undefined
  const label = target ? recordTitle(target) : recordId
  const chip = (
    <span
      className={`inline-flex max-w-48 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${
        dangling ? "border-destructive/40 text-destructive" : "border-border bg-muted/30"
      }`}
      title={dangling ? `${recordId} not found in ${collectionId}` : recordId}
    >
      <span className={`size-1.5 shrink-0 rounded-full ${dangling ? "bg-destructive/70" : "bronze-knob"}`} />
      <span className="truncate">{label}</span>
    </span>
  )
  if (!collectionId || dangling) return chip
  return (
    <Link
      to="/spaces/$spaceId/records/$"
      params={{ spaceId, _splat: collectionId }}
      search={{ record: recordId }}
      onClick={(e) => e.stopPropagation()}
      className="transition-opacity hover:opacity-80"
    >
      {chip}
    </Link>
  )
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
  } catch {
    return false
  }
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 4 })
}

function formatDate(value: string, withTime: boolean): string {
  // Date-only strings must parse as LOCAL dates: new Date("2026-07-11") is
  // UTC midnight, which renders as the previous day west of UTC.
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  })
}

function safeStringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}
