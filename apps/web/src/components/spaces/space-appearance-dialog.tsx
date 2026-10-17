import { useRef, useState } from "react"
import { Smile } from "lucide-react"
import type { RecognitionColor } from "@worktable/types/recognition"
import {
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from "@worktable/ui/components/responsive-dialog"
import { Button } from "@worktable/ui/components/button"
import { IconSearchGrid } from "@/components/icon-search-grid"
import { RecognitionSwatches } from "@/components/recognition-swatches"

/** A Space's icon and color, which everyone sees. */
export function SpaceAppearanceDialog({
  open,
  onClose,
  onSelect,
  currentIcon,
  currentColor,
  onSelectColor,
}: {
  open: boolean
  onClose: () => void
  onSelect: (icon: string) => void
  currentIcon?: string
  currentColor: RecognitionColor
  onSelectColor: (color: RecognitionColor) => Promise<void>
}) {
  // One color saves at a time and the latest pick saves last, so an earlier
  // click can't overwrite it.
  const [shownColor, setShownColor] = useState<RecognitionColor | null>(null)
  const saving = useRef(false)
  const wanted = useRef<RecognitionColor | null>(null)
  const selectColor = (color: RecognitionColor) => {
    setShownColor(color)
    wanted.current = color
    if (saving.current) return
    saving.current = true
    void (async () => {
      while (wanted.current) {
        const next = wanted.current
        wanted.current = null
        await onSelectColor(next)
      }
      saving.current = false
      setShownColor(null)
    })()
  }
  const handleSelect = (icon: string) => {
    onSelect(icon)
    onClose()
  }

  return (
    <ResponsiveDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-lg bg-surface-tint">
            <Smile className="h-5 w-5 text-primary" />
          </div>
          <ResponsiveDialogTitle>Icon and Color</ResponsiveDialogTitle>
          <ResponsiveDialogDescription>
            Everyone sees the Space this way.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        <ResponsiveDialogBody>
          <RecognitionSwatches
            label="Color"
            value={shownColor ?? currentColor}
            onChange={selectColor}
          />
          <IconSearchGrid
            selected={currentIcon}
            onSelect={handleSelect}
            autoFocus
          />
        </ResponsiveDialogBody>

        <ResponsiveDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
