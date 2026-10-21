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

export interface RenameDialogProps {
  open: boolean
  onClose: () => void
  /**
   * Resolves false to stay open, or with a reason to show under the name and
   * stay open.
   */
  onRename: (
    newPath: string
  ) => boolean | string | void | Promise<boolean | string | void>
  currentPath: string
  /**
   * The Doc's title. The dialog then starts from it and onRename receives the
   * new title rather than a path.
   */
  title?: string
  isFolder?: boolean
  pathInput?: boolean
  itemType?: "Doc" | "Thread"
  maxLength?: number
}

export function RenameDialog({
  open,
  onClose,
  onRename,
  currentPath,
  title,
  isFolder,
  pathInput,
  itemType = "Doc",
  maxLength,
}: RenameDialogProps) {
  const [newName, setNewName] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isMobile = useIsMobile()

  const parts = currentPath.split("/")
  const currentName = parts[parts.length - 1]
  const parentDir = parts.slice(0, -1).join("/")
  const currentValue = title ?? (pathInput ? currentPath : currentName)

  useEffect(() => {
    if (open) {
      setNewName(currentValue)
      setError(null)
    }
  }, [open, currentValue])

  const handleRename = async () => {
    if (pending) return
    if (!newName.trim() || newName.trim() === currentValue) {
      onClose()
      return
    }
    const newPath =
      title !== undefined || pathInput
        ? newName.trim()
        : parentDir
          ? `${parentDir}/${newName.trim()}`
          : newName.trim()
    setPending(true)
    try {
      const renamed = await onRename(newPath)
      if (typeof renamed === "string") setError(renamed)
      else if (renamed !== false) onClose()
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
            Rename {isFolder ? "Folder" : itemType}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            {pathInput
              ? "Change its name or use / to move it into a folder."
              : `Enter a new name for this ${isFolder ? "folder" : itemType.toLowerCase()}.`}
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody>
          <div className="space-y-2">
            <label htmlFor="new-name" className="text-sm font-medium">
              {pathInput ? "New path" : "New name"}
            </label>
            <Input
              id="new-name"
              maxLength={maxLength}
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value)
                setError(null)
              }}
              onKeyDown={handleKeyDown}
              className="h-9"
              autoFocus={!isMobile}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "rename-error" : undefined}
            />
            {error && (
              <p
                id="rename-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {error}
              </p>
            )}
          </div>

          {hasChanged && (
            <div className="flex items-center gap-2 rounded-lg bg-surface-inset px-3 py-2 text-sm text-muted-foreground">
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
