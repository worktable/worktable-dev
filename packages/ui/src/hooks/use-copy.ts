import { useCallback, useEffect, useRef, useState } from "react"

import { copyText } from "@worktable/ui/lib/clipboard"

/**
 * Shared "click to copy, flash a check for ~1.5s" behavior for CopyField,
 * Snippet, and SecretReveal. `onCopied` fires only on a successful write (call
 * sites use it to toast); a failed copy is a silent no-op. The flash timer is
 * cleared on unmount.
 */
export function useCopy(onCopied?: () => void) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const copy = useCallback(
    async (text: string) => {
      try {
        await copyText(text)
      } catch {
        return
      }
      setCopied(true)
      onCopied?.()
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1500)
    },
    [onCopied]
  )

  return { copied, copy }
}
