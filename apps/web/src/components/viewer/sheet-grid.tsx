import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type PointerEvent,
} from "react"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"
import { ResizeHandle } from "@worktable/ui/components/resize-handle"
import { cn } from "@worktable/ui/lib/utils"

/**
 * Height of one row, borders included, in pixels: rows don't wrap, as in a
 * spreadsheet, so every row is this tall and the rows in view follow from
 * the scroll position alone.
 */
const ROW_HEIGHT = 36
/** The band of column letters above the column names. */
const LETTER_HEIGHT = 22
/** The column names' row. */
const NAME_HEIGHT = 36
/** Rows drawn beyond each edge of the view, so a quick scroll shows no gap. */
const OVERSCAN = 12
/** Rows measured to size the columns; enough to see a column's usual width. */
const SAMPLE_ROWS = 200
/** Cells measured at most, so a very wide file sizes quickly. */
const SAMPLE_CELLS = 20_000
const MIN_COLUMN_WIDTH = 72
const MAX_COLUMN_WIDTH = 320
/** Narrowest and widest a person can drag a column. */
const MIN_DRAG_WIDTH = 48
const MAX_DRAG_WIDTH = 960
/** A cell's padding on both sides, and a little room, in pixels. */
const CELL_PADDING = 32
/** Room a column name keeps for its sort arrow. */
const SORT_ROOM = 20
/** The grid's text size, in pixels: the app's small text. */
const FONT_SIZE = 14
/** Column names: the app's extra small, spaced capitals, as in Records. */
const NAME_FONT_SIZE = 12

type Sort = { column: number; direction: "asc" | "desc" } | null

/**
 * A grid of text cells that fills its container and scrolls both ways, in
 * the look of Records' table: column letters and names that stay at the
 * top, the file's row numbers at the left, and only the rows in view drawn,
 * so a long file scrolls as fast as a short one. Cells hold exact text;
 * nothing is typed or reformatted. Sorting and widths change only the view.
 * A delimited text file and, later, a sheet of a workbook show in it.
 */
export function SheetGrid({
  header,
  rows,
  shownRows,
  columnCount,
  label,
  empty,
}: {
  /** The header row's text, one per column; a missing one is blank. */
  header: readonly string[]
  /** Every row after the header. */
  rows: readonly (readonly string[])[]
  /** The rows to show, by index into `rows`, in the file's order. */
  shownRows: readonly number[]
  /** Columns to show; a row's values past this are left out. */
  columnCount: number
  /** The grid's accessible name. */
  label: string
  /** What the grid says when no row is shown. */
  empty: string
}) {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null
  )
  const fontsLoaded = useFontsLoaded()
  const fitted = useMemo(
    () => columnWidths(header, rows, columnCount, textMeasure()),
    // fontsLoaded re-measures in the loaded font.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [header, rows, columnCount, fontsLoaded]
  )
  const [dragged, setDragged] = useState<ReadonlyMap<number, number>>(
    () => new Map()
  )
  const widths = fitted.map((width, index) => dragged.get(index) ?? width)
  const numeric = useMemo(
    () => numericColumns(rows, columnCount),
    [rows, columnCount]
  )
  const [sort, setSort] = useState<Sort>(null)
  const order = useMemo(
    () => sortedRows(rows, shownRows, sort, numeric),
    [rows, shownRows, sort, numeric]
  )

  const numberWidth = 20 + String(rows.length).length * 8
  const headerHeight = LETTER_HEIGHT + NAME_HEIGHT
  const view = useScrollView(scrollElement)
  // A new search or sort starts from the top. Until the scroll position
  // catches up, draw from where the shorter list can actually scroll to,
  // so a narrowed list never shows an empty stretch.
  useLayoutEffect(() => {
    if (scrollElement) scrollElement.scrollTop = 0
  }, [scrollElement, order])
  const top = Math.min(
    view.top,
    Math.max(0, headerHeight + order.length * ROW_HEIGHT - view.height)
  )
  const first = Math.max(
    0,
    Math.floor((top - headerHeight) / ROW_HEIGHT) - OVERSCAN
  )
  const end = Math.min(
    order.length,
    Math.ceil((top + view.height) / ROW_HEIGHT) + OVERSCAN
  )
  const before = first * ROW_HEIGHT
  const after = Math.max(0, order.length - end) * ROW_HEIGHT
  const columns = Array.from({ length: columnCount }, (_, index) => index)
  const width = numberWidth + widths.reduce((sum, value) => sum + value, 0)

  const setWidth = (column: number, value: number) =>
    setDragged((current) => new Map(current).set(column, value))
  const toggleSort = (column: number) =>
    setSort((current) =>
      current?.column !== column
        ? { column, direction: "asc" }
        : current.direction === "asc"
          ? { column, direction: "desc" }
          : null
    )

  return (
    <div
      ref={setScrollElement}
      // Arrow keys and Page Down scroll the grid once it has focus.
      tabIndex={0}
      aria-label={label}
      className="h-full min-h-0 overflow-auto overscroll-contain outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
    >
      <table
        aria-rowcount={order.length + 1}
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
          <tr aria-hidden>
            <th
              className="sticky top-0 left-0 z-30 bg-card"
              style={{ height: LETTER_HEIGHT }}
            />
            {columns.map((index) => (
              <th
                key={index}
                className={cn(
                  "sticky top-0 z-20 bg-card px-3 pt-1.5 text-left align-bottom font-mono text-[0.65rem] leading-none font-normal text-muted-foreground/70",
                  // Over its name, which a number column aligns right.
                  numeric[index] && "text-right"
                )}
                style={{ height: LETTER_HEIGHT }}
              >
                {columnLetter(index)}
              </th>
            ))}
          </tr>
          <tr aria-rowindex={1}>
            <th
              className="sticky left-0 z-30 border-r border-b border-border/60 bg-card"
              style={{ top: LETTER_HEIGHT, height: NAME_HEIGHT }}
            />
            {columns.map((index) => {
              const direction =
                sort?.column === index ? sort.direction : undefined
              const name = header[index] ?? ""
              return (
                <th
                  key={index}
                  scope="col"
                  aria-sort={
                    direction === "asc"
                      ? "ascending"
                      : direction === "desc"
                        ? "descending"
                        : undefined
                  }
                  className="sticky z-20 border-r border-b border-r-border/40 border-b-border/60 bg-card px-1 text-left font-normal last:border-r-0"
                  style={{ top: LETTER_HEIGHT, height: NAME_HEIGHT }}
                >
                  <button
                    type="button"
                    title={name || undefined}
                    onClick={() => toggleSort(index)}
                    className={cn(
                      "group flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2 text-xs font-semibold tracking-wide whitespace-nowrap text-muted-foreground uppercase transition-colors hover:bg-surface-hover hover:text-foreground",
                      numeric[index] && "flex-row-reverse"
                    )}
                  >
                    <span className="min-w-0 truncate">{name}</span>
                    {direction === "asc" ? (
                      <ArrowUp className="size-3 shrink-0" />
                    ) : direction === "desc" ? (
                      <ArrowDown className="size-3 shrink-0" />
                    ) : (
                      <ArrowUpDown className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-40" />
                    )}
                  </button>
                  <ResizeHandle
                    role="separator"
                    aria-orientation="vertical"
                    aria-label={`Resize ${name || columnLetter(index)} column`}
                    onPointerDown={(event) =>
                      dragColumn(event, widths[index]!, (value) =>
                        setWidth(index, value)
                      )
                    }
                    onDoubleClick={() =>
                      setDragged((current) => {
                        const next = new Map(current)
                        next.delete(index)
                        return next
                      })
                    }
                    // Inside its own header: each sticky header is its own
                    // layer, so the next one would cover an overhang.
                    className="inset-y-1.5 right-0"
                  />
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {order.length === 0 ? (
            <tr>
              <td
                colSpan={columnCount + 1}
                className="sticky left-0 px-4 py-10 text-sm text-muted-foreground"
              >
                {empty}
              </td>
            </tr>
          ) : null}
          {before > 0 && (
            <tr aria-hidden>
              <td style={{ height: before }} colSpan={columnCount + 1} />
            </tr>
          )}
          {order.slice(first, end).map((rowIndex, offset) => {
            const row = rows[rowIndex]!
            return (
              <tr
                key={rowIndex}
                aria-rowindex={first + offset + 2}
                className="hover:[&>td]:bg-surface-hover"
              >
                <td
                  className="sticky left-0 z-10 border-r border-b border-border/60 bg-card pr-3 text-right font-mono text-xs text-muted-foreground/70 tabular-nums select-none"
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
                      className={cn(
                        "truncate border-r border-b border-r-border/40 border-b-border/60 px-3 whitespace-nowrap last:border-r-0",
                        numeric[index] && "text-right tabular-nums"
                      )}
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

/** A column's letters, as a spreadsheet names it: A to Z, then AA, AB… */
function columnLetter(index: number): string {
  let letters = ""
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters
  }
  return letters
}

const NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/

/**
 * Which columns hold numbers: those whose values in the first rows are all
 * numbers, ignoring blanks. They sort as numbers and align right, as a
 * spreadsheet shows them; their text stays as written.
 */
function numericColumns(
  rows: readonly (readonly string[])[],
  columnCount: number
): boolean[] {
  const sample = rows.slice(0, SAMPLE_ROWS)
  return Array.from({ length: columnCount }, (_, index) => {
    let seen = 0
    for (const row of sample) {
      const value = row[index]?.trim()
      if (!value) continue
      if (!NUMBER.test(value)) return false
      seen += 1
    }
    return seen > 0
  })
}

const COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
})

/**
 * The shown rows in the chosen order. In a number column, numbers compare
 * as numbers and come before any text further down that isn't one, such
 * as "N/A". Other text compares as a person reads it, so "Item 9" comes
 * before "Item 10" and dates written year first sort by date. Blank cells
 * go last either way, and rows that compare equal keep the file's order.
 */
function sortedRows(
  rows: readonly (readonly string[])[],
  shown: readonly number[],
  sort: Sort,
  numeric: readonly boolean[]
): readonly number[] {
  if (!sort) return shown
  const { column, direction } = sort
  const sign = direction === "asc" ? 1 : -1
  const asNumber = numeric[column] === true
  return [...shown].sort((left, right) => {
    const a = rows[left]![column]?.trim() ?? ""
    const b = rows[right]![column]?.trim() ?? ""
    if (!a || !b) return a === b ? left - right : a ? -1 : 1
    const compared = asNumber ? compareNumbers(a, b) : COLLATOR.compare(a, b)
    return compared === 0 ? left - right : compared * sign
  })
}

/**
 * Two cells of a number column: numbers by value, a number before text,
 * and text against text as a person reads it. Which columns hold numbers
 * is judged from the first rows, so a later cell may not be one.
 */
function compareNumbers(a: string, b: string): number {
  const x = NUMBER.test(a) ? Number(a) : Number.NaN
  const y = NUMBER.test(b) ? Number(b) : Number.NaN
  const xNumber = Number.isFinite(x)
  const yNumber = Number.isFinite(y)
  if (xNumber && yNumber) return x - y
  if (xNumber !== yNumber) return xNumber ? -1 : 1
  return COLLATOR.compare(a, b)
}

/**
 * Drags a column's edge to a new width while the pointer is held, starting
 * from the width the column had.
 */
function dragColumn(
  event: PointerEvent<HTMLDivElement>,
  from: number,
  onWidth: (width: number) => void
) {
  if (event.button !== 0) return
  event.preventDefault()
  event.stopPropagation()
  const handle = event.currentTarget
  const startX = event.clientX
  handle.setPointerCapture(event.pointerId)
  handle.dataset.resizing = ""
  const move = (moved: globalThis.PointerEvent) => {
    onWidth(
      Math.min(
        MAX_DRAG_WIDTH,
        Math.max(MIN_DRAG_WIDTH, Math.round(from + moved.clientX - startX))
      )
    )
  }
  const stop = () => {
    delete handle.dataset.resizing
    handle.removeEventListener("pointermove", move)
    handle.removeEventListener("pointerup", stop)
    handle.removeEventListener("pointercancel", stop)
  }
  handle.addEventListener("pointermove", move)
  handle.addEventListener("pointerup", stop)
  handle.addEventListener("pointercancel", stop)
}

/** Whether the app's fonts have loaded, so text can be measured in them. */
function useFontsLoaded(): boolean {
  const [loaded, setLoaded] = useState(
    () => typeof document === "undefined" || document.fonts.status === "loaded"
  )
  useEffect(() => {
    if (loaded) return
    let live = true
    void document.fonts.ready.then(() => {
      if (live) setLoaded(true)
    })
    return () => {
      live = false
    }
  }, [loaded])
  return loaded
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
 * Each column's width from its name and the first rows: wide enough for
 * its usual value, within bounds, so one long cell can't push the others
 * off screen. A cell shows on one line, so its whole text counts.
 */
function columnWidths(
  header: readonly string[],
  rows: readonly (readonly string[])[],
  columnCount: number,
  measure: (text: string, name: boolean) => number
): number[] {
  const widest = Array.from(
    { length: columnCount },
    (_, index) => measure(header[index] ?? "", true) + SORT_ROOM
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
 * fits its values on the first paint: cells in the body's small text, names
 * in Records' spaced capitals. Where a canvas isn't available, it falls back
 * to a rough width per character.
 */
function textMeasure(): (text: string, name: boolean) => number {
  const context =
    typeof document === "undefined"
      ? null
      : document.createElement("canvas").getContext("2d")
  if (!context) return (text) => text.length * FONT_SIZE * 0.6
  const family = getComputedStyle(document.body).fontFamily
  const fonts = {
    cell: `400 ${FONT_SIZE}px ${family}`,
    name: `600 ${NAME_FONT_SIZE}px ${family}`,
  }
  return (text, name) => {
    // Whitespace, line breaks included, shows as one space in a cell.
    const shown = text.replace(/\s+/g, " ")
    if (!name) {
      context.font = fonts.cell
      return context.measureText(shown).width
    }
    context.font = fonts.name
    // Names show in capitals with a little tracking between letters.
    const upper = shown.toUpperCase()
    return context.measureText(upper).width + upper.length * 0.3
  }
}
