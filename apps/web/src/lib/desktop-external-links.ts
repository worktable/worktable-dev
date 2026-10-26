/**
 * Desktop opens a destination outside Worktable in the browser or mail app
 * only when the page asks for a new window. It cancels every other navigation
 * away, because WebKit reports an HTML Doc frame navigating itself the same
 * way. So inside Desktop, a plain click on a link that leaves Worktable asks
 * for a new window. HTML Doc frames are separate documents and are unaffected.
 */
export function openExternalLinksAsWindows(doc: Document): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || event.button !== 0) return
    if (!doc.documentElement.hasAttribute("data-worktable-desktop")) return
    const anchor = (event.target as Element | null)?.closest?.("a[href]")
    if (!anchor || anchor.hasAttribute("download")) return
    const target = anchor.getAttribute("target")
    if (target && target !== "_self") return
    const url = externalUrl(anchor.getAttribute("href") ?? "", doc)
    if (!url) return
    event.preventDefault()
    doc.defaultView?.open(url, "_blank", "noopener,noreferrer")
  }
  doc.addEventListener("click", onClick)
  return () => doc.removeEventListener("click", onClick)
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
