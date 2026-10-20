import { useState, lazy, Suspense, type ReactNode } from "react"
import { ChevronDown, Mail, Trash2 } from "lucide-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import { Card } from "@worktable/ui/components/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@worktable/ui/components/dropdown-menu"
import { ConfirmDialog } from "@worktable/ui/components/confirm-dialog"
import { toast } from "@worktable/ui/components/sonner"
import { SettingsGroup } from "../settings-group"
import { LinkToSend } from "../link-to-send"
import { copyText } from "@/lib/clipboard"
import { PlanFullNotice } from "@/components/billing/plan-full-notice"
import { roomFor, useCloudPlan } from "@/lib/cloud-plan"
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
import { invitationEmailNote } from "@/lib/invite-people"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"
import { getSpaces } from "@/lib/api"
import { SpaceAccessEditor } from "@/components/spaces/space-access-editor"
import { PersonAvatar } from "@/components/person-avatar"
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

/**
 * Team agents are registered here and get their own Space grants. The
 * registration flow is hidden until it reads as simply as connecting a
 * personal agent; agents already registered stay listed and managed.
 */
const SHOW_TEAM_AGENTS = false

const ROLES: Array<{ value: TeamMember["role"]; label: string; detail: string }> = [
  { value: "owner", label: "Owner", detail: "Manages people, the plan and every Space" },
  { value: "member", label: "Member", detail: "Works in the Spaces shared with them" },
]

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
  const invite = useMutation({
    mutationFn: (address: string) => inviteTeamMember(address),
    onSuccess: (result, address) => {
      const emailed = result.email === null ? null : result.email === "sent"
      if (emailed) {
        toast.success(`Invitation sent to ${address}`)
        setInvited(null)
      } else setInvited({ email: address, url: result.url, emailed })
      setEmail((current) => (current === address ? "" : current))
      void refresh()
    },
  })
  const resend = useMutation({
    mutationFn: emailTeamInvitation,
    onSuccess: (result) => {
      if (result.email === "sent") toast.success("Invitation sent again")
      else
        toast.error(
          `${invitationEmailNote(result.email)?.reason ?? "Couldn't send the invitation"}. Copy the link instead.`
        )
      void refresh()
    },
  })
  const copyInvitation = (url: string) =>
    void copyText(url).then(
      () => toast.success("Invitation link copied"),
      () => toast.error("Select and copy the invitation link")
    )
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
  const pending =
    invitations.data?.invitations.filter(
      (invitation) => invitation.status === "pending"
    ) ?? []
  const emailing = Boolean(invitations.data?.email)
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-medium text-foreground">People</h3>
          {plan && plan.peopleLimit !== null ? (
            <span className="text-xs text-muted-foreground">
              {plan.people} of {plan.peopleLimit}
            </span>
          ) : null}
        </div>
        <Card className="gap-3 px-4">
          {plan && !fits ? (
            <PlanFullNotice plan={plan} worktableName={worktableName} adding={1} />
          ) : (
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                invite.mutate(email.trim())
              }}
            >
              <Input
                aria-label="Email to invite"
                placeholder="Email address"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                className="min-w-0 flex-1"
              />
              <Button type="submit" disabled={invite.isPending}>
                {invite.isPending ? "Inviting…" : "Invite"}
              </Button>
            </form>
          )}
          {invited && (
            <LinkToSend
              text={
                !cloud
                  ? "Anyone with this invitation can join. Send it directly to the person you intend to invite."
                  : invited.emailed === false
                    ? `Couldn't email ${invited.email}. Copy the link and send it to them. It only works for that address.`
                    : `Send this link to ${invited.email}. It only works for that address.`
              }
              label="Invitation link"
              url={invited.url}
              copy="Copy"
              onCopy={() => copyInvitation(invited.url)}
            />
          )}
          {resetLink && (
            <LinkToSend
              text={`This link lets ${resetLink.name} choose a new password. It works once, expires in 24 hours, and signs them out everywhere. Send it to them directly.`}
              label="Password reset link"
              url={resetLink.url}
              copy="Copy"
              onCopy={() =>
                void copyText(resetLink.url).then(
                  () => toast.success("Reset link copied"),
                  () => toast.error("Select and copy the reset link")
                )
              }
            />
          )}
          {members.isError ? (
            <p role="alert" className="text-sm text-destructive">
              Could not load people.
            </p>
          ) : (
            <ul className="-mx-1 flex flex-col">
              {members.data?.map((member) => {
                const self = member.id === selfId
                const label = member.role === "owner" ? "Owner" : "Member"
                // Operators grant and withdraw operating whatever their role.
                const operatorItem =
                  !cloud && operator ? (
                    <DropdownMenuItem
                      onClick={() =>
                        operatorChange.mutate({ id: member.id, value: !member.operator })
                      }
                    >
                      {member.operator
                        ? "Stop operating this computer"
                        : "Let them operate this computer"}
                    </DropdownMenuItem>
                  ) : null
                return (
                  <PersonRow
                    key={member.id}
                    avatar={<PersonAvatar id={member.actorId} name={member.name} size="lg" />}
                    name={
                      <>
                        {member.name}
                        {self ? (
                          <span className="font-normal text-muted-foreground"> (you)</span>
                        ) : null}
                      </>
                    }
                    detail={`${member.email}${!cloud && member.operator ? " · Operates this computer" : ""}`}
                    status={
                      owner && !self ? (
                        <RowSelect label={label} aria={`Role for ${member.name}`} disabled={role.isPending}>
                          <DropdownMenuRadioGroup
                            value={member.role}
                            onValueChange={(next) => {
                              if (next !== member.role)
                                role.mutate({ id: member.id, value: next as TeamMember["role"] })
                            }}
                          >
                            {ROLES.map((option) => (
                              <DropdownMenuRadioItem
                                key={option.value}
                                value={option.value}
                                className="items-start py-2"
                              >
                                <span className="flex flex-col gap-0.5">
                                  <span className="text-sm text-foreground">{option.label}</span>
                                  <span className="text-xs text-muted-foreground">{option.detail}</span>
                                </span>
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                          {!cloud && (operator || member.role !== "owner") ? (
                            <DropdownMenuSeparator />
                          ) : null}
                          {!cloud && member.role !== "owner" ? (
                            <DropdownMenuItem
                              onClick={() => reset.mutate({ name: member.name, memberId: member.id })}
                            >
                              Reset password
                            </DropdownMenuItem>
                          ) : null}
                          {operatorItem}
                        </RowSelect>
                      ) : operatorItem ? (
                        <RowSelect
                          label={label}
                          aria={`Operating this computer for ${member.name}`}
                          disabled={operatorChange.isPending}
                        >
                          {operatorItem}
                        </RowSelect>
                      ) : (
                        <RowLabel>{label}</RowLabel>
                      )
                    }
                    action={
                      owner && !self ? (
                        <RemoveButton
                          label={`Remove ${member.name}`}
                          onClick={() => setRemoving(member)}
                        />
                      ) : null
                    }
                  />
                )
              })}
              {pending.map((invitation) => (
                <PersonRow
                  key={invitation.id}
                  avatar={
                    <span
                      aria-hidden
                      className="flex size-9 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground"
                    >
                      <Mail className="size-4" />
                    </span>
                  }
                  name={invitation.email}
                  detail={
                    invitation.expired
                      ? "Invitation expired"
                      : emailing && !invitation.emailed
                        ? `Invited · ${invitationEmailNote(invitation.emailStatus)?.reason ?? "Not emailed yet"}`
                        : "Invited"
                  }
                  status={
                    invitation.expired ? (
                      <RowLabel>Expired</RowLabel>
                    ) : (
                      <RowSelect label="Pending" aria={`Invitation for ${invitation.email}`}>
                        <DropdownMenuItem onClick={() => copyInvitation(invitation.url)}>
                          Copy link
                        </DropdownMenuItem>
                        {emailing && invitation.emailStatus !== "not_allowed" ? (
                          <DropdownMenuItem
                            disabled={resend.isPending}
                            onClick={() => resend.mutate(invitation.id)}
                          >
                            {invitation.emailed || invitation.emailStatus ? "Send again" : "Send email"}
                          </DropdownMenuItem>
                        ) : null}
                        {!cloud && owner ? (
                          <DropdownMenuItem
                            onClick={() =>
                              reset.mutate({ name: invitation.email, invitationId: invitation.id })
                            }
                          >
                            Reset password
                          </DropdownMenuItem>
                        ) : null}
                      </RowSelect>
                    )
                  }
                  action={
                    <RemoveButton
                      label={`Cancel the invitation for ${invitation.email}`}
                      disabled={cancel.isPending}
                      onClick={() => cancel.mutate(invitation.id)}
                    />
                  }
                />
              ))}
            </ul>
          )}
        </Card>
      </section>
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
      <TeamAgents owner={owner} canRegister={SHOW_TEAM_AGENTS} />
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
        title={`Remove ${removing?.name ?? "this person"}?`}
        description="Their personal agents and Space access will be revoked. Their existing contributions stay in the Worktable."
        confirmLabel="Remove"
        variant="destructive"
        loading={remove.isPending}
        onConfirm={() => {
          if (removing) remove.mutate(removing.id)
        }}
      />
    </div>
  )
}

/**
 * One person or invitation. Role or status and the remove button sit in
 * fixed columns, so they line up down the list.
 */
function PersonRow({
  avatar,
  name,
  detail,
  status,
  action,
}: {
  avatar: ReactNode
  name: ReactNode
  detail: string
  status: ReactNode
  action: ReactNode
}) {
  return (
    <li className="grid min-h-14 grid-cols-[auto_minmax(0,1fr)_7rem_2rem] items-center gap-3 px-1 py-2">
      {avatar}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </div>
      <div className="flex">{status}</div>
      <div className="flex justify-end">{action}</div>
    </li>
  )
}

/** A role or status that opens choices; its text starts where a plain label's does. */
function RowSelect({
  label,
  aria,
  disabled,
  children,
}: {
  label: string
  aria: string
  disabled?: boolean
  children: ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={aria}
            className="w-full justify-between px-2 font-normal text-muted-foreground"
          />
        }
      >
        {label}
        <ChevronDown className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function RowLabel({ children }: { children: ReactNode }) {
  return <span className="px-2 text-sm text-muted-foreground">{children}</span>
}

function RemoveButton({
  label,
  disabled,
  onClick,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      disabled={disabled}
      className="text-muted-foreground hover:text-destructive"
      onClick={onClick}
    >
      <Trash2 className="size-4" />
    </Button>
  )
}

function TeamAgents({
  owner,
  canRegister,
}: {
  owner: boolean
  canRegister: boolean
}) {
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
  const teamAgents =
    agents.data?.filter((agent) => agent.active && agent.ownership === "team") ??
    []
  // Without registration, the group is only for agents already registered.
  if (!canRegister && !teamAgents.length) return null
  return (
    <SettingsGroup title="Team agents">
      <p className="text-sm text-muted-foreground">
        Team agents belong to this Worktable. Give them Space access in each
        Space&apos;s access settings, and choose here whether they can use
        threads outside Spaces.
      </p>
      {teamAgents.map((agent) => (
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
      {owner && canRegister && (
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
