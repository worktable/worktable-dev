import { useCallback, useEffect, useRef } from "react"

interface ScrollFadeEdges {
  top?: boolean
  bottom?: boolean
}

/**
 * Hook that adds scroll-aware fade masks to a scrollable container.
 *
 * Sets data attributes on the element:
 * - data-scroll-top: "true" when scrolled away from top
 * - data-scroll-bottom: "true" when not at bottom
 *
 * Use with the .scroll-fade CSS class for the mask effect.
 *
 * Returns a callback ref (works with conditional rendering).
 */
export function useScrollFade<T extends HTMLElement = HTMLElement>(
  threshold = 8,
  { top = true, bottom = true }: ScrollFadeEdges = {}
) {
  const rafRef = useRef(0)
  const cleanupRef = useRef<() => void>(() => {})

  const ref = useCallback(
    (node: T | null) => {
      cleanupRef.current()
      cleanupRef.current = () => {}
      if (!node) return

      const update = () => {
        const { scrollTop, scrollHeight, clientHeight } = node
        const atTop = scrollTop <= threshold
        const atBottom = scrollTop + clientHeight >= scrollHeight - threshold

        if (!top || atTop) delete node.dataset.scrollTop
        else node.dataset.scrollTop = "true"

        if (!bottom || atBottom) delete node.dataset.scrollBottom
        else node.dataset.scrollBottom = "true"
      }

      const onScroll = () => {
        if (rafRef.current) return
        rafRef.current = requestAnimationFrame(() => {
          update()
          rafRef.current = 0
        })
      }

      // Initial state
      update()

      node.addEventListener("scroll", onScroll, { passive: true })

      // Observe both container and first child for content size changes
      const ro = new ResizeObserver(() => update())
      ro.observe(node)
      if (node.firstElementChild) {
        ro.observe(node.firstElementChild)
      }

      cleanupRef.current = () => {
        node.removeEventListener("scroll", onScroll)
        ro.disconnect()
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current)
          rafRef.current = 0
        }
      }
    },
    [bottom, threshold, top]
  )

  useEffect(() => () => cleanupRef.current(), [])

  return ref
}
