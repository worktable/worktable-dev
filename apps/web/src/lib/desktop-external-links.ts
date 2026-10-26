type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

/**
 * Desktop cancels every navigation away from Worktable, because WebKit asks
 * about an HTML Doc frame navigating itself and about a deliberate link in
 * the same way. Inside Desktop, this page hands its own links that leave
 * Worktable, whether clicked or opened by code, to Desktop, which opens them
 * in the browser or mail app. A Desktop without that command gets a new
 * window, as before. HTML Doc frames are separate documents and unaffected.
 */
export function openExternalLinksThroughDesktop(
  doc: Document,
  call: NativeInvoke | null = nativeInvoke()
): () => void {
  const win = doc.defaultView
  if (!win || !call || !doc.documentElement.hasAttribute("data-worktable-desktop"))
    return () => {}
  const original = win.open
  const openOutside = (url: string) => {
    call("desktop_workspace_open_external", { url }).catch(() =>
      original.call(win, url, "_blank", "noopener,noreferrer")
    )
  }
  win.open = (url?: string | URL, target?: string, features?: string) => {
    const outside = url === undefined ? null : externalUrl(String(url), doc)
    if (!outside) return original.call(win, url, target, features)
    openOutside(outside)
    return null
  }
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return
    const anchor = (event.target as Element | null)?.closest?.("a[href]")
    if (!anchor || anchor.hasAttribute("download")) return
    const outside = externalUrl(anchor.getAttribute("href") ?? "", doc)
    if (!outside) return
    event.preventDefault()
    openOutside(outside)
  }
  doc.addEventListener("click", onClick)
  return () => {
    win.open = original
    doc.removeEventListener("click", onClick)
  }
}

/** Desktop's native command bridge, when this page runs inside Desktop. */
function nativeInvoke(): NativeInvoke | null {
  return (
    (globalThis as typeof globalThis & {
      __TAURI__?: { core?: { invoke?: NativeInvoke } }
    }).__TAURI__?.core?.invoke ?? null
  )
}

function externalUrl(href: string, doc: Document): string | null {
  try {
    const url = new URL(href, doc.baseURI)
    if (url.protocol === "mailto:" || url.protocol === "tel:") return url.href
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return url.origin === doc.location.origin ? null : url.href
  } catch {
    return null
  }
}
