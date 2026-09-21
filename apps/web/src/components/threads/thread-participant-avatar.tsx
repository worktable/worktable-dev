import type { ParticipantRef } from "@worktable/types"
import { Avatar, AvatarFallback } from "@worktable/ui/components/avatar"
import { cn } from "@worktable/ui/lib/utils"

import { participantInitials } from "@/lib/thread-presentation"

interface ThreadParticipantAvatarProps {
  participant?: ParticipantRef
  className?: string
}

export function ThreadParticipantAvatar({
  participant,
  className,
}: ThreadParticipantAvatarProps) {
  const isAgent = participant?.kind === "agent"

  return (
    <Avatar
      className={cn("size-8", className)}
      aria-label={participant?.name ?? "Unknown participant"}
    >
      <AvatarFallback
        className={cn(
          "text-xs font-medium",
          isAgent && "bg-surface-tint text-primary"
        )}
      >
        {participant ? participantInitials(participant.name) : "?"}
      </AvatarFallback>
    </Avatar>
  )
}
