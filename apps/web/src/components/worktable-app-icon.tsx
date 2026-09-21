import { cn } from "@worktable/ui/lib/utils"

export function WorktableAppIcon({ className }: { className?: string }) {
  return (
    <img
      src="/favicon.svg"
      alt=""
      aria-hidden="true"
      draggable={false}
      className={cn("shrink-0", className)}
    />
  )
}
