import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./collapsible"
import { cn } from "../lib/utils"

/**
 * A section that opens in place. `quiet` is a muted text toggle for optional
 * settings; `row` is a filled rounded row with a title and, on the right, a
 * short status such as "On", for stacking several in a dialog.
 */
export function Disclosure({
  title,
  status,
  children,
  className,
  keepMounted,
  defaultOpen,
  open,
  onOpenChange,
  variant = "quiet",
}: {
  title: ReactNode
  /** Shown at the right of a `row`, open or closed. */
  status?: ReactNode
  children: ReactNode
  className?: string
  keepMounted?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  variant?: "quiet" | "row"
}) {
  const row = variant === "row"
  return (
    <Collapsible
      className={cn("text-sm", row && "rounded-xl bg-surface-inset", className)}
      defaultOpen={defaultOpen}
      open={open}
      onOpenChange={onOpenChange}
    >
      <CollapsibleTrigger
        className={cn(
          "flex min-h-11 w-full items-center gap-2 text-left transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none [&[data-panel-open]>svg]:rotate-90",
          row
            ? "rounded-xl px-3 font-medium text-foreground hover:bg-surface-hover"
            : "text-muted-foreground hover:text-foreground"
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 shrink-0 transition-transform duration-250 motion-reduce:transition-none",
            row && "text-muted-foreground"
          )}
        />
        {row ? (
          <>
            <span className="min-w-0 flex-1 truncate">{title}</span>
            {status ? (
              <span className="shrink-0 font-normal text-muted-foreground tabular-nums">
                {status}
              </span>
            ) : null}
          </>
        ) : (
          title
        )}
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted={keepMounted}>
        <div className={row ? "px-3 pt-1 pb-3" : "pt-2 pb-1"}>{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
