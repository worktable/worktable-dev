import { useMemo } from "react"
import { Download } from "lucide-react"
import { Button } from "@worktable/ui/components/button"
import { ViewerDialog } from "@/components/viewer/viewer-dialog"
import { ZoomCanvas, type ZoomContent } from "@/components/viewer/zoom-canvas"
import { DIAGRAM_PLACEMENT, svgNaturalSize } from "@/lib/zoom-view"

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
  return (
    <ViewerDialog open={open} onOpenChange={onOpenChange}>
      <DiagramBody svg={svg} svgId={svgId} title={title} />
    </ViewerDialog>
  )
}

function DiagramBody({
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
  const content = useMemo<ZoomContent>(
    () => ({ type: "svg", html: { __html: svg } }),
    [svg]
  )
  const size = useMemo(() => svgNaturalSize(svg), [svg])
  return (
    <ZoomCanvas
      title={title}
      fallbackTitle="Diagram"
      content={content}
      size={size}
      placement={DIAGRAM_PLACEMENT}
      tools={
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => downloadSvg(svg, title)}
          title="Download SVG"
          aria-label="Download SVG"
        >
          <Download />
        </Button>
      }
    />
  )
}
