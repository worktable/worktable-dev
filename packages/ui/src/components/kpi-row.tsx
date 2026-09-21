import { cn } from "@worktable/ui/lib/utils"
import { StatCard } from "@worktable/ui/components/stat-card"
import type { StatCardProps } from "@worktable/ui/components/stat-card"

interface KpiRowProps {
  items: StatCardProps[]
  columns?: 2 | 3 | 4
  className?: string
}

const colClasses: Record<number, string> = {
  2: "grid-cols-1 sm:grid-cols-2",
  3: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
  4: "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4",
}

function KpiRow({ items, columns, className }: KpiRowProps) {
  const cols = columns ?? Math.min(4, Math.max(2, items.length)) as 2 | 3 | 4

  return (
    <div className={cn("grid gap-3", colClasses[cols], className)}>
      {items.map((item, i) => (
        <StatCard key={i} {...item} />
      ))}
    </div>
  )
}

export { KpiRow }
export type { KpiRowProps }
