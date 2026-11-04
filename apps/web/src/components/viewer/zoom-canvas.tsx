import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react"
import { Scan, ZoomIn, ZoomOut } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import {
  minViewScale,
  placeView,
  zoomViewAt,
  type PlacementRule,
  type ViewPlacement,
  type ViewSize,
  type ZoomView,
} from "@/lib/zoom-view"
import { ViewerHeader } from "./viewer-dialog"

const BUTTON_STEP = 1.25
const INITIAL_VIEW: ZoomView = { scale: 1, x: 0, y: 0 }

/** What a zoom canvas shows: SVG markup, or an image by its URL. */
export type ZoomContent =
  | { type: "svg"; html: { __html: string } }
  | { type: "image"; src: string; alt: string }

/**
 * A viewer body that pans and zooms what it shows: drag or scroll to move,
 * pinch, Ctrl+scroll, double-click or the header controls to zoom.
 */
export function ZoomCanvas({
  title,
  fallbackTitle,
  leading,
  content,
  size,
  placement,
  tools,
}: {
  title: string | undefined
  fallbackTitle: string
  /** Header controls after the title. */
  leading?: ReactNode
  content: ZoomContent
  /** Its size at scale 1, once known. */
  size: ViewSize | null
  placement: PlacementRule
  /** Tools after the zoom controls in the header. */
  tools?: ReactNode
}) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<ZoomView>(INITIAL_VIEW)
  /** The automatic placement to keep on resize, until the person moves the view. */
  const placementRef = useRef<ViewPlacement | null>(placement.open)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const [view, setViewState] = useState<ZoomView>(INITIAL_VIEW)

  const setView = useCallback((next: ZoomView) => {
    viewRef.current = next
    setViewState(next)
  }, [])

  const place = useCallback(
    (mode: ViewPlacement) => {
      const canvas = canvasRef.current
      if (!canvas || !size) return
      placementRef.current = mode
      setView(
        placeView(
          mode,
          { width: canvas.clientWidth, height: canvas.clientHeight },
          size,
          placement.largest
        )
      )
    },
    [placement.largest, setView, size]
  )
  const fit = useCallback(() => place("fit"), [place])

  const zoomAt = useCallback(
    (factor: number, originX?: number, originY?: number) => {
      const canvas = canvasRef.current
      if (!canvas) return
      placementRef.current = null
      const canvasSize = {
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      }
      setView(
        zoomViewAt(
          viewRef.current,
          factor,
          originX ?? canvasSize.width / 2,
          originY ?? canvasSize.height / 2,
          size ? minViewScale(canvasSize, size) : undefined
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

  const openPlacement = placement.open
  useLayoutEffect(() => {
    place(openPlacement)
  }, [openPlacement, place])

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

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return
      // Capturing would retarget the click and swallow a diagram link.
      if ((event.target as Element).closest("a")) return
      event.currentTarget.setPointerCapture(event.pointerId)
      pointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      })
    },
    []
  )

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

  // Sized rather than scaled, so the browser resamples an image at the size
  // shown and a large photo stays smooth at a small zoom. A diagram keeps
  // its markup object, so panning never rewrites the drawing.
  const layer =
    content.type === "svg" ? (
      <div
        className="absolute top-0 left-0 origin-top-left [&>svg]:block [&>svg]:!h-full [&>svg]:!w-full [&>svg]:!max-w-none"
        style={{
          width: size?.width,
          height: size?.height,
          transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
        }}
        dangerouslySetInnerHTML={content.html}
      />
    ) : (
      <img
        src={content.src}
        alt={content.alt}
        draggable={false}
        className="absolute top-0 left-0 max-w-none select-none"
        style={
          size
            ? {
                width: size.width * view.scale,
                height: size.height * view.scale,
                transform: `translate(${view.x}px, ${view.y}px)`,
              }
            : { visibility: "hidden" }
        }
      />
    )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerHeader
        title={title}
        fallbackTitle={fallbackTitle}
        leading={leading}
      >
        {/* Phones pinch to zoom, which leaves the header room for the rest. */}
        <Button
          variant="ghost"
          size="icon-sm"
          className="max-sm:hidden"
          onClick={() => zoomAt(1 / BUTTON_STEP)}
          title="Zoom out"
          aria-label="Zoom out"
        >
          <ZoomOut />
        </Button>
        <span
          className="min-w-12 text-center font-mono text-xs text-muted-foreground tabular-nums select-none max-sm:hidden"
          aria-live="polite"
        >
          {Math.round(view.scale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="max-sm:hidden"
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
        {tools}
      </ViewerHeader>
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
        {layer}
      </div>
    </div>
  )
}
