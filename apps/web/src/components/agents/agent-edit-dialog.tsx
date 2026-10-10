import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  AGENT_PLATFORMS,
  type AgentAccess,
  type AgentConnection,
} from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  useResponsiveDialog,
} from "@worktable/ui/components/responsive-dialog"
import { toast } from "@worktable/ui/components/sonner"
import { cn } from "@worktable/ui/lib/utils"

import { IconSearchGrid } from "@/components/icon-search-grid"
import { updateAgentConnection } from "@/lib/agent-connections-api"
import { threadQueryKeys } from "@/lib/threads-queries"
import { AgentAccessFields } from "./agent-access-fields"
import { AgentAvatar, agentLogoUrl } from "./agent-avatar"

function sameAccess(a: AgentAccess | null, b: AgentAccess | null): boolean {
  return a?.threads === b?.threads && a?.read === b?.read && a?.edit === b?.edit
}

/** Rename an agent, change its picture, or change what it may do. */
export function AgentEditDialog({
  connection,
  onOpenChange,
}: {
  connection: AgentConnection | null
  onOpenChange: (open: boolean) => void
}) {
  const { isMobile } = useResponsiveDialog()
  const queryClient = useQueryClient()
  const [name, setName] = useState("")
  const [icon, setIcon] = useState<string | null>(null)
  const [access, setAccess] = useState<AgentAccess | null>(null)

  useEffect(() => {
    if (!connection) return
    setName(connection.displayName)
    setIcon(connection.icon ?? null)
    setAccess(connection.access ?? null)
  }, [connection])

  const save = useMutation({
    mutationFn: () => {
      if (!connection) throw new Error("No agent selected")
      const trimmed = name.trim()
      return updateAgentConnection(connection.id, {
        ...(trimmed !== connection.displayName ? { displayName: trimmed } : {}),
        ...(icon !== (connection.icon ?? null) ? { icon } : {}),
        ...(access && !sameAccess(access, connection.access) ? { access } : {}),
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["agent-connections"] })
      void queryClient.invalidateQueries({ queryKey: ["tokens"] })
      void queryClient.invalidateQueries({ queryKey: threadQueryKeys.root })
      onOpenChange(false)
    },
    onError: (error) =>
      toast.error(
        error instanceof Error ? error.message : "Couldn’t save the agent."
      ),
  })

  if (!connection) return null
  const platform = AGENT_PLATFORMS[connection.platform] ?? AGENT_PLATFORMS.other
  const trimmed = name.trim()
  const changed =
    trimmed !== connection.displayName ||
    icon !== (connection.icon ?? null) ||
    !sameAccess(access, connection.access)
  const canSave =
    trimmed.length > 0 && trimmed.length <= 100 && changed && !save.isPending
  const hasLogo = agentLogoUrl(connection.platform) !== null

  return (
    <ResponsiveDialog open onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <AgentAvatar
            name={trimmed || connection.displayName}
            platform={connection.platform}
            icon={icon}
            className="mb-1 size-10"
          />
          <ResponsiveDialogTitle>
            {connection.displayName}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {[platform.name, connection.machine].filter(Boolean).join(" · ")}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="agent-name"
                className="text-sm font-medium text-foreground"
              >
                Name
              </label>
              <Input
                id="agent-name"
                value={name}
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
                autoFocus={!isMobile}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-foreground">Icon</span>
              <IconSearchGrid
                selected={icon}
                onSelect={setIcon}
                columns={9}
                className="max-h-40"
                leading={
                  <button
                    type="button"
                    onClick={() => setIcon(null)}
                    title={hasLogo ? `${platform.name} logo` : "Initials"}
                    aria-label={hasLogo ? `${platform.name} logo` : "Initials"}
                    aria-pressed={icon === null}
                    className={cn(
                      "flex size-8 items-center justify-center rounded-md transition-colors duration-150",
                      icon === null ? "bg-surface-selected" : "hover:bg-accent"
                    )}
                  >
                    <AgentAvatar
                      name={trimmed || connection.displayName}
                      platform={connection.platform}
                      className="size-6"
                    />
                  </button>
                }
              />
            </div>
            {access ? (
              <AgentAccessFields
                value={access}
                onChange={setAccess}
                alwaysOn={connection.mode === "always-on"}
              />
            ) : null}
          </div>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
