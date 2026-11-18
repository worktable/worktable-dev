import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"

import type { ThreadListFilter, ThreadListView } from "@/lib/thread-list-view"

const FILTERS: Record<ThreadListFilter, string> = {
  people: "People",
  agents: "Agents",
  all: "All",
}
const VIEWS: Record<ThreadListView, string> = {
  ...FILTERS,
  archived: "Archived",
}

/** Chooses whose threads the list shows, or the archive. */
export function ThreadViewSelect({
  value,
  onChange,
  className,
}: {
  value: ThreadListView
  onChange: (view: ThreadListView) => void
  className?: string
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next && next in VIEWS) onChange(next as ThreadListView)
      }}
    >
      <SelectTrigger aria-label="Thread filter" className={className}>
        <SelectValue>{VIEWS[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(FILTERS) as ThreadListFilter[]).map((filter) => (
          <SelectItem key={filter} value={filter}>
            {FILTERS[filter]}
          </SelectItem>
        ))}
        <SelectSeparator />
        <SelectItem value="archived">{VIEWS.archived}</SelectItem>
      </SelectContent>
    </Select>
  )
}
