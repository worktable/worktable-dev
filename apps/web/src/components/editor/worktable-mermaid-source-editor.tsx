import CodeMirror from "@uiw/react-codemirror"
import { mermaid as mermaidLanguage } from "codemirror-lang-mermaid"

// Loaded only when someone opens a diagram's source; reading never needs it.
const extensions = [mermaidLanguage()]

export default function MermaidSourceEditor({
  value,
  theme,
  onChange,
}: {
  value: string
  theme: "dark" | "light"
  onChange: (value: string) => void
}) {
  return (
    <CodeMirror
      placeholder="Write your mermaid code here…"
      style={{ width: "100%" }}
      extensions={extensions}
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        syntaxHighlighting: true,
      }}
      theme={theme}
      value={value}
      width="100%"
      height="200px"
      onChange={onChange}
    />
  )
}
