import { cn } from "@worktable/ui/lib/utils"

const variantStyles: Record<string, string> = {
  recommended: "bg-success/10 text-success ring-success/25",
  consider: "bg-warning/10 text-warning ring-warning/25",
  avoid: "bg-destructive/10 text-destructive ring-destructive/25",
  neutral: "bg-surface-tint text-primary ring-primary/25",
}

interface VerdictBadgeProps {
  verdict: "recommended" | "consider" | "avoid" | "neutral"
  label?: string
  className?: string
}

function VerdictBadge({ verdict, label, className }: VerdictBadgeProps) {
  const displayLabel =
    label ?? verdict.charAt(0).toUpperCase() + verdict.slice(1)

  return (
    <span
      className={cn(
        "inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-sm font-medium ring-1",
        variantStyles[verdict] ?? variantStyles.neutral,
        className
      )}
    >
      {displayLabel}
    </span>
  )
}

export { VerdictBadge }
export type { VerdictBadgeProps }
