import { useState, lazy, Suspense } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import { Badge } from "@worktable/ui/components/badge"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { toast } from "@worktable/ui/components/sonner"
import { SettingsGroup } from "../settings-group"
import { CLOUD_PLANS } from "@worktable/hosted-contract/plans"
import { PlanFullNotice } from "@/components/billing/plan-full-notice"
import { peopleCount, roomFor, useCloudPlan } from "@/lib/cloud-plan"
import { queryKeys } from "@/lib/queries"
import { useSettingsSectionActive } from "../settings-dialog"
import {
  activateTeams,
  cancelTeamInvitation,
  changeMemberRole,
  emailTeamInvitation,
  getTeamInvitations,
  getTeamMembers,
  getTeamAgents,
  registerTeamAgent,
  getTeamStatus,
  inviteTeamMember,
  removeTeamMember,
  setTeamAgentWorktableThreads,
  issueMemberPasswordReset,
  issueInvitationPasswordReset,
  setMemberOperator,
} from "@/lib/team-api"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import { getSpaces } from "@/lib/api"
import { SpaceAccessEditor } from "@/components/spaces/space-access-editor"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import type { TeamAgent, TeamMember } from "@worktable/types"

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
      operator={team.data.operator}
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

const NO_START_SPACE = "__none__"

function TeamMembers({
  owner,
  operator,
  selfId,
  cloud,
}: {
  owner: boolean
  operator: boolean
  selfId?: string
  cloud: boolean
}) {
  const client = useQueryClient()
  const [email, setEmail] = useState("")
  const [startSpace, setStartSpace] = useState<string>(NO_START_SPACE)
  const [invited, setInvited] = useState<{
    email: string
    url: string
    emailed: boolean | null
  } | null>(null)
  const [resetLink, setResetLink] = useState<{ name: string; url: string } | null>(null)
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
  const refresh = () => {
    // The plan's room depends on who is in or invited.
    void client.invalidateQueries({ queryKey: queryKeys.workspace, exact: true })
    return client.invalidateQueries({ queryKey: ["team"] })
  }
  const { plan, worktableName } = useCloudPlan()
  const fits = roomFor(plan, 1)
  const people = peopleCount(plan)
  const invite = useMutation({
    mutationFn: (input: { email: string; spaceId?: string }) =>
      inviteTeamMember(input.email, input.spaceId),
    onSuccess: (result, input) => {
      const emailed = result.email === null ? null : result.email === "sent"
      if (emailed) {
        toast.success(`Invitation sent to ${input.email}`)
        setInvited(null)
      } else setInvited({ email: input.email, url: result.url, emailed })
      setEmail((current) => (current === input.email ? "" : current))
      void refresh()
    },
  })
  const resend = useMutation({
    mutationFn: emailTeamInvitation,
    onSuccess: (result) => {
      if (result.email === "sent") toast.success("Invitation sent again")
      else toast.error("Couldn't send the invitation. Copy the link instead.")
      void refresh()
    },
  })
  const copyInvitation = (url: string) =>
    void navigator.clipboard.writeText(url).then(
      () => toast.success("Invitation link copied"),
      () => toast.error("Select and copy the invitation link")
    )
  // A shared Space is open to every member; inviting someone into a
  // restricted one gives them access, which needs managing it.
  const startSpaces =
    spaces.data?.filter(
      (space) =>
        !space.permissions ||
        space.permissions.manage ||
        space.permissions.shared === true
    ) ?? []
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
  const reset = useMutation({
    mutationFn: (target: { name: string; memberId?: string; invitationId?: string }) =>
      (target.memberId
        ? issueMemberPasswordReset(target.memberId)
        : issueInvitationPasswordReset(target.invitationId!)
      ).then((link) => ({ name: target.name, url: link.url })),
    onSuccess: setResetLink,
  })
  const operatorChange = useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) =>
      setMemberOperator(id, value),
    onSuccess: refresh,
  })
  const error =
    invite.error ??
    resend.error ??
    cancel.error ??
    role.error ??
    remove.error ??
    reset.error ??
    operatorChange.error
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
              {!cloud && member.operator && (
                <Badge variant="outline">Operator</Badge>
              )}
              {!cloud && operator && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={operatorChange.isPending}
                  onClick={() =>
                    operatorChange.mutate({
                      id: member.id,
                      value: !member.operator,
                    })
                  }
                >
                  {member.operator ? "Remove operator" : "Make operator"}
                </Button>
              )}
              {!cloud && owner && member.role !== "owner" && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={reset.isPending}
                  onClick={() =>
                    reset.mutate({ name: member.name, memberId: member.id })
                  }
                >
                  Reset password
                </Button>
              )}
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
        {people ? (
          <p className="text-xs text-muted-foreground">
            {people} on {CLOUD_PLANS[plan!.plan].name}
          </p>
        ) : null}
        {plan && !fits ? (
          <PlanFullNotice plan={plan} worktableName={worktableName} adding={1} />
        ) : null}
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (!fits) return
            invite.mutate({
              email,
              ...(startSpace === NO_START_SPACE ? {} : { spaceId: startSpace }),
            })
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
          {startSpaces.length > 0 && (
            <Select
              value={startSpace}
              onValueChange={(value) => {
                if (value) setStartSpace(value)
              }}
            >
              <SelectTrigger aria-label="Starting Space" className="w-44">
                <SelectValue>
                  {startSpace === NO_START_SPACE
                    ? "No starting Space"
                    : (startSpaces.find((space) => space.id === startSpace)
                        ?.name ?? "No starting Space")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_START_SPACE}>No starting Space</SelectItem>
                {startSpaces.map((space) => (
                  <SelectItem key={space.id} value={space.id}>
                    {space.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button type="submit" disabled={invite.isPending || !fits}>
            {invite.isPending ? "Creating invite…" : "Invite member"}
          </Button>
        </form>
        {invited && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              {!cloud
                ? "Anyone with this invitation can join. Send it directly to the person you intend to invite."
                : invited.emailed === false
                  ? `Couldn't email ${invited.email}. Copy the link and send it to them. It only works for that address.`
                  : `Send this link to ${invited.email}. It only works for that address.`}
            </p>
            <Input
              aria-label="Invitation link"
              value={invited.url}
              readOnly
              onFocus={(event) => event.target.select()}
            />
            <Button variant="outline" onClick={() => copyInvitation(invited.url)}>
              Copy invitation
            </Button>
          </div>
        )}
        {resetLink && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              This link lets {resetLink.name} choose a new password. It works
              once, expires in 24 hours, and signs them out everywhere. Send it
              to them directly.
            </p>
            <Input
              aria-label="Password reset link"
              value={resetLink.url}
              readOnly
              onFocus={(event) => event.target.select()}
            />
            <Button
              variant="outline"
              onClick={() =>
                void navigator.clipboard.writeText(resetLink.url).then(
                  () => toast.success("Reset link copied"),
                  () => toast.error("Select and copy the reset link")
                )
              }
            >
              Copy reset link
            </Button>
          </div>
        )}
        {invitations.data?.invitations
          .filter((invitation) => invitation.status === "pending")
          .map((invitation) => (
            <div
              key={invitation.id}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                {invitation.email} ·{" "}
                {invitation.expired
                  ? "Expired"
                  : invitations.data?.email
                    ? invitation.emailed
                      ? "Emailed"
                      : "Not emailed"
                    : "Invited"}
              </span>
              {!invitation.expired && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => copyInvitation(invitation.url)}
                >
                  Copy link
                </Button>
              )}
              {invitations.data?.email && !invitation.expired && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={resend.isPending}
                  onClick={() => resend.mutate(invitation.id)}
                >
                  {invitation.emailed ? "Resend" : "Send email"}
                </Button>
              )}
              {!cloud && owner && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={reset.isPending}
                  onClick={() =>
                    reset.mutate({
                      name: invitation.email,
                      invitationId: invitation.id,
                    })
                  }
                >
                  Reset password
                </Button>
              )}
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
                .then(() => {
                  void client.invalidateQueries({ queryKey: ["team", "spaces"] })
                  toast.success("Every Space is shared with the team")
                })
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
  const threads = useMutation({
    mutationFn: (change: {
      id: string
      value: TeamAgent["worktableThreads"]
    }) => setTeamAgentWorktableThreads(change.id, change.value),
    onSuccess: () =>
      void client.invalidateQueries({ queryKey: ["team", "agents"] }),
    onError: () => toast.error("Could not change thread access. Try again."),
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
        Team agents belong to this Worktable. Give them Space access in each
        Space&apos;s access settings, and choose here whether they can use
        threads outside Spaces.
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
              <WorktableThreadsSelect
                agent={agent}
                onChange={(value) => threads.mutate({ id: agent.id, value })}
                disabled={threads.isPending}
              />
            )}
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

const WORKTABLE_THREAD_LABELS: Record<TeamAgent["worktableThreads"], string> = {
  none: "No access",
  read: "Read",
  edit: "Read and post",
}

/** Threads outside every Space; team agents get them only when an owner chooses. */
function WorktableThreadsSelect({
  agent,
  disabled,
  onChange,
}: {
  agent: TeamAgent
  disabled: boolean
  onChange: (value: TeamAgent["worktableThreads"]) => void
}) {
  return (
    <div className="ml-auto w-40">
      <Select
        value={agent.worktableThreads}
        disabled={disabled}
        onValueChange={(value) => {
          if (value) onChange(value as TeamAgent["worktableThreads"])
        }}
      >
        <SelectTrigger aria-label={`Worktable threads for ${agent.name}`}>
          <SelectValue>{WORKTABLE_THREAD_LABELS[agent.worktableThreads]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {(["none", "read", "edit"] as const).map((value) => (
            <SelectItem key={value} value={value}>
              {WORKTABLE_THREAD_LABELS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
