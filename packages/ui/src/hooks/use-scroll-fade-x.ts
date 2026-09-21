import { useCallback, useEffect, useRef, useState } from "react"

export function useScrollFadeX<T extends HTMLElement = HTMLElement>(
  threshold = 8
) {
  const [element, setElement] = useState<T | null>(null)
  const animationFrameRef = useRef(0)

  const ref = useCallback((node: T | null) => {
    setElement(node)
  }, [])

  useEffect(() => {
    if (!element) return

    const update = () => {
      const { scrollLeft, scrollWidth, clientWidth } = element
      const atLeft = scrollLeft <= threshold
      const atRight = scrollLeft + clientWidth >= scrollWidth - threshold

      if (atLeft) delete element.dataset.scrollLeft
      else element.dataset.scrollLeft = "true"

      if (atRight) delete element.dataset.scrollRight
      else element.dataset.scrollRight = "true"
    }

    const onScroll = () => {
      if (animationFrameRef.current) return
      animationFrameRef.current = requestAnimationFrame(() => {
        update()
        animationFrameRef.current = 0
      })
    }

    update()
    element.addEventListener("scroll", onScroll, { passive: true })

    const observer = new ResizeObserver(update)
    observer.observe(element)
    if (element.firstElementChild) observer.observe(element.firstElementChild)

    return () => {
      element.removeEventListener("scroll", onScroll)
      observer.disconnect()
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = 0
      }
    }
  }, [element, threshold])

  return ref
}
