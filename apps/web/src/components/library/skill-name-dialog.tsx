import { useState } from "react"
import { Button } from "@worktable/ui/components/button"
import { Input } from "@worktable/ui/components/input"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog"
import { useIsMobile } from "@/hooks/use-mobile"
import { type LibraryEntry } from "@/lib/library"
import { useLibraryActions } from "@/lib/library-actions"

/** Change the name agents call a skill by. Its text stays as it is. */
export function SkillNameDialog({
  entry,
  onClose,
}: {
  entry: LibraryEntry
  onClose: () => void
}) {
  const isMobile = useIsMobile()
  const { describe } = useLibraryActions()
  const [name, setName] = useState(entry.name)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = name.trim() !== "" && name.trim() !== entry.name

  const submit = async () => {
    if (pending || !ready) return
    setPending(true)
    setError(null)
    const refused = await describe(entry.id, { name: name.trim() })
    setPending(false)
    if (refused) setError(refused)
    else onClose()
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
          <ResponsiveDialogTitle>Rename</ResponsiveDialogTitle>
        </ResponsiveDialogHeader>
        <ResponsiveDialogBody>
          <div className="space-y-2">
            <label htmlFor="skill-name" className="block text-sm font-medium">
              Name
            </label>
            <Input
              id="skill-name"
              value={name}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              autoFocus={!isMobile}
              onChange={(event) => {
                setName(event.target.value)
                setError(null)
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit()
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "skill-name-error" : undefined}
            />
            {error && (
              <p
                id="skill-name-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {error}
              </p>
            )}
          </div>
        </ResponsiveDialogBody>
        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={!ready || pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
