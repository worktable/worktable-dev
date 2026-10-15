import { createCodeBlockSpec } from "@blocknote/core"
import { copyText } from "@/lib/clipboard"
import {
  codeWrapEnabled,
  setCodeWrap,
  subscribeCodeWrap,
} from "@/lib/code-wrap"

type CodeBlockSpec = ReturnType<typeof createCodeBlockSpec>
type Render = CodeBlockSpec["implementation"]["render"]

const WRAP_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/></svg>'
const COPY_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>'
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'

function relabel(button: HTMLElement, label: string) {
  button.dataset.tooltip = label
  button.setAttribute("aria-label", label)
}

function iconButton(label: string, icon: string, className: string) {
  const button = document.createElement("button")
  button.type = "button"
  button.className = `worktable-code-button ${className}`
  button.setAttribute("aria-label", label)
  button.dataset.tooltip = label
  button.innerHTML = icon
  return button
}

/**
 * The editor's code block with the same header strip as Markdown code: the
 * language picker, a wrap toggle and copy. The controls are part of the
 * block's node view, so ProseMirror is told to ignore changes inside them.
 */
export function createRichCodeBlockSpec(
  options: Parameters<typeof createCodeBlockSpec>[0]
): CodeBlockSpec {
  const spec = createCodeBlockSpec(options)
  const render: Render = spec.implementation.render
  spec.implementation.render = function (this: unknown, block, editor) {
    const view = render.call(this as never, block, editor)
    const context = this as { renderType?: string }
    if (context.renderType !== "nodeView") return view

    const content = view.dom as HTMLElement
    const header = document.createElement("div")
    header.className = "worktable-code-header"
    header.contentEditable = "false"
    const picker = content.querySelector(":scope > div")
    if (picker) header.append(picker)
    else {
      const spacer = document.createElement("span")
      spacer.className = "worktable-code-language"
      header.append(spacer)
    }

    const wrap = iconButton("Wrap lines", WRAP_ICON, "worktable-code-wrap")
    const syncWrap = () =>
      wrap.setAttribute("aria-pressed", String(codeWrapEnabled()))
    syncWrap()
    wrap.addEventListener("mousedown", (event) => event.preventDefault())
    wrap.addEventListener("click", () => setCodeWrap(!codeWrapEnabled()))
    const unsubscribe = subscribeCodeWrap(syncWrap)

    const copy = iconButton("Copy", COPY_ICON, "worktable-code-copy")
    let reset = 0
    copy.addEventListener("mousedown", (event) => event.preventDefault())
    copy.addEventListener("click", () => {
      const settle = (copied: boolean) => {
        if (copied) copy.innerHTML = CHECK_ICON
        relabel(copy, copied ? "Copied" : "Couldn't copy")
        window.clearTimeout(reset)
        reset = window.setTimeout(() => {
          copy.innerHTML = COPY_ICON
          relabel(copy, "Copy")
        }, 1500)
      }
      void copyText(view.contentDOM?.textContent ?? "").then(
        () => settle(true),
        () => settle(false)
      )
    })

    header.append(wrap, copy)
    content.prepend(header)

    const destroy = view.destroy
    return Object.assign(view, {
      ignoreMutation: (mutation: { target: Node }) =>
        header.contains(mutation.target),
      destroy: () => {
        unsubscribe()
        window.clearTimeout(reset)
        destroy?.()
      },
    })
  }
  return spec
}
