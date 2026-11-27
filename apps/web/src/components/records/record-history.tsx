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
import { queryKeys } from "@/lib/queries"
import { columnLabel, type RecordFieldColumn } from "@/lib/records"
import { readRecordHistory } from "@/lib/records-api"
import { RelativeTime } from "@/lib/time"
import { humanizeSegment } from "@/lib/tree"
import { useActorName } from "@/lib/use-actor-name"
import { FieldValue, type ExpandedRecords } from "./field-value"

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

/** One field as it was and as it became; a side with no value shows nothing. */
function ValueChange({
  column,
  change,
  spaceId,
  expanded,
}: {
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
  const value = (side: unknown) => (
    <FieldValue
      column={column}
      value={side}
      spaceId={spaceId}
      expanded={expanded}
      linksDisabled
    />
  )
  return (
    <div className="grid grid-cols-[minmax(5.5rem,0.34fr)_minmax(0,1fr)] items-start gap-3">
      <dt className="truncate text-muted-foreground">{columnLabel(column)}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-foreground/90">
        {had && (
          <span className="min-w-0 text-muted-foreground line-through decoration-muted-foreground/60">
            {change.beforeTooLarge ? tooLarge : value(change.before)}
          </span>
        )}
        {had && has && (
          <ArrowRight
            aria-label="changed to"
            className="size-3 shrink-0 text-muted-foreground"
          />
        )}
        {has ? (
          <span className="min-w-0">
            {change.afterTooLarge ? tooLarge : value(change.after)}
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
  const { data, isPending, isError, hasNextPage, fetchNextPage, isFetchingNextPage } =
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
  if (isPending) {
    return (
      <div aria-hidden className="space-y-2 pt-1">
        <div className="h-3 w-2/3 rounded bg-surface-inset" />
        <div className="h-3 w-1/2 rounded bg-surface-inset" />
      </div>
    )
  }
  if (isError) return <p>Couldn’t load the history.</p>
  const changes = data.pages.flatMap((page) => page.changes)
  if (changes.length === 0) return <p>No changes kept yet.</p>
  const pageTitle = (path: string) => {
    const page = documents?.find(
      (item) => item.kind === "document" && item.path === path
    )
    return page?.kind === "document"
      ? page.title
      : humanizeSegment(path.split("/").at(-1) ?? path)
  }
  return (
    <ol className="divide-y divide-border/60">
      {changes.map((change) => {
        const fields = Object.entries({
          ...change.fields,
          ...change.metadata,
        })
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
            {fields.length > 0 && (
              <dl className="space-y-1.5">
                {fields.map(([key, value]) => (
                  <ValueChange
                    key={key}
                    column={columnFor(key, schema)}
                    change={value}
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
}
