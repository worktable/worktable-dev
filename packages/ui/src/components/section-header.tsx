import type { ReactNode } from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@worktable/ui/lib/utils"

const titleVariants = cva("font-medium leading-snug text-foreground", {
  variants: {
    level: {
      1: "text-xl tracking-tight",
      2: "text-lg",
      3: "text-sm",
    },
  },
  defaultVariants: {
    level: 2,
  },
})

const subtitleVariants = cva("text-muted-foreground leading-snug", {
  variants: {
    level: {
      1: "text-sm",
      2: "text-xs",
      3: "text-xs",
    },
  },
  defaultVariants: {
    level: 2,
  },
})

const wrapperVariants = cva("flex items-start justify-between gap-3", {
  variants: {
    level: {
      1: "mt-2 mb-5",
      2: "mt-2 mb-4",
      3: "mt-1 mb-2",
    },
  },
  defaultVariants: {
    level: 2,
  },
})

interface SectionHeaderProps extends VariantProps<typeof titleVariants> {
  title: string
  subtitle?: string
  action?: ReactNode
  level?: 1 | 2 | 3
  className?: string
}

function SectionHeader({
  title,
  subtitle,
  action,
  level = 2,
  className,
}: SectionHeaderProps) {
  const Tag = (level === 1 ? "h2" : level === 2 ? "h3" : "h4") as
    | "h2"
    | "h3"
    | "h4"

  return (
    <div className={cn(wrapperVariants({ level }), className)}>
      <div className="flex flex-col gap-0.5 min-w-0">
        <Tag className={cn(titleVariants({ level }))}>{title}</Tag>
        {subtitle && (
          <p className={cn(subtitleVariants({ level }))}>{subtitle}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

export { SectionHeader }
export type { SectionHeaderProps }
