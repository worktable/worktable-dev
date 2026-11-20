import {
  useDeferredValue,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { Search } from "lucide-react"
import { delimiterForFilename, parseDelimitedText } from "@worktable/types"
import { Input } from "@worktable/ui/components/input"
import { Skeleton } from "@worktable/ui/components/skeleton"
import { SheetGrid } from "@/components/viewer/sheet-grid"

/** Columns the grid shows at most; the rest stay in the file. */
const MAX_COLUMNS = 200
/**
 * A CSV or TSV file on its page, laid out as Records lays out a collection:
 * a search above, then the grid in a card filling the rest of the pane. The
 * file's first row names the columns. The text is read by the file page, so
 * this shows a skeleton until it arrives.
 */
export default function TableFileView({
  name,
  text,
  leading,
}: {
  name: string
  /** The file's text, or undefined while it loads. */
  text: string | undefined
  /** The file's byline, shown above the grid. */
  leading: ReactNode
}) {
  const table = useMemo(
    () =>
      text === undefined
        ? null
        : parseDelimitedText(text, delimiterForFilename(name)),
    [name, text]
  )
  let widest = table?.header.length ?? 0
  for (const row of table?.rows ?? []) widest = Math.max(widest, row.length)
  const columnCount = Math.min(widest, MAX_COLUMNS)

  const [search, setSearch] = useState("")
  const query = useDeferredValue(search.trim().toLocaleLowerCase())
  // Each row's shown text, lowercased once, the first time someone searches.
  const searchable = useMemo(
    () =>
      query && table
        ? table.rows.map((row) =>
            row.slice(0, columnCount).join("\u0000").toLocaleLowerCase()
          )
        : null,
    // Built once per file; a new query reuses it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table, columnCount, query !== ""]
  )
  const shownRows = useMemo(() => {
    const count = table?.rows.length ?? 0
    const shown: number[] = []
    for (let index = 0; index < count; index += 1) {
      if (!query || searchable?.[index]!.includes(query)) shown.push(index)
    }
    return shown
  }, [table, query, searchable])

  const total = table?.rowCount ?? 0
  const count = query
    ? `${shownRows.length.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? "row" : "rows"}`
    : `${total.toLocaleString()} ${total === 1 ? "row" : "rows"}`

  return (
    <div className="flex h-full min-h-0 flex-col px-4 pt-3 pb-4 sm:px-6">
      <div className="mb-2 min-w-0 shrink-0 text-sm text-muted-foreground">
        {leading}
      </div>
      <div className="mb-3 flex shrink-0 flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-1 sm:max-w-64">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground/60" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search rows…"
            className="h-9 w-full pl-9"
            aria-label="Search rows"
            disabled={!table}
          />
        </div>
        {table ? (
          <div className="ml-auto px-1.5 text-xs text-muted-foreground tabular-nums">
            {count}
            {widest > columnCount
              ? `, first ${columnCount.toLocaleString()} of ${widest.toLocaleString()} columns`
              : ""}
          </div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-xl card-surface">
        {table ? (
          <SheetGrid
            header={table.header}
            rows={table.rows}
            shownRows={shownRows}
            columnCount={columnCount}
            label={name}
            empty={query ? "No matching rows" : "No rows"}
          />
        ) : (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-7 w-full" />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

