/**
 * Copy text to the clipboard. Prefers the async Clipboard API and falls back
 * to a hidden textarea + execCommand for non-secure contexts (plain-HTTP
 * LAN installs), where navigator.clipboard is unavailable.
 *
 * Mirrors apps/web/src/lib/clipboard.ts verbatim — packages/ui can't import app
 * libs, so the logic is duplicated here. Keep the two in sync.
 */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.position = "fixed"
  textarea.style.opacity = "0"
  document.body.appendChild(textarea)
  textarea.select()
  try {
    if (!document.execCommand("copy")) {
      throw new Error("execCommand copy failed")
    }
  } finally {
    document.body.removeChild(textarea)
  }
}
