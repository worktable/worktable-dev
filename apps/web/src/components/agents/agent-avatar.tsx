import { AGENT_PLATFORMS, type AgentPlatformId } from "@worktable/types"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@worktable/ui/components/avatar"
import { cn } from "@worktable/ui/lib/utils"

import { getIcon } from "@/lib/icons"
import { participantInitials } from "@/lib/thread-presentation"

/** Logos drawn edge to edge; the rest sit inset on a neutral disc. */
const FULL_BLEED_LOGOS = new Set<AgentPlatformId>(["hermes"])

export function agentLogoUrl(
  platform: AgentPlatformId | undefined
): string | null {
  const logo = platform ? AGENT_PLATFORMS[platform]?.logo : null
  return logo ? `/agent-logos/${logo}` : null
}

/**
 * An agent's picture: the icon its owner chose, else its platform's logo,
 * else its initials.
 */
export function AgentAvatar({
  name,
  platform,
  icon,
  className,
}: {
  name: string
  platform?: AgentPlatformId
  icon?: string | null
  className?: string
}) {
  const Icon = icon ? getIcon(icon) : null
  const logo = Icon ? null : agentLogoUrl(platform)
  return (
    <Avatar className={cn("size-8", className)} aria-label={name}>
      {logo ? (
        <AvatarImage
          src={logo}
          alt=""
          className={cn(
            platform && FULL_BLEED_LOGOS.has(platform)
              ? "object-cover"
              : "bg-card object-contain p-[18%]"
          )}
        />
      ) : null}
      <AvatarFallback className="bg-surface-tint text-xs font-medium text-primary">
        {Icon ? (
          <Icon className="size-[55%]" aria-hidden />
        ) : (
          participantInitials(name)
        )}
      </AvatarFallback>
    </Avatar>
  )
}
