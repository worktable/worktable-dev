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
import { Checkbox } from "@worktable/ui/components/checkbox"
import { Trash2, AlertTriangle } from "lucide-react"
import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { readDocumentUses } from "@/lib/documents-api"

interface DeleteDialogProps {
  open: boolean
  onClose: () => void
  /** `keep`: what in a Doc's folder stays, once the dialog knows what's in it. */
  onConfirm: (keep?: string[]) => Promise<boolean>
  itemName: string
  isFolder?: boolean
  /** What is deleted: Doc or File. */
  noun?: string
  /** With files on, the document whose folder and uses the dialog shows. */
  uses?: { spaceId: string; path: string }
}

function leaf(path: string): string {
  return path.split("/").at(-1) ?? path
}

export function DeleteDialog({
  open,
  onClose,
  onConfirm,
  itemName,
  isFolder,
  noun = "Doc",
  uses,
}: DeleteDialogProps) {
  const [pending, setPending] = useState(false)
  const [keepShared, setKeepShared] = useState(true)
  const usesQuery = useQuery({
    queryKey: ["document-uses", uses?.spaceId, uses?.path],
    queryFn: () => readDocumentUses(uses!.spaceId, uses!.path),
    enabled: open && Boolean(uses),
    staleTime: 0,
  })
  const items = usesQuery.data?.items ?? []
  const self = items.find((item) => item.path === uses?.path)
  const inFolder = items.filter((item) => item.path !== uses?.path)
  const shared = inFolder.filter((item) => item.usedBy.length > 0)

  useEffect(() => {
    if (open) {
      setPending(false)
      setKeepShared(true)
    }
  }, [open])

  const handleConfirm = async () => {
    setPending(true)
    try {
      const keep =
        inFolder.length > 0
          ? keepShared
            ? shared.map((item) => item.path)
            : []
          : undefined
      if (await onConfirm(keep)) onClose()
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
            Delete {isFolder ? "Folder" : noun}
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

          {uses && usesQuery.isError && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/25 bg-warning/5 p-3 text-sm">
              <p className="text-muted-foreground">
                Couldn’t check what’s in its folder and what uses it.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void usesQuery.refetch()}
                disabled={usesQuery.isFetching}
              >
                Try Again
              </Button>
            </div>
          )}

          {self && self.usedBy.length > 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-warning/25 bg-warning/5 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <p className="text-muted-foreground">
                Used in {self.usedBy.map(leaf).join(", ")}, which will show it
                as missing.
              </p>
            </div>
          )}

          {inFolder.length > 0 && (
            <div className="flex flex-col gap-2 text-sm">
              <p className="text-muted-foreground">
                The {inFolder.length === 1 ? "item" : `${inFolder.length} items`}{" "}
                in its folder {inFolder.length === 1 ? "is" : "are"} deleted
                too.
              </p>
              {shared.length > 0 && (
                <label className="flex items-start gap-2">
                  <Checkbox
                    checked={keepShared}
                    disabled={pending}
                    onCheckedChange={(checked) => setKeepShared(checked)}
                    className="mt-0.5"
                  />
                  <span>
                    Keep files used elsewhere
                    <span className="block text-muted-foreground">
                      {shared
                        .map(
                          (item) =>
                            `${leaf(item.path)} (in ${item.usedBy.map(leaf).join(", ")})`
                        )
                        .join(", ")}
                    </span>
                  </span>
                </label>
              )}
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
            // Deleting needs to know what goes with it first.
            disabled={pending || (Boolean(uses) && !usesQuery.isSuccess)}
          >
            {pending ? "Deleting…" : "Delete"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
