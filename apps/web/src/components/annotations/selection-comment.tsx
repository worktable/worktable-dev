import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type RefObject,
} from "react"
import { createPortal } from "react-dom"
import { MessageSquarePlus } from "lucide-react"
import type { PassageSelector } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { useHeaderContextualAction } from "@/hooks/use-page-meta"
import { readPassageText, selectorForRange } from "./passage-text"

export interface SelectedPassage {
  range: Range
  selector: PassageSelector
}

type Shown =
  { kind: "float"; top: number; left: number } | { kind: "header" } | null

const coarsePointer = () => window.matchMedia("(pointer: coarse)").matches

/** Room the floating button needs above a line before it goes below it. */
const ABOVE = 48

/**
 * A Comment button for text selected in a read-only Doc. With a mouse it
 * floats at the end of the selection; on a touch screen it appears as a
 * contextual action in the header, clear of both the system's selection menu
 * and Android's bottom search drawer. Mod+Alt+M does the same.
 */
export function SelectionComment({
  rootRef,
  onComment,
  paused = false,
}: {
  rootRef: RefObject<HTMLElement | null>
  onComment: (passage: SelectedPassage) => void
  /** While the comment box is open. */
  paused?: boolean
}) {
  const [shown, setShown] = useState<Shown>(null)
  if (paused && shown !== null) setShown(null)
  // The selection as last seen: a tap can clear it before the click lands.
  const selected = useRef<Range | null>(null)

  const comment = () => {
    const root = rootRef.current
    const range = selected.current
    if (!root || !range) return
    const selector = selectorForRange(readPassageText(root), range)
    if (!selector) return
    setShown(null)
    onComment({ range, selector })
  }
  const commentFromKey = useEffectEvent(comment)

  useHeaderContextualAction(
    !paused && shown?.kind === "header"
      ? {
          label: "Comment",
          icon: MessageSquarePlus,
          preserveSelection: true,
          onClick: comment,
        }
      : null
  )

  useEffect(() => {
    if (paused) {
      selected.current = null
      return
    }
    let timer = 0
    let releaseTimer = 0
    let pressed = false
    // A touch tap on the contextual button can collapse the DOM selection
    // before click fires; hold the snapshot and button alive until the tap ends.
    let activating = false
    const read = (): Range | null => {
      const selection = window.getSelection()
      const root = rootRef.current
      if (!root || !selection || selection.isCollapsed || !selection.rangeCount)
        return null
      const range = selection.getRangeAt(0)
      if (!root.contains(range.commonAncestorContainer)) return null
      return range.toString().trim() ? range : null
    }
    const place = () => {
      if (activating) return
      const range = read()
      selected.current = range?.cloneRange() ?? null
      if (!range || pressed) {
        setShown(null)
        return
      }
      if (coarsePointer()) {
        setShown((current) =>
          current?.kind === "header" ? current : { kind: "header" }
        )
        return
      }
      const rects = range.getClientRects()
      const line = rects[rects.length - 1] ?? range.getBoundingClientRect()
      setShown({
        kind: "float",
        top: line.top >= ABOVE ? line.top - ABOVE + 4 : line.bottom + 8,
        left: Math.min(Math.max(line.right, 64), window.innerWidth - 64),
      })
    }
    const later = () => {
      if (activating) return
      window.clearTimeout(timer)
      if (!read()) place()
      else timer = window.setTimeout(place, coarsePointer() ? 300 : 120)
    }
    const down = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("[data-preserve-selection='true']")
      ) {
        activating = true
        window.clearTimeout(releaseTimer)
        return
      }
      if (event.pointerType === "mouse") pressed = true
    }
    const up = () => {
      if (activating) {
        window.clearTimeout(releaseTimer)
        releaseTimer = window.setTimeout(() => {
          activating = false
          place()
        }, 150)
        return
      }
      if (!pressed) return
      pressed = false
      later()
    }
    const key = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.altKey &&
        event.code === "KeyM" &&
        read()
      ) {
        event.preventDefault()
        selected.current = read()!.cloneRange()
        commentFromKey()
      }
    }
    if (read()) {
      timer = window.setTimeout(place, coarsePointer() ? 300 : 120)
    }
    document.addEventListener("selectionchange", later)
    document.addEventListener("pointerdown", down, true)
    document.addEventListener("pointerup", up, true)
    document.addEventListener("pointercancel", up, true)
    document.addEventListener("keydown", key)
    window.addEventListener("scroll", place, true)
    window.addEventListener("resize", place)
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(releaseTimer)
      document.removeEventListener("selectionchange", later)
      document.removeEventListener("pointerdown", down, true)
      document.removeEventListener("pointerup", up, true)
      document.removeEventListener("pointercancel", up, true)
      document.removeEventListener("keydown", key)
      window.removeEventListener("scroll", place, true)
      window.removeEventListener("resize", place)
    }
  }, [rootRef, paused])

  if (shown?.kind !== "float" || paused) return null
  return createPortal(
    <div
      data-preserve-selection="true"
      className="overlay-floating fixed z-40 -translate-x-1/2 rounded-lg bg-popover p-1 print:hidden"
      style={{ top: shown.top, left: shown.left }}
      // Keep the selection: pressing the button must not clear it first.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      <Button size="sm" variant="ghost" onClick={comment}>
        <MessageSquarePlus />
        Comment
      </Button>
    </div>,
    document.body
  )
}
