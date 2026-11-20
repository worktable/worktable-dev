import { useEffect, useMemo, useState } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"

/** Height of one row, in pixels: rows don't wrap, as in a spreadsheet. */
const ROW_HEIGHT = 32
/** Rows measured to size the columns; enough to see a column's usual width. */
const SAMPLE_ROWS = 200
/** Cells measured at most, so a very wide file sizes quickly. */
const SAMPLE_CELLS = 20_000
const MIN_COLUMN_WIDTH = 64
const MAX_COLUMN_WIDTH = 320
/** A cell's padding on both sides, and a little room, in pixels. */
const CELL_PADDING = 28
/** The grid's text size, in pixels: the app's small text. */
const FONT_SIZE = 14

/**
 * A grid of text cells that fills its container and scrolls both ways: a
 * header row that stays at the top, row numbers that stay at the left, and
 * only the rows in view drawn, so a long file scrolls as fast as a short one.
 * Cells hold exact text; nothing is typed or reformatted. A delimited text
 * file and, later, a sheet of a workbook show in it.
 */
export function SheetGrid({
  header,
  rows,
  columnCount,
  label,
}: {
  /** The header row's text, one per column; a missing one is blank. */
  header: readonly string[]
  /** Every row after the header. */
  rows: readonly (readonly string[])[]
  /** Columns to show; a row's values past this are left out. */
  columnCount: number
  /** The grid's accessible name. */
  label: string
}) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null
  )
  // Sized again once the app's font has loaded, if it was still loading.
  const [fontsLoaded, setFontsLoaded] = useState(
    () => typeof document === "undefined" || document.fonts.status === "loaded"
  )
  useEffect(() => {
    if (fontsLoaded) return
    let live = true
    void document.fonts.ready.then(() => {
      if (live) setFontsLoaded(true)
    })
    return () => {
      live = false
    }
  }, [fontsLoaded])
  const widths = useMemo(
    () => columnWidths(header, rows, columnCount, textMeasure()),
    // fontsLoaded re-measures in the loaded font.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [header, rows, columnCount, fontsLoaded]
  )
  const numberWidth = CELL_PADDING + String(rows.length).length * 8
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLTableRowElement>({
    count: rows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // Draw a screen of rows before the grid has been measured.
    initialRect: {
      width: 0,
      height: typeof window === "undefined" ? 0 : window.innerHeight,
    },
  })
  const items = virtualizer.getVirtualItems()
  const before = items[0]?.start ?? 0
  const after = virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0)
  const columns = Array.from({ length: columnCount }, (_, index) => index)
  const width = numberWidth + widths.reduce((sum, value) => sum + value, 0)

  return (
    <div
      ref={setScrollElement}
      // Arrow keys and Page Down scroll the grid once it has focus.
      tabIndex={0}
      aria-label={label}
      className="h-full min-h-0 overflow-auto overscroll-contain outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
    >
      <table
        aria-rowcount={rows.length + 1}
        className="table-fixed border-separate border-spacing-0 text-sm"
        style={{ width }}
      >
        <colgroup>
          <col style={{ width: numberWidth }} />
          {widths.map((value, index) => (
            <col key={index} style={{ width: value }} />
          ))}
        </colgroup>
        <thead>
          <tr aria-rowindex={1}>
            <th
              aria-hidden
              className="sticky top-0 left-0 z-30 border-r border-b border-border/60 bg-card"
            />
            {columns.map((index) => (
              <th
                key={index}
                scope="col"
                title={header[index] || undefined}
                className="sticky top-0 z-20 truncate border-r border-b border-border/60 bg-card px-3 text-left font-semibold whitespace-nowrap text-foreground last:border-r-0"
                style={{ height: ROW_HEIGHT }}
              >
                {header[index] ?? ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {before > 0 && (
            <tr aria-hidden>
              <td style={{ height: before }} colSpan={columnCount + 1} />
            </tr>
          )}
          {items.map((item) => {
            const row = rows[item.index]!
            return (
              <tr
                key={item.key}
                aria-rowindex={item.index + 2}
                className="hover:[&>td]:bg-surface-hover"
              >
                <td
                  className="sticky left-0 z-10 border-r border-b border-border/60 bg-card px-2 text-right font-mono text-xs text-muted-foreground tabular-nums select-none"
                  style={{ height: ROW_HEIGHT }}
                >
                  {item.index + 1}
                </td>
                {columns.map((index) => {
                  const value = row[index] ?? ""
                  return (
                    <td
                      key={index}
                      title={value || undefined}
                      className="truncate border-r border-b border-border/60 px-3 whitespace-nowrap last:border-r-0"
                    >
                      {value}
                    </td>
                  )
                })}
              </tr>
            )
          })}
          {after > 0 && (
            <tr aria-hidden>
              <td style={{ height: after }} colSpan={columnCount + 1} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Each column's width from the header and the first rows: wide enough for
 * its usual value, within bounds, so one long cell can't push the others
 * off screen. A cell shows on one line, so its whole text counts.
 */
function columnWidths(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  columnCount: number,
  measure: (text: string, bold: boolean) => number
): number[] {
  const widest = Array.from({ length: columnCount }, (_, index) =>
    measure(header[index] ?? "", true)
  )
  const sample = Math.min(
    SAMPLE_ROWS,
    Math.floor(SAMPLE_CELLS / Math.max(columnCount, 1))
  )
  for (const row of rows.slice(0, sample)) {
    for (let index = 0; index < columnCount; index += 1) {
      const value = row[index]
      if (!value) continue
      const width = measure(value, false)
      if (width > widest[index]!) widest[index] = width
    }
  }
  return widest.map((width) =>
    Math.ceil(
      Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width + CELL_PADDING))
    )
  )
}

/**
 * Measures text as the grid draws it, in the page's own font, so a column
 * fits its values on the first paint. Where a canvas isn't available, it
 * falls back to a rough width per character.
 */
function textMeasure(): (text: string, bold: boolean) => number {
  const context =
    typeof document === "undefined"
      ? null
      : document.createElement("canvas").getContext("2d")
  if (!context) return (text) => text.length * FONT_SIZE * 0.6
  const family = getComputedStyle(document.body).fontFamily
  const fonts = {
    regular: `400 ${FONT_SIZE}px ${family}`,
    bold: `600 ${FONT_SIZE}px ${family}`,
  }
  return (text, bold) => {
    context.font = bold ? fonts.bold : fonts.regular
    // Whitespace, line breaks included, shows as one space in a cell.
    return context.measureText(text.replace(/\s+/g, " ")).width
  }
}

