import { useEffect, useLayoutEffect, useMemo, useState } from "react"

/**
 * Height of one row, borders included, in pixels: rows don't wrap, as in a
 * spreadsheet, so every row is this tall and the rows in view follow from
 * the scroll position alone.
 */
const ROW_HEIGHT = 32
/** Rows drawn beyond each edge of the view, so a quick scroll shows no gap. */
const OVERSCAN = 12
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
  const view = useScrollView(scrollElement)
  // The header row is the first row's height above the body.
  const first = Math.max(
    0,
    Math.floor((view.top - ROW_HEIGHT) / ROW_HEIGHT) - OVERSCAN
  )
  const end = Math.min(
    rows.length,
    Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN
  )
  const before = first * ROW_HEIGHT
  const after = Math.max(0, rows.length - end) * ROW_HEIGHT
  const shown: number[] = []
  for (let index = first; index < end; index += 1) shown.push(index)
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
          {shown.map((rowIndex) => {
            const row = rows[rowIndex]!
            return (
              <tr
                key={rowIndex}
                aria-rowindex={rowIndex + 2}
                className="hover:[&>td]:bg-surface-hover"
              >
                <td
                  className="sticky left-0 z-10 border-r border-b border-border/60 bg-card px-2 text-right font-mono text-xs text-muted-foreground tabular-nums select-none"
                  style={{ height: ROW_HEIGHT }}
                >
                  {rowIndex + 1}
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
 * Where the grid is scrolled to and how tall it is, kept current through
 * scrolling and resizing. Before the grid is measured, a window's height of
 * rows is drawn.
 */
function useScrollView(element: HTMLElement | null): {
  top: number
  height: number
} {
  const [view, setView] = useState(() => ({
    top: 0,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  }))
  useLayoutEffect(() => {
    if (!element) return
    let frame = 0
    const read = () => {
      frame = 0
      setView((current) =>
        current.top === element.scrollTop &&
        current.height === element.clientHeight
          ? current
          : { top: element.scrollTop, height: element.clientHeight }
      )
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()
    element.addEventListener("scroll", schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    return () => {
      element.removeEventListener("scroll", schedule)
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [element])
  return view
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

