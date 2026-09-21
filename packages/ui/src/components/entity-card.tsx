import type { ReactNode } from "react"

import { cn } from "@worktable/ui/lib/utils"
import { Badge } from "@worktable/ui/components/badge"

interface BadgeItem {
  label: string
  variant?: "default" | "secondary" | "destructive" | "outline"
}

interface MetadataItem {
  label: string
  value: string
}

interface EntityCardProps {
  name: string
  subtitle?: string
  description?: string
  avatar?: string
  badges?: BadgeItem[]
  metadata?: MetadataItem[]
  actions?: ReactNode
  className?: string
}

function getInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("")
}

function EntityCard({
  name,
  subtitle,
  description,
  avatar,
  badges,
  metadata,
  actions,
  className,
}: EntityCardProps) {
  const initials = getInitials(name)

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl bg-card p-3 text-sm text-card-foreground ring-1 ring-border transition-all duration-180",
        className
      )}
    >
      {/* Header: avatar + name */}
      <div className="flex items-start gap-3">
        <div className="shrink-0">
          {avatar ? (
            <img
              src={avatar}
              alt={name}
              className="size-9 rounded-lg object-cover ring-1 ring-border"
            />
          ) : (
            <div className="flex size-9 items-center justify-center rounded-lg bg-surface-tint ring-1 ring-primary/20">
              <span className="text-xs font-bold text-primary">{initials}</span>
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate leading-snug font-medium">{name}</div>
          {subtitle && (
            <div className="mt-0.5 truncate text-xs text-muted-foreground">
              {subtitle}
            </div>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>

      {/* Badges */}
      {badges && badges.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {badges.map((badge, i) => (
            <Badge key={i} variant={badge.variant ?? "secondary"}>
              {badge.label}
            </Badge>
          ))}
        </div>
      )}

      {/* Description */}
      {description && (
        <p className="line-clamp-3 text-xs leading-snug text-muted-foreground">
          {description}
        </p>
      )}

      {/* Metadata */}
      {metadata && metadata.length > 0 && (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-border pt-1">
          {metadata.map((item, i) => (
            <div key={i} className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">
                {item.label}
              </span>
              <span className="truncate text-xs font-medium">{item.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export { EntityCard }
export type { EntityCardProps, BadgeItem, MetadataItem }
