import { recognitionColor } from "@worktable/types/recognition"
import { cn } from "@worktable/ui/lib/utils"
import { resolveIcon } from "@/lib/icons"
import { recognitionChip } from "@/lib/recognition"

const SIZES = {
  xs: { chip: "size-4 rounded", icon: "size-3" },
  sm: { chip: "size-5 rounded-md", icon: "size-3.5" },
  lg: { chip: "size-9 rounded-lg", icon: "size-5" },
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
