"use client"

import * as React from "react"

import { cn } from "@worktable/ui/lib/utils"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@worktable/ui/components/dialog"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHandle,
  DrawerTitle,
} from "@worktable/ui/components/drawer"

// ── Mobile detection ─────────────────────────────────────────

const MOBILE_BREAKPOINT = 768

function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean>(
    typeof window !== "undefined"
      ? window.innerWidth < MOBILE_BREAKPOINT
      : false
  )

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isMobile
}

// ── Context ──────────────────────────────────────────────────

const ResponsiveDialogContext = React.createContext<{
  isMobile: boolean
  handleOnly: boolean
  keyboardFriendly: boolean
}>({
  isMobile: false,
  handleOnly: false,
  keyboardFriendly: false,
})

/**
 * Returns `{ isMobile }` so children can adapt their rendering.
 * For example, disable `autoFocus` on inputs when isMobile
 * to prevent the virtual keyboard from covering the drawer.
 */
function useResponsiveDialog() {
  return React.useContext(ResponsiveDialogContext)
}

// ── Root ─────────────────────────────────────────────────────

interface ResponsiveDialogProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  handleOnly?: boolean
  keyboardFriendly?: boolean
  children: React.ReactNode
}

function ResponsiveDialog({
  open,
  onOpenChange,
  handleOnly = false,
  keyboardFriendly = false,
  children,
}: ResponsiveDialogProps) {
  const isMobile = useIsMobile()

  return (
    <ResponsiveDialogContext.Provider
      value={{ isMobile, handleOnly, keyboardFriendly }}
    >
      {isMobile ? (
        <Drawer
          open={open}
          onOpenChange={onOpenChange}
          handleOnly={handleOnly}
          repositionInputs={!keyboardFriendly}
          fixed={keyboardFriendly}
        >
          {children}
        </Drawer>
      ) : (
        <Dialog open={open} onOpenChange={onOpenChange}>
          {children}
        </Dialog>
      )}
    </ResponsiveDialogContext.Provider>
  )
}

// ── Content ──────────────────────────────────────────────────

function ResponsiveDialogContent({
  className,
  children,
  showCloseButton,
  ...props
}: React.ComponentProps<"div"> & { showCloseButton?: boolean }) {
  const { isMobile, keyboardFriendly } = useResponsiveDialog()

  if (isMobile) {
    return (
      <DrawerContent
        className={cn(
          keyboardFriendly
            ? "data-[vaul-drawer-direction=bottom]:max-h-[calc(100dvh-1rem)]"
            : "data-[vaul-drawer-direction=bottom]:max-h-[90dvh]",
          className
        )}
        {...props}
      >
        <div className={cn("flex min-h-0 flex-1 flex-col px-5 pt-7 pb-0")}>
          {children}
        </div>
      </DrawerContent>
    )
  }

  return (
    <DialogContent
      className={cn("gap-0 p-5 sm:max-w-sm", className)}
      showCloseButton={showCloseButton}
      {...props}
    >
      {children}
    </DialogContent>
  )
}

// ── Header ───────────────────────────────────────────────────

function ResponsiveDialogHeader({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const { isMobile, handleOnly } = useResponsiveDialog()

  if (isMobile) {
    // Render a plain div instead of DrawerHeader to avoid its
    // built-in text-center for bottom drawers
    return (
      <div
        data-slot="responsive-dialog-header"
        className={cn(
          "relative flex shrink-0 flex-col gap-1.5 pb-4",
          className
        )}
        {...props}
      >
        {handleOnly && (
          <DrawerHandle
            preventCycle
            className="!absolute inset-0 z-20 !mt-0 !block !h-full !w-full rounded-none !bg-transparent opacity-0"
          />
        )}
        <div className={cn(handleOnly && "pointer-events-none relative z-10")}>
          {props.children}
        </div>
      </div>
    )
  }

  return (
    <DialogHeader className={cn("shrink-0 p-0 pb-4", className)} {...props} />
  )
}

// ── Title ────────────────────────────────────────────────────

function ResponsiveDialogTitle({
  className,
  ...props
}: React.ComponentProps<"h2">) {
  const { isMobile } = useResponsiveDialog()

  if (isMobile) {
    return (
      <DrawerTitle
        className={cn("text-lg leading-tight font-semibold", className)}
        {...props}
      />
    )
  }

  return (
    <DialogTitle
      className={cn("text-lg leading-tight font-semibold", className)}
      {...props}
    />
  )
}

// ── Description ──────────────────────────────────────────────

function ResponsiveDialogDescription({
  className,
  ...props
}: React.ComponentProps<"p">) {
  const { isMobile } = useResponsiveDialog()

  if (isMobile) {
    return (
      <DrawerDescription
        className={cn("text-sm text-muted-foreground", className)}
        {...props}
      />
    )
  }

  return (
    <DialogDescription
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

// ── Body ─────────────────────────────────────────────────────

function ResponsiveDialogBody({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const { isMobile } = useResponsiveDialog()

  return (
    <div
      data-slot="responsive-dialog-body"
      className={cn(
        "min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-1 py-4 [scrollbar-gutter:stable]",
        isMobile ? "-mx-1" : "-mx-1",
        className
      )}
      {...props}
    />
  )
}

// ── Footer ───────────────────────────────────────────────────

function ResponsiveDialogFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  const { isMobile } = useResponsiveDialog()
  const footerClassName = cn(
    isMobile
      ? "shrink-0 flex-col-reverse gap-2 border-t border-border/60 bg-background/95 p-0 pt-4 pb-[max(calc(env(safe-area-inset-bottom)+1rem),1rem)]"
      : "m-0 shrink-0 flex-row justify-end gap-2 border-0 bg-transparent p-0 pt-4",
    className
  )

  if (isMobile) {
    return <DrawerFooter className={footerClassName} {...props} />
  }

  return <DialogFooter className={footerClassName} {...props} />
}

// ── Close ────────────────────────────────────────────────────

function ResponsiveDialogClose(props: React.ComponentProps<"button">) {
  const { isMobile } = useResponsiveDialog()
  return isMobile ? <DrawerClose {...props} /> : <DialogClose {...props} />
}

export {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  ResponsiveDialogBody,
  ResponsiveDialogFooter,
  ResponsiveDialogClose,
  useResponsiveDialog,
}
