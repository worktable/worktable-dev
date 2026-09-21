import type { ReactNode } from "react"
import { Check, Circle, Clock } from "lucide-react"
import { cva } from "class-variance-authority"

import { cn } from "@worktable/ui/lib/utils"

const dotVariants = cva(
  "relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full ring-2 ring-background",
  {
    variants: {
      status: {
        complete: "bg-success text-white",
        current: "bg-surface-selected text-primary",
        upcoming: "bg-muted text-muted-foreground ring-border",
      },
    },
    defaultVariants: {
      status: "upcoming",
    },
  }
)

interface TimelineItem {
  date?: string
  title: string
  description?: string
  status?: "complete" | "current" | "upcoming"
  icon?: ReactNode
}

interface TimelineProps {
  items: TimelineItem[]
  className?: string
}

function Timeline({ items, className }: TimelineProps) {
  return (
    <div className={cn("flex flex-col", className)}>
      {items.map((item, i) => {
        const status = item.status ?? "upcoming"
        const isLast = i === items.length - 1

        const DefaultIcon =
          status === "complete" ? Check : status === "current" ? Circle : Clock

        return (
          <div key={i} className="flex gap-3">
            {/* Left column: dot + line */}
            <div className="flex flex-col items-center">
              <div className={cn(dotVariants({ status }))}>
                {item.icon ? (
                  <span className="[&_svg]:size-3">{item.icon}</span>
                ) : (
                  <DefaultIcon className="size-3" />
                )}
              </div>
              {!isLast && (
                <div className="mt-1 min-h-4 w-px flex-1 bg-border" />
              )}
            </div>

            {/* Right column: content */}
            <div className={cn("min-w-0 flex-1 pb-4", isLast && "pb-0")}>
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className={cn(
                    "text-sm leading-snug font-medium",
                    status === "upcoming" && "text-muted-foreground"
                  )}
                >
                  {item.title}
                </span>
                {item.date && (
                  <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
                    {item.date}
                  </span>
                )}
              </div>
              {item.description && (
                <p className="mt-1 text-xs leading-snug text-muted-foreground">
                  {item.description}
                </p>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export { Timeline }
export type { TimelineProps, TimelineItem }
