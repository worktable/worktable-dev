import type { ReactNode } from "react"
import { cn } from "@worktable/ui/lib/utils"

const PANEL_GUTTER = 12

export function DesktopContextPanel({
  open,
  width,
  children,
  resizeHandle,
  resizing = false,
  className,
  surfaceClassName,
}: {
  open: boolean
  width: number
  children: ReactNode
  resizeHandle?: ReactNode
  resizing?: boolean
  className?: string
  surfaceClassName?: string
}) {
  return (
    <div
      className={cn(
        "relative hidden h-full shrink-0 xl:block print:hidden",
        open ? "overflow-visible" : "overflow-hidden",
        className
      )}
      style={{
        width: open ? width + PANEL_GUTTER * 2 : 0,
        transition: resizing ? "none" : "width 300ms ease-out",
      }}
      aria-hidden={!open}
      inert={!open}
    >
      <div
        className={cn(
          "absolute inset-y-3 left-3 transition-[transform,opacity] duration-300 ease-out",
          open ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0"
        )}
        style={{ width }}
      >
        {resizeHandle}
        <div
          className={cn(
            "h-full w-full overflow-hidden rounded-2xl border border-[color:var(--overlay-border)] bg-popover shadow-[var(--overlay-floating-shadow)] dark:bg-card",
            surfaceClassName
          )}
          data-worktable-context-panel
        >
          {children}
        </div>
      </div>
    </div>
  )
}
