import { useState, type RefObject } from "react"
import type { AnnotationTarget, PassageSelector } from "@worktable/types"
import type { CommentContext } from "./annotation-composer"
import { CommentBox } from "./comment-box"
import { SelectionComment } from "./selection-comment"

interface PassageDraft extends PassageSelector {
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
  context,
  onCreate,
}: {
  rootRef: RefObject<HTMLElement | null>
  docPath: string
  context?: CommentContext
  onCreate: (input: { target: AnnotationTarget; body: string; to: string[] }) => void
}) {
  const [draft, setDraft] = useState<PassageDraft | null>(null)
  const [open, setOpen] = useState(false)
  return (
    <>
      <SelectionComment
        rootRef={rootRef}
        paused={open}
        onComment={({ range, selector }) => {
          setDraft({ ...selector, anchor: range })
          setOpen(true)
        }}
      />
      <CommentBox
        draft={draft}
        open={open}
        onOpenChange={setOpen}
        context={context}
        onSubmit={(body, to) => {
          if (!draft) return
          const { quote, prefix, suffix } = draft
          onCreate({
            target: { type: "doc", docPath, quote, prefix, suffix },
            body,
            to,
          })
        }}
      />
    </>
  )
}
