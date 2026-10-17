import { platformForName, type ParticipantRef } from "@worktable/types"
import { recognitionColor } from "@worktable/types/recognition"
import { Avatar, AvatarFallback } from "@worktable/ui/components/avatar"
import { cn } from "@worktable/ui/lib/utils"

import { AgentAvatar } from "@/components/agents/agent-avatar"
import { participantInitials } from "@/lib/thread-presentation"
import { recognitionSolid } from "@/lib/recognition"
import { useThreadParticipants } from "@/lib/threads-queries"

interface ThreadParticipantAvatarProps {
  participant?: ParticipantRef
  className?: string
}

export function ThreadParticipantAvatar({
  participant,
  className,
}: ThreadParticipantAvatarProps) {
  const isAgent = participant?.kind === "agent"
  const participants = useThreadParticipants()

  if (participant && isAgent) {
    // The directory has the agent's current platform and chosen icon, also
    // for an agent no longer offered as a recipient.
    const current = participants.data?.presentations?.[participant.id]
    return (
      <AgentAvatar
        name={participant.name}
        // A sign-in agent (Claude, ChatGPT on Cloud) has no agent record here.
        platform={current?.platform ?? platformForName(participant.name)}
        icon={current?.icon}
        className={className}
      />
    )
  }

  return (
    <Avatar
      className={cn("size-8", className)}
      aria-label={participant?.name ?? "Unknown participant"}
    >
      <AvatarFallback
        className="text-xs font-medium"
        // A person's color follows their participant id, as in the sidebar.
        style={participant ? recognitionSolid(recognitionColor(null, participant.id)) : undefined}
      >
        {participant ? participantInitials(participant.name) : "?"}
      </AvatarFallback>
    </Avatar>
  )
}
