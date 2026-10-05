/** A TOC owns its listeners for exactly as long as its route is connected. */
class WorktableTOC extends HTMLElement {
  private controller?: AbortController
  private resizeObserver?: ResizeObserver
  private frame = 0
  private links: { link: HTMLAnchorElement; heading: HTMLElement }[] = []
  private pinned?: HTMLAnchorElement

  connectedCallback() {
    this.controller = new AbortController()
    const { signal } = this.controller
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      if (!this.isConnected) return
      this.links = [...this.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')].flatMap((link) => {
        const heading = document.getElementById(decodeURIComponent(link.hash.slice(1)))
        return heading ? [{ link, heading }] : []
      })
      this.selectHash()
      this.update()
      const main = document.querySelector("main")
      if (main) {
        this.resizeObserver = new ResizeObserver(this.schedule)
        this.resizeObserver.observe(main)
      }
    })

    window.addEventListener("scroll", this.schedule, { passive: true, signal })
    window.addEventListener("resize", this.schedule, { passive: true, signal })
    this.querySelector(".dropdown")?.addEventListener("scroll", this.updateFade, { passive: true, signal })
    this.querySelector("details")?.addEventListener("toggle", this.schedule, { signal })
    window.addEventListener("hashchange", this.selectHash, { signal })
    window.addEventListener("wheel", this.release, { passive: true, signal })
    window.addEventListener("touchmove", this.release, { passive: true, signal })
    window.addEventListener("pointerdown", (event) => {
      if (!this.contains(event.target as Node)) this.release()
    }, { signal })
    window.addEventListener("keydown", (event) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
        this.release()
      }
      const details = this.querySelector("details")
      if (event.key === "Escape" && details?.open) {
        const hasFocus = details.contains(document.activeElement)
        details.open = false
        if (hasFocus) details.querySelector("summary")?.focus()
      }
    }, { signal })
    window.addEventListener("click", (event) => {
      const details = this.querySelector("details")
      if (details && !details.contains(event.target as Node)) details.open = false
    }, { signal })
    this.addEventListener("click", (event) => {
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a") : null
      if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      if (this.links.some((entry) => entry.link === link)) {
        this.pinned = link
        this.select(link)
        const details = this.querySelector("details")
        if (details) details.open = false
      }
    }, { signal })
  }

  disconnectedCallback() {
    this.controller?.abort()
    this.resizeObserver?.disconnect()
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.links = []
    this.pinned = undefined
  }

  private selectHash = () => {
    this.pinned = this.links.find(({ link }) => link.hash === location.hash)?.link
    this.schedule()
  }

  private release = () => {
    this.pinned = undefined
    this.schedule()
  }

  private schedule = () => {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.update()
    })
  }

  private update() {
    this.updateFade()
    if (this.pinned) return this.select(this.pinned)
    const headerHeight = document.querySelector("header")?.getBoundingClientRect().height ?? 0
    const mobileHeight = this.querySelector("summary")?.getBoundingClientRect().height ?? 0
    const threshold = headerHeight + mobileHeight + 32
    let current: HTMLAnchorElement | undefined = this.links[0]?.link
    for (const { link, heading } of this.links) {
      if (heading.getBoundingClientRect().top > threshold) break
      current = link
    }
    if (window.scrollY > 0 && window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2) {
      current = this.links.at(-1)?.link
    }
    if (current) this.select(current)
  }

  private updateFade = () => {
    const dropdown = this.querySelector<HTMLElement>(".dropdown")
    if (!dropdown) return
    dropdown.toggleAttribute("data-scroll-top", dropdown.scrollTop > 1)
    dropdown.toggleAttribute("data-scroll-bottom", dropdown.scrollTop + dropdown.clientHeight < dropdown.scrollHeight - 1)
  }

  private select(current: HTMLAnchorElement) {
    for (const { link } of this.links) {
      if (link === current) link.setAttribute("aria-current", "true")
      else link.removeAttribute("aria-current")
    }
    const display = this.querySelector(".display-current")
    if (display) display.textContent = current.textContent
  }
}

if (!customElements.get("starlight-toc")) customElements.define("starlight-toc", WorktableTOC)
if (!customElements.get("mobile-starlight-toc")) {
  customElements.define("mobile-starlight-toc", class extends WorktableTOC {})
}
