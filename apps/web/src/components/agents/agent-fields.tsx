import { useId } from "react"
import {
  AGENT_PLATFORMS,
  type AgentAccess,
  type AgentPlatformId,
} from "@worktable/types"
import { Input } from "@worktable/ui/components/input"
import { cn } from "@worktable/ui/lib/utils"

import { IconSearchGrid } from "@/components/icon-search-grid"
import { AgentAccessFields } from "./agent-access-fields"
import { AgentAvatar, agentLogoUrl } from "./agent-avatar"

/** An agent's name, icon, and access, as its owner sets them. */
export function AgentFields({
  platform,
  name,
  onNameChange,
  icon,
  onIconChange,
  access,
  onAccessChange,
  alwaysOn,
  autoFocus,
}: {
  platform: AgentPlatformId
  name: string
  onNameChange: (name: string) => void
  icon: string | null
  onIconChange: (icon: string | null) => void
  access: AgentAccess | null
  onAccessChange: (access: AgentAccess) => void
  alwaysOn: boolean
  autoFocus?: boolean
}) {
  const id = useId()
  const platformName = (AGENT_PLATFORMS[platform] ?? AGENT_PLATFORMS.other).name
  const platformLabel = agentLogoUrl(platform)
    ? `${platformName} logo`
    : "Initials"
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <label
          htmlFor={`${id}-name`}
          className="text-sm font-medium text-foreground"
        >
          Name
        </label>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={100}
          onChange={(event) => onNameChange(event.target.value)}
          autoFocus={autoFocus}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-foreground">Icon</span>
        <IconSearchGrid
          selected={icon}
          onSelect={onIconChange}
          columns={9}
          className="max-h-40"
          leading={
            <button
              type="button"
              onClick={() => onIconChange(null)}
              title={platformLabel}
              aria-label={platformLabel}
              aria-pressed={icon === null}
              className={cn(
                "flex size-8 items-center justify-center rounded-md transition-colors duration-150",
                icon === null ? "bg-surface-selected" : "hover:bg-accent"
              )}
            >
              <AgentAvatar
                name={name.trim() || platformName}
                platform={platform}
                className="size-6"
              />
            </button>
          }
        />
      </div>
      {access ? (
        <AgentAccessFields
          value={access}
          onChange={onAccessChange}
          alwaysOn={alwaysOn}
        />
      ) : null}
    </div>
  )
}
