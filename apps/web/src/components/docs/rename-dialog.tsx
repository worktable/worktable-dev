import { useState, useEffect } from "react"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogBody,
  ResponsiveDialogFooter,
} from "@worktable/ui/components/responsive-dialog"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import { useIsMobile } from "@/hooks/use-mobile"
import { Pencil, ArrowRight } from "lucide-react"

interface RenameDialogProps {
  open: boolean
  onClose: () => void
  onRename: (newPath: string) => boolean | void | Promise<boolean | void>
  currentPath: string
  isFolder?: boolean
  pathInput?: boolean
}

export function RenameDialog({
  open,
  onClose,
  onRename,
  currentPath,
  isFolder,
  pathInput,
}: RenameDialogProps) {
  const [newName, setNewName] = useState("")
  const [pending, setPending] = useState(false)
  const isMobile = useIsMobile()

  const parts = currentPath.split("/")
  const currentName = parts[parts.length - 1]
  const parentDir = parts.slice(0, -1).join("/")
  const currentValue = pathInput ? currentPath : currentName

  useEffect(() => {
    if (open) {
      setNewName(currentValue)
    }
  }, [open, currentValue])

  const handleRename = async () => {
    if (pending) return
    if (!newName.trim() || newName.trim() === currentValue) {
      onClose()
      return
    }
    const newPath = pathInput
      ? newName.trim()
      : parentDir
        ? `${parentDir}/${newName.trim()}`
        : newName.trim()
    setPending(true)
    try {
      const renamed = await onRename(newPath)
      if (renamed !== false) onClose()
    } finally {
      setPending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && newName.trim() && !pending) {
      void handleRename()
    }
  }

  const hasChanged = newName.trim() && newName.trim() !== currentValue

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-tint">
            <Pencil className="h-5 w-5 text-primary" />
          </div>
          <ResponsiveDialogTitle>
            Rename {isFolder ? "Folder" : "Doc"}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {pathInput
              ? "Change its name or use / to move it into a folder."
              : `Enter a new name for this ${isFolder ? "folder" : "doc"}.`}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody>
          <div className="space-y-2">
            <label htmlFor="new-name" className="text-sm font-medium">
              {pathInput ? "New path" : "New name"}
            </label>
            <Input
              id="new-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={handleKeyDown}
              className="h-9"
              autoFocus={!isMobile}
            />
          </div>

          {hasChanged && (
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              <span className="truncate font-medium text-foreground/70">
                {currentValue}
              </span>
              <ArrowRight className="h-4 w-4 shrink-0" />
              <span className="truncate font-medium text-foreground">
                {newName.trim()}
              </span>
            </div>
          )}
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleRename()}
            disabled={!hasChanged || pending}
          >
            {pending ? "Renaming…" : "Rename"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
