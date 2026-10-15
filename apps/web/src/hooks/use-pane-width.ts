import { useCallback, useRef } from "react"

/**
 * Publishes the reading pane's width as `--doc-pane-width`, so an expanded
 * table can fill the pane while the text stays in its column. Returns a
 * callback ref for the scroll root.
 */
export function usePaneWidth<T extends HTMLElement>() {
  const cleanup = useRef<() => void>(() => {})
  return useCallback((node: T | null) => {
    cleanup.current()
    cleanup.current = () => {}
    if (!node) return
    const update = () =>
      node.style.setProperty("--doc-pane-width", `${node.clientWidth}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    cleanup.current = () => observer.disconnect()
  }, [])
}

/** Combines callback refs, e.g. a scroll fade and the pane width. */
export function mergeRefs<T>(
  ...refs: ((node: T | null) => void)[]
): (node: T | null) => void {
  return (node) => {
    for (const ref of refs) ref(node)
  }
}
