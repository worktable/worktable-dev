import { useRef, type ReactNode } from "react"
import { XIcon } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@worktable/ui/components/dialog"

/**
 * The full-window viewer a diagram or a file opens in, over the page it came
 * from. What it shows, and the tools for it, come from its body.
 */
export function ViewerDialog({
  open,
  onOpenChange,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: ReactNode
}) {
  // Focus the viewer itself so a tap or click doesn't ring the first control.
  const popupRef = useRef<HTMLDivElement>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={popupRef}
        initialFocus={popupRef}
        showCloseButton={false}
        // The editor leaves gestures in here out of what counts as an edit.
        data-viewer=""
        className="top-0 left-0 h-dvh max-h-none w-dvw max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0 sm:max-w-none"
      >
        {/* The popup mounts only while open or closing, so the body stays
            visible through the exit animation. */}
        {children}
      </DialogContent>
    </Dialog>
  )
}

/** The viewer's top bar: what is shown, its tools, and Close. */
export function ViewerHeader({
  title,
  fallbackTitle,
  leading,
  children,
}: {
  title: string | undefined
  /** Names the viewer for assistive technology when there is no title. */
  fallbackTitle: string
  /** Controls after the title, such as moving through a set. */
  leading?: ReactNode
  /** Tools for what is shown, before Close. */
  children?: ReactNode
}) {
  const shown = title?.trim()
  return (
    <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      <DialogTitle className={shown ? "min-w-0 truncate text-sm" : "sr-only"}>
        {shown || fallbackTitle}
      </DialogTitle>
      {leading}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {children}
        {children ? <div className="mx-1 h-5 w-px bg-border" /> : null}
        <DialogClose
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              title="Close"
              aria-label="Close"
            />
          }
        >
          <XIcon />
        </DialogClose>
      </div>
    </div>
  )
}
