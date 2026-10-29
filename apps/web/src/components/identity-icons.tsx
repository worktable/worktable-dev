import { useState, type ReactNode } from "react"
import {
  platformForName,
  type AgentPlatformId,
  type ParticipantRef,
} from "@worktable/types"
import { recognitionColor } from "@worktable/types/recognition"
import { cn } from "@worktable/ui/lib/utils"
import { NamedIcon, resolveIcon } from "@/lib/icons"
import {
  agentLogoUrl,
  participantInitials,
  recognitionChip,
  recognitionSolid,
} from "@/lib/recognition"
import { useWorkspace } from "@/lib/queries"

// Recognition graphics share one small module already loaded by the sidebar.
// Keep avatars free of Thread schema and image-widget dependencies.
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
  // Hermes fills its circle; OpenAI and Goose artwork include their own padding.
  const fullBleed = platform === "hermes"
  const prePadded =
    platform === "chatgpt" || platform === "codex" || platform === "goose"
  const initials = participantInitials(name)
  const fallback = icon ? (
    <NamedIcon
      name={icon}
      className="size-[55%]"
      aria-hidden
      fallback={initials}
    />
  ) : (
    initials
  )
  return (
    <span
      data-slot="avatar"
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-xs font-medium ring-1 ring-border select-none ring-inset",
        className
      )}
      aria-label={name}
      style={(icon ? recognitionChip : recognitionSolid)(
        recognitionColor(null, name)
      )}
    >
      {logo ? (
        <AgentLogo
          key={logo}
          src={logo}
          fallback={fallback}
          className={cn(
            fullBleed ? "object-cover" : "bg-white object-contain",
            prePadded && "scale-125",
            platform && !fullBleed && !prePadded && "p-[18%]"
          )}
        />
      ) : (
        fallback
      )}
    </span>
  )
}

/** Keep initials visible until the local logo loads, or if it cannot load. */
function AgentLogo({
  src,
  fallback,
  className,
}: {
  src: string
  fallback: ReactNode
  className: string
}) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading")
  return (
    <>
      {state !== "loaded" && fallback}
      {state !== "failed" && (
        <img
          src={src}
          alt=""
          className={cn("absolute inset-0 size-full", className)}
          hidden={state !== "loaded"}
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
        />
      )}
    </>
  )
}

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
    <span
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold",
        size === "md" && "size-8 text-sm",
        size === "lg" && "size-9 text-sm",
        className
      )}
      aria-label={name}
      style={recognitionSolid(recognitionColor(null, id))}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  )
}

interface ThreadParticipantAvatarProps {
  participant?: ParticipantRef
  className?: string
}

export function ThreadParticipantAvatar({
  participant,
  className,
}: ThreadParticipantAvatarProps) {
  const workspace = useWorkspace()
  const current = participant
    ? workspace.data?.presentations?.[participant.id]
    : undefined

  if (participant?.kind === "agent") {
    // The directory has the agent's current platform and chosen icon, also
    // for an agent no longer offered as a recipient.
    return (
      <AgentAvatar
        name={current?.name ?? participant.name}
        // A sign-in agent (Claude, ChatGPT on Cloud) has no agent record here.
        platform={current?.platform ?? platformForName(participant.name)}
        icon={current?.icon}
        className={className}
      />
    )
  }

  if (participant?.kind === "human") {
    return (
      <PersonAvatar
        id={current?.id ?? participant.id}
        name={current?.name ?? participant.name}
        size="md"
        className={className}
      />
    )
  }

  return (
    <span
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium",
        className
      )}
      aria-label={participant?.name ?? "Unknown participant"}
      style={
        participant
          ? recognitionSolid(recognitionColor(null, participant.id))
          : undefined
      }
    >
      {participant ? participantInitials(participant.name) : "?"}
    </span>
  )
}

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
