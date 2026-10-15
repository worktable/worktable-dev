import { useEffect, useId, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { Maximize2 } from "lucide-react"
import type { WorktableMermaidThemeMode } from "@worktable/ui/theme/mermaid-config"
import { cn } from "@worktable/ui/lib/utils"
import { DocIconButton } from "@/components/document/doc-icon-button"
import { renderWorktableMermaid } from "@/lib/mermaid-runtime"
import { MermaidDiagramViewer } from "./mermaid-diagram-viewer"

interface WorktableMermaidRendererProps {
  name?: string
  chart?: string
  themeMode: WorktableMermaidThemeMode
  /** Labels the fullscreen viewer. */
  title?: string
  /** Shown under the diagram when someone named it. */
  caption?: string
  /** Extra icon controls, shown before Full screen. */
  controls?: ReactNode
  /** Content inside the frame below the diagram, such as its source. */
  footer?: ReactNode
  /** Keeps the frame and controls visible while editing. */
  editing?: boolean
  errorFallback?: ReactNode
}

export function WorktableMermaidRenderer({
  name,
  chart = "",
  themeMode,
  title,
  caption,
  controls,
  footer,
  editing,
  errorFallback,
}: WorktableMermaidRendererProps) {
  const [viewerOpen, setViewerOpen] = useState(false)
  const reactId = useId()

  const stableName = useMemo(
    () =>
      `mermaid_${(name ?? "block").replace(/[^a-zA-Z0-9]/g, "_")}_${reactId.replace(/[^a-zA-Z0-9]/g, "_")}`,
    [name, reactId]
  )

  const [rendered, setRendered] = useState({ id: "", svg: "" })
  const [error, setError] = useState("")
  const svg = rendered.svg
  // A stable object: React rewrites innerHTML whenever this prop's identity
  // changes, and replacing the drawing mid-click (an editor selection
  // re-render) makes the browser drop the click.
  const svgHtml = useMemo(() => ({ __html: svg }), [svg])

  useEffect(() => {
    let active = true

    const renderDiagram = async () => {
      const source = chart.trim()
      if (!source) {
        setRendered({ id: "", svg: "" })
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
        setRendered({ id: renderId, svg: result })
        setError("")
      } catch (err) {
        if (!active) return
        setError("Error rendering mermaid diagram")
        setRendered({ id: "", svg: "" })
        console.error("Mermaid render error:", err)
      }
    }

    void renderDiagram()

    return () => {
      active = false
    }
  }, [chart, stableName, themeMode])

  let body: ReactNode
  if (!chart.trim()) {
    body = (
      <div className="p-5 text-center text-sm text-muted-foreground">
        Enter mermaid code to see a preview…
      </div>
    )
  } else if (error) {
    body = errorFallback ?? (
      <div className="m-2 rounded-lg bg-destructive/10 p-4 text-center text-sm text-destructive">
        {error}
      </div>
    )
  } else {
    body = (
      <div
        className={cn("mermaid-diagram-area", svg && "cursor-zoom-in")}
        data-mermaid-open=""
        onClick={(event) => {
          // A diagram link keeps its own navigation.
          if ((event.target as Element).closest("a")) return
          if (svg) setViewerOpen(true)
        }}
      >
        <div
          className="flex min-h-12 items-center justify-center p-3"
          dangerouslySetInnerHTML={svgHtml}
        />
      </div>
    )
  }

  return (
    <div
      className="worktable-diagram mermaid-interactive-container"
      data-theme-mode={themeMode}
      data-editing={editing || undefined}
    >
      {(controls || svg) && (
        <div
          className="worktable-diagram-controls mermaid-open-control"
          // Keep the browser from moving the editor's selection onto the
          // block, which would highlight it and raise the formatting bar.
          onMouseDown={(event) => event.preventDefault()}
        >
          {controls}
          {svg && (
            <DocIconButton
              label="Full screen"
              onClick={() => setViewerOpen(true)}
            >
              <Maximize2 />
            </DocIconButton>
          )}
        </div>
      )}
      {body}
      {caption && <span className="worktable-caption">{caption}</span>}
      {footer}
      <MermaidDiagramViewer
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        svg={svg}
        svgId={rendered.id}
        title={title}
      />
    </div>
  )
}
