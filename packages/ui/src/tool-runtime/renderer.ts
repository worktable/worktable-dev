import { validateToolView, type ToolView, type ToolViewNode } from "./view.ts"

const UNITLESS = new Set(["opacity", "lineHeight", "flexGrow", "flexShrink"])
const SVG_NAMESPACE = "http://www.w3.org/2000/svg"
export interface ToolInteraction {
  action: string
  value: { value?: string; checked?: boolean }
}

/** Owns only a dedicated content root. Authored keys never become DOM IDs.
 * All event handlers and element references stay in this trusted closure. */
export function createToolRenderer(
  root: HTMLElement,
  interact: (interaction: ToolInteraction) => void
): { render: (input: unknown) => void; clear: () => void } {
  let elements = new Map<string, Element>()
  let closed = false
  root.addEventListener("submit", (event) => event.preventDefault())

  function render(input: unknown): void {
    if (closed) return
    // Validation completes before even constructing detached authored elements.
    const view = validateToolView(input)
    const nextElements = new Map<string, Element>()
    const focused = root.ownerDocument.activeElement
    const focusedKey = [...elements].find(
      ([, element]) => element === focused
    )?.[0]
    const selection =
      focused instanceof HTMLInputElement ||
      focused instanceof HTMLTextAreaElement
        ? {
            start: focused.selectionStart,
            end: focused.selectionEnd,
            direction: focused.selectionDirection,
          }
        : undefined

    function build(view: ToolView, namespace?: string): Node {
      if (typeof view !== "object")
        return root.ownerDocument.createTextNode(String(view))
      const ns = view.tag === "svg" ? SVG_NAMESPACE : namespace
      const element = ns
        ? root.ownerDocument.createElementNS(ns, view.tag)
        : root.ownerDocument.createElement(view.tag)
      if (view.key) nextElements.set(view.key, element)
      if (view.tag === "button") element.setAttribute("type", "button")
      for (const [key, value] of Object.entries(view.props ?? {})) {
        if (typeof value === "boolean") {
          if (value) element.setAttribute(key, "")
        } else element.setAttribute(key, String(value))
      }
      if (element instanceof HTMLElement || element instanceof SVGElement) {
        for (const [key, value] of Object.entries(view.style ?? {})) {
          element.style.setProperty(
            key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
            typeof value === "number" && !UNITLESS.has(key)
              ? `${value}px`
              : String(value)
          )
        }
      }
      for (const [type, action] of Object.entries(view.on ?? {})) {
        element.addEventListener(type, (event) => {
          event.preventDefault()
          event.stopPropagation()
          if (closed || !event.isTrusted) return
          const value: ToolInteraction["value"] = {}
          if (
            element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLTextAreaElement
          )
            value.value = element.value.slice(0, 16_384)
          if (
            element instanceof HTMLInputElement &&
            ["checkbox", "radio"].includes(element.type)
          )
            value.checked = element.checked
          interact({ action, value })
        })
      }
      for (const child of view.children ?? [])
        element.appendChild(build(child, ns))
      // Select and textarea values need their children in place first.
      if (
        typeof view.props?.value === "string" &&
        (element instanceof HTMLInputElement ||
          element instanceof HTMLSelectElement ||
          element instanceof HTMLTextAreaElement)
      )
        element.value = view.props.value
      return element
    }

    const next = build(view)
    root.replaceChildren(next)
    elements = nextElements
    if (focusedKey) {
      const replacement = elements.get(focusedKey)
      if (
        replacement instanceof HTMLElement &&
        sameControl(focused, replacement)
      ) {
        replacement.focus({ preventScroll: true })
        if (
          selection &&
          selection.start !== null &&
          selection.end !== null &&
          (replacement instanceof HTMLInputElement ||
            replacement instanceof HTMLTextAreaElement)
        ) {
          try {
            replacement.setSelectionRange(
              selection.start,
              selection.end,
              selection.direction ?? undefined
            )
          } catch {
            /* Number and date controls do not support text selections. */
          }
        }
      }
    }
  }
  return {
    render,
    clear: () => {
      closed = true
      elements.clear()
      root.replaceChildren()
    },
  }
}

function sameControl(old: Element | null, next: HTMLElement): boolean {
  return (
    old?.tagName === next.tagName &&
    (!(old instanceof HTMLInputElement) ||
      (next instanceof HTMLInputElement && old.type === next.type))
  )
}

// Keep the public shape discoverable for authoring without exporting DOM types.
export type { ToolViewNode }
