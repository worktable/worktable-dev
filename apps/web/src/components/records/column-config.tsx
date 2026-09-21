import { ArrowDown, ArrowUp, Columns3, Eye, EyeOff, RotateCcw } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@worktable/ui/components/popover"
import { Button } from "@worktable/ui/components/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@worktable/ui/components/tooltip"
import { useScrollFade } from "@/hooks/use-scroll-fade"
import { columnLabel, type RecordFieldColumn } from "@/lib/records"

import type { ColumnPrefs } from "@/lib/records"

/** Visibility + manual order for the grid's columns (localStorage-backed). */
export function ColumnConfig({
  columns,
  prefs,
  onChange,
}: {
  /** In display order (order prefs already applied). */
  columns: RecordFieldColumn[]
  prefs: ColumnPrefs
  onChange: (prefs: ColumnPrefs) => void
}) {
  const scrollRef = useScrollFade<HTMLDivElement>()
  const hidden = new Set(prefs.hidden)
  const hiddenCount = columns.filter((column) => hidden.has(column.key)).length

  const toggle = (key: string) => {
    onChange({
      ...prefs,
      hidden: hidden.has(key) ? prefs.hidden.filter((entry) => entry !== key) : [...prefs.hidden, key],
    })
  }

  const move = (index: number, delta: -1 | 1) => {
    const keys = columns.map((column) => column.key)
    const next = index + delta
    if (next < 0 || next >= keys.length) return
    const reordered = [...keys]
    ;[reordered[index], reordered[next]] = [reordered[next], reordered[index]]
    onChange({ ...prefs, order: reordered })
  }

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <PopoverTrigger
            render={
              <Button
                className="relative"
                variant={hiddenCount > 0 ? "secondary" : "outline"}
                size="icon-sm"
                aria-label="Configure columns"
                aria-pressed={hiddenCount > 0}
              />
            }
          >
            <Columns3 className="size-4" />
            {hiddenCount > 0 && (
              <span className="absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground">
                {hiddenCount}
              </span>
            )}
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Configure columns</TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-64 gap-0.5 p-1.5">
        <div ref={scrollRef} className="scroll-fade max-h-72 overflow-y-auto">
          {columns.map((column, index) => {
            const isHidden = hidden.has(column.key)
            return (
              <div key={column.key} className="group/col flex items-center gap-1 rounded-md px-1.5 py-1 hover:bg-accent/40">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                  onClick={() => toggle(column.key)}
                  aria-pressed={!isHidden}
                  aria-label={`${isHidden ? "Show" : "Hide"} ${columnLabel(column)}`}
                >
                  {isHidden ? (
                    <EyeOff className="size-3.5 shrink-0 text-muted-foreground/50" />
                  ) : (
                    <Eye className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className={`min-w-0 truncate ${isHidden ? "text-muted-foreground/60" : ""}`}>{columnLabel(column)}</span>
                </button>
                <span className="flex shrink-0 opacity-0 transition-opacity group-hover/col:opacity-100">
                  <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground disabled:opacity-30"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move ${columnLabel(column)} up`}
                  >
                    <ArrowUp className="size-3" />
                  </button>
                  <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded text-muted-foreground/60 hover:bg-muted hover:text-foreground disabled:opacity-30"
                    onClick={() => move(index, 1)}
                    disabled={index === columns.length - 1}
                    aria-label={`Move ${columnLabel(column)} down`}
                  >
                    <ArrowDown className="size-3" />
                  </button>
                </span>
              </div>
            )
          })}
        </div>
        {Object.keys(prefs.widths).length > 0 && (
          <button
            type="button"
            className="mt-1 flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
            onClick={() => onChange({ ...prefs, widths: {} })}
          >
            <RotateCcw className="size-3.5" />
            Reset column widths
          </button>
        )}
      </PopoverContent>
    </Popover>
  )
}
