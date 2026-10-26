type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

/**
 * Desktop cancels every navigation away from Worktable, because WebKit asks
 * about an HTML Doc frame navigating itself and about a deliberate link in
 * the same way. Inside Desktop, this page hands its own links that leave
 * Worktable, whether clicked or opened by code, to Desktop, which opens them
 * in the browser or mail app. Clicks are taken before the page's own handlers
 * see them, so nothing on the page can swallow one. A Desktop without that
 * command gets a new window, as before. HTML Doc frames are separate
 * documents and unaffected.
 */
export function openExternalLinksThroughDesktop(
  win: Window,
  call: NativeInvoke | null = nativeInvoke()
): () => void {
  if (!call) return () => {}
  const doc = win.document
  // Desktop marks the page once it has loaded.
  const inDesktop = () => doc.documentElement.hasAttribute("data-worktable-desktop")
  const original = win.open
  let last = { url: "", at: 0 }
  const openOutside = (url: string) => {
    // One click can reach both the link and code that opens it.
    const now = Date.now()
    if (last.url === url && now - last.at < 1000) return
    last = { url, at: now }
    call("desktop_workspace_open_external", { url }).catch(() =>
      original.call(win, url, "_blank", "noopener,noreferrer")
    )
  }
  win.open = (url?: string | URL, target?: string, features?: string) => {
    const outside =
      url === undefined || !inDesktop() ? null : externalUrl(String(url), doc)
    if (!outside) return original.call(win, url, target, features)
    openOutside(outside)
    return null
  }
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0 || !inDesktop()) return
    const anchor = (event.target as Element | null)?.closest?.("a[href]")
    // A link being edited places the cursor; the editor opens it if asked.
    if (!anchor || anchor.hasAttribute("download") || anchor.closest("[contenteditable='true']"))
      return
    const outside = externalUrl(anchor.getAttribute("href") ?? "", doc)
    if (!outside) return
    event.preventDefault()
    openOutside(outside)
  }
  win.addEventListener("click", onClick, true)
  return () => {
    win.open = original
    win.removeEventListener("click", onClick, true)
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
