import { SearchResults, type SearchMatch, type SearchPage } from "../lib/search-results"

interface Pagefind {
  destroy(): Promise<void>
  search(query: string): Promise<{ results: SearchMatch[] }>
}

function resultRow(page: SearchPage, icon: HTMLTemplateElement) {
  const row = document.createElement("li")
  row.className = "pagefind-ui__result"
  const link = (url: string, title: string, excerpt?: string) => {
    const anchor = document.createElement("a")
    anchor.className = "pagefind-ui__result-link"
    anchor.href = url
    const label = document.createElement("span")
    label.className = "pagefind-ui__result-title"
    label.textContent = title
    anchor.append(label)
    if (excerpt) {
      const description = document.createElement("span")
      description.className = "pagefind-ui__result-excerpt"
      // Pagefind escapes indexed text before adding its <mark> highlights.
      description.innerHTML = excerpt
      anchor.append(description)
    }
    return anchor
  }
  const url = page.meta.url || page.url
  const sections = page.sub_results ?? []
  const heading = link(url, page.meta.title || "Untitled", sections[0]?.url === url ? page.excerpt : undefined)
  heading.prepend(icon.content.cloneNode(true))
  row.append(heading)
  const nested = sections.filter((section) => section.url !== url)
  const best = new Set([...nested].sort((a, b) => b.locations.length - a.locations.length).slice(0, 3))
  for (const section of nested.filter((section) => best.has(section))) {
    const anchor = link(section.url, section.title, section.excerpt)
    anchor.classList.add("pagefind-ui__result-nested")
    row.append(anchor)
  }
  return row
}

export function setupSearch(root: HTMLElement) {
  const dialog = root.querySelector("dialog")!
  const frame = root.querySelector<HTMLElement>(".dialog-frame")!
  const open = root.querySelector<HTMLButtonElement>("[data-open-modal]")!
  const close = root.querySelector<HTMLButtonElement>("[data-close-modal]")!
  const input = root.querySelector<HTMLInputElement>("input")
  const apple = /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform)
  if (apple) {
    root.querySelector("[data-shortcut-key]")!.textContent = "⌘"
    open.setAttribute("aria-keyshortcuts", "Meta+K")
  }
  const openModal = () => {
    dialog.showModal()
    document.body.setAttribute("data-search-modal-open", "")
    input?.focus()
  }
  open.disabled = false
  open.addEventListener("click", openModal)
  close.addEventListener("click", () => dialog.close())
  dialog.addEventListener("close", () => document.body.removeAttribute("data-search-modal-open"))
  dialog.addEventListener("click", (event) => {
    if (event.target instanceof Element && (event.target.closest("a") || !frame.contains(event.target))) dialog.close()
  })
  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault()
      dialog.open ? dialog.close() : openModal()
    }
  })
  let dismissingWithEscape = false
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dialog.open) {
      dismissingWithEscape = true
      event.stopPropagation()
    }
  })
  root.addEventListener("keyup", (event) => {
    if (event.key === "Escape" && dismissingWithEscape) {
      dismissingWithEscape = false
      event.stopPropagation()
    }
  })
  if (!input) return

  const icon = root.querySelector<HTMLTemplateElement>("[data-search-page-icon]")!
  const form = root.querySelector("form")!
  const clear = root.querySelector<HTMLButtonElement>(".pagefind-ui__search-clear")!
  const drawer = root.querySelector<HTMLElement>(".pagefind-ui__drawer")!
  const message = root.querySelector<HTMLElement>(".pagefind-ui__message")!
  const list = root.querySelector<HTMLOListElement>(".pagefind-ui__results")!
  const more = root.querySelector<HTMLButtonElement>("[data-search-more]")!
  const retry = root.querySelector<HTMLButtonElement>("[data-search-retry]")!
  let pagefind: Promise<Pagefind> | undefined
  let importAttempt = 0
  const loadPagefind = (reset: boolean) => {
    if (reset && pagefind) {
      // Pagefind caches rejected fragment promises. Recreate its index after
      // a failed request, and make subsequent searches wait for that reset.
      pagefind = pagefind.then(async (api) => {
        await api.destroy()
        return api
      }).catch((error) => {
        pagefind = undefined
        throw error
      })
    }
    // Browsers cache failed module imports. A retry needs a fresh module URL;
    // resetting the promise alone would leave search broken until a reload.
    const suffix = importAttempt ? `?retry=${importAttempt}` : ""
    const url = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/pagefind/pagefind.js${suffix}`
    pagefind ??= import(/* @vite-ignore */ url).catch((error) => {
      pagefind = undefined
      importAttempt++
      throw error
    })
    return pagefind
  }
  const fade = () => {
    drawer.toggleAttribute("data-scroll-top", drawer.scrollTop > 4)
    drawer.toggleAttribute("data-scroll-bottom", drawer.scrollTop + drawer.clientHeight < drawer.scrollHeight - 4)
  }
  drawer.addEventListener("scroll", fade, { passive: true })
  new ResizeObserver(fade).observe(drawer)
  let resetIndex = false
  const results = new SearchResults(async (query) => {
    const api = loadPagefind(resetIndex)
    resetIndex = false
    return (await api).search(query)
  }, {
    pending() {
      list.setAttribute("aria-busy", "true")
      more.disabled = true
      retry.hidden = true
      // Keep the previous count, links, and excerpts untouched during refresh.
      if (drawer.hidden) {
        drawer.hidden = false
        message.textContent = "Searching…"
      }
    },
    clear() {
      list.removeAttribute("aria-busy")
      list.replaceChildren()
      message.textContent = ""
      drawer.hidden = true
      more.hidden = true
      retry.hidden = true
    },
    commit(pages, total, append) {
      const rows = pages.map((page) => resultRow(page, icon))
      append ? list.append(...rows) : list.replaceChildren(...rows)
      message.textContent = total ? `${total} ${total === 1 ? "result" : "results"}` : "No results. Try a different search."
      list.removeAttribute("aria-busy")
      more.disabled = false
      more.hidden = list.children.length >= total
      if (append) rows[0]?.querySelector("a")?.focus({ preventScroll: true })
      else drawer.scrollTop = 0
      fade()
    },
    error() {
      resetIndex = true
      list.removeAttribute("aria-busy")
      message.textContent = "Couldn’t load results. Try again."
      more.hidden = true
      retry.hidden = false
      fade()
    },
  })
  const update = (debounce = 180) => {
    clear.hidden = !input.value
    void results.update(input.value, debounce)
  }
  input.addEventListener("input", () => update())
  form.addEventListener("submit", (event) => {
    event.preventDefault()
    update(0)
  })
  clear.addEventListener("click", () => {
    input.value = ""
    update(0)
    input.focus()
  })
  more.addEventListener("click", () => {
    void results.more()
  })
  retry.addEventListener("click", () => {
    input.focus()
    update(0)
  })
}
