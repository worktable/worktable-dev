import { lazy, Suspense, useState } from "react"
import type { RenameDialogProps } from "./rename-dialog-content"

const RenameDialogContent = lazy(() =>
  import("./rename-dialog-content").then((module) => ({
    default: module.RenameDialog,
  }))
)

/** Load on first use, then keep mounted so closing animations still finish. */
export function RenameDialog(props: RenameDialogProps) {
  const [opened, setOpened] = useState(false)
  if (props.open && !opened) setOpened(true)
  if (!props.open && !opened) return null
  return (
    <Suspense fallback={null}>
      <RenameDialogContent {...props} />
    </Suspense>
  )
}
