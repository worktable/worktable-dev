import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type RefObject,
} from "react"
import {
  HTML_ELEMENT_QUOTE_LENGTH,
  HtmlElementSchema,
  type Annotation,
  type HtmlElement,
} from "@worktable/types"
import type { CommentAnchor } from "./annotation-composer"

interface FrameRect {
  x: number
  y: number
  width: number
  height: number
}

interface Picked {
  quote?: string
  element: HtmlElement
  rect: FrameRect
}

/** An element chosen in the page, waiting for its comment to be written. */
export interface ElementDraft {
  quote?: string
  element: HtmlElement
  /** Where the comment box opens: the element, through the frame. */
  anchor: CommentAnchor
}

const NONE: ReadonlySet<string> = new Set()

function rectFrom(value: unknown): FrameRect | null {
  if (!value || typeof value !== "object") return null
  const { x, y, width, height } = value as Record<string, unknown>
  return [x, y, width, height].every(
    (side) => typeof side === "number" && Number.isFinite(side)
  )
    ? (value as FrameRect)
    : null
}

/**
 * Comments on elements of an HTML Doc. The page's runtime does what needs
 * the page: it outlines the element under the pointer, describes the one
 * chosen, and marks the elements comments are about. This holds the mode and
 * the draft, and sends the frame the open comments to mark. What the frame
 * sends back is a page's own account of itself, so it is checked before use.
 */
export function useElementComments({
  frameRef,
  frameKey,
  enabled,
  annotations,
  activeAnnotationId,
  composing,
  onPick,
  onOpenComment,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>
  /** Names the page now loaded in the frame; null while one loads. */
  frameKey: string | null
  enabled: boolean
  annotations: Annotation[]
  activeAnnotationId: string | null
  /** The comment box is open. */
  composing: boolean
  onPick: () => void
  onOpenComment: (annotationId: string) => void
}) {
  const [wanted, setMode] = useState(false)
  const mode = wanted && enabled
  const [picked, setPicked] = useState<Picked | null>(null)
  const [gone, setGone] = useState<ReadonlySet<string>>(NONE)

  const pins = useMemo(
    () =>
      annotations.flatMap((annotation) => {
        const target = annotation.target
        return annotation.status !== "resolved" &&
          target.type === "widget" &&
          target.element
          ? [
              {
                id: annotation.id,
                anchor: { quote: target.quote, element: target.element },
              },
            ]
          : []
      }),
    [annotations]
  )

  const drafting = picked !== null
  useEffect(() => {
    if (frameKey === null) return
    frameRef.current?.contentWindow?.postMessage(
      {
        type: "worktable.comment.set",
        mode,
        draft: drafting,
        activeId: activeAnnotationId,
        pins,
      },
      "*"
    )
  }, [frameRef, frameKey, mode, drafting, activeAnnotationId, pins])

  const toggle = useCallback(() => setMode((on) => !on), [])
  const clearDraft = useCallback(() => setPicked(null), [])

  useEffect(() => {
    if (!enabled) return
    const key = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.altKey &&
        event.code === "KeyM"
      ) {
        event.preventDefault()
        toggle()
      } else if (event.key === "Escape" && mode && !composing) setMode(false)
    }
    window.addEventListener("keydown", key)
    return () => window.removeEventListener("keydown", key)
  }, [enabled, mode, composing, toggle])

  /** A message from the page's runtime, already known to come from it. */
  const onFrameMessage = (data: { type?: string; [field: string]: unknown }) => {
    if (data.type === "worktable.comment.pick") {
      const anchor = data["anchor"] as
        | { quote?: unknown; element?: unknown }
        | undefined
      const element = HtmlElementSchema.safeParse(anchor?.element)
      const rect = rectFrom(data["rect"])
      if (!mode || !element.success || !rect) return
      const quote =
        typeof anchor?.quote === "string"
          ? anchor.quote.slice(0, HTML_ELEMENT_QUOTE_LENGTH)
          : ""
      setPicked({ ...(quote ? { quote } : {}), element: element.data, rect })
      onPick()
    } else if (data.type === "worktable.comment.rect") {
      const rect = rectFrom(data["rect"])
      setPicked((current) => (current && rect ? { ...current, rect } : null))
    } else if (data.type === "worktable.comment.status") {
      const states = data["states"]
      if (!states || typeof states !== "object") return
      const next = new Set(
        Object.entries(states).flatMap(([id, state]) =>
          state === "gone" ? [id] : []
        )
      )
      setGone((current) =>
        current.size === next.size && [...next].every((id) => current.has(id))
          ? current
          : next
      )
    } else if (data.type === "worktable.comment.open") {
      if (typeof data["id"] === "string") onOpenComment(data["id"])
    } else if (data.type === "worktable.comment.key") {
      if (data["key"] === "toggle") {
        if (enabled) toggle()
      } else if (!composing) setMode(false)
    }
  }

  const draft = useMemo<ElementDraft | null>(() => {
    if (!picked) return null
    const { rect, ...about } = picked
    return {
      ...about,
      anchor: {
        // The part of the element the frame shows, in this window.
        getBoundingClientRect: () => {
          const frame = frameRef.current?.getBoundingClientRect()
          if (!frame) return new DOMRect()
          const left = Math.max(rect.x, 0)
          const top = Math.max(rect.y, 0)
          const right = Math.min(rect.x + rect.width, frame.width)
          const bottom = Math.min(rect.y + rect.height, frame.height)
          return new DOMRect(
            frame.left + Math.min(left, frame.width),
            frame.top + Math.min(top, frame.height),
            Math.max(right - left, 0),
            Math.max(bottom - top, 0)
          )
        },
      },
    }
  }, [frameRef, picked])

  /** Scrolls a comment's element into view. */
  const reveal = useCallback(
    (annotationId: string) =>
      frameRef.current?.contentWindow?.postMessage(
        { type: "worktable.comment.reveal", id: annotationId },
        "*"
      ),
    [frameRef]
  )

  return {
    mode,
    toggle,
    draft,
    clearDraft,
    /** Open comments whose element is no longer on the page. */
    detachedIds: gone,
    reveal,
    onFrameMessage,
  }
}
