import { AGENT_PLATFORMS, type AgentPlatformId } from "@worktable/types"
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@worktable/ui/components/avatar"
import { cn } from "@worktable/ui/lib/utils"

import { NamedIcon } from "@/lib/icons"
import { participantInitials } from "@/lib/thread-presentation"

/**
 * Hermes fills its avatar. OpenAI's artwork already includes its own inset;
 * other marks need padding. Keep monochrome marks on white in both themes.
 */
const FULL_BLEED_LOGOS = new Set<AgentPlatformId>(["hermes"])
const PRE_PADDED_LOGOS = new Set<AgentPlatformId>(["chatgpt", "codex"])

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
  const logo = icon ? null : agentLogoUrl(platform)
  const initials = participantInitials(name)
  return (
    <Avatar className={cn("size-8", className)} aria-label={name}>
      {logo ? (
        <AvatarImage
          src={logo}
          alt=""
          className={cn(
            platform && FULL_BLEED_LOGOS.has(platform)
              ? "object-cover"
              : "bg-white object-contain",
            platform &&
              !FULL_BLEED_LOGOS.has(platform) &&
              !PRE_PADDED_LOGOS.has(platform) &&
              "p-[18%]"
          )}
        />
      ) : null}
      <AvatarFallback className="bg-surface-tint text-xs font-medium text-primary">
        {icon ? (
          <NamedIcon
            name={icon}
            className="size-[55%]"
            aria-hidden
            fallback={initials}
          />
        ) : (
          initials
        )}
      </AvatarFallback>
    </Avatar>
  )
}
