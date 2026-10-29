import { TruncatedText } from "@worktable/ui/components/truncated-text"
import { Link } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { PinOff } from "lucide-react"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"
import type { SpaceView } from "@/lib/api"
import { ProgressRing } from "@/components/getting-started/progress-ring"
import { saveSetup, type ChecklistProgress } from "@/lib/setup"

export function GettingStartedRow({
  space,
  progress,
  active,
  onNavigate,
}: {
  space: SpaceView
  progress: ChecklistProgress
  active: boolean
  onNavigate: () => void
}) {
  const queryClient = useQueryClient()
  const unpin = () => {
    saveSetup(queryClient, { hidden: true }).catch(() =>
      toast.error("Couldn’t unpin. Try again.")
    )
  }
  return (
    <div className="group/getting-started relative mx-1 mb-3">
      <Link
        to="/spaces/$spaceId"
        params={{ spaceId: space.id }}
        onClick={onNavigate}
        className={cn(
          "flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm transition-colors duration-180",
          active
            ? "bg-sidebar-accent font-medium text-sidebar-primary"
            : "text-sidebar-item-foreground hover:bg-sidebar-hover hover:text-sidebar-foreground"
        )}
      >
        <ProgressRing done={progress.done} total={progress.total} />
        <TruncatedText text={space.name} className="flex-1" />
        <span className="text-xs text-sidebar-foreground/45 tabular-nums group-hover/getting-started:opacity-0 group-has-[:focus-visible]/getting-started:opacity-0">
          {progress.done}/{progress.total}
        </span>
      </Link>
      <button
        type="button"
        aria-label="Unpin Getting Started"
        title="Unpin"
        onClick={unpin}
        className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-sidebar-foreground/50 opacity-0 transition-opacity group-hover/getting-started:opacity-100 hover:bg-sidebar-hover hover:text-sidebar-foreground focus-visible:opacity-100"
      >
        <PinOff className="size-3.5" />
      </button>
    </div>
  )
}
