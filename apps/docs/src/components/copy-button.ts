import { writeClipboard } from "@worktable/public-analytics/clipboard"

let nextTooltipId = 0

class CopyButton extends HTMLElement {
  private timer?: ReturnType<typeof setTimeout>
  private request?: AbortController

  connectedCallback() {
    const button = this.querySelector("button")
    const tooltip = this.querySelector<HTMLElement>(".wt-copy-tooltip")
    const status = this.querySelector<HTMLElement>(".wt-copy-status")
    if (!button || !tooltip || !status || button.dataset.ready) return
    button.dataset.ready = "true"
    tooltip.id = `wt-copy-tooltip-${++nextTooltipId}`
    button.setAttribute("aria-describedby", tooltip.id)
    this.hidden = false

    const reset = () => {
      clearTimeout(this.timer)
      delete this.dataset.state
      tooltip.textContent = button.getAttribute("aria-label")
      status.textContent = ""
    }
    this.addEventListener("pointerenter", () => delete this.dataset.dismissed)
    this.addEventListener("focusin", () => delete this.dataset.dismissed)
    this.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.dataset.dismissed = "true"
    })
    button.addEventListener("click", async () => {
      reset()
      const hadFocus = document.activeElement === button
      let loaded = !this.dataset.copySource
      button.disabled = true
      button.setAttribute("aria-busy", "true")
      this.request = new AbortController()
      try {
        let text = this.dataset.copyText
        if (this.dataset.copySource) {
          const response = await fetch(this.dataset.copySource, { signal: this.request.signal })
          if (!response.ok) throw new Error("load")
          text = await response.text()
          loaded = true
        }
        if (text === undefined) throw new Error("load")
        const succeeded = await writeClipboard(text)
        if (!this.isConnected) return
        if (!succeeded) throw new Error("copy")
        this.dataset.state = "copied"
        tooltip.textContent = "Copied"
        status.textContent = "Copied"
        this.timer = setTimeout(reset, 1500)
        if (this.dataset.copyInstall) {
          const config = window.__WORKTABLE_PUBLIC_ANALYTICS_CONFIG__
          if (config) {
            void import("@worktable/public-analytics/browser").then((analytics) => {
              analytics.captureInstallCommandCopy(config, "cli_install", "docs_start")
            })
          }
        }
      } catch {
        if (!this.isConnected || this.request.signal.aborted) return
        this.dataset.state = "error"
        status.textContent = this.dataset.copySource
          ? !loaded
            ? "Could not load the skill. Try again or open Markdown."
            : "Could not copy. Try again or open Markdown."
          : "Could not copy. Select the text and copy it."
      } finally {
        button.disabled = false
        button.removeAttribute("aria-busy")
        if (hadFocus && this.isConnected && document.activeElement === document.body) {
          button.focus({ preventScroll: true })
        }
      }
    })
  }

  disconnectedCallback() {
    clearTimeout(this.timer)
    this.request?.abort()
  }
}

if (!customElements.get("worktable-copy")) customElements.define("worktable-copy", CopyButton)
