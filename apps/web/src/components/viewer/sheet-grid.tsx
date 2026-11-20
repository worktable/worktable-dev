import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
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
const LETTER_HEIGHT = 28
/** The column names' row. */
const NAME_HEIGHT = 36
/** Rows drawn beyond each edge of the view, so a quick scroll shows no gap. */
const OVERSCAN = 8
/**
 * The drawn rows move in blocks of this many, so scrolling redraws the grid
 * once a block, not on every frame.
 */
const BLOCK_ROWS = 8
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
 * A row's shading: every other row striped with the inset fill, and the
 * hovered row a step stronger than any stripe, the same on every row, so a
 * hovered row never reads as a stripe. The row paints both as plain fills
 * behind its cells; the hover's second layer is a gradient on that one row
 * only, since a gradient on every cell made scrolling slow to paint.
 */
const ROW_TINTS =
  "group/row [--sheet-hover:transparent] [--sheet-stripe:transparent] data-[striped]:[--sheet-stripe:var(--surface-inset)] hover:[--sheet-hover:var(--surface-hover)] hover:[--sheet-stripe:var(--surface-inset)] bg-(--sheet-stripe) hover:bg-[image:linear-gradient(var(--surface-hover),var(--surface-hover))]"
/**
 * The row number stays opaque as cells scroll under it, so it lays the
 * row's two tints over the card as plain fills of its own.
 */
const GUTTER_TINTS =
  "bg-card before:pointer-events-none before:absolute before:inset-0 before:bg-(--sheet-stripe) before:content-[''] after:pointer-events-none after:absolute after:inset-0 after:bg-(--sheet-hover) after:content-['']"

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
  // Each column's sort keys, made once per file the first time it sorts.
  const keys = useRef(new Map<number, SortKeys>())
  const keysOf = useRef(rows)
  if (keysOf.current !== rows) {
    keysOf.current = rows
    keys.current = new Map()
  }
  const order = useMemo(() => {
    if (!sort) return shownRows
    let column = keys.current.get(sort.column)
    if (!column) {
      column = sortKeys(rows, sort.column, numeric[sort.column] === true)
      keys.current.set(sort.column, column)
    }
    return sortedRows(shownRows, column, sort.direction)
  }, [rows, shownRows, sort, numeric])

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
  // The view's top is snapped to a block, so draw a block further down too.
  const first = Math.max(
    0,
    Math.floor((top - headerHeight) / ROW_HEIGHT) - OVERSCAN
  )
  const end = Math.min(
    order.length,
    Math.ceil((top + view.height) / ROW_HEIGHT) + BLOCK_ROWS + OVERSCAN
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
      // Opaque, so the browser can scroll what it already painted instead
      // of painting the grid again on every frame.
      className="h-full min-h-0 overflow-auto overscroll-contain bg-card outline-none [overflow-anchor:none] focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
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
                // Centered over the column, as a spreadsheet does, whichever
                // way the column's values align.
                className="sticky top-0 z-20 bg-card px-3 text-center align-middle font-mono text-[0.65rem] leading-none font-normal text-muted-foreground/70"
                style={{ height: LETTER_HEIGHT }}
              >
                {columnLetter(index)}
              </th>
            ))}
          </tr>
          <tr aria-rowindex={1}>
            <th
              className="sticky left-0 z-30 border-t border-r border-b border-border/60 bg-card"
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
                  className="sticky z-20 border-t border-r border-b border-t-border/60 border-r-border/40 border-b-border/60 bg-card px-1 text-left font-normal"
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
          {order.slice(first, end).map((rowIndex, offset) => (
            <SheetRow
              key={rowIndex}
              row={rows[rowIndex]!}
              number={rowIndex + 1}
              position={first + offset}
              columnCount={columnCount}
              numeric={numeric}
            />
          ))}
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
 * One row of the grid. A row already drawn isn't drawn again as the grid
 * scrolls; only rows coming into view are.
 */
const SheetRow = memo(function SheetRow({
  row,
  number,
  position,
  columnCount,
  numeric,
}: {
  row: readonly string[]
  /** The row's number in the file, whatever order it shows in. */
  number: number
  /** Where it shows, which sets its stripe. */
  position: number
  columnCount: number
  numeric: readonly boolean[]
}) {
  const cells = []
  for (let index = 0; index < columnCount; index += 1) {
    const value = row[index] ?? ""
    cells.push(
      <td
        key={index}
        title={value || undefined}
        className={
          numeric[index]
            ? "truncate border-r border-b border-r-border/40 border-b-border/60 px-3 text-right whitespace-nowrap tabular-nums"
            : "truncate border-r border-b border-r-border/40 border-b-border/60 px-3 whitespace-nowrap"
        }
      >
        {value}
      </td>
    )
  }
  return (
    <tr
      aria-rowindex={position + 2}
      // Every other row as shown is striped, so stripes stay even after
      // sorting or searching.
      data-striped={position % 2 === 1 ? "" : undefined}
      className={ROW_TINTS}
    >
      <td
        className={cn(
          GUTTER_TINTS,
          "sticky left-0 z-10 border-r border-b border-border/60 pr-3 text-right font-mono text-xs text-muted-foreground/70 tabular-nums transition-colors select-none group-hover/row:text-foreground"
        )}
        style={{ height: ROW_HEIGHT }}
      >
        {number}
      </td>
      {cells}
    </tr>
  )
})

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
 * A column's values made ready to compare, once per column: numbers by
 * value, text by rank. Comparing two cells is then a subtraction, so a
 * sort of tens of thousands of rows takes a moment, not a second.
 */
interface SortKeys {
  /** A number column's values; NaN where a cell isn't a number. */
  numbers?: Float64Array
  /** Each cell's place among the column's text, as a person reads it. */
  ranks: Int32Array
  /** Cells left blank. */
  blank: Uint8Array
}

/**
 * Ranks a column's text: "Item 9" before "Item 10", year-first dates by
 * date, case ignored. Plain ASCII text is ranked by a key compared code
 * point by code point, with each run of digits padded so numbers compare
 * by value; other text is ranked by the locale's collation.
 */
function sortKeys(
  rows: readonly (readonly string[])[],
  column: number,
  asNumber: boolean
): SortKeys {
  const values = rows.map((row) => row[column]?.trim() ?? "")
  const blank = Uint8Array.from(values, (value) => (value ? 0 : 1))
  const numbers = asNumber
    ? Float64Array.from(values, (value) =>
        NUMBER.test(value) ? Number(value) : Number.NaN
      )
    : undefined
  const distinct = [...new Set(values)]
  const ascii = distinct.every((value) => /^[\x20-\x7e]*$/.test(value))
  if (ascii) {
    const keyed = distinct.map((value) => ({
      value,
      key: value
        .toLowerCase()
        .replace(/\d+/g, (digits) =>
          digits.replace(/^0+(?=\d)/, "").padStart(24, "0")
        ),
    }))
    keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    distinct.splice(0, distinct.length, ...keyed.map((entry) => entry.value))
  } else {
    distinct.sort(COLLATOR.compare)
  }
  const rank = new Map<string, number>()
  let place = 0
  for (let index = 0; index < distinct.length; index += 1) {
    // Values a person reads as the same share a place.
    if (
      index > 0 &&
      COLLATOR.compare(distinct[index - 1]!, distinct[index]!) !== 0
    ) {
      place += 1
    }
    rank.set(distinct[index]!, place)
  }
  const ranks = Int32Array.from(values, (value) => rank.get(value) ?? 0)
  return numbers ? { numbers, ranks, blank } : { ranks, blank }
}

/**
 * The shown rows in the chosen order. In a number column, numbers compare
 * by value and come before any text that isn't one, such as "N/A". Blank
 * cells go last either way, and rows that compare equal keep the file's
 * order.
 */
function sortedRows(
  shown: readonly number[],
  keys: SortKeys,
  direction: "asc" | "desc"
): readonly number[] {
  const sign = direction === "asc" ? 1 : -1
  const { numbers, ranks, blank } = keys
  return [...shown].sort((left, right) => {
    const leftBlank = blank[left]!
    const rightBlank = blank[right]!
    if (leftBlank || rightBlank) {
      return leftBlank === rightBlank ? left - right : leftBlank - rightBlank
    }
    let compared = 0
    if (numbers) {
      const x = numbers[left]!
      const y = numbers[right]!
      const xNumber = x === x
      const yNumber = y === y
      compared =
        xNumber && yNumber
          ? x - y
          : xNumber !== yNumber
            ? xNumber
              ? -1
              : 1
            : ranks[left]! - ranks[right]!
    } else {
      compared = ranks[left]! - ranks[right]!
    }
    return compared === 0 ? left - right : compared * sign
  })
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
    const block = BLOCK_ROWS * ROW_HEIGHT
    const read = () => {
      frame = 0
      // Snapped to blocks of rows, so the grid redraws once a block.
      const top = Math.floor(element.scrollTop / block) * block
      const height = Math.ceil(element.clientHeight / block) * block
      setView((current) =>
        current.top === top && current.height === height
          ? current
          : { top, height }
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
