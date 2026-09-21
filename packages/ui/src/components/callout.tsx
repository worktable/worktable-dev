import type { ReactNode } from "react"
import { Info, AlertTriangle, CheckCircle, XCircle } from "lucide-react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@worktable/ui/lib/utils"

const calloutVariants = cva(
  "relative flex gap-3 rounded-xl p-3 text-sm ring-1",
  {
    variants: {
      variant: {
        info: "bg-info/8 ring-info/20 text-foreground",
        warning: "bg-warning/8 ring-warning/20 text-foreground",
        success: "bg-success/8 ring-success/20 text-foreground",
        danger: "bg-destructive/8 ring-destructive/20 text-foreground",
      },
    },
    defaultVariants: {
      variant: "info",
    },
  }
)

const iconVariants = cva("size-4 shrink-0 mt-0.5", {
  variants: {
    variant: {
      info: "text-info",
      warning: "text-warning",
      success: "text-success",
      danger: "text-destructive",
    },
  },
  defaultVariants: {
    variant: "info",
  },
})

const iconMap = {
  info: Info,
  warning: AlertTriangle,
  success: CheckCircle,
  danger: XCircle,
} as const

interface CalloutProps extends VariantProps<typeof calloutVariants> {
  title?: string
  children: ReactNode
  className?: string
}

function Callout({ variant = "info", title, children, className }: CalloutProps) {
  const Icon = iconMap[variant ?? "info"]

  return (
    <div className={cn(calloutVariants({ variant }), className)} role="note">
      <Icon className={cn(iconVariants({ variant }))} aria-hidden="true" />
      <div className="flex flex-col gap-1 min-w-0">
        {title && (
          <span className="font-medium leading-snug">{title}</span>
        )}
        <div className="text-sm text-foreground/90 leading-snug">{children}</div>
      </div>
    </div>
  )
}

export { Callout }
export type { CalloutProps }
