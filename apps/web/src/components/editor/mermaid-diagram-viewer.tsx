import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { PointerEvent } from "react"
import { Download, Scan, XIcon, ZoomIn, ZoomOut } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@worktable/ui/components/dialog"
import {
  diagramNaturalSize,
  minDiagramScale,
  placeDiagram,
  zoomDiagramAt,
  type DiagramPlacement,
  type DiagramView,
} from "@/lib/diagram-view"

const BUTTON_STEP = 1.25
const INITIAL_VIEW: DiagramView = { scale: 1, x: 0, y: 0 }

function downloadSvg(svg: string, title: string | undefined) {
  const blob = new Blob([svg], { type: "image/svg+xml" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  const name = title?.trim().replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "")
  anchor.href = url
  anchor.download = `${name || "diagram"}.svg`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

interface MermaidDiagramViewerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  svg: string
  /** Mermaid's render id inside `svg`; the viewer copy needs its own. */
  svgId: string
  title?: string
}

/**
 * Full-window diagram viewer. The page-level diagram stays passive so the
 * document always scrolls; panning and zooming happen only here.
 */
export function MermaidDiagramViewer({
  open,
  onOpenChange,
  svg,
  svgId,
  title,
}: MermaidDiagramViewerProps) {
  // Focus the viewer itself so a tap or click doesn't ring the first control.
  const popupRef = useRef<HTMLDivElement>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        ref={popupRef}
        initialFocus={popupRef}
        showCloseButton={false}
        className="top-0 left-0 h-dvh max-h-none w-dvw max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0 sm:max-w-none"
      >
        {/* The popup mounts only while open or closing, so the body stays
            visible through the exit animation. */}
        <ViewerBody svg={svg} svgId={svgId} title={title} />
      </DialogContent>
    </Dialog>
  )
}

function ViewerBody({
  svg: inlineSvg,
  svgId,
  title,
}: {
  svg: string
  svgId: string
  title?: string
}) {
  // A second copy of the diagram needs fresh SVG ids so its styles and markers
  // stay independent of the inline one.
  const svg = useMemo(
    () => (svgId ? inlineSvg.replaceAll(svgId, `${svgId}_viewer`) : inlineSvg),
    [inlineSvg, svgId]
  )
  // Stable, so pan and zoom re-renders never rewrite the drawing.
  const svgHtml = useMemo(() => ({ __html: svg }), [svg])
  const canvasRef = useRef<HTMLDivElement>(null)
  const size = useMemo(() => diagramNaturalSize(svg), [svg])
  const viewRef = useRef<DiagramView>(INITIAL_VIEW)
  /** The automatic placement to keep on resize, until the user moves the view. */
  const placementRef = useRef<DiagramPlacement | null>("open")
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const [view, setViewState] = useState<DiagramView>(INITIAL_VIEW)

  const setView = useCallback((next: DiagramView) => {
    viewRef.current = next
    setViewState(next)
  }, [])

  const place = useCallback(
    (mode: DiagramPlacement) => {
      const canvas = canvasRef.current
      if (!canvas || !size) return
      placementRef.current = mode
      setView(
        placeDiagram(
          mode,
          { width: canvas.clientWidth, height: canvas.clientHeight },
          size
        )
      )
    },
    [setView, size]
  )
  const fit = useCallback(() => place("fit"), [place])

  const zoomAt = useCallback(
    (factor: number, originX?: number, originY?: number) => {
      const canvas = canvasRef.current
      if (!canvas) return
      placementRef.current = null
      const canvasSize = { width: canvas.clientWidth, height: canvas.clientHeight }
      setView(
        zoomDiagramAt(
          viewRef.current,
          factor,
          originX ?? canvasSize.width / 2,
          originY ?? canvasSize.height / 2,
          size ? minDiagramScale(canvasSize, size) : undefined
        )
      )
    },
    [setView, size]
  )

  const panBy = useCallback(
    (dx: number, dy: number) => {
      const current = viewRef.current
      placementRef.current = null
      setView({ ...current, x: current.x + dx, y: current.y + dy })
    },
    [setView]
  )

  useLayoutEffect(() => {
    place("open")
  }, [place])

  useEffect(() => {
    const replace = () => {
      if (placementRef.current) place(placementRef.current)
    }
    window.addEventListener("resize", replace)
    return () => window.removeEventListener("resize", replace)
  }, [place])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Pinch on a trackpad arrives as a ctrl+wheel; plain wheel scrolls the view.
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const lineScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : 1
      if (event.ctrlKey || event.metaKey) {
        const box = canvas.getBoundingClientRect()
        zoomAt(
          Math.exp(-event.deltaY * lineScale * 0.002),
          event.clientX - box.left,
          event.clientY - box.top
        )
      } else {
        panBy(-event.deltaX * lineScale, -event.deltaY * lineScale)
      }
    }
    canvas.addEventListener("wheel", handleWheel, { passive: false })
    return () => canvas.removeEventListener("wheel", handleWheel)
  }, [panBy, zoomAt])

  const handlePointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return
    // Capturing would retarget the click and swallow a diagram link.
    if ((event.target as Element).closest("a")) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    })
  }, [])

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const pointers = pointersRef.current
      const previous = pointers.get(event.pointerId)
      if (!previous) return
      const next = { x: event.clientX, y: event.clientY }

      if (pointers.size === 1) {
        pointers.set(event.pointerId, next)
        panBy(next.x - previous.x, next.y - previous.y)
        return
      }

      const other = [...pointers].find(([id]) => id !== event.pointerId)?.[1]
      pointers.set(event.pointerId, next)
      if (!other) return
      const box = event.currentTarget.getBoundingClientRect()
      const before = Math.hypot(previous.x - other.x, previous.y - other.y)
      const after = Math.hypot(next.x - other.x, next.y - other.y)
      if (before > 0) {
        zoomAt(
          after / before,
          (next.x + other.x) / 2 - box.left,
          (next.y + other.y) / 2 - box.top
        )
      }
      panBy((next.x - previous.x) / 2, (next.y - previous.y) / 2)
    },
    [panBy, zoomAt]
  )

  const handlePointerEnd = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      pointersRef.current.delete(event.pointerId)
    },
    []
  )

  // The dialog keeps focus on its own controls, so listen at the document.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === "+" || event.key === "=") zoomAt(BUTTON_STEP)
      else if (event.key === "-") zoomAt(1 / BUTTON_STEP)
      else if (event.key === "0") fit()
      else return
      event.preventDefault()
    }
    document.addEventListener("keydown", handleKeyDown)
    return () => document.removeEventListener("keydown", handleKeyDown)
  }, [fit, zoomAt])

  return (
    <div className="flex h-full min-h-0 flex-col" data-diagram-viewer="">
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border px-3">
        <DialogTitle
          className={
            title?.trim()
              ? "min-w-0 flex-1 truncate text-sm"
              : "sr-only"
          }
        >
          {title?.trim() || "Diagram"}
        </DialogTitle>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => zoomAt(1 / BUTTON_STEP)}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <ZoomOut />
          </Button>
          <span
            className="min-w-12 text-center font-mono text-xs text-muted-foreground tabular-nums select-none"
            aria-live="polite"
          >
            {Math.round(view.scale * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => zoomAt(BUTTON_STEP)}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <ZoomIn />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={fit}
            title="Fit to screen"
            aria-label="Fit to screen"
          >
            <Scan />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => downloadSvg(svg, title)}
            title="Download SVG"
            aria-label="Download SVG"
          >
            <Download />
          </Button>
          <div className="mx-1 h-5 w-px bg-border" />
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                title="Close"
                aria-label="Close"
              />
            }
          >
            <XIcon />
          </DialogClose>
        </div>
      </div>
      <div
        ref={canvasRef}
        className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onDoubleClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          zoomAt(2, event.clientX - box.left, event.clientY - box.top)
        }}
      >
        <div
          className="absolute top-0 left-0 origin-top-left [&>svg]:block [&>svg]:!h-full [&>svg]:!w-full [&>svg]:!max-w-none"
          style={{
            width: size?.width,
            height: size?.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
          dangerouslySetInnerHTML={svgHtml}
        />
      </div>
    </div>
  )
}
