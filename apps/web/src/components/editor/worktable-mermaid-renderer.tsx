import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react"
import {
  Crosshair,
  Download,
  Maximize,
  Minimize,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import type { WorktableMermaidThemeMode } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { cn } from "@worktable/ui/lib/utils"
import { renderWorktableMermaid } from "@/lib/mermaid-runtime"

interface WorktableMermaidRendererProps {
  name?: string
  chart?: string
  themeMode: WorktableMermaidThemeMode
  showToolbar?: boolean
  errorFallback?: ReactNode
}

export function WorktableMermaidRenderer({
  name,
  chart = "",
  themeMode,
  showToolbar = true,
  errorFallback,
}: WorktableMermaidRendererProps) {
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 })
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [isPinching, setIsPinching] = useState(false)
  const [lastPinchDistance, setLastPinchDistance] = useState(0)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const diagramAreaRef = useRef<HTMLDivElement>(null)
  const reactId = useId()

  const stableName = useMemo(
    () =>
      `mermaid_${(name ?? "block").replace(/[^a-zA-Z0-9]/g, "_")}_${reactId.replace(/[^a-zA-Z0-9]/g, "_")}`,
    [name, reactId]
  )

  const [svg, setSvg] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    let active = true

    const renderDiagram = async () => {
      const source = chart.trim()
      if (!source) {
        setSvg("")
        setError("")
        return
      }

      try {
        const renderId = `${stableName}_${Date.now()}`
        const result = await renderWorktableMermaid({
          id: renderId,
          source,
          themeMode,
        })
        if (!active) return
        setSvg(result)
        setError("")
      } catch (err) {
        if (!active) return
        setError("Error rendering mermaid diagram")
        setSvg("")
        console.error("Mermaid render error:", err)
      }
    }

    void renderDiagram()

    return () => {
      active = false
    }
  }, [chart, stableName, themeMode])

  const zoomIn = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setZoom((current) => Math.min(current + 0.25, 3))
  }, [])

  const zoomOut = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setZoom((current) => Math.max(current - 0.25, 0.25))
  }, [])

  const resetView = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const handleMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (
        event.button === 0 &&
        (event.target as HTMLElement).closest(".mermaid-diagram-area")
      ) {
        event.preventDefault()
        setIsDragging(true)
        setDragStart({ x: event.clientX - pan.x, y: event.clientY - pan.y })
      }
    },
    [pan]
  )

  const handleMouseMove = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!isDragging) return
      event.preventDefault()
      setPan({ x: event.clientX - dragStart.x, y: event.clientY - dragStart.y })
    },
    [dragStart, isDragging]
  )

  const stopDragging = useCallback(() => {
    setIsDragging(false)
  }, [])

  const toggleFullscreen = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()

      if (!wrapperRef.current) return

      if (document.fullscreenElement) {
        void document.exitFullscreen()
        setIsFullscreen(false)
        return
      }

      void wrapperRef.current.requestFullscreen()
      setIsFullscreen(true)
    },
    []
  )

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }

    document.addEventListener("fullscreenchange", handleFullscreenChange)
    return () =>
      document.removeEventListener("fullscreenchange", handleFullscreenChange)
  }, [])

  const getTouchDistance = useCallback((touches: TouchList) => {
    if (touches.length < 2) return 0
    const first = touches[0]
    const second = touches[1]
    const deltaX = first.clientX - second.clientX
    const deltaY = first.clientY - second.clientY
    return Math.sqrt(deltaX * deltaX + deltaY * deltaY)
  }, [])

  const interactionRef = useRef({
    isDragging,
    isPinching,
    lastPinchDistance,
    pan,
    dragStart,
    zoom,
  })

  useEffect(() => {
    interactionRef.current = {
      isDragging,
      isPinching,
      lastPinchDistance,
      pan,
      dragStart,
      zoom,
    }
  }, [dragStart, isDragging, isPinching, lastPinchDistance, pan, zoom])

  useEffect(() => {
    const area = diagramAreaRef.current
    if (!area || !showToolbar) return

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        event.preventDefault()
        setIsPinching(true)
        setLastPinchDistance(getTouchDistance(event.touches))
        return
      }

      if (event.touches.length === 1) {
        setIsDragging(true)
        setDragStart({
          x: event.touches[0].clientX - interactionRef.current.pan.x,
          y: event.touches[0].clientY - interactionRef.current.pan.y,
        })
      }
    }

    const handleTouchMove = (event: TouchEvent) => {
      const state = interactionRef.current
      if (state.isPinching && event.touches.length === 2) {
        event.preventDefault()
        const distance = getTouchDistance(event.touches)
        if (state.lastPinchDistance > 0) {
          const scale = distance / state.lastPinchDistance
          setZoom((current) => Math.min(Math.max(current * scale, 0.25), 3))
        }
        setLastPinchDistance(distance)
        return
      }

      if (state.isDragging && event.touches.length === 1) {
        event.preventDefault()
        setPan({
          x: event.touches[0].clientX - state.dragStart.x,
          y: event.touches[0].clientY - state.dragStart.y,
        })
      }
    }

    const handleTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) {
        setIsPinching(false)
        setLastPinchDistance(0)
      }
      if (event.touches.length === 0) {
        setIsDragging(false)
      }
    }

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      event.stopPropagation()
      const step = event.deltaY > 0 ? -0.05 : 0.05
      setZoom((current) => Math.min(Math.max(current + step, 0.25), 3))
    }

    area.addEventListener("touchstart", handleTouchStart, { passive: false })
    area.addEventListener("touchmove", handleTouchMove, { passive: false })
    area.addEventListener("touchend", handleTouchEnd, { passive: false })
    area.addEventListener("wheel", handleWheel, { passive: false })

    return () => {
      area.removeEventListener("touchstart", handleTouchStart)
      area.removeEventListener("touchmove", handleTouchMove)
      area.removeEventListener("touchend", handleTouchEnd)
      area.removeEventListener("wheel", handleWheel)
    }
  }, [getTouchDistance, showToolbar])

  const downloadSvg = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (!svg) return

      const blob = new Blob([svg], { type: "image/svg+xml" })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `mermaid-diagram-${Date.now()}.svg`
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      URL.revokeObjectURL(url)
    },
    [svg]
  )

  if (!chart.trim()) {
    return (
      <div className="p-5 text-center text-sm text-muted-foreground">
        Enter mermaid code to see a preview…
      </div>
    )
  }

  if (error) {
    if (errorFallback) return errorFallback
    return (
      <div className="m-2 rounded-lg bg-destructive/10 p-4 text-center text-sm text-destructive">
        {error}
      </div>
    )
  }

  return (
    <div
      ref={wrapperRef}
      className={cn(
        "mermaid-interactive-container group/diagram relative w-full",
        showToolbar && "min-h-36",
        isFullscreen && "bg-background"
      )}
      data-theme-mode={themeMode}
    >
      {showToolbar && (
        <div
          className={cn(
            "mermaid-toolbar absolute top-2 right-2 z-10 flex items-center gap-0.5",
            "rounded-lg border border-border bg-card p-0.5 shadow-sm",
            "opacity-0 transition-opacity duration-150",
            "group-hover/diagram:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"
          )}
        >
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={zoomOut}
            title="Zoom out"
          >
            <ZoomOut className="size-3.5" />
          </Button>
          <span className="min-w-10 text-center font-mono text-xs text-muted-foreground select-none">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={zoomIn}
            title="Zoom in"
          >
            <ZoomIn className="size-3.5" />
          </Button>
          <div className="mx-0.5 h-4 w-px bg-border" />
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={resetView}
            title="Reset view"
          >
            <Crosshair className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={toggleFullscreen}
            title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? (
              <Minimize className="size-3.5" />
            ) : (
              <Maximize className="size-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={downloadSvg}
            title="Download as SVG"
          >
            <Download className="size-3.5" />
          </Button>
        </div>
      )}

      <div
        className={cn(
          "mermaid-diagram-area overflow-hidden",
          isFullscreen ? "min-h-screen" : showToolbar ? "min-h-28" : "min-h-0",
          showToolbar && (isDragging ? "cursor-grabbing" : "cursor-grab")
        )}
        ref={diagramAreaRef}
        style={{ touchAction: showToolbar ? "none" : "auto" }}
        onMouseDown={showToolbar ? handleMouseDown : undefined}
        onMouseMove={showToolbar ? handleMouseMove : undefined}
        onMouseUp={showToolbar ? stopDragging : undefined}
        onMouseLeave={showToolbar ? stopDragging : undefined}
      >
        <div
          className={cn(
            "mermaid-zoom-layer flex items-center justify-center p-3",
            isFullscreen
              ? "min-h-[calc(100vh-5rem)]"
              : showToolbar
                ? "min-h-24"
                : "min-h-0"
          )}
          style={{
            transform: showToolbar
              ? `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
              : "none",
            transformOrigin: "center center",
            transition: isDragging ? "none" : "transform 0.15s ease-out",
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
    </div>
  )
}
