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
import { cn } from "@worktable/ui/lib/utils"
import { readPassageText, selectorForRange } from "./passage-text"

export interface SelectedPassage {
  range: Range
  selector: PassageSelector
}

type Shown = { top: number; left: number; touch: boolean } | null

const coarsePointer = () => window.matchMedia("(pointer: coarse)").matches

/** Room the floating button needs above a line before it goes below it. */
const ABOVE = 48

// On a touch screen the system draws its own things around a selection.
/** The drag handle under the end of a selection. */
const HANDLE = 32
/** The system's Copy menu: above the selection, or below it with no room. */
const MENU = 64
/** The bottom of the screen, where Chrome on Android shows Touch to Search. */
const BOTTOM = 112
/** The touch button's height. */
const PILL = 48
const EDGE = 8

/** The top of the Doc's scrolling pane, below the app's header. */
function paneTop(root: HTMLElement | null): number {
  for (let node = root?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === "auto" || overflowY === "scroll")
      return Math.max(node.getBoundingClientRect().top, 0)
  }
  return 0
}

/**
 * Where the touch button goes: under the selection, the side its Copy menu
 * leaves free. When the selection ends too low, at the top of the Doc.
 */
function touchTop(bounds: DOMRect, last: DOMRect, top: number): number {
  const height = window.innerHeight
  const menuBelow = bounds.top < MENU
  const below = last.bottom + HANDLE + (menuBelow ? MENU : 0)
  if (below + PILL <= height - BOTTOM) return below
  // The menu sits just above the selection, or isn't above it at all.
  if (menuBelow || bounds.top - MENU >= top + PILL + EDGE) return top
  // A selection from near the top to near the bottom: just above Chrome's bar.
  return height - BOTTOM - PILL
}

/**
 * A Comment button for text selected in a read-only Doc. With a mouse it
 * floats above the end of the selection; on a touch screen it sits under the
 * selection, clear of the system's selection menu and drag handles and of
 * Android's Touch to Search bar. Mod+Alt+M does the same.
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
      const rects = range.getClientRects()
      const bounds = range.getBoundingClientRect()
      const line = rects[rects.length - 1] ?? bounds
      // Half the button's width and a gutter, so it stays on screen.
      const half = coarsePointer() ? 84 : 64
      const left = Math.min(
        Math.max(line.right, half),
        window.innerWidth - half
      )
      if (coarsePointer()) {
        const top = touchTop(bounds, line, paneTop(rootRef.current) + EDGE)
        setShown({ top, left, touch: true })
        return
      }
      setShown({
        top: line.top >= ABOVE ? line.top - ABOVE + 4 : line.bottom + 8,
        left,
        touch: false,
      })
    }
    const later = () => {
      window.clearTimeout(timer)
      if (!read()) return place()
      // Out of the way of the handles while they move.
      if (coarsePointer()) setShown(null)
      timer = window.setTimeout(place, coarsePointer() ? 300 : 120)
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
        "overlay-floating fixed z-40 -translate-x-1/2 rounded-lg bg-popover p-1 print:hidden",
        shown.touch && "rounded-full"
      )}
      style={{
        top: shown.touch
          ? `max(${shown.top}px, calc(env(safe-area-inset-top) + ${EDGE}px))`
          : shown.top,
        left: shown.left,
      }}
      // Keep the selection: pressing the button must not clear it first.
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
    >
      <Button
        size={shown.touch ? "default" : "sm"}
        variant="ghost"
        className={shown.touch ? "rounded-full px-5" : undefined}
        onClick={comment}
      >
        <MessageSquarePlus />
        Comment
      </Button>
    </div>,
    document.body
  )
}
