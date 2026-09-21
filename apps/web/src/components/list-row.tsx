import type { ReactNode } from "react"
import { cn } from "@worktable/ui/lib/utils"

/**
 * ListRow — shared interactive list item for navigation lists.
 *
 * Used on homepage (recent activity), space overview (views list),
 * and anywhere a clickable row with icon + title + subtitle + meta appears.
 *
 * Renders as a styled container; wrap with <Link> or <a> externally.
 */

interface ListRowProps {
  /** Raw icon element — wrapped in a default primary container */
  icon?: ReactNode
  /** Pre-wrapped icon (e.g. ListRowIcon) — rendered as-is, no wrapper */
  iconSlot?: ReactNode
  /** Primary text */
  title: string
  /** Secondary text below title */
  subtitle?: string
  /** Trailing metadata (e.g. timestamp, count) */
  meta?: ReactNode
  /** Additional className on the outer wrapper */
  className?: string
  children?: never
}

export function ListRow({
  icon,
  iconSlot,
  title,
  subtitle,
  meta,
  className,
}: ListRowProps) {
  return (
    <div
      className={cn(
        "group flex items-start gap-3 rounded-lg px-4 py-3 transition-all duration-180 hover:bg-accent",
        className
      )}
    >
      <div className="mt-0.5 shrink-0">
        {iconSlot ?? <ListRowIcon>{icon}</ListRowIcon>}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground transition-colors group-hover:text-primary">
          {title}
        </p>
        {subtitle && (
          <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {meta && (
        <span className="mt-0.5 shrink-0 text-xs text-muted-foreground">
          {meta}
        </span>
      )}
    </div>
  )
}

/**
 * ListRowIcon — standardized icon container for ListRow.
 * Use when you need a non-primary-colored icon (e.g. space icons).
 */
interface ListRowIconProps {
  children: ReactNode
  variant?: "primary" | "muted"
}

export function ListRowIcon({
  children,
  variant = "primary",
}: ListRowIconProps) {
  return (
    <div
      className={cn(
        "flex size-8 items-center justify-center rounded-lg",
        variant === "primary"
          ? "bg-surface-tint text-primary"
          : "bg-muted text-muted-foreground"
      )}
    >
      {children}
    </div>
  )
}
