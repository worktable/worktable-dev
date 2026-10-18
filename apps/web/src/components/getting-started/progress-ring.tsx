import { cn } from "@worktable/ui/lib/utils"

/** A small ring that fills as a person's first steps complete. */
export function ProgressRing({
  done,
  total,
  className,
}: {
  done: number
  total: number
  className?: string
}) {
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const share = total > 0 ? Math.min(1, done / total) : 0
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn("size-4 shrink-0 -rotate-90", className)}
      aria-hidden
    >
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2"
        className="stroke-border"
      />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - share)}
        className="stroke-primary transition-[stroke-dashoffset] duration-500 motion-reduce:transition-none"
      />
    </svg>
  )
}
