import type { ReactNode } from "react"
import { TrendingUp, TrendingDown, Minus } from "lucide-react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@worktable/ui/lib/utils"

const statCardVariants = cva(
  "group/stat-card relative flex flex-col gap-2 overflow-hidden rounded-xl p-3 ring-1 ring-border transition-all duration-180",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        highlight:
          "bg-surface-tint text-card-foreground ring-primary/20 dark:bg-surface-tint",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

interface TrendProps {
  direction: "up" | "down" | "flat"
  label: string
}

interface StatCardProps extends VariantProps<typeof statCardVariants> {
  label: string
  value: string | number
  description?: string
  trend?: TrendProps
  icon?: ReactNode
  className?: string
}

function StatCard({
  label,
  value,
  description,
  trend,
  icon,
  variant = "default",
  className,
}: StatCardProps) {
  const TrendIcon =
    trend?.direction === "up"
      ? TrendingUp
      : trend?.direction === "down"
        ? TrendingDown
        : Minus

  const trendColor =
    trend?.direction === "up"
      ? "text-success bg-success/10"
      : trend?.direction === "down"
        ? "text-destructive bg-destructive/10"
        : "text-muted-foreground bg-muted"

  return (
    <div className={cn(statCardVariants({ variant }), className)}>
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {label}
        </span>
        {icon && (
          <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
        )}
      </div>

      <div className="flex items-end justify-between gap-2">
        <span className="text-2xl leading-none font-bold text-foreground tabular-nums">
          {value}
        </span>
        {trend && (
          <div
            className={cn(
              "flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
              trendColor
            )}
          >
            <TrendIcon className="size-3" />
            <span>{trend.label}</span>
          </div>
        )}
      </div>

      {description && (
        <p className="text-xs leading-snug text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  )
}

export { StatCard }
export type { StatCardProps }
