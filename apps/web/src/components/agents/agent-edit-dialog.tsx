import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AGENT_PLATFORMS,
  agentConnectionPlatform,
  type AgentAccess,
  type AgentConnection,
  type AutoReply,
} from "@worktable/types"
import { Checkbox } from "@worktable/ui/components/checkbox"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
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
import { useConnectionApp, worksElsewhere } from "@/lib/app-choices"
import { WorksInSetting } from "./works-in"
import { CloudTaskSetup } from "./cloud-task-setup"

function sameAccess(a: AgentAccess | null, b: AgentAccess | null): boolean {
  return a?.threads === b?.threads && a?.read === b?.read && a?.edit === b?.edit
}

/** Rename an agent, change its picture, change what it may do, or disconnect it. */
export function AgentEditDialog({
  connection,
  autoReply,
  onOpenChange,
  onDisconnect,
  disconnecting = false,
}: {
  connection: AgentConnection | null
  /** Its latest auto-reply, which changes while the dialog is open. */
  autoReply?: AutoReply
  onOpenChange: (open: boolean) => void
  /** Absent when this agent can't be disconnected here. */
  onDisconnect?: () => void
  disconnecting?: boolean
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
  // The dialog shows a cloud task's setup steps in place of the agent's fields.
  const [settingUp, setSettingUp] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Where an app reached through Cloud works, when Cloud can say.
  const app = useConnectionApp(connection)

  useEffect(() => {
    if (!connection) return
    setSpaceIds(connection.spaceIds ?? null)
    setName(connection.displayName)
    setIcon(connection.icon ?? null)
    setAccess(connection.access ?? null)
    setSettingUp(false)
    setConfirming(false)
  }, [connection])

  // Back to the agent once the test reaches it.
  if (settingUp && autoReply?.state === "on") setSettingUp(false)

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
  // Only a token made here or a sign-in with access saves changes here.
  const editable =
    connection.authKind === "local-token" ||
    (connection.authKind === "oauth" && connection.access != null)
  const platformId = agentConnectionPlatform(connection)
  const platform = AGENT_PLATFORMS[platformId]
  const trimmed = name.trim()
  const changed =
    trimmed !== connection.displayName ||
    icon !== (connection.icon ?? null) ||
    !sameAccess(access, connection.access) ||
    (connection.ownership === "personal" &&
      JSON.stringify(spaceIds) !== JSON.stringify(connection.spaceIds ?? null))
  const canSave =
    trimmed.length > 0 && trimmed.length <= 100 && changed && !save.isPending

  const header = (
    <ResponsiveDialogHeader>
      <AgentAvatar
        name={trimmed || connection.displayName}
        platform={platformId}
        icon={icon}
        className="mb-1 size-10"
      />
      <ResponsiveDialogTitle>{connection.displayName}</ResponsiveDialogTitle>
      <ResponsiveDialogDescription>
        {[platform.name, connection.machine].filter(Boolean).join(" · ")}
      </ResponsiveDialogDescription>
    </ResponsiveDialogHeader>
  )

  if (settingUp && autoReply)
    return (
      <ResponsiveDialog open onOpenChange={onOpenChange}>
        <ResponsiveDialogContent>
          {header}
          <ResponsiveDialogBody>
            <CloudTaskSetup connection={{ ...connection, autoReply }} />
          </ResponsiveDialogBody>
          <ResponsiveDialogFooter>
            <Button variant="outline" onClick={() => setSettingUp(false)}>
              Back
            </Button>
          </ResponsiveDialogFooter>
        </ResponsiveDialogContent>
      </ResponsiveDialog>
    )

  return (
    <ResponsiveDialog open onOpenChange={onOpenChange}>
      <ResponsiveDialogContent>
        {header}
        <ResponsiveDialogBody>
          {app?.worktable && (
            <div className={autoReply ? "mb-3" : "mb-5"}>
              <WorksInSetting app={app} />
            </div>
          )}
          {autoReply && (
            <div className="mb-5">
              <AutoReplySetting
                connection={{ ...connection, autoReply }}
                onSetUp={() => setSettingUp(true)}
                elsewhere={worksElsewhere(app)}
              />
            </div>
          )}
          {editable && (
            <AgentFields
              platform={platformId}
              name={name}
              onNameChange={setName}
              icon={icon}
              onIconChange={setIcon}
              access={access}
              onAccessChange={setAccess}
              alwaysOn={connection.mode === "always-on"}
              autoFocus={!isMobile}
            />
          )}
          {editable && connection.ownership === "personal" && (
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
          {connection.link && (
            <a
              href={connection.link.manageUrl}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-muted-foreground hover:text-foreground sm:mr-auto sm:self-center"
            >
              Manage in Cloud
            </a>
          )}
          {onDisconnect && (
            <Button
              variant="destructive"
              className="sm:mr-auto"
              disabled={disconnecting || save.isPending}
              onClick={() => setConfirming(true)}
            >
              Disconnect
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {editable ? "Cancel" : "Close"}
          </Button>
          {editable && (
            <Button disabled={!canSave} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          )}
        </ResponsiveDialogFooter>
        {/* Nested, so answering it never counts as leaving the dialog. */}
        {onDisconnect && (
          <ConfirmDialog
            open={confirming}
            onOpenChange={(open) => {
              if (!disconnecting) setConfirming(open)
            }}
            title={`Disconnect ${connection.displayName}?`}
            description="It loses access to this Worktable."
            confirmLabel="Disconnect"
            variant="destructive"
            loading={disconnecting}
            loadingLabel="Disconnecting…"
            onConfirm={onDisconnect}
          />
        )}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
