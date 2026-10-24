import type { ReactNode } from "react"
import { Info } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "./popover"
import { cn } from "../lib/utils"

/**
 * A quiet info icon beside a label that opens a few sentences of detail. Use
 * it for what helps some people decide but would crowd the main text; keep
 * anything everyone needs in the text itself.
 */
export function InfoTip({
  label,
  children,
  className,
  side = "bottom",
  align = "start",
}: {
  /** Names the button for assistive technology, e.g. "About Worktable Link". */
  label: string
  children: ReactNode
  className?: string
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
}) {
  return (
    <Popover>
      <PopoverTrigger
        aria-label={label}
        className={cn(
          "-m-1.5 inline-grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none data-popup-open:text-foreground",
          className
        )}
      >
        <Info aria-hidden className="size-4" />
      </PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        className="w-80 gap-2 p-3 leading-relaxed text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground"
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}
