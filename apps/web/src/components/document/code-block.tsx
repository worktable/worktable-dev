import { useRef, useState, type ReactNode } from "react"
import { Check, Copy, WrapText } from "lucide-react"
import { codeLanguageName } from "@worktable/ui/lib/code-language"
import { copyText } from "@/lib/clipboard"
import { setCodeWrap, useCodeWrap } from "@/lib/code-wrap"
import { DocIconButton } from "./doc-icon-button"

/** A framed code block with its language, a wrap toggle and copy. */
export function CodeBlock({
  language,
  children,
}: {
  language?: string
  children: ReactNode
}) {
  const wrap = useCodeWrap()
  const [copied, setCopied] = useState(false)
  const pre = useRef<HTMLPreElement>(null)
  return (
    <div className="worktable-code">
      <div className="worktable-code-header">
        <span className="worktable-code-language">
          {codeLanguageName(language)}
        </span>
        <DocIconButton
          label="Wrap lines"
          aria-pressed={wrap}
          onClick={() => setCodeWrap(!wrap)}
        >
          <WrapText />
        </DocIconButton>
        <DocIconButton
          label={copied ? "Copied" : "Copy"}
          onClick={() => {
            void copyText(pre.current?.textContent ?? "").then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? <Check /> : <Copy />}
        </DocIconButton>
      </div>
      <pre ref={pre}>{children}</pre>
    </div>
  )
}
