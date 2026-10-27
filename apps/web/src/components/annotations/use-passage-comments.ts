import { useCallback, useEffect, useRef, useState, type RefObject } from "react"
import type { Annotation, PassageSelector } from "@worktable/types"
import { rangeForPassage, readPassageText, setHighlight } from "./passage-text"

const HIGHLIGHT = "worktable-comment"
const ACTIVE_HIGHLIGHT = "worktable-comment-active"

/** The passage an annotation is about, from any target that quotes one. */
export function annotationPassage(
  annotation: Annotation
): PassageSelector | null {
  const target = annotation.target
  if (!("quote" in target) || !target.quote) return null
  return {
    quote: target.quote,
    prefix: "prefix" in target ? target.prefix : undefined,
    suffix: "suffix" in target ? target.suffix : undefined,
  }
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>) {
  return a.size === b.size && [...a].every((id) => b.has(id))
}

/**
 * Marks the passages open comments are about in a read-only Doc, keeps the
 * marks in place as the content renders, and opens a comment when its
 * passage is clicked; a click elsewhere in the Doc lets go of it. Returns a way to show a comment's passage, and the
 * comments whose passage is gone.
 */
export function usePassageComments({
  rootRef,
  ready,
  annotations,
  activeAnnotationId,
  onSelectAnnotation,
  onDeselect,
}: {
  rootRef: RefObject<HTMLElement | null>
  /** The content is on the page. */
  ready: boolean
  annotations: Annotation[]
  activeAnnotationId: string | null
  onSelectAnnotation: (annotation: Annotation) => void
  onDeselect: () => void
}) {
  const ranges = useRef(new Map<string, Range>())
  const [detached, setDetached] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    const root = rootRef.current
    const open = annotations.filter(
      (annotation) =>
        annotation.status !== "resolved" && annotationPassage(annotation)
    )
    if (!root || open.length === 0) {
      ranges.current = new Map()
      setHighlight(HIGHLIGHT, [])
      setHighlight(ACTIVE_HIGHLIGHT, [])
      setDetached((previous) => (previous.size ? new Set() : previous))
      return
    }
    let frame = 0
    const place = () => {
      frame = 0
      const model = readPassageText(root)
      const next = new Map<string, Range>()
      const gone = new Set<string>()
      for (const annotation of open) {
        const range = rangeForPassage(model, annotationPassage(annotation)!)
        if (range) next.set(annotation.id, range)
        else gone.add(annotation.id)
      }
      ranges.current = next
      setHighlight(
        HIGHLIGHT,
        [...next].flatMap(([id, range]) =>
          id === activeAnnotationId ? [] : [range]
        )
      )
      const active = activeAnnotationId && next.get(activeAnnotationId)
      setHighlight(ACTIVE_HIGHLIGHT, active ? [active] : [])
      setDetached((previous) => (sameIds(previous, gone) ? previous : gone))
    }
    place()
    // Diagrams, HTML and late plugins change the text after the first render.
    const observer = new MutationObserver(() => {
      frame ||= requestAnimationFrame(place)
    })
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [rootRef, ready, annotations, activeAnnotationId])

  useEffect(
    () => () => {
      setHighlight(HIGHLIGHT, [])
      setHighlight(ACTIVE_HIGHLIGHT, [])
    },
    []
  )

  // A click on a marked passage, not the end of a selection, opens its
  // comment; a click anywhere else lets go of the one open.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const open = (event: MouseEvent) => {
      if (!window.getSelection()?.isCollapsed) return
      const caret = caretAt(event.clientX, event.clientY)
      let hit: [string, Range] | null = null
      for (const entry of ranges.current) {
        if (!caret || !entry[1].isPointInRange(caret.node, caret.offset)) continue
        // The innermost passage wins where comments overlap.
        if (!hit || entry[1].toString().length < hit[1].toString().length)
          hit = entry
      }
      const annotation =
        hit && annotations.find((candidate) => candidate.id === hit[0])
      if (annotation) onSelectAnnotation(annotation)
      else onDeselect()
    }
    root.addEventListener("click", open)
    return () => root.removeEventListener("click", open)
  }, [rootRef, ready, annotations, onSelectAnnotation, onDeselect])

  /** Scroll a comment's passage into view. */
  const reveal = useCallback((annotationId: string) => {
    ranges.current
      .get(annotationId)
      ?.startContainer.parentElement?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      })
  }, [])

  return { reveal, detached }
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  if (document.caretPositionFromPoint) {
    const position = document.caretPositionFromPoint(x, y)
    return position
      ? { node: position.offsetNode, offset: position.offset }
      : null
  }
  const range = document.caretRangeFromPoint?.(x, y)
  return range
    ? { node: range.startContainer, offset: range.startOffset }
    : null
}
