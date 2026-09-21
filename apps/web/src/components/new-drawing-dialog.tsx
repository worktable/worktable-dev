import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { emptyQuickdrawDocument, QUICKDRAW_FORMAT } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogBody,
  ResponsiveDialogFooter,
} from "@worktable/ui/components/responsive-dialog"
import { listDocuments, writeDocumentSource } from "@/lib/documents-api"
import { documentQueryKeys } from "@/lib/documents-queries"

export function NewDrawingDialog({
  spaceId,
  onClose,
  onCreated,
}: {
  spaceId: string
  onClose: () => void
  onCreated: () => void
}) {
  const [name, setName] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const create = async () => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const title = name.trim() || "Untitled drawing"
      const slug =
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "") || "drawing"
      const paths = new Set(
        (await listDocuments(spaceId, true)).map((item) =>
          item.kind === "document" ? item.path : item.pathKey
        )
      )
      let path = `drawings/${slug}`
      for (let suffix = 2; paths.has(path); suffix += 1)
        path = `drawings/${slug}-${suffix}`
      const result = await writeDocumentSource(spaceId, {
        path,
        format: { id: QUICKDRAW_FORMAT, sourceVersion: 1 },
        source: JSON.stringify(emptyQuickdrawDocument(title)),
      })
      await queryClient.invalidateQueries({
        queryKey: documentQueryKeys.list(spaceId),
      })
      onCreated()
      await navigate({
        to: "/spaces/$spaceId/documents/$",
        params: { spaceId, _splat: result.path },
      })
      onClose()
    } catch (cause) {
      console.error("Drawing creation failed", cause)
      setError("Couldn’t create a drawing. Try again.")
    } finally {
      setPending(false)
    }
  }
  return (
    <ResponsiveDialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>New drawing</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <label
            htmlFor="drawing-name"
            className="mb-2 block text-sm font-medium"
          >
            Name
          </label>
          <Input
            id="drawing-name"
            placeholder="Untitled drawing"
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create()
            }}
          />
          {error && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={pending}>
            {pending ? "Creating…" : "Create drawing"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
