import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"

import {
  parseThreadListView,
  type ThreadListView,
} from "@/lib/thread-list-view"

const VIEWS: Record<ThreadListView, string> = {
  mine: "Mine",
  all: "Everyone",
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
        if (next) onChange(parseThreadListView(next))
      }}
    >
      <SelectTrigger aria-label="Thread filter" className={className}>
        <SelectValue>{VIEWS[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(VIEWS) as ThreadListView[]).map((view) => (
          <SelectItem key={view} value={view}>
            {VIEWS[view]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
