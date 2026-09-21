import type { ReactNode } from "react"

import { cn } from "@worktable/ui/lib/utils"

interface DimensionValue {
  content: string | ReactNode
  highlight?: boolean
}

interface Dimension {
  label: string
  values: DimensionValue[]
}

interface ComparisonTableProps {
  items: string[]
  dimensions: Dimension[]
  className?: string
}

/** Render badge-style indicators for yes/partial/no values */
function renderCellContent(content: string | ReactNode): ReactNode {
  if (typeof content !== "string") return content

  const lower = content.toLowerCase().trim()

  if (lower === "yes") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-full bg-success" />
        <span>Yes</span>
      </span>
    )
  }

  if (lower === "partial") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="relative size-2.5">
          <span className="absolute inset-0 rounded-full border border-warning" />
          <span
            className="clip-path-half absolute inset-0 rounded-full bg-warning"
            style={{ clipPath: "inset(0 50% 0 0)" }}
          />
        </span>
        <span>Partial</span>
      </span>
    )
  }

  if (lower === "no") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className="size-2.5 rounded-full border-[1.5px] border-destructive" />
        <span>No</span>
      </span>
    )
  }

  return content
}

function ComparisonTable({
  items,
  dimensions,
  className,
}: ComparisonTableProps) {
  return (
    <div
      className={cn(
        "w-full overflow-x-auto rounded-xl ring-1 ring-border",
        className
      )}
    >
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr className="bg-muted/60">
            <th
              className="sticky left-0 z-10 w-36 border-b border-border bg-muted/60 px-3 py-2.5 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase"
              scope="col"
            >
              Feature
            </th>
            {items.map((item, i) => (
              <th
                key={i}
                className="min-w-[120px] border-b border-border px-3 py-2.5 text-left text-xs font-semibold whitespace-nowrap text-foreground"
                scope="col"
              >
                {item}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dimensions.map((dim, rowIdx) => (
            <tr
              key={rowIdx}
              className={cn(
                "border-b border-border transition-colors last:border-0 hover:bg-muted/40",
                rowIdx % 2 === 1 && "bg-muted/20"
              )}
            >
              <td
                className={cn(
                  "sticky left-0 z-10 border-r border-border px-3 py-2.5 text-xs font-medium whitespace-nowrap text-muted-foreground",
                  rowIdx % 2 === 1 ? "bg-muted/20" : "bg-card"
                )}
              >
                {dim.label}
              </td>
              {dim.values.map((val, colIdx) => (
                <td
                  key={colIdx}
                  className={cn(
                    "px-3 py-2.5 text-sm text-foreground",
                    val.highlight &&
                      "bg-surface-tint font-medium text-primary dark:bg-surface-tint"
                  )}
                >
                  {renderCellContent(val.content)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export { ComparisonTable }
export type { ComparisonTableProps, Dimension, DimensionValue }
