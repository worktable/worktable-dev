import { createElement, type ReactNode, type UIEvent } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { DocumentStatus } from "./components/document-status"
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {}
}
// A deliberately non-editable projection of a validated saved snapshot.
// Never insert these blocks into Yjs: IndexedDB and the server own live state.
function inline(value: unknown, depth = 0): ReactNode {
  if (value == null || depth > 32) return null
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value.map((item, index) =>
      createElement("span", { key: index }, inline(item, depth + 1))
    )
  const node = record(value)
  let text: ReactNode =
    typeof node.text === "string" ? node.text : inline(node.content, depth + 1)
  const styles = record(node.styles)
  if (styles.bold) text = createElement("strong", null, text)
  if (styles.italic) text = createElement("em", null, text)
  if (styles.code) text = createElement("code", null, text)
  if (styles.strike) text = createElement("s", null, text)
  if (styles.underline) text = createElement("u", null, text)
  return text
}
function blocks(
  value: unknown[],
  budget: { remaining: number; truncated: boolean },
  depth = 0
): ReactNode {
  if (depth > 32) return null
  let numberedIndex = 0
  const visible = value.slice(0, budget.remaining)
  if (visible.length < value.length) budget.truncated = true
  return visible.map((value, index) => {
    if (budget.remaining <= 0) {
      budget.truncated = true
      return null
    }
    budget.remaining -= 1
    const block = record(value)
    const props = record(block.props)
    numberedIndex =
      block.type === "numberedListItem"
        ? Number(props.start) || numberedIndex + 1
        : 0
    const content = inline(block.content)
    let body: ReactNode
    switch (block.type) {
      case "paragraph":
        body = createElement("p", null, content || createElement("br", null))
        break
      case "heading":
        body = createElement(
          `h${Math.max(1, Math.min(6, Number(props.level) || 1))}`,
          null,
          content
        )
        break
      case "bulletListItem":
        body = createElement("ul", null, createElement("li", null, content))
        break
      case "numberedListItem":
        body = createElement(
          "ol",
          { start: numberedIndex },
          createElement("li", null, content)
        )
        break
      case "checkListItem":
        body = createElement("p", null, props.checked ? "☑ " : "☐ ", content)
        break
      case "quote":
        body = createElement("blockquote", null, content)
        break
      case "codeBlock":
        body = createElement("pre", null, createElement("code", null, content))
        break
      case "table": {
        const rows = record(block.content).rows
        if (Array.isArray(rows) && rows.length > 40) budget.truncated = true
        body = Array.isArray(rows)
          ? createElement(
              "table",
              null,
              createElement(
                "tbody",
                null,
                rows.slice(0, 40).map((row, i) => {
                  const cells = record(row).cells
                  return createElement(
                    "tr",
                    { key: i },
                    Array.isArray(cells) &&
                      cells.map((cell, j) =>
                        createElement("td", { key: j }, inline(cell))
                      )
                  )
                })
              )
            )
          : null
        break
      }
      default:
        body = createElement(
          "p",
          { className: "text-muted-foreground" },
          typeof props.caption === "string" && props.caption
            ? props.caption
            : "Opening embedded content…"
        )
    }
    return createElement(
      "div",
      {
        key: typeof block.id === "string" ? block.id : index,
        "data-preview-block": true,
      },
      body,
      Array.isArray(block.children) &&
        block.children.length > 0 &&
        createElement(
          "div",
          { className: "pl-6" },
          blocks(block.children, budget, depth + 1)
        )
    )
  })
}
export function DocumentReadingPreview({
  content,
  onScroll,
  showStatus = true,
}: {
  content: unknown[] | string
  onScroll?: (top: number) => void
  showStatus?: boolean
}) {
  // Keep the opening preview bounded even for thousands of blocks. The full
  // editor still receives the complete document through collaboration.
  const budget = {
    remaining: 80,
    truncated: typeof content === "string" && content.length > 64 * 1024,
  }
  const preview = Array.isArray(content)
    ? blocks(content, budget)
    : createElement(Markdown, {
        remarkPlugins: [remarkGfm],
        skipHtml: true,
        disallowedElements: ["img"],
        children: content.slice(0, 64 * 1024),
      })
  return createElement(
    "div",
    {
      "data-document-preview": true,
      onScroll: (event: UIEvent<HTMLDivElement>) =>
        onScroll?.(event.currentTarget.scrollTop),
      className: "relative h-full overflow-auto bg-background",
    },
    createElement(
      "article",
      {
        className: `worktable-markdown worktable-document-content${Array.isArray(content) ? " worktable-rich-preview" : ""}`,
      },
      preview,
      budget.truncated &&
        createElement(
          "p",
          { className: "text-sm text-muted-foreground" },
          "More content is opening\u2026"
        )
    ),
    showStatus &&
      createElement(DocumentStatus, { state: "opening", announce: false })
  )
}
