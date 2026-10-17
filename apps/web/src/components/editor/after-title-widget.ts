import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

export const afterTitleKey = new PluginKey("worktable-after-title")

type PmDoc = EditorState["doc"]
type Decorations = NonNullable<
  NonNullable<ConstructorParameters<typeof Plugin>[0]["props"]>["decorations"]
>

/** How the editor treats the Doc's title, its opening level-one heading. */
export interface TitleOptions {
  /** Grey text for an empty title, and for a Doc that has no title yet. */
  placeholder: string
  /** Turn the grey stand-in into a title; absent when the Doc is read-only. */
  onCreate?: () => void
}

/** The title's heading node, when the Doc's first block is one. */
function titleRange(doc: PmDoc): { from: number; to: number } | null {
  const first = doc.firstChild?.firstChild
  const content = first?.firstChild
  if (
    !first ||
    content?.type.name !== "heading" ||
    (Number(content.attrs.level) || 1) !== 1 ||
    content.attrs.isToggleable
  ) {
    return null
  }
  // The block group opens at 0 and its first block container at 1, so the
  // heading inside it starts at 2.
  return { from: 2, to: 2 + content.nodeSize }
}

/**
 * Where the byline sits: after the Doc's first block when that block is its
 * title, otherwise before the first block.
 */
export function afterTitlePosition(doc: PmDoc): number {
  const first = doc.firstChild?.firstChild
  if (!first) return 0
  return titleRange(doc) ? 1 + first.nodeSize : 1
}

/** A heading laid out like the editor's own, standing in for a missing title. */
function titleStandIn(options: TitleOptions): HTMLElement {
  const outer = document.createElement("div")
  outer.className = "bn-block-outer worktable-title-stand-in"
  outer.contentEditable = "false"
  const block = document.createElement("div")
  block.className = "bn-block"
  const content = document.createElement("div")
  content.className = "bn-block-content"
  content.dataset.contentType = "heading"
  const heading = document.createElement("h1")
  heading.className = "bn-inline-content"
  heading.textContent = options.placeholder
  content.append(heading)
  block.append(content)
  outer.append(block)
  const create = options.onCreate
  if (create) {
    outer.dataset.editable = ""
    outer.addEventListener("mousedown", (event) => {
      event.preventDefault()
      create()
    })
  }
  return outer
}

/**
 * The title and what goes under it. An empty title shows `placeholder`; a
 * Doc without one shows it as a grey stand-in that becomes the title when
 * clicked. `host` sits under the title, outside the editable content: it is
 * never part of the document, takes no caret and keeps its own pointer
 * events. Options are read on each update; dispatch any transaction to
 * show new ones.
 */
export function afterTitlePlugin(
  host: HTMLElement | null,
  title: { readonly current: TitleOptions | null }
): Plugin {
  const decorations = (state: EditorState) => {
    const options = title.current
    const range = titleRange(state.doc)
    const list: Decoration[] = []
    if (options && range) {
      list.push(
        Decoration.node(range.from, range.to, {
          "data-doc-title": "",
          "data-placeholder": options.placeholder,
        })
      )
    } else if (options && state.doc.firstChild?.firstChild) {
      list.push(
        Decoration.widget(1, () => titleStandIn(options), {
          key: `title-stand-in:${options.placeholder}:${options.onCreate ? 1 : 0}`,
          side: -2,
          ignoreSelection: true,
          stopEvent: () => true,
        })
      )
    }
    if (host) {
      list.push(
        Decoration.widget(afterTitlePosition(state.doc), () => host, {
          key: "after-title",
          side: -1,
          ignoreSelection: true,
          stopEvent: () => true,
        })
      )
    }
    return DecorationSet.create(
      state.doc as unknown as Parameters<typeof DecorationSet.create>[0],
      list
    )
  }
  return new Plugin({
    key: afterTitleKey,
    // prosemirror-state and prosemirror-view type the same document through
    // separate copies of prosemirror-model and prosemirror-transform.
    props: { decorations: decorations as unknown as Decorations },
  })
}
