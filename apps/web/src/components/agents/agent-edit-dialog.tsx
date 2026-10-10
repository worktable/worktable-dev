import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  AGENT_PLATFORMS,
  type AgentAccess,
  type AgentConnection,
} from "@worktable/types"
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

import {
  updateAgentConnection,
  updateSignInAgent,
} from "@/lib/agent-connections-api"
import { threadQueryKeys } from "@/lib/threads-queries"
import { AgentAvatar } from "./agent-avatar"
import { AgentFields } from "./agent-fields"

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
    mutationFn: async () => {
      if (!connection) throw new Error("No agent selected")
      const trimmed = name.trim()
      const renamed = trimmed !== connection.displayName
      const iconChanged = icon !== (connection.icon ?? null)
      await updateAgentConnection(connection.id, {
        ...(renamed ? { displayName: trimmed } : {}),
        ...(iconChanged ? { icon } : {}),
        ...(access && !sameAccess(access, connection.access) ? { access } : {}),
      })
      // A sign-in agent on Cloud also appears in this workspace's threads.
      if (
        connection.authKind === "oauth" &&
        connection.target.kind === "mcp-client" &&
        connection.target.clientId &&
        (renamed || iconChanged)
      ) {
        await updateSignInAgent(connection.target.clientId, {
          ...(renamed ? { displayName: trimmed } : {}),
          ...(iconChanged ? { icon } : {}),
          platform: connection.platform,
        })
      }
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
