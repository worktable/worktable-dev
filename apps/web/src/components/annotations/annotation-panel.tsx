import { lazy, Suspense } from "react"
import type { AnnotationPanelProps } from "./annotation-panel-content"
export type { AnnotationPanelProps } from "./annotation-panel-content"

const Content = lazy(() =>
  import("./annotation-panel-content").then((module) => ({
    default: module.AnnotationPanel,
  }))
)

/** Context panels mount on first open; defer their presentation code too. */
export function AnnotationPanel(props: AnnotationPanelProps) {
  return (
    <Suspense
      fallback={
        <p className="p-4 text-sm text-muted-foreground" role="status">
          Loading annotations…
        </p>
      }
    >
      <Content {...props} />
    </Suspense>
  )
}
