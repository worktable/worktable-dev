import { useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
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
import {
  getSpaceAccess,
  getTeamAgents,
  getTeamMembers,
  setSpaceAccess,
} from "@/lib/team-api"

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
  const save = useMutation({
    mutationFn: () => setSpaceAccess(draft!),
    onSuccess: onClose,
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
                  Personal agents follow their member&rsquo;s access. Team
                  agents need their own grants.
                </p>
                {agents.data
                  ?.filter(
                    (agent) => agent.ownership === "team" && agent.active
                  )
                  .map((agent) => (
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
            {save.isPending ? "Saving…" : "Save access"}
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
