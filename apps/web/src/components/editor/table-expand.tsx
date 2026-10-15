import { useEffect, useMemo, useState, type RefObject } from "react"
import { Maximize2, Minimize2 } from "lucide-react"
import { DocIconButton } from "@/components/document/doc-icon-button"

type Target = { id: string; top: number; right: number; overflows: boolean }

/**
 * Expand for rich text tables. The control floats over the hovered table's
 * corner from outside the editor, and widening happens through a style rule
 * keyed by block id, so ProseMirror's DOM is never touched.
 */
export function TableExpandControl({
  frameRef,
}: {
  frameRef: RefObject<HTMLDivElement | null>
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [target, setTarget] = useState<Target | null>(null)

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    let frameRequest = 0
    const select = (element: Element | null) => {
      if (frameRequest) return
      frameRequest = requestAnimationFrame(() => {
        frameRequest = 0
        if (element?.closest(".worktable-table-controls")) return
        const content = element?.closest('[data-content-type="table"]')
        const outer = content?.closest<HTMLElement>(".bn-block-outer")
        const wrapper = content?.querySelector<HTMLElement>(".tableWrapper")
        if (!outer?.dataset.id || !wrapper) {
          setTarget(null)
          return
        }
        const box = wrapper.getBoundingClientRect()
        const bounds = frame.getBoundingClientRect()
        setTarget({
          id: outer.dataset.id,
          top: box.top - bounds.top,
          right: bounds.right - box.right,
          overflows: wrapper.scrollWidth > wrapper.clientWidth + 1,
        })
      })
    }
    // Pointer moves, and taps on a touch screen, find the table under them.
    const point = (event: Event) => select(event.target as Element | null)
    // The caret moving into a table finds it too, for keyboard use.
    const caret = () => {
      const node = document.getSelection()?.anchorNode
      const element = node instanceof Element ? node : node?.parentElement
      if (element && frame.contains(element)) select(element)
    }
    // Touch pointers leave after every tap; keep the control until the next tap.
    const leave = (event: PointerEvent) => {
      if (event.pointerType === "mouse") setTarget(null)
    }
    frame.addEventListener("pointermove", point)
    frame.addEventListener("pointerdown", point)
    frame.addEventListener("pointerleave", leave)
    document.addEventListener("selectionchange", caret)
    return () => {
      frame.removeEventListener("pointermove", point)
      frame.removeEventListener("pointerdown", point)
      frame.removeEventListener("pointerleave", leave)
      document.removeEventListener("selectionchange", caret)
      cancelAnimationFrame(frameRequest)
    }
  }, [frameRef])

  const rules = useMemo(
    () =>
      [...expanded]
        .map(
          (id) =>
            `.bn-editor [data-id="${CSS.escape(id)}"] > .bn-block > [data-content-type="table"] .tableWrapper{--doc-expanded-width:calc(var(--doc-pane-width,100%) - 3rem);width:calc(var(--doc-expanded-width) + var(--bn-table-handle-size) + var(--bn-table-widget-size))!important;max-width:none;margin-left:calc((100% - var(--doc-expanded-width)) / 2 - var(--bn-table-handle-size))}`
        )
        .join(""),
    [expanded]
  )

  const isExpanded = target ? expanded.has(target.id) : false
  return (
    <>
      {rules && <style>{rules}</style>}
      {target && (target.overflows || isExpanded) && (
        <div
          className="worktable-table-controls"
          style={{
            top: target.top + 5,
            right: target.right + 5,
            opacity: 1,
          }}
        >
          <DocIconButton
            label={isExpanded ? "Collapse table" : "Expand table"}
            onClick={() => {
              const id = target.id
              setExpanded((current) => {
                const next = new Set(current)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                return next
              })
              // Re-measure once the width transition settles.
              window.setTimeout(() => setTarget(null), 260)
            }}
          >
            {isExpanded ? <Minimize2 /> : <Maximize2 />}
          </DocIconButton>
        </div>
      )}
    </>
  )
}
