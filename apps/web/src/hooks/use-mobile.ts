import { useSyncExternalStore } from "react"

const MOBILE_BREAKPOINT = 768

/**
 * A media query as an external store. The first render already reads the
 * real match, so a phone never paints the desktop layout first.
 */
export function mediaQueryStore(query: string) {
  let list: MediaQueryList | undefined
  const media = () => (list ??= window.matchMedia(query))
  return {
    subscribe(onChange: () => void): () => void {
      const current = media()
      current.addEventListener("change", onChange)
      return () => current.removeEventListener("change", onChange)
    },
    getSnapshot: (): boolean => media().matches,
  }
}

const mobile = mediaQueryStore(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
// The app renders only after hydration, so the server value is never shown.
const serverSnapshot = () => false

export function useIsMobile(): boolean {
  return useSyncExternalStore(
    mobile.subscribe,
    mobile.getSnapshot,
    serverSnapshot
  )
}
