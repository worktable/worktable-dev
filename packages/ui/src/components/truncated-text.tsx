"use client"

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { cn } from "@worktable/ui/lib/utils"

const loadTooltip = () => import("./truncated-text-tooltip")
const TruncatedTextTooltip = lazy(loadTooltip)

/** A single-line label that reveals its full text only when it is clipped. */
export function TruncatedText({
  text,
  children = text,
  className,
}: {
  text: string
  children?: ReactNode
  className?: string
}) {
  const label = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLSpanElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const [state, setState] = useState<"unmounted" | "open" | "closed">(
    "unmounted"
  )
  const open = state === "open"
  const isClipped = useCallback(() => {
    const element = trigger.current ?? label.current
    return !!element && element.scrollWidth > element.clientWidth
  }, [])
  const show = useCallback(() => {
    if (isClipped()) setState("open")
  }, [isClipped])
  const close = useCallback(() => {
    window.clearTimeout(timer.current)
    // Keep the activated trigger mounted so dismissal cannot replace a link's
    // click target between pointerdown and click.
    setState((current) => (current === "unmounted" ? current : "closed"))
  }, [])

  // Keep the row's existing keyboard stop. The label itself stays a span.
  useEffect(() => {
    const control = label.current?.closest<HTMLElement>(
      "a[href], button, [role='menuitem']"
    )
    const onFocus = () => {
      if (control?.matches(":focus-visible")) show()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }
    control?.addEventListener("focus", onFocus)
    control?.addEventListener("blur", close)
    control?.addEventListener("click", close)
    control?.addEventListener("keydown", onKeyDown)
    return () => {
      window.clearTimeout(timer.current)
      control?.removeEventListener("focus", onFocus)
      control?.removeEventListener("blur", close)
      control?.removeEventListener("click", close)
      control?.removeEventListener("keydown", onKeyDown)
    }
  }, [close, show])

  // Only open tooltips need to observe resizing; other labels measure on intent.
  useEffect(() => {
    const element = label.current
    if (!open || !element) return
    const observer = new ResizeObserver(() => {
      if (!isClipped()) close()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [close, isClipped, open, text])

  return (
    <span
      ref={label}
      className={cn("min-w-0 truncate", className)}
      onPointerEnter={(event) => {
        if (event.pointerType !== "mouse" || !isClipped()) return
        void loadTooltip().catch(() => {})
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(show, 500)
      }}
      onPointerLeave={close}
      onPointerDown={close}
    >
      {state !== "unmounted" ? (
        <Suspense fallback={children}>
          <TruncatedTextTooltip
            open={open}
            text={text}
            triggerRef={trigger}
            onClose={close}
          >
            {children}
          </TruncatedTextTooltip>
        </Suspense>
      ) : (
        children
      )}
    </span>
  )
}
