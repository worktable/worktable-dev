import { lazy, Suspense } from "react"
import type { ActivityActor } from "@worktable/types"
import type { AnnotationPanelContentProps } from "./annotation-panel-content"

const Comments = lazy(() => import("./annotation-panel-content").then(module => ({default: module.AnnotationPanelContent})))
const WithVisitors = lazy(() => import("./document-comments-panel").then(module => ({default: module.DocumentCommentsPanel})))

export interface AnnotationPanelProps extends AnnotationPanelContentProps {
  visitorComments?: {
    spaceId: string
    path: string
    documentId: string
    newCount: number
    /** Who changed the page, newest first: the first agent is who comments go to until one is picked. */
    contributors?: readonly ActivityActor[]
  }
}

/** Context panels mount on first use; visitor data waits for its tab. */
export function AnnotationPanel(props: AnnotationPanelProps) {
  return <Suspense fallback={<p className="p-4 text-sm text-muted-foreground" role="status">Loading comments…</p>}>
    {props.visitorComments ? <WithVisitors {...props} /> : <Comments {...props} />}
  </Suspense>
}
