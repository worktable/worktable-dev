import { recognitionColor } from "@worktable/types/recognition"
import { cn } from "@worktable/ui/lib/utils"
import { resolveIcon } from "@/lib/icons"
import { recognitionChip } from "@/lib/recognition"

const SIZES = {
  // Rounded squares, a quarter of their width: Spaces are places, and only
  // people are round.
  xs: { chip: "size-4 rounded-[4px]", icon: "size-3" },
  sm: { chip: "size-5 rounded-[5px]", icon: "size-3.5" },
  lg: { chip: "size-9 rounded-[9px]", icon: "size-5" },
} as const

/** A Space's icon on its own color, the same for everyone wherever it shows. */
export function SpaceIcon({
  space,
  size = "sm",
  className,
}: {
  space: { id: string; icon?: string; settings?: Record<string, unknown> }
  size?: keyof typeof SIZES
  className?: string
}) {
  const color = recognitionColor(space.settings?.color, space.id)
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center",
        SIZES[size].chip,
        className
      )}
      style={recognitionChip(color)}
    >
      {resolveIcon(space.icon, SIZES[size].icon)}
    </span>
  )
}
