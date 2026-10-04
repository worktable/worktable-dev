"use client"

import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@worktable/ui/lib/utils"

/** A modal panel that unfolds from beneath a full-width anchor such as the app header. */
function HeaderSheet({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="header-sheet" modal {...props} />
}

function HeaderSheetTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return (
    <PopoverPrimitive.Trigger data-slot="header-sheet-trigger" {...props} />
  )
}

function HeaderSheetContent({
  anchor,
  className,
  children,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "anchor">) {
  return (
    <PopoverPrimitive.Portal>
      {/* Below the header's stacking layer so the header stays legible. */}
      <PopoverPrimitive.Backdrop className="header-sheet-backdrop fixed inset-0 z-20" />
      <PopoverPrimitive.Positioner
        anchor={anchor}
        side="bottom"
        align="start"
        // Cover the header's bottom border with the sheet's own edge.
        sideOffset={-1}
        collisionPadding={0}
        className="z-40 outline-none"
      >
        <PopoverPrimitive.Popup
          data-slot="header-sheet-content"
          className={cn(
            "header-sheet overlay-floating flex max-h-[min(var(--available-height),85dvh)] w-(--anchor-width) flex-col rounded-t-none rounded-b-2xl bg-popover text-popover-foreground outline-none",
            className
          )}
          {...props}
        >
          <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { HeaderSheet, HeaderSheetContent, HeaderSheetTrigger }
