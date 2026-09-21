import type * as React from "react"

import { cn } from "@worktable/ui/lib/utils"

/**
 * Grab target for useResizable. Spread the hook's `handleProps` onto it and
 * position it over the pane's draggable edge (e.g. `right-0` inside a
 * relatively-positioned left sidebar). The hit area is an invisible 8px
 * strip; a 2px neutral graphite bar fades in on hover, keyboard focus, or
 * active drag. Pass an `aria-label` — the hook only provides the separator
 * role.
 */
function ResizeHandle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="resize-handle"
      {...props}
      className={cn(
        "group/resize absolute inset-y-0 z-20 w-2 cursor-col-resize touch-none outline-none",
        className
      )}
    >
      <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-resize-handle opacity-0 transition-opacity delay-75 duration-150 group-hover/resize:opacity-100 group-focus-visible/resize:opacity-100 group-data-[resizing]/resize:opacity-100 group-data-[resizing]/resize:delay-0" />
    </div>
  )
}

export { ResizeHandle }
