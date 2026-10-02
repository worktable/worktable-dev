// @ts-check
// Draws marked Mermaid source on a public share page. The page CSP admits this
// file and the pinned Mermaid bundle by exact URL; author content never runs.
// Unrendered or invalid diagrams keep their readable source.
;(() => {
  const mermaid = /** @type {any} */ (window).mermaid
  if (!mermaid) return
  // Only this renderer draws diagrams; Mermaid never scans the page itself.
  mermaid.startOnLoad = false
  // Only the generated script element: author content can carry an SVG with
  // the same id, but never a script.
  const configElement = document.querySelector(
    'script[type="application/json"]#worktable-diagram-config'
  )
  if (!configElement) return

  /** @type {{ light: object; dark: object }} */
  const configs = JSON.parse(configElement.textContent || "{}")
  const diagrams = Array.from(
    document.querySelectorAll('pre[data-worktable-diagram="mermaid"]'),
    (element) => ({ element, source: element.textContent || "" })
  )
  const darkMode = window.matchMedia("(prefers-color-scheme: dark)")
  // Unpredictable render ids: Mermaid removes and styles elements by id, and
  // author content can carry ids.
  const idPrefix = `worktable-diagram-${crypto.getRandomValues(new Uint32Array(2)).join("")}`
  let generation = 0
  let queue = Promise.resolve()

  /**
   * Diagram links bypass the share link policy, so drop their targets; the
   * element stays because Mermaid positions linked nodes on it. Only Mermaid's
   * own scoped stylesheet may style the page.
   */
  function neutralize(/** @type {Element} */ root) {
    for (const link of Array.from(root.querySelectorAll("a"))) {
      for (const attribute of Array.from(link.attributes)) {
        if (["href", "target", "rel"].includes(attribute.localName)) {
          link.removeAttributeNode(attribute)
        }
      }
    }
    for (const style of Array.from(root.querySelectorAll("style"))) {
      if (style.parentElement !== root.firstElementChild) style.remove()
    }
  }

  /** Mermaid configuration is global, so theme changes render one pass at a time. */
  async function renderAll(/** @type {number} */ current) {
    mermaid.initialize(darkMode.matches ? configs.dark : configs.light)
    await document.fonts.ready
    for (const [index, diagram] of diagrams.entries()) {
      if (current !== generation) return
      try {
        if (!(await mermaid.parse(diagram.source, { suppressErrors: true })))
          continue
        const { svg } = await mermaid.render(
          `${idPrefix}-${current}-${index}`,
          diagram.source
        )
        if (current !== generation) return
        const figure = document.createElement("figure")
        figure.className = "shared-diagram"
        figure.innerHTML = svg
        neutralize(figure)
        diagram.element.replaceWith(figure)
        diagram.element = figure
      } catch {
        // Keep whatever is already shown: the source or the previous drawing.
      }
    }
  }

  function schedule() {
    const current = ++generation
    // A failed pass must not stop later theme changes from rendering.
    queue = queue.then(() => renderAll(current)).catch(() => undefined)
  }

  darkMode.addEventListener("change", schedule)
  schedule()
})()
