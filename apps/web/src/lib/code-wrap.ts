import { useSyncExternalStore } from "react"

// A reading preference for this device, applied to every code block. It is
// not saved into Docs, so turning it on creates no edits.
const STORAGE_KEY = "worktable-code-wrap"
const listeners = new Set<() => void>()

/** Runs before first paint so saved previews already wrap as the editor will. */
export const codeWrapScript = `try{document.documentElement.dataset.codeWrap=localStorage.getItem("${STORAGE_KEY}")==="true"?"true":"false"}catch{}`

export function codeWrapEnabled(): boolean {
  return (
    typeof document !== "undefined" &&
    document.documentElement.dataset.codeWrap === "true"
  )
}

export function setCodeWrap(next: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, next ? "true" : "false")
  } catch {
    // Private windows can refuse storage; the choice still applies here.
  }
  document.documentElement.dataset.codeWrap = next ? "true" : "false"
  for (const listener of listeners) listener()
}

export function subscribeCodeWrap(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useCodeWrap(): boolean {
  return useSyncExternalStore(subscribeCodeWrap, codeWrapEnabled, () => false)
}
