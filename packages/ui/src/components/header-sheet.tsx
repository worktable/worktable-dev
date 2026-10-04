"use client"

import { createContext, useContext, useRef } from "react"
import type { PointerEvent, RefObject } from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@worktable/ui/lib/utils"

const PopupRefContext = createContext<RefObject<HTMLDivElement | null> | null>(
  null
)

/** Clear what a drag wrote, in case the popup is reused before it unmounts. */
function clearDrag(popup: HTMLDivElement | null) {
  popup?.style.removeProperty("transition")
  popup?.style.removeProperty("transform")
  popup?.style.removeProperty("clip-path")
}

/** A modal panel that unfolds from beneath a full-width anchor such as the app header. */
function HeaderSheet({ onOpenChange, ...props }: PopoverPrimitive.Root.Props) {
  const popupRef = useRef<HTMLDivElement>(null)
  return (
    <PopupRefContext.Provider value={popupRef}>
      <PopoverPrimitive.Root
        data-slot="header-sheet"
        modal
        {...props}
        onOpenChange={(open, details) => {
          if (open) clearDrag(popupRef.current)
          onOpenChange?.(open, details)
        }}
      />
    </PopupRefContext.Provider>
  )
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
  onDismiss,
  dismissible = true,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "anchor"> & {
    /** Adds a handle that closes the sheet when dragged up or tapped. */
    onDismiss?: () => void
    /** While false, the handle springs back instead of dismissing. */
    dismissible?: boolean
  }) {
  const ownRef = useRef<HTMLDivElement>(null)
  const popupRef = useContext(PopupRefContext) ?? ownRef
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
        className="header-sheet-positioner z-40 outline-none"
      >
        <PopoverPrimitive.Popup
          ref={popupRef}
          data-slot="header-sheet-content"
          className={cn(
            "header-sheet overlay-floating flex max-h-[min(var(--available-height),85dvh)] w-(--anchor-width) flex-col rounded-t-none rounded-b-2xl bg-popover text-popover-foreground outline-none",
            className
          )}
          {...props}
        >
          <div className="flex min-h-0 flex-1 flex-col">
            {children}
            {onDismiss && (
              <HeaderSheetHandle
                popupRef={popupRef}
                onDismiss={onDismiss}
                dismissible={dismissible}
              />
            )}
          </div>
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

const SETTLE = "cubic-bezier(0.32, 0.72, 0, 1)"
const LEAVE = "cubic-bezier(0.4, 0, 1, 1)"

/**
 * Dragging up slides the sheet back under the header edge it came from.
 * Releasing past a distance or with an upward flick finishes the dismissal;
 * otherwise the sheet springs back.
 */
function HeaderSheetHandle({
  popupRef,
  onDismiss,
  dismissible,
}: {
  popupRef: RefObject<HTMLDivElement | null>
  onDismiss: () => void
  dismissible: boolean
}) {
  const drag = useRef<{
    startY: number
    lastY: number
    lastTime: number
    velocity: number
  } | null>(null)
  const dragged = useRef(false)
  // A drag may or may not end in a click (pointercancel never does, and some
  // mobile browsers drop it). Ignore only a click that follows the drag closely
  // so a later keyboard press still closes.
  const ignoreClickUntil = useRef(0)

  // Only the transform moves. The positioner's fixed clip at the header edge
  // hides what passes above it, so nothing can drift out of step.
  const lift = (distance: number, transition = "none") => {
    const popup = popupRef.current
    if (!popup) return
    popup.style.transition = transition
    popup.style.transform = distance ? `translateY(${-distance}px)` : ""
  }

  const release = (
    event: PointerEvent<HTMLButtonElement>,
    cancelled = false
  ) => {
    const state = drag.current
    drag.current = null
    const popup = popupRef.current
    if (!state || !popup || !dragged.current) return
    dragged.current = false
    ignoreClickUntil.current = event.timeStamp + 400
    const distance = Math.max(0, state.startY - event.clientY)
    const height = popup.offsetHeight
    // A finger that paused before lifting is not a flick.
    const flicked =
      state.velocity > 0.5 && event.timeStamp - state.lastTime < 100
    // An interrupted gesture (pointercancel) never dismisses: its coordinates
    // are not a release point.
    if (
      dismissible &&
      !cancelled &&
      (distance > Math.min(96, height * 0.3) || flicked)
    ) {
      // Hold the open clip so the roll-up exit cannot run alongside the slide.
      popup.style.clipPath = "inset(0 -2rem -2rem -2rem)"
      lift(height, `transform 220ms ${LEAVE}`)
      onDismiss()
      return
    }
    lift(0, `transform 280ms ${SETTLE}`)
    // Restore the stylesheet transitions even when the sheet was already at
    // rest and no transition runs to signal its end.
    window.setTimeout(() => {
      if (!drag.current) popup.style.transition = ""
    }, 280)
  }

  return (
    <button
      type="button"
      aria-label="Close"
      className="group/handle flex h-7 w-full shrink-0 cursor-grab touch-none items-center justify-center rounded-b-2xl outline-none active:cursor-grabbing"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        dragged.current = false
        drag.current = {
          startY: event.clientY,
          lastY: event.clientY,
          lastTime: event.timeStamp,
          velocity: 0,
        }
      }}
      onPointerMove={(event) => {
        const state = drag.current
        if (!state) return
        const distance = Math.max(0, state.startY - event.clientY)
        if (distance > 4) dragged.current = true
        const elapsed = event.timeStamp - state.lastTime
        if (elapsed > 0) {
          state.velocity = (state.lastY - event.clientY) / elapsed
          state.lastY = event.clientY
          state.lastTime = event.timeStamp
        }
        if (dragged.current) lift(distance)
      }}
      onPointerUp={release}
      onPointerCancel={(event) => release(event, true)}
      onClick={(event) => {
        if (event.timeStamp < ignoreClickUntil.current) return
        if (dismissible) onDismiss()
      }}
    >
      <span className="h-1 w-9 rounded-full bg-muted-foreground/30 transition-colors group-hover/handle:bg-muted-foreground/50 group-focus-visible/handle:bg-ring" />
    </button>
  )
}

export { HeaderSheet, HeaderSheetContent, HeaderSheetTrigger }
