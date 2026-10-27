import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AGENT_PLATFORMS,
  type AgentAccess,
  type AgentConnection,
  type AutoReply,
} from "@worktable/types"
import { Checkbox } from "@worktable/ui/components/checkbox"
import { getSpaces } from "@/lib/api"
import { Button } from "@worktable/ui/components/button"
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

import { saveAgentChanges } from "@/lib/agent-connections-api"
import { threadQueryKeys } from "@/lib/threads-queries"
import { AgentAvatar } from "./agent-avatar"
import { AgentFields } from "./agent-fields"
import { AutoReplySetting } from "./auto-reply"

function sameAccess(a: AgentAccess | null, b: AgentAccess | null): boolean {
  return a?.threads === b?.threads && a?.read === b?.read && a?.edit === b?.edit
}

/** Rename an agent, change its picture, or change what it may do. */
export function AgentEditDialog({
  connection,
  autoReply,
  onOpenChange,
}: {
  connection: AgentConnection | null
  /** Its latest auto-reply, which changes while the dialog is open. */
  autoReply?: AutoReply
  onOpenChange: (open: boolean) => void
}) {
  const { isMobile } = useResponsiveDialog()
  const queryClient = useQueryClient()
  const spaces = useQuery({
    queryKey: ["spaces"],
    queryFn: getSpaces,
    enabled: connection?.ownership === "personal",
  })
  const [spaceIds, setSpaceIds] = useState<string[] | null>(null)
  const [name, setName] = useState("")
  const [icon, setIcon] = useState<string | null>(null)
  const [access, setAccess] = useState<AgentAccess | null>(null)

  useEffect(() => {
    if (!connection) return
    setSpaceIds(connection.spaceIds ?? null)
    setName(connection.displayName)
    setIcon(connection.icon ?? null)
    setAccess(connection.access ?? null)
  }, [connection])

  const save = useMutation({
    mutationFn: async () => {
      if (!connection) throw new Error("No agent selected")
      await saveAgentChanges(connection, {
        name,
        icon,
        access,
        ...(connection.ownership === "personal" ? { spaceIds } : {}),
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
    !sameAccess(access, connection.access) ||
    (connection.ownership === "personal" &&
      JSON.stringify(spaceIds) !== JSON.stringify(connection.spaceIds ?? null))
  const canSave =
    trimmed.length > 0 && trimmed.length <= 100 && changed && !save.isPending

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
          {autoReply && (
            <div className="mb-5">
              <AutoReplySetting connection={{ ...connection, autoReply }} />
            </div>
          )}
          <AgentFields
            platform={connection.platform}
            name={name}
            onNameChange={setName}
            icon={icon}
            onIconChange={setIcon}
            access={access}
            onAccessChange={setAccess}
            alwaysOn={connection.mode === "always-on"}
            autoFocus={!isMobile}
          />
          {connection.ownership === "personal" && (
            <div className="mt-5 flex flex-col gap-3">
              <p className="text-sm font-medium">Space access</p>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={spaceIds === null}
                  disabled={save.isPending}
                  onCheckedChange={(checked) =>
                    setSpaceIds(checked ? null : [])
                  }
                />
                Follow my current and future Space access
              </label>
              {spaceIds !== null &&
                spaces.data?.map((space) => (
                  <label
                    key={space.id}
                    className="flex items-center gap-2 text-sm"
                  >
                    <Checkbox
                      checked={spaceIds.includes(space.id)}
                      disabled={save.isPending}
                      onCheckedChange={(checked) =>
                        setSpaceIds((previous) =>
                          checked
                            ? [...(previous ?? []), space.id]
                            : (previous ?? []).filter((id) => id !== space.id)
                        )
                      }
                    />
                    {space.name}
                  </label>
                ))}
              {spaces.isError && (
                <p role="alert" className="text-sm text-destructive">
                  Could not load Spaces.
                </p>
              )}
            </div>
          )}
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
