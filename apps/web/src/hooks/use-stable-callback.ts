import { useCallback, useLayoutEffect, useRef } from "react"

/**
 * A function whose identity never changes and that always calls the latest
 * `callback`. For event handlers passed to memoized rows. Call it from
 * events and effects, not during render.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result
): (...args: Args) => Result {
  const latest = useRef(callback)
  useLayoutEffect(() => {
    latest.current = callback
  })
  return useCallback((...args: Args) => latest.current(...args), [])
}
