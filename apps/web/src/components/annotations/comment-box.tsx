import { Suspense, lazy, useState, type ComponentProps } from "react"
import type { AnnotationComposer as Composer } from "./annotation-composer"

const AnnotationComposer = lazy(() =>
  import("./annotation-composer").then((module) => ({
    default: module.AnnotationComposer,
  }))
)

/**
 * The comment box, loaded the first time it opens: a page that nobody
 * comments on never loads it.
 */
export function CommentBox(props: ComponentProps<typeof Composer>) {
  const [wanted, setWanted] = useState(props.open)
  if (props.open && !wanted) setWanted(true)
  if (!wanted) return null
  return (
    <Suspense fallback={null}>
      <AnnotationComposer {...props} />
    </Suspense>
  )
}
