import { recognitionColor } from "@worktable/types/recognition"
import { Avatar, AvatarFallback } from "@worktable/ui/components/avatar"
import { cn } from "@worktable/ui/lib/utils"
import { recognitionSolid } from "@/lib/recognition"

/** A person's saved identity, shared by the profile, Threads, and activity. */
export function PersonAvatar({
  id,
  name,
  size = "sm",
  className,
}: {
  id: string
  name: string
  size?: "sm" | "md" | "lg"
  className?: string
}) {
  return (
    <Avatar
      className={cn(
        "size-6",
        size === "md" && "size-8",
        size === "lg" && "size-9",
        className
      )}
      aria-label={name}
    >
      <AvatarFallback
        className={cn("text-[11px] font-semibold", size !== "sm" && "text-sm")}
        style={recognitionSolid(recognitionColor(null, id))}
      >
        {name.trim().charAt(0).toUpperCase() || "?"}
      </AvatarFallback>
    </Avatar>
  )
}
