import { useEffect, useState } from "react"
import { Database } from "lucide-react"
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
} from "@worktable/ui/components/responsive-dialog"
import { useIsMobile } from "@/hooks/use-mobile"

const MAX_NAME_LENGTH = 80
const MAX_DESCRIPTION_LENGTH = 180

/**
 * Creates an empty collection (name + concise description). Fields can be
 * added through the schema editor or MCP after the collection has a concrete
 * workflow to model.
 */
export function NewCollectionDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean
  onClose: () => void
  onCreate: (name: string, description?: string) => Promise<void>
}) {
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [pending, setPending] = useState(false)
  const isMobile = useIsMobile()

  useEffect(() => {
    if (open) {
      setName("")
      setDescription("")
      setPending(false)
    }
  }, [open])

  const trimmedName = name.trim()
  const canCreate = trimmedName.length > 0 && !pending

  const handleCreate = async () => {
    if (!canCreate) return
    setPending(true)
    try {
      await onCreate(trimmedName, description.trim() || undefined)
      onClose()
    } catch {
      // Caller toasted the failure; stay open so the input survives.
    } finally {
      setPending(false)
    }
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-tint">
            <Database className="h-5 w-5 text-primary" />
          </div>
          <ResponsiveDialogTitle>New record collection</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            A file-backed table for items that change or get queried independently.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <div className="space-y-2">
            <label htmlFor="collection-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="collection-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canCreate) void handleCreate()
              }}
              placeholder="Tasks"
              className="h-9"
              maxLength={MAX_NAME_LENGTH}
              autoFocus={!isMobile}
            />
          </div>
          <div className="space-y-2">
            <label
              htmlFor="collection-description"
              className="text-sm font-medium"
            >
              Description{" "}
              <span className="font-normal text-muted-foreground">
                recommended
              </span>
            </label>
            <Input
              id="collection-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canCreate) void handleCreate()
              }}
              placeholder="Very briefly: what belongs here?"
              className="h-9"
              maxLength={MAX_DESCRIPTION_LENGTH}
            />
          </div>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!canCreate}>
            {pending ? "Creating…" : "Create collection"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
