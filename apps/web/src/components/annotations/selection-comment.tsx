import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react"
import { createPortal } from "react-dom"
import { MessageSquarePlus } from "lucide-react"
import type { PassageSelector } from "@worktable/types"
import { Button } from "@worktable/ui/components/button"
import { cn } from "@worktable/ui/lib/utils"
import { readPassageText, selectorForRange } from "./passage-text"

export interface SelectedPassage {
  range: Range
  selector: PassageSelector
}

type Shown =
  | { kind: "float"; top: number; left: number }
  | { kind: "bar" }
  | null

const coarsePointer = () => window.matchMedia("(pointer: coarse)").matches

/** Room the floating button needs above a line before it goes below it. */
const ABOVE = 48

/**
 * A Comment button for text selected in a read-only Doc. With a mouse it
 * floats at the end of the selection; on a touch screen it sits at the
 * bottom, clear of the system's own selection menu. Mod+Alt+M does the same.
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

  useEffect(() => {
    if (paused) return
    let timer = 0
    let pressed = false
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
      const range = read()
      selected.current = range?.cloneRange() ?? null
      if (!range || pressed) {
        setShown(null)
        return
      }
      if (coarsePointer()) {
        setShown({ kind: "bar" })
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
      window.clearTimeout(timer)
      if (!read()) place()
      else timer = window.setTimeout(place, coarsePointer() ? 300 : 120)
    }
    const down = (event: PointerEvent) => {
      if (event.pointerType === "mouse") pressed = true
    }
    const up = () => {
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
    document.addEventListener("selectionchange", later)
    document.addEventListener("pointerdown", down, true)
    document.addEventListener("pointerup", up, true)
    document.addEventListener("keydown", key)
    window.addEventListener("scroll", place, true)
    window.addEventListener("resize", place)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener("selectionchange", later)
      document.removeEventListener("pointerdown", down, true)
      document.removeEventListener("pointerup", up, true)
      document.removeEventListener("keydown", key)
      window.removeEventListener("scroll", place, true)
      window.removeEventListener("resize", place)
    }
  }, [rootRef, paused])

  if (!shown || paused) return null
  return createPortal(
    <div
      className={cn(
        "overlay-floating fixed z-40 rounded-lg bg-popover p-1 print:hidden",
        shown.kind === "bar"
          ? "bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 -translate-x-1/2 rounded-full"
          : "-translate-x-1/2"
      )}
      style={
        shown.kind === "float" ? { top: shown.top, left: shown.left } : undefined
      }
      // Keep the selection: pressing the button must not clear it first.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      <Button
        size={shown.kind === "bar" ? "default" : "sm"}
        variant="ghost"
        className={shown.kind === "bar" ? "rounded-full px-5" : undefined}
        onClick={comment}
      >
        <MessageSquarePlus />
        Comment
      </Button>
    </div>,
    document.body
  )
}
