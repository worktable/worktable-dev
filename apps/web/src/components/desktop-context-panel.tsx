import type { ReactNode } from "react"
import { cn } from "@worktable/ui/lib/utils"
import { DeferredMount } from "@worktable/ui/components/deferred-mount"

const PANEL_GUTTER = 12

export function ContextPanelHeader({
  title,
  icon,
  meta,
  actions,
}: {
  title: string
  icon: ReactNode
  meta?: ReactNode
  actions: ReactNode
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 p-4 pb-2">
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {meta}
      </div>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </div>
  )
}

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
            "overlay-floating h-full w-full overflow-hidden rounded-2xl bg-card",
            surfaceClassName
          )}
          data-worktable-context-panel
        >
          <DeferredMount active={open}>{children}</DeferredMount>
        </div>
      </div>
    </div>
  )
}
