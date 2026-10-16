import { useState } from "react"
import { FolderPlus, Pencil } from "lucide-react"
import type { PersonalGroup } from "@worktable/types"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import { useIsMobile } from "@/hooks/use-mobile"

const MAX_GROUP_NAME = 60

/** Names a new group or renames one; names are unique, ignoring case. */
export function GroupNameDialog({
  open,
  group,
  groups,
  onClose,
  onSubmit,
}: {
  open: boolean
  /** The group being renamed; absent when creating one. */
  group?: PersonalGroup
  groups: readonly PersonalGroup[]
  onClose: () => void
  onSubmit: (name: string) => void
}) {
  const isMobile = useIsMobile()
  const [name, setName] = useState(group?.name ?? "")
  // Each opening starts from the group's current name, or empty.
  const [openedFor, setOpenedFor] = useState<PersonalGroup | null | undefined>()
  const openKey = open ? (group ?? null) : undefined
  if (openKey !== openedFor) {
    setOpenedFor(openKey)
    if (open) setName(group?.name ?? "")
  }

  const trimmed = name.trim()
  const taken = groups.some(
    (other) =>
      other.id !== group?.id &&
      other.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase()
  )
  const valid =
    trimmed.length > 0 &&
    trimmed.length <= MAX_GROUP_NAME &&
    !taken &&
    trimmed !== group?.name

  const submit = () => {
    if (!valid) return
    onSubmit(trimmed)
    onClose()
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-tint">
            {group ? (
              <Pencil className="h-5 w-5 text-primary" />
            ) : (
              <FolderPlus className="h-5 w-5 text-primary" />
            )}
          </div>
          <ResponsiveDialogTitle>
            {group ? "Rename Group" : "New Group"}
          </ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <div className="space-y-2">
            <label htmlFor="group-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="group-name"
              value={name}
              maxLength={MAX_GROUP_NAME}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit()
              }}
              className="h-9"
              autoFocus={!isMobile}
              aria-invalid={taken}
            />
            {taken && (
              <p className="text-xs text-destructive">
                You already have a group with this name.
              </p>
            )}
          </div>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid}>
            {group ? "Rename" : "Create"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}

