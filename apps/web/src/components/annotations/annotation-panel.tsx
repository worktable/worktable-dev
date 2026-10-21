import { lazy, Suspense } from "react"
import type { AnnotationCommentsPanelProps } from "./annotation-comments"

const Comments = lazy(() => import("./annotation-comments").then(module => ({default: module.AnnotationCommentsPanel})))
const WithVisitors = lazy(() => import("./document-comments-panel").then(module => ({default: module.DocumentCommentsPanel})))

export interface AnnotationPanelProps extends AnnotationCommentsPanelProps {
  visitorComments?: {spaceId: string; path: string; documentId: string; newCount: number}
}

/** Both context panels mount on first use; visitor data waits for its tab. */
export function AnnotationPanel(props: AnnotationPanelProps) {
  return <Suspense fallback={<p className="p-4 text-sm text-muted-foreground" role="status">Loading comments…</p>}>
    {props.visitorComments ? <WithVisitors {...props} /> : <Comments {...props} />}
  </Suspense>
}
