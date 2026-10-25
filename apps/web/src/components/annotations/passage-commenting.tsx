import { useState, type RefObject } from "react"
import type {
  AnnotationCategory,
  AnnotationTarget,
  PassageSelector,
} from "@worktable/types"
import { AnnotationComposer } from "./annotation-composer"
import { SelectionComment } from "./selection-comment"

interface PassageDraft extends PassageSelector {
  category: AnnotationCategory
  anchor: Range
}

/**
 * Comment on text selected in a Doc as it reads: the Comment button, and the
 * comment box beside the selection. The comment is about that passage of the
 * Doc, found again by its words when the Doc changes.
 */
export function PassageCommenting({
  rootRef,
  docPath,
  onCreate,
}: {
  rootRef: RefObject<HTMLElement | null>
  docPath: string
  onCreate: (input: {
    target: AnnotationTarget
    category: AnnotationCategory
    body: string
  }) => void
}) {
  const [draft, setDraft] = useState<PassageDraft | null>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <SelectionComment
        rootRef={rootRef}
        paused={open}
        onComment={({ range, selector }) => {
          setDraft({ ...selector, anchor: range, category: "comment" })
          setOpen(true)
        }}
      />
      <AnnotationComposer
        draft={draft}
        open={open}
        onOpenChange={setOpen}
        onSubmit={(category, body) => {
          if (!draft) return
          const { quote, prefix, suffix } = draft
          onCreate({
            target: { type: "doc", docPath, quote, prefix, suffix },
            category,
            body,
          })
        }}
      />
    </>
  )
}
