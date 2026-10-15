import { useEffect, useState, type RefObject } from "react"
import { createPortal } from "react-dom"

/**
 * Tooltips for the controls inside a Doc: any element with `data-tooltip`
 * gets the app's compact tooltip above it. Works for controls rendered
 * outside React too, such as the code block header inside the editor.
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
    // Labels can change while shown, as Copy does.
    const labels = new MutationObserver(() =>
      setTip((shown) =>
        shown && current
          ? { ...shown, label: current.dataset.tooltip ?? "" }
          : shown
      )
    )
    const show = (event: PointerEvent | FocusEvent) => {
      const element =
        (event.target as Element | null)?.closest<HTMLElement>(
          "[data-tooltip]"
        ) ?? null
      if (element === current) return
      current = element
      window.clearTimeout(timer)
      labels.disconnect()
      if (!element) return setTip(null)
      labels.observe(element, {
        attributes: true,
        attributeFilter: ["data-tooltip"],
      })
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
      labels.disconnect()
      setTip(null)
    }
    // Copying over plain HTTP briefly focuses a hidden field; a control still
    // under the pointer keeps its tooltip.
    const blur = () => {
      if (!current?.matches(":hover")) hide()
    }
    root.addEventListener("pointerover", show)
    root.addEventListener("focusin", show)
    root.addEventListener("pointerleave", hide)
    root.addEventListener("focusout", blur)
    root.addEventListener("scroll", hide, true)
    return () => {
      window.clearTimeout(timer)
      labels.disconnect()
      root.removeEventListener("pointerover", show)
      root.removeEventListener("focusin", show)
      root.removeEventListener("pointerleave", hide)
      root.removeEventListener("focusout", blur)
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
