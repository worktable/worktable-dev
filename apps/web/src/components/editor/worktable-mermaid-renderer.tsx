import { useEffect, useId, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { Maximize } from "lucide-react"
import type { WorktableMermaidThemeMode } from "@worktable/ui/theme/mermaid-config"
import { Button } from "@worktable/ui/components/button"
import { cn } from "@worktable/ui/lib/utils"
import { renderWorktableMermaid } from "@/lib/mermaid-runtime"
import { MermaidDiagramViewer } from "./mermaid-diagram-viewer"

interface WorktableMermaidRendererProps {
  name?: string
  chart?: string
  themeMode: WorktableMermaidThemeMode
  /** Labels the fullscreen viewer. */
  title?: string
  errorFallback?: ReactNode
}

export function WorktableMermaidRenderer({
  name,
  chart = "",
  themeMode,
  title,
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
      className="mermaid-interactive-container group/diagram relative w-full"
      data-theme-mode={themeMode}
    >
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
      {svg && (
        <Button
          variant="outline"
          size="icon-xs"
          className="mermaid-open-control absolute top-2 right-2 z-10 opacity-0 transition-opacity duration-150 group-hover/diagram:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
          onClick={() => setViewerOpen(true)}
          title="Fullscreen"
          aria-label="Fullscreen"
        >
          <Maximize />
        </Button>
      )}
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
