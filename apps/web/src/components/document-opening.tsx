import { useEffect, useState } from "react"

export const documentOpeningLayoutScript = `(()=>{try{const w=Number(localStorage.getItem("worktable-sidebar-width")??288);document.documentElement.style.setProperty("--worktable-opening-sidebar",(Number.isFinite(w)?Math.min(480,Math.max(220,w)):288)+"px")}catch{}})()`

export const documentOpeningPreloadScript = `requestAnimationFrame(()=>requestAnimationFrame(()=>{try{const d=JSON.parse(document.getElementById("worktable-opening-data").textContent);for(const href of d?.preloads??[]){if(!/^\\/assets\\/[\\w./-]+\\.js$/.test(href)||href.includes(".."))continue;const l=document.createElement("link");l.rel="modulepreload";l.href=href;l.crossOrigin="";l.fetchPriority="low";document.head.appendChild(l)}}catch{}}))`

type Opening = { pathname: string; html: string }

// Captured once, before hydration. The server only fills this after the normal
// identity/scope checks and a transactional source read. It is a display-only
// snapshot; it never authorizes a route, seeds query data, or enters Yjs.
const opening: Opening | null = (() => {
  if (typeof document === "undefined") return null
  try {
    const data = JSON.parse(
      document.getElementById("worktable-opening-data")?.textContent ?? "null"
    )
    return data?.pathname === location.pathname && typeof data.html === "string"
      ? data
      : null
  } catch {
    return null
  }
})()

export function DocumentOpeningData() {
  const serialized = JSON.stringify(opening)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
  return (
    <script
      id="worktable-opening-data"
      type="application/json"
      dangerouslySetInnerHTML={{ __html: serialized }}
    />
  )
}

export function DocumentOpening() {
  const [visible, setVisible] = useState(Boolean(opening?.html))
  useEffect(() => {
    if (!opening?.html) return
    const check = () => {
      const next = document.querySelector<HTMLElement>(
        'main [data-document-preview], main [data-document-scroll-root], main [data-document-ready="true"], [data-document-state]'
      )
      if (!next && location.pathname === opening.pathname) return
      // Preserve reading position as the validated in-app preview takes over.
      const first = document.querySelector<HTMLElement>(
        "#worktable-opening-preview [data-document-preview]"
      )
      if (next && first) next.scrollTop = first.scrollTop
      setVisible(false)
      observer.disconnect()
    }
    const observer = new MutationObserver(check)
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-document-ready"],
    })
    window.addEventListener("popstate", check)
    check()
    return () => {
      observer.disconnect()
      window.removeEventListener("popstate", check)
    }
  }, [])

  return (
    <div
      id="worktable-opening-preview"
      dangerouslySetInnerHTML={{ __html: visible ? (opening?.html ?? "") : "" }}
    />
  )
}
