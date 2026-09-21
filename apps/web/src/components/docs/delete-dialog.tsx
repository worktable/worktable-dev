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
import { Trash2, AlertTriangle } from "lucide-react"
import { useEffect, useState } from "react"

interface DeleteDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: () => Promise<boolean>
  itemName: string
  isFolder?: boolean
}

export function DeleteDialog({
  open,
  onClose,
  onConfirm,
  itemName,
  isFolder,
}: DeleteDialogProps) {
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (open) setPending(false)
  }, [open])

  const handleConfirm = async () => {
    setPending(true)
    try {
      if (await onConfirm()) onClose()
    } finally {
      setPending(false)
    }
  }

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(nextOpen) => !nextOpen && !pending && onClose()}
    >
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-destructive/10">
            <Trash2 className="h-5 w-5 text-destructive" />
          </div>
          <ResponsiveDialogTitle>
            Delete {isFolder ? "folder" : "doc"}
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Delete{" "}
            <span className="font-medium text-foreground">{itemName}</span>?
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody>
          {isFolder && (
            <div className="flex items-start gap-3 rounded-lg border border-warning/25 bg-warning/5 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p className="text-muted-foreground">
                Every document in this folder will be deleted.
              </p>
            </div>
          )}

          <p className="text-sm text-muted-foreground">
            This action cannot be undone.
          </p>
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={pending}
          >
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
