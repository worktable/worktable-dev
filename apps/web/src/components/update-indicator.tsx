import { cn } from "@worktable/ui/lib/utils"

export function UpdateIndicatorDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-1.5 rounded-full bg-info", className)}
    />
  )
}
