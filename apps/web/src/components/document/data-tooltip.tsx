import { useEffect, useState, type RefObject } from "react"
import { createPortal } from "react-dom"

/**
 * Tooltips for controls rendered outside React, such as the code block
 * header inside the editor: any element with `data-tooltip` gets the app's
 * compact tooltip above it.
 */
export function DataTooltips({
  rootRef,
}: {
  rootRef: RefObject<HTMLElement | null>
}) {
  const [tip, setTip] = useState<{
    label: string
    x: number
    y: number
  } | null>(null)

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    let timer = 0
    let current: HTMLElement | null = null
    const show = (event: PointerEvent | FocusEvent) => {
      const element =
        (event.target as Element | null)?.closest<HTMLElement>(
          "[data-tooltip]"
        ) ?? null
      if (element === current) return
      current = element
      window.clearTimeout(timer)
      if (!element) return setTip(null)
      timer = window.setTimeout(() => {
        const box = element.getBoundingClientRect()
        setTip({
          label: element.dataset.tooltip ?? "",
          x: box.left + box.width / 2,
          y: box.top,
        })
      }, 350)
    }
    const hide = () => {
      current = null
      window.clearTimeout(timer)
      setTip(null)
    }
    // Labels can change while shown, as Copy does; such controls announce it.
    const relabel = () =>
      current &&
      setTip((shown) =>
        shown ? { ...shown, label: current?.dataset.tooltip ?? "" } : shown
      )
    root.addEventListener("pointerover", show)
    root.addEventListener("focusin", show)
    root.addEventListener("pointerleave", hide)
    root.addEventListener("focusout", hide)
    root.addEventListener("tooltipchange", relabel)
    root.addEventListener("scroll", hide, true)
    return () => {
      window.clearTimeout(timer)
      root.removeEventListener("pointerover", show)
      root.removeEventListener("focusin", show)
      root.removeEventListener("pointerleave", hide)
      root.removeEventListener("focusout", hide)
      root.removeEventListener("tooltipchange", relabel)
      root.removeEventListener("scroll", hide, true)
    }
  }, [rootRef])

  if (!tip?.label) return null
  return createPortal(
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-md bg-foreground px-3 py-1.5 text-xs text-background"
      style={{ left: tip.x, top: tip.y - 6 }}
    >
      {tip.label}
    </div>,
    document.body
  )
}
