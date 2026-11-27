import { useMemo, type ReactNode } from "react"
import { useInfiniteQuery } from "@tanstack/react-query"
import type {
  DocumentListItem,
  RecordChange,
  RecordCollectionSchema,
  RecordFile,
  RecordValueChange,
} from "@worktable/types"
import { normalizeRecordFieldType } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { ArrowRight } from "lucide-react"
import { queryKeys, useActorName } from "@/lib/queries"
import {
  columnLabel,
  formatRecordDate,
  formatRecordNumber,
  type RecordFieldColumn,
} from "@/lib/records"
import { readRecordHistory } from "@/lib/records-api"
import { RelativeTime } from "@/lib/time"
import { humanizeSegment } from "@/lib/tree"
import {
  DocumentReferenceScope,
  FieldValue,
  type ExpandedRecords,
} from "./field-value"

const KIND_WORDS: Record<Exclude<RecordChange["kind"], "changed">, string> = {
  added: "Added",
  archived: "Archived",
  restored: "Restored",
}

function columnFor(
  key: string,
  schema: RecordCollectionSchema | undefined
): RecordFieldColumn {
  const field = schema?.fields[key] ?? null
  return {
    key,
    field,
    type: field ? normalizeRecordFieldType(field.type) : "unknown",
  }
}

/** Values that are a list: a change to one shows only with every entry. */
const LIST_TYPES = new Set(["multi_select", "relation", "document", "file"])

/** Every document a kept value names, to look them all up in one request. */
function documentPaths(
  changes: readonly RecordChange[],
  schema: RecordCollectionSchema | undefined
): string[] {
  const paths = new Set<string>()
  for (const change of changes) {
    for (const [key, value] of Object.entries(change.fields ?? {})) {
      if (columnFor(key, schema).type !== "document") continue
      for (const side of [value.before, value.after]) {
        for (const entry of Array.isArray(side) ? side : [side]) {
          if (typeof entry === "string" && entry) paths.add(entry)
        }
      }
    }
  }
  return [...paths]
}

/**
 * Whether two values that differ read the same the way a cell shows them: a
 * number past its fourth decimal place, a time within the same minute.
 */
function readTheSame(type: string, before: unknown, after: unknown): boolean {
  if (type === "number") {
    return (
      typeof before === "number" &&
      typeof after === "number" &&
      formatRecordNumber(before) === formatRecordNumber(after)
    )
  }
  if (type === "date" || type === "datetime") {
    const withTime = type === "datetime"
    return (
      formatRecordDate(String(before), withTime) ===
      formatRecordDate(String(after), withTime)
    )
  }
  return false
}

/** Text that opens the same for longer than this starts near where it differs. */
const SHARED_OPENING = 40
/** How much of the shared opening stays in front of the first difference. */
const KEPT_OPENING = 24

/**
 * Two texts from where they first differ, so an edit far into a long text
 * shows within the lines a row has. Each starts at a whole word.
 */
function fromFirstDifference(before: string, after: string): [string, string] {
  const limit = Math.min(before.length, after.length)
  let shared = 0
  while (shared < limit && before[shared] === after[shared]) shared++
  if (shared <= SHARED_OPENING) return [before, after]
  let start = shared - KEPT_OPENING
  while (start > 0 && !/\s/.test(before[start - 1])) start--
  if (start === 0) return [before, after]
  return [`…${before.slice(start)}`, `…${after.slice(start)}`]
}

/** One value as it was and as it became; a side with no value shows nothing. */
function ValueChange({
  label,
  column,
  change,
  spaceId,
  expanded,
}: {
  label: ReactNode
  column: RecordFieldColumn
  change: RecordValueChange
  spaceId: string
  expanded?: ExpandedRecords
}) {
  const filled = (side: unknown) => side !== undefined && side !== null && side !== ""
  const had = change.beforeTooLarge === true || filled(change.before)
  const has = change.afterTooLarge === true || filled(change.after)
  // A value too large to have been kept has nothing to show.
  const tooLarge = <span className="text-muted-foreground">Too large to show</span>
  // A kept change is two values that differ, so a row never shows them
  // reading the same: where a cell's short form would, each shows as written.
  const exact = had && has && readTheSame(column.type, change.before, change.after)
  const [before, after] =
    (column.type === "string" || column.type === "text") &&
    typeof change.before === "string" &&
    typeof change.after === "string"
      ? fromFirstDifference(change.before, change.after)
      : [change.before, change.after]
  const value = (side: unknown) =>
    exact ? (
      <span className="font-mono text-[13px] tabular-nums">
        {String(side)}
        {column.field?.unit ? (
          <span className="ml-1 text-muted-foreground">{column.field.unit}</span>
        ) : null}
      </span>
    ) : (
      <FieldValue
        column={column}
        value={side}
        spaceId={spaceId}
        expanded={expanded}
        linksDisabled
        rowHeight={LIST_TYPES.has(column.type) ? "full" : undefined}
      />
    )
  return (
    <div className="grid grid-cols-[minmax(5.5rem,0.34fr)_minmax(0,1fr)] items-start gap-3">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-foreground/90">
        {had && (
          <span className="min-w-0 text-muted-foreground line-through decoration-muted-foreground/60">
            {change.beforeTooLarge ? tooLarge : value(before)}
          </span>
        )}
        {has ? (
          // The arrow stays with the value it points at when the line breaks.
          <span className="flex min-w-0 items-center gap-1.5">
            {had && (
              <ArrowRight
                aria-label="changed to"
                className="size-3 shrink-0 text-muted-foreground"
              />
            )}
            <span className="min-w-0">
              {change.afterTooLarge ? tooLarge : value(after)}
            </span>
          </span>
        ) : (
          <span className="text-muted-foreground">Cleared</span>
        )}
      </dd>
    </div>
  )
}

/**
 * A record's changes, newest first: who changed what, and what it replaced.
 * Read when it is shown, and again only after the record changes.
 */
export function RecordHistory({
  spaceId,
  schema,
  record,
  expanded,
  documents,
}: {
  spaceId: string
  schema: RecordCollectionSchema | undefined
  record: RecordFile
  expanded?: ExpandedRecords
  /** The Space's documents, to name a page a change was made through. */
  documents?: readonly DocumentListItem[]
}) {
  const nameOf = useActorName()
  const { data, isPending, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: [
        ...queryKeys.records(spaceId, record.collectionId),
        "history",
        record.id,
        record.updatedAt,
      ],
      queryFn: ({ pageParam }) =>
        readRecordHistory(spaceId, record.collectionId, record.id, pageParam),
      initialPageParam: undefined as string | undefined,
      // Older changes are asked for from the last one shown, while any remain.
      getNextPageParam: (last, pages) =>
        pages.reduce((shown, page) => shown + page.changes.length, 0) < last.total
          ? last.changes.at(-1)?.id
          : undefined,
      // History for one state of the record never changes.
      staleTime: Number.POSITIVE_INFINITY,
    })
  const changes = useMemo(
    () => data?.pages.flatMap((page) => page.changes) ?? [],
    [data]
  )
  const paths = useMemo(() => documentPaths(changes, schema), [changes, schema])
  if (isPending) {
    return (
      <div aria-hidden className="space-y-2 pt-1">
        <div className="h-3 w-2/3 rounded bg-surface-inset" />
        <div className="h-3 w-1/2 rounded bg-surface-inset" />
      </div>
    )
  }
  // Changes already shown stay when older ones fail to load: Show Older
  // asks for them again.
  if (!data) return <p>Couldn’t load the history.</p>
  if (changes.length === 0) return <p>No changes kept yet.</p>
  const pageTitle = (path: string) => {
    const page = documents?.find(
      (item) => item.kind === "document" && item.path === path
    )
    return page?.kind === "document"
      ? page.title
      : humanizeSegment(path.split("/").at(-1) ?? path)
  }
  const list = (
    <ol className="divide-y divide-border/60">
      {changes.map((change) => {
        // A field and one of the record's other values can share a name, so
        // each keeps its own row: a field under its name, the other as written.
        const rows = [
          ...Object.entries(change.fields ?? {}).map(([key, value]) => {
            const column = columnFor(key, schema)
            return { id: `field:${key}`, label: columnLabel(column), column, value }
          }),
          ...Object.entries(change.metadata ?? {}).map(([key, value]) => ({
            id: `metadata:${key}`,
            label: <span className="font-mono">{key}</span>,
            column: { key, field: null, type: "unknown" } as RecordFieldColumn,
            value,
          })),
        ]
        return (
          <li key={change.id} className="space-y-2 py-3 first:pt-1 last:pb-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0">
                <span className="font-medium text-foreground">
                  {nameOf(change.by)}
                </span>
                {change.page && <> on {pageTitle(change.page)}</>}
                {change.kind !== "changed" && (
                  <> · {KIND_WORDS[change.kind]}</>
                )}
              </span>
              <RelativeTime iso={change.at} />
            </div>
            {change.reason && <p>{change.reason}</p>}
            {rows.length > 0 && (
              <dl className="space-y-1.5">
                {rows.map((row) => (
                  <ValueChange
                    key={row.id}
                    label={row.label}
                    column={row.column}
                    change={row.value}
                    spaceId={spaceId}
                    expanded={expanded}
                  />
                ))}
              </dl>
            )}
          </li>
        )
      })}
      {hasNextPage && (
        <li className="pt-2">
          <Button
            variant="ghost"
            size="xs"
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
          >
            Show Older
          </Button>
        </li>
      )}
    </ol>
  )
  return paths.length > 0 ? (
    <DocumentReferenceScope spaceId={spaceId} paths={paths}>
      {list}
    </DocumentReferenceScope>
  ) : (
    list
  )
}
