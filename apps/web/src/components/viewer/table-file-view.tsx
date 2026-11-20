import { useMemo, type ReactNode } from "react"
import { delimiterForFilename, parseDelimitedText } from "@worktable/types"
import { Skeleton } from "@worktable/ui/components/skeleton"
import { SheetGrid } from "@/components/viewer/sheet-grid"

/** Columns the grid shows at most; the rest stay in the file. */
const MAX_COLUMNS = 200

/**
 * A CSV or TSV file filling its pane as a grid: the file's first row as the
 * header, every other row below it. The text is read by the file page, so
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-1">
        <div className="min-w-0 flex-1 text-sm text-muted-foreground">
          {leading}
        </div>
        {table ? (
          <div className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {table.rowCount.toLocaleString()}{" "}
            {table.rowCount === 1 ? "row" : "rows"}
            {widest > columnCount
              ? `, first ${columnCount.toLocaleString()} of ${widest.toLocaleString()} columns`
              : ""}
          </div>
        ) : null}
      </div>
      <div className="relative min-h-0 flex-1 bg-card">
        {table ? (
          <SheetGrid
            header={table.header}
            rows={table.rows}
            columnCount={columnCount}
            label={name}
          />
        ) : (
          <div className="flex flex-col gap-2 p-4">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="h-6 w-full" />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
