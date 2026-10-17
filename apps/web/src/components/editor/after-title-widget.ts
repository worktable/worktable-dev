import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

export const afterTitleKey = new PluginKey("worktable-after-title")

type PmDoc = EditorState["doc"]
type Decorations = NonNullable<
  NonNullable<ConstructorParameters<typeof Plugin>[0]["props"]>["decorations"]
>

/**
 * Where the widget sits: after the Doc's first block when that block is a
 * level-one heading (its title), otherwise before the first block.
 */
export function afterTitlePosition(doc: PmDoc): number {
  const group = doc.firstChild
  const first = group?.firstChild
  if (!group || !first) return 0
  const content = first.firstChild
  const opensWithTitle =
    content?.type.name === "heading" &&
    (Number(content.attrs.level) || 1) === 1 &&
    !content.attrs.isToggleable
  // Inside the block group: its first block starts one position in.
  return opensWithTitle ? 1 + first.nodeSize : 1
}

/**
 * Shows `host` under the title, outside the editable content: it is never
 * part of the document, takes no caret and keeps its own pointer events.
 */
export function afterTitlePlugin(host: HTMLElement): Plugin {
  const decorations = (state: EditorState) =>
    DecorationSet.create(
      state.doc as unknown as Parameters<typeof DecorationSet.create>[0],
      [
        Decoration.widget(afterTitlePosition(state.doc), () => host, {
          key: "after-title",
          side: -1,
          ignoreSelection: true,
          stopEvent: () => true,
        }),
      ]
    )
  return new Plugin({
    key: afterTitleKey,
    // prosemirror-state and prosemirror-view type the same document through
    // separate copies of prosemirror-model and prosemirror-transform.
    props: { decorations: decorations as unknown as Decorations },
  })
}
