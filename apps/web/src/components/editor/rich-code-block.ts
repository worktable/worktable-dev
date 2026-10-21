import { codeBlockOptions } from "@blocknote/code-block"
import { createCodeBlockSpec } from "@blocknote/core"
import { CHECK_ICON, COPY_ICON, WRAP_ICON } from "@worktable/ui/lib/code-icons"
import { copyText } from "@/lib/clipboard"
import {
  codeWrapEnabled,
  setCodeWrap,
  subscribeCodeWrap,
} from "@/lib/code-wrap"

type CodeBlockSpec = ReturnType<typeof createCodeBlockSpec>
type Render = CodeBlockSpec["implementation"]["render"]
type Languages = Record<string, { name: string; aliases?: string[] }>

const PLAIN_TEXT = "text"
const upstreamLanguages = (codeBlockOptions.supportedLanguages ??
  {}) as Languages

/**
 * The editor's languages: upstream's, without Mermaid (a block of its own),
 * with more names for plain text. An unlabeled fence stays unlabeled rather
 * than becoming JavaScript; the server's schema uses the same default.
 */
export const richCodeBlockOptions = {
  ...codeBlockOptions,
  defaultLanguage: "",
  supportedLanguages: Object.fromEntries(
    Object.entries(upstreamLanguages)
      .filter(([id]) => id !== "mermaid")
      .map(([id, language]) =>
        id === PLAIN_TEXT
          ? [
              id,
              {
                ...language,
                aliases: [...(language.aliases ?? []), "plaintext"],
              },
            ]
          : [id, language]
      )
  ) as Languages,
}

/**
 * The picker entry for a stored language: its id, or the id it is an alias
 * of. BlockNote's picker throws for any other value, `txt` included.
 */
function pickerLanguage(language: string): string | undefined {
  const languages = richCodeBlockOptions.supportedLanguages
  if (Object.hasOwn(languages, language)) return language
  const name = language.trim().toLowerCase()
  if (!name) return undefined
  return Object.entries(languages).find(
    ([id, { aliases }]) => id === name || aliases?.includes(name)
  )?.[0]
}

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
 *
 * Any stored language opens: an alias shows as its language, and one the
 * editor doesn't know shows by its own name, unhighlighted. The stored value
 * changes only when someone picks another, so Markdown keeps what was written.
 */
export function createRichCodeBlockSpec(): CodeBlockSpec {
  const spec = createCodeBlockSpec(richCodeBlockOptions)
  const render: Render = spec.implementation.render
  spec.implementation.render = function (this: unknown, block, editor) {
    const stored = String(block.props.language ?? "")
    const shown = pickerLanguage(stored)
    const view = render.call(
      this as never,
      shown === stored
        ? block
        : {
            ...block,
            props: { ...block.props, language: shown ?? PLAIN_TEXT },
          },
      editor
    )
    // The block's own markup keeps the stored language: copying and pasting
    // read it back from there.
    const wrapper = view.dom as HTMLElement
    if (stored === richCodeBlockOptions.defaultLanguage) {
      wrapper.removeAttribute?.("data-language")
    } else {
      wrapper.setAttribute?.("data-language", stored)
    }
    const select = wrapper.querySelector?.("select")
    if (select && shown === undefined && stored.trim()) {
      const option = document.createElement("option")
      option.value = stored
      option.text = stored
      select.prepend(option)
      select.value = stored
    }
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
