import { useCallback, useMemo, useRef, useState, type ReactNode } from "react"
import { Maximize2, Minimize2 } from "lucide-react"
import { useScrollFadeX } from "@/hooks/use-scroll-fade-x"
import { mergeRefs } from "@/hooks/use-pane-width"
import { DocIconButton } from "./doc-icon-button"

/**
 * A table that scrolls inside its own frame. When it is wider than the text
 * column, Expand widens it to the reading pane.
 */
export function DocTable({ children }: { children: ReactNode }) {
  const fade = useScrollFadeX<HTMLDivElement>()
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const observer = useRef<ResizeObserver | null>(null)
  const measure = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!node) return
    const update = () => setOverflows(node.scrollWidth > node.clientWidth + 1)
    update()
    observer.current = new ResizeObserver(update)
    observer.current.observe(node)
    if (node.firstElementChild) observer.current.observe(node.firstElementChild)
  }, [])
  const scrollRef = useMemo(() => mergeRefs(fade, measure), [fade, measure])
  return (
    <div className="worktable-table-frame" data-expanded={expanded || undefined}>
      {(overflows || expanded) && (
        <div className="worktable-table-controls">
          <DocIconButton
            label={expanded ? "Collapse table" : "Expand table"}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </DocIconButton>
        </div>
      )}
      <div
        ref={scrollRef}
        className="worktable-table-scroll scroll-fade-x"
      >
        <table>{children}</table>
      </div>
    </div>
  )
}
