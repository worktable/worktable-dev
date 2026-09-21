import { defaultProps } from "@blocknote/core"
import type { BlockConfig, BlockNoteEditor } from "@blocknote/core"
import { createReactBlockSpec } from "@blocknote/react"
import { lazy, Suspense } from "react"
import { Workflow } from "lucide-react"
import {
  MERMAID_BLOCK_TYPE,
  isMermaidLanguage,
  mermaidBlockPropSchema,
} from "@worktable/types"

// The schema is always available, including for diagrams arriving over Yjs.
// Diagram UI and CodeMirror load only when a diagram is actually rendered.
const MermaidBlockComponent = lazy(
  () => import("./worktable-mermaid-block-view")
)
const mermaidPropSchema = {
  ...defaultProps,
  ...mermaidBlockPropSchema,
} as const

export const WorktableMermaidBlock = createReactBlockSpec(
  {
    type: MERMAID_BLOCK_TYPE,
    propSchema: mermaidPropSchema,
    content: "none",
  },
  {
    render: (props) => (
      <Suspense
        fallback={
          <pre className="overflow-auto rounded-lg bg-muted p-3 text-sm">
            <code>{props.block.props.data}</code>
          </pre>
        }
      >
        <MermaidBlockComponent block={props.block} editor={props.editor} />
      </Suspense>
    ),
    toExternalHTML: ({ block }) => (
      <pre>
        <code className="language-mermaid">{block.props.data}</code>
      </pre>
    ),
    parse: (element) => {
      if (
        element.tagName !== "PRE" ||
        element.childElementCount !== 1 ||
        element.firstElementChild?.tagName !== "CODE"
      ) {
        return undefined
      }

      const code = element.firstElementChild!
      const language =
        code.getAttribute("data-language") ??
        code.className
          .split(" ")
          .find((name) => name.startsWith("language-"))
          ?.slice("language-".length)
      if (!isMermaidLanguage(language)) return undefined
      return { data: code.textContent ?? "" }
    },
    runsBefore: ["codeBlock"],
  },
  [
    {
      key: "worktable-mermaid-input-rule",
      runsBefore: ["codeBlock"],
      inputRules: [
        {
          find: /^```(?:mermaid|mmd)\s$/i,
          replace: () => ({
            type: MERMAID_BLOCK_TYPE,
            props: { data: "" },
          }),
        },
      ],
    },
  ]
)

export function insertWorktableMermaid() {
  return {
    title: "Mermaid",
    group: "Other",
    onItemClick: <BSchema extends Record<string, BlockConfig>>(
      editor: BlockNoteEditor<BSchema>
    ) => {
      const currentBlock = editor.getTextCursorPosition().block
      editor.insertBlocks([{ type: MERMAID_BLOCK_TYPE }], currentBlock, "after")
    },
    aliases: ["mermaid"],
    icon: <Workflow size={18} />,
    subtext: "Insert a Mermaid chart",
  }
}
