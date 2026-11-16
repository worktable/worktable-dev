"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { X } from "lucide-react"

import { cn } from "@worktable/ui/lib/utils"

/**
 * The look every piece of Worktable help shares: the normal popover surface
 * with a cobalt band across the top that carries the Worktable mark, "Tip", and
 * close. Cards sit in the page, hints point at one control, and
 * inline help sits inside a dialog or box.
 */
export function HelpBand({
  label,
  mark,
  onClose,
  closeLabel = "Close",
}: {
  label: "Tip"
  /** The Worktable mark, supplied by the app. */
  mark?: React.ReactNode
  onClose?: () => void
  closeLabel?: string
}) {
  return (
    <div className="help-band flex items-center gap-2 rounded-t-[inherit] py-1.5 pr-1.5 pl-3 text-xs font-semibold text-primary-text">
      {mark ? (
        <span aria-hidden className="grid size-4 shrink-0 place-items-center">
          {mark}
        </span>
      ) : null}
      <span>{label}</span>
      {onClose ? (
        <button
          type="button"
          aria-label={closeLabel}
          onClick={onClose}
          className="ml-auto grid size-6 place-items-center rounded-md text-primary-text transition-colors hover:bg-surface-hover focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </div>
  )
}

export interface HelpContentProps {
  label: "Tip"
  mark?: React.ReactNode
  title?: React.ReactNode
  children?: React.ReactNode
  /** Buttons and links under the text. */
  actions?: React.ReactNode
  onClose?: () => void
}

function HelpBody({
  title,
  children,
  actions,
}: Pick<HelpContentProps, "title" | "children" | "actions">) {
  return (
    <div className="flex flex-col gap-1 px-3 pt-2.5 pb-3 text-sm">
      {title ? (
        <p className="font-semibold text-foreground">{title}</p>
      ) : null}
      {children ? (
        <div className="leading-relaxed text-muted-foreground [&_p+p]:mt-1.5">
          {children}
        </div>
      ) : null}
      {actions ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">{actions}</div>
      ) : null}
    </div>
  )
}

/** A tip in the page: first meetings, and must-knows about a whole screen. */
export function HelpCard({
  label,
  mark,
  title,
  children,
  actions,
  onClose,
  className,
  ...props
}: HelpContentProps &
  Omit<React.ComponentProps<"section">, "title" | "children">) {
  return (
    <section
      data-slot="help-card"
      aria-label={typeof title === "string" ? title : label}
      className={cn(
        "help-surface overflow-hidden rounded-xl bg-popover text-popover-foreground",
        className
      )}
      {...props}
    >
      <HelpBand label={label} mark={mark} onClose={onClose} />
      <HelpBody title={title} actions={actions}>
        {children}
      </HelpBody>
    </section>
  )
}

/** Help inside a dialog or composer: no elevation, same band. */
export function HelpInline({
  className,
  ...props
}: React.ComponentProps<typeof HelpCard>) {
  return <HelpCard className={cn("rounded-lg", className)} {...props} />
}

/**
 * A tip pointing at one control. It stays until closed: clicking elsewhere
 * doesn't dismiss it, so the person can try the thing it points at.
 */
export function HelpHint({
  anchor,
  open,
  side = "bottom",
  align = "end",
  className,
  ...content
}: HelpContentProps & {
  anchor: Element | null
  open: boolean
  side?: "top" | "bottom" | "left" | "right"
  align?: "start" | "center" | "end"
  className?: string
}) {
  // A hint that closes while focused hands focus back to what it points at,
  // so a keyboard user isn't left on nothing.
  const close = () => {
    const popup = document.activeElement?.closest('[data-slot="help-hint"]')
    content.onClose?.()
    if (!popup || !(anchor instanceof HTMLElement)) return
    const focusable = "button, [href], input, select, textarea, [tabindex]"
    const target = anchor.matches(focusable)
      ? anchor
      : anchor.querySelector<HTMLElement>(focusable)
    target?.focus()
  }
  return (
    <PopoverPrimitive.Root
      open={open && anchor !== null}
      modal={false}
      onOpenChange={(next, details) => {
        // Only the close button closes a hint.
        if (!next && details?.reason === "escape-key") close()
      }}
    >
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={anchor}
          side={side}
          align={align}
          sideOffset={8}
          className="isolate z-50"
        >
          <PopoverPrimitive.Popup
            data-slot="help-hint"
            aria-label={
              typeof content.title === "string" ? content.title : content.label
            }
            initialFocus={false}
            finalFocus={false}
            className={cn(
              "help-surface overlay-floating w-72 origin-(--transform-origin) overflow-hidden rounded-xl bg-popover text-popover-foreground outline-hidden duration-150 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 motion-reduce:animate-none",
              className
            )}
          >
            <HelpBand
              label={content.label}
              mark={content.mark}
              onClose={content.onClose ? close : undefined}
            />
            <HelpBody title={content.title} actions={content.actions}>
              {content.children}
            </HelpBody>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  )
}

/** A link out of help, such as Learn More to the docs. */
export function HelpLink({
  className,
  children,
  ...props
}: React.ComponentProps<"a">) {
  return (
    <a
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex items-center gap-1 text-sm font-medium text-primary-text hover:underline focus-visible:underline focus-visible:outline-none",
        className
      )}
      {...props}
    >
      {children}
    </a>
  )
}
