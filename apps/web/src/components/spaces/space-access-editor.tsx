import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type {
  SpaceAccessGrant,
  SpaceAccessLevel,
  SpaceAccessPolicy,
} from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@worktable/ui/components/select"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog"
import { Input } from "@worktable/ui/components/input"
import { toast } from "@worktable/ui/components/sonner"
import {
  getSpaceAccess,
  getTeamAgents,
  getTeamMembers,
  inviteTeamMember,
  setSpaceAccess,
} from "@/lib/team-api"
import { PlanFullNotice } from "@/components/billing/plan-full-notice"
import { LinkToSend } from "@/components/settings/link-to-send"
import { copyText } from "@/lib/clipboard"
import { roomFor, useCloudPlan } from "@/lib/cloud-plan"
import { queryKeys } from "@/lib/queries"

export function SpaceAccessEditor({
  spaceId,
  onClose,
}: {
  spaceId: string
  onClose: () => void
}) {
  const policy = useQuery({
    queryKey: ["team", "spaces", spaceId],
    queryFn: () => getSpaceAccess(spaceId),
  })
  const members = useQuery({
    queryKey: ["team", "members"],
    queryFn: getTeamMembers,
  })
  const agents = useQuery({
    queryKey: ["team", "agents"],
    queryFn: getTeamAgents,
  })
  // The loaded policy stands until the first change.
  const [edited, setEdited] = useState<SpaceAccessPolicy | null>(null)
  const draft = edited ?? policy.data ?? null
  const setDraft = (
    next:
      | SpaceAccessPolicy
      | ((previous: SpaceAccessPolicy | null) => SpaceAccessPolicy | null)
  ) =>
    setEdited((previous) =>
      typeof next === "function" ? next(previous ?? policy.data ?? null) : next
    )
  const queryClient = useQueryClient()
  const save = useMutation({
    mutationFn: () => setSpaceAccess(draft!),
    onSuccess: (saved) => {
      // The next open starts from what was saved, not the policy read before.
      queryClient.setQueryData(["team", "spaces", spaceId], saved)
      setEdited(null)
      onClose()
    },
  })
  const changeGrant = (
    subjectType: SpaceAccessGrant["subjectType"],
    subjectId: string,
    access: SpaceAccessLevel | "none" | null
  ) => {
    if (!access) return
    setDraft((previous) =>
      previous
        ? {
            ...previous,
            grants: [
              ...previous.grants.filter(
                (grant) =>
                  grant.subjectType !== subjectType ||
                  grant.subjectId !== subjectId
              ),
              ...(access === "none"
                ? []
                : [{ subjectType, subjectId, access }]),
            ],
          }
        : previous
    )
  }
  const { plan, worktableName } = useCloudPlan()
  const [email, setEmail] = useState("")
  // A link that couldn't be emailed or copied stays here to copy by hand.
  const [link, setLink] = useState<{ email: string; url: string } | null>(null)
  // Someone new joins straight into this Space, with access to it.
  const invite = useMutation({
    mutationFn: (address: string) => inviteTeamMember(address, spaceId),
    onSuccess: (result, address) => {
      setEmail("")
      setLink(null)
      // Only the invitations and the plan's people count changed.
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspace, exact: true })
      void queryClient.invalidateQueries({ queryKey: ["team", "invitations"] })
      if (result.email === "sent") toast.success(`Invitation sent to ${address}`)
      else
        void copyText(result.url).then(
          () => toast.success(`Invitation link for ${address} copied. Send it to them.`),
          () => setLink({ email: address, url: result.url })
        )
    },
  })
  const teamAgents =
    agents.data?.filter((agent) => agent.ownership === "team" && agent.active) ?? []
  const grantFor = (subjectType: SpaceAccessGrant["subjectType"], id: string) =>
    draft?.grants.find(
      (grant) => grant.subjectType === subjectType && grant.subjectId === id
    )?.access ?? "none"
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!open && !save.isPending) onClose()
      }}
    >
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>Space access</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Owners can always read and administer this Space.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody className="flex flex-col gap-4">
          {policy.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading access…
            </p>
          ) : policy.isError ? (
            <p role="alert" className="text-sm text-destructive">
              You cannot manage this Space&rsquo;s access.
            </p>
          ) : (
            draft && (
              <>
                <Select
                  value={draft.visibility}
                  disabled={save.isPending}
                  onValueChange={(visibility) => {
                    if (visibility) setDraft({ ...draft, visibility })
                  }}
                >
                  <SelectTrigger aria-label="Default Space access">
                    <SelectValue>
                      {draft.visibility === "shared"
                        ? "Everyone can read and edit"
                        : "Only selected people and agents"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="shared">
                      Everyone can read and edit
                    </SelectItem>
                    <SelectItem value="restricted">
                      Only selected people and agents
                    </SelectItem>
                  </SelectContent>
                </Select>
                {members.data
                  ?.filter((member) => member.role !== "owner")
                  .map((member) => (
                    <div key={member.id} className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {member.name}
                      </span>
                      <PermissionSelect
                        label={`Access for ${member.name}`}
                        value={
                          draft.visibility === "shared" &&
                          grantFor("member", member.id) !== "manage"
                            ? "none"
                            : grantFor("member", member.id)
                        }
                        management
                        shared={draft.visibility === "shared"}
                        disabled={save.isPending}
                        onChange={(access) =>
                          changeGrant("member", member.id, access)
                        }
                      />
                    </div>
                  ))}
                <p className="text-xs text-muted-foreground">
                  Each person&rsquo;s agents follow their access.
                  {teamAgents.length ? " Team agents need their own grants." : ""}
                </p>
                {teamAgents.map((agent) => (
                    <div key={agent.id} className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {agent.name}
                      </span>
                      <PermissionSelect
                        label={`Access for ${agent.name}`}
                        value={grantFor("agent", agent.id)}
                        disabled={save.isPending}
                        onChange={(access) =>
                          changeGrant("agent", agent.id, access)
                        }
                      />
                    </div>
                  ))}
              </>
            )
          )}
          {draft && roomFor(plan, 1) ? (
            <form
              className="flex flex-col gap-2 border-t border-border pt-4"
              onSubmit={(event) => {
                event.preventDefault()
                invite.mutate(email.trim())
              }}
            >
              <label htmlFor="space-invite" className="text-sm font-medium text-foreground">
                Invite someone new to this Space
              </label>
              <div className="flex gap-2">
                <Input
                  id="space-invite"
                  placeholder="Email address"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  className="min-w-0 flex-1"
                />
                <Button type="submit" variant="outline" disabled={invite.isPending}>
                  {invite.isPending ? "Inviting…" : "Invite"}
                </Button>
              </div>
              {invite.isError ? (
                <p role="alert" className="text-sm text-destructive">
                  {invite.error.message}
                </p>
              ) : null}
              {link ? (
                <LinkToSend
                  text={`Couldn't copy the invitation link. Send it to ${link.email} yourself.`}
                  label="Invitation link"
                  url={link.url}
                  copy="Copy"
                  onCopy={() =>
                    void copyText(link.url).then(
                      () => toast.success("Invitation link copied"),
                      () => toast.error("Select and copy the invitation link")
                    )
                  }
                />
              ) : null}
            </form>
          ) : draft && plan ? (
            <div className="border-t border-border pt-4">
              <PlanFullNotice plan={plan} worktableName={worktableName} adding={1} />
            </div>
          ) : null}
          {save.isError && (
            <p role="alert" className="text-sm text-destructive">
              {save.error.message}
            </p>
          )}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={
              !draft || save.isPending || members.isError || agents.isError
            }
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

function PermissionSelect({
  label,
  value,
  management,
  shared,
  disabled,
  onChange,
}: {
  label: string
  value: SpaceAccessLevel | "none"
  management?: boolean
  shared?: boolean
  disabled: boolean
  onChange: (value: SpaceAccessLevel | "none" | null) => void
}) {
  return (
    <div className="w-36">
      <Select value={value} disabled={disabled} onValueChange={onChange}>
        <SelectTrigger aria-label={label}>
          <SelectValue>
            {value === "none"
              ? shared
                ? "Read and edit"
                : "No access"
              : value === "read"
                ? "Read"
                : value === "edit"
                  ? "Read and edit"
                  : "Manage access"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">
            {shared ? "Read and edit" : "No access"}
          </SelectItem>
          {!shared && <SelectItem value="read">Read</SelectItem>}
          {!shared && <SelectItem value="edit">Read and edit</SelectItem>}
          {management && <SelectItem value="manage">Manage access</SelectItem>}
        </SelectContent>
      </Select>
    </div>
  )
}
