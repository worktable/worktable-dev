import { useState, lazy, Suspense } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import { Badge } from "@worktable/ui/components/badge"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { toast } from "@worktable/ui/components/sonner"
import { SettingsGroup } from "../settings-group"
import { useSettingsSectionActive } from "../settings-dialog"
import {
  activateTeams,
  cancelTeamInvitation,
  changeMemberRole,
  getTeamInvitations,
  getTeamMembers,
  getTeamAgents,
  registerTeamAgent,
  getTeamStatus,
  inviteTeamMember,
  removeTeamMember,
} from "@/lib/team-api"
import { signOutLocalTeam } from "@/lib/team-context"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import { getSpaces } from "@/lib/api"
import { SpaceAccessEditor } from "@/components/spaces/space-access-editor"
import type { TeamMember } from "@worktable/types"

const TeamAgentConnectPanel = lazy(() =>
  import("./agents").then((module) => ({
    default: module.TeamAgentConnectPanel,
  }))
)

export function TeamSection() {
  const active = useSettingsSectionActive()
  const team = useQuery({
    queryKey: ["team"],
    queryFn: getTeamStatus,
    enabled: active,
  })
  const deployment = useDeploymentInfo()
  if (team.isPending)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading team…
      </p>
    )
  if (team.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load the team. Try reopening Settings.
      </p>
    )
  if (!team.data.enabled) return <EnableTeams />
  return (
    <TeamMembers
      owner={team.data.member?.role === "owner"}
      selfId={team.data.member?.id}
      cloud={deployment.data?.mode === "cloud"}
    />
  )
}

function EnableTeams() {
  const [name, setName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const activate = useMutation({
    mutationFn: () => activateTeams({ name, email, password }),
    onSuccess: () => window.location.reload(),
  })
  return (
    <SettingsGroup title="Worktable for Teams">
      <p className="text-sm text-muted-foreground">
        Give each person their own account and control which Spaces they can
        access. Your existing Spaces stay restricted until you share them.
      </p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          activate.mutate()
        }}
      >
        <Input
          aria-label="Your name"
          placeholder="Your name"
          autoComplete="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          disabled={activate.isPending}
        />
        <Input
          aria-label="Email"
          placeholder="Email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
          disabled={activate.isPending}
        />
        <Input
          aria-label="Password"
          placeholder="Password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
          disabled={activate.isPending}
        />
        {activate.isError && (
          <p role="alert" className="text-sm text-destructive">
            {activate.error.message}
          </p>
        )}
        <Button type="submit" disabled={activate.isPending}>
          {activate.isPending ? "Enabling Teams…" : "Enable Teams"}
        </Button>
      </form>
    </SettingsGroup>
  )
}

function TeamMembers({
  owner,
  selfId,
  cloud,
}: {
  owner: boolean
  selfId?: string
  cloud: boolean
}) {
  const client = useQueryClient()
  const [email, setEmail] = useState("")
  const [inviteUrl, setInviteUrl] = useState<string | null>(null)
  const [removing, setRemoving] = useState<TeamMember | null>(null)
  const [selectedSpace, setSelectedSpace] = useState<string | null>(null)
  const members = useQuery({
    queryKey: ["team", "members"],
    queryFn: getTeamMembers,
  })
  const invitations = useQuery({
    queryKey: ["team", "invitations"],
    queryFn: getTeamInvitations,
  })
  const spaces = useQuery({ queryKey: ["spaces"], queryFn: getSpaces })
  const refresh = () => client.invalidateQueries({ queryKey: ["team"] })
  const invite = useMutation({
    mutationFn: () => inviteTeamMember(email),
    onSuccess: (result) => {
      setInviteUrl(result.url)
      setEmail("")
      void refresh()
    },
  })
  const cancel = useMutation({
    mutationFn: cancelTeamInvitation,
    onSuccess: refresh,
  })
  const role = useMutation({
    mutationFn: ({ id, value }: { id: string; value: TeamMember["role"] }) =>
      changeMemberRole(id, value),
    onSuccess: refresh,
  })
  const remove = useMutation({
    mutationFn: removeTeamMember,
    onSuccess: () => {
      setRemoving(null)
      void refresh()
    },
  })
  const logout = useMutation({ mutationFn: signOutLocalTeam })
  const error =
    invite.error ?? cancel.error ?? role.error ?? remove.error ?? logout.error
  return (
    <div className="flex flex-col gap-6">
      {cloud && <Button variant="outline" render={<a href="/" />}>Switch Worktable</Button>}
      <SettingsGroup title="Members">
        {members.isError ? (
          <p role="alert" className="text-sm text-destructive">
            Could not load members.
          </p>
        ) : (
          members.data?.map((member) => (
            <div
              key={member.id}
              className="flex flex-wrap items-center gap-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {member.name}
                  {member.id === selfId ? " (you)" : ""}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {member.email}
                </p>
              </div>
              <Badge variant="secondary">
                {member.role === "owner" ? "Owner" : "Member"}
              </Badge>
              {owner && (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={role.isPending || remove.isPending}
                    onClick={() =>
                      role.mutate({
                        id: member.id,
                        value: member.role === "owner" ? "member" : "owner",
                      })
                    }
                  >
                    {member.role === "owner" ? "Make member" : "Make owner"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setRemoving(member)}
                  >
                    Remove
                  </Button>
                </>
              )}
            </div>
          ))
        )}
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            invite.mutate()
          }}
        >
          <Input
            aria-label="Invite email"
            placeholder="Email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
            className="min-w-0 flex-1"
          />
          <Button type="submit" disabled={invite.isPending}>
            {invite.isPending ? "Creating invite…" : "Invite member"}
          </Button>
        </form>
        {inviteUrl && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              Anyone with this invitation can join. Send it directly to the
              person you intend to invite.
            </p>
            <Input
              aria-label="Invitation link"
              value={inviteUrl}
              readOnly
              onFocus={(event) => event.target.select()}
            />
            <Button
              variant="outline"
              onClick={() =>
                void navigator.clipboard.writeText(inviteUrl).then(
                  () => toast.success("Invitation copied"),
                  () => toast.error("Select and copy the invitation link")
                )
              }
            >
              Copy invitation
            </Button>
          </div>
        )}
        {invitations.data
          ?.filter((invitation) => invitation.status === "pending")
          .map((invitation) => (
            <div
              key={invitation.id}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="truncate">{invitation.email} · Invited</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(invitation.id)}
              >
                Cancel invitation
              </Button>
            </div>
          ))}
      </SettingsGroup>
      <SettingsGroup title="Space access">
        <p className="text-sm text-muted-foreground">
          Owners can access every Space. Manage sharing for the Spaces you
          administer.
        </p>
        {spaces.data
          ?.filter((space) => space.permissions?.manage)
          .map((space) => (
            <Button
              key={space.id}
              variant="outline"
              onClick={() => setSelectedSpace(space.id)}
            >
              {space.name}
            </Button>
          ))}
        {owner && (
          <Button
            variant="ghost"
            onClick={async () => {
              const restricted = spaces.data?.map((space) => space.id) ?? []
              if (!restricted.length) return
              await import("@/lib/http")
                .then(({ fetchJSON }) =>
                  fetchJSON("/api/team/spaces/share", {
                    method: "POST",
                    body: JSON.stringify({ spaceIds: restricted }),
                  })
                )
                .catch((error: Error) => toast.error(error.message))
            }}
          >
            Share all existing Spaces
          </Button>
        )}
        {selectedSpace && (
          <SpaceAccessEditor
            spaceId={selectedSpace}
            onClose={() => setSelectedSpace(null)}
          />
        )}
      </SettingsGroup>
      <TeamAgents owner={owner} />
      {!cloud && (
        <SettingsGroup title="Session">
          <Button
            variant="outline"
            disabled={logout.isPending}
            onClick={() => logout.mutate()}
          >
            Sign out
          </Button>
        </SettingsGroup>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error.message}
        </p>
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setRemoving(null)
        }}
        title={`Remove ${removing?.name ?? "member"}?`}
        description="Their personal agents and Space access will be revoked. Their existing contributions stay in the Worktable."
        confirmLabel="Remove member"
        loading={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id)
        }}
      />
    </div>
  )
}

function TeamAgents({ owner }: { owner: boolean }) {
  const client = useQueryClient()
  const [name, setName] = useState("")
  const [connecting, setConnecting] = useState<string | null>(null)
  const agents = useQuery({
    queryKey: ["team", "agents"],
    queryFn: getTeamAgents,
  })
  const register = useMutation({
    mutationFn: () => registerTeamAgent(name.trim()),
    onSuccess: (result) => {
      setName("")
      setConnecting(result.agent.id)
      void client.invalidateQueries({ queryKey: ["team", "agents"] })
      void client.invalidateQueries({ queryKey: ["agent-connections"] })
    },
  })
  return (
    <SettingsGroup title="Team agents">
      <p className="text-sm text-muted-foreground">
        Team agents belong to this Worktable. Grant them access through Space
        access settings.
      </p>
      {agents.data
        ?.filter((agent) => agent.active && agent.ownership === "team")
        .map((agent) => (
          <div
            key={agent.id}
            className="flex items-center justify-between gap-3"
          >
            <span className="text-sm">{agent.name}</span>
            {owner && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setConnecting(connecting === agent.id ? null : agent.id)
                }
              >
                Connect agent
              </Button>
            )}
          </div>
        ))}
      {owner && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            register.mutate()
          }}
        >
          <Input
            aria-label="Team agent name"
            placeholder="Agent name"
            value={name}
            maxLength={100}
            required
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" variant="outline" disabled={register.isPending}>
            {register.isPending ? "Registering…" : "Register agent"}
          </Button>
        </form>
      )}
      {register.isError && (
        <p role="alert" className="text-sm text-destructive">
          {register.error.message}
        </p>
      )}
      {agents.isError && (
        <p role="alert" className="text-sm text-destructive">
          Could not load team agents.
        </p>
      )}
      {connecting && (
        <Suspense
          fallback={
            <p role="status" className="text-sm text-muted-foreground">
              Loading connection…
            </p>
          }
        >
          <TeamAgentConnectPanel agentId={connecting} />
        </Suspense>
      )}
    </SettingsGroup>
  )
}
