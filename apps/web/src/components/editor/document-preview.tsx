import { createElement, type ReactNode } from "react"

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {}
}

// A deliberately non-editable projection of the just-validated REST snapshot.
// Never insert these blocks into Yjs: IndexedDB and the server own live state.
function inline(value: unknown, depth = 0): ReactNode {
  if (value == null || depth > 32) return null
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value.map((item, index) => (
      <span key={index}>{inline(item, depth + 1)}</span>
    ))
  const node = record(value)
  let text: ReactNode =
    typeof node.text === "string" ? node.text : inline(node.content, depth + 1)
  const styles = record(node.styles)
  if (styles.bold) text = <strong>{text}</strong>
  if (styles.italic) text = <em>{text}</em>
  if (styles.code) text = <code>{text}</code>
  if (styles.strike) text = <s>{text}</s>
  if (styles.underline) text = <u>{text}</u>
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
        body = <p>{content || <br />}</p>
        break
      case "heading":
        body = createElement(
          `h${Math.max(1, Math.min(6, Number(props.level) || 1))}`,
          null,
          content
        )
        break
      case "bulletListItem":
        body = (
          <ul>
            <li>{content}</li>
          </ul>
        )
        break
      case "numberedListItem":
        body = (
          <ol start={numberedIndex}>
            <li>{content}</li>
          </ol>
        )
        break
      case "checkListItem":
        body = (
          <p>
            {props.checked ? "☑ " : "☐ "}
            {content}
          </p>
        )
        break
      case "quote":
        body = <blockquote>{content}</blockquote>
        break
      case "codeBlock":
        body = (
          <pre>
            <code>{content}</code>
          </pre>
        )
        break
      case "table": {
        const rows = record(block.content).rows
        if (Array.isArray(rows) && rows.length > 40) budget.truncated = true
        body = Array.isArray(rows) ? (
          <table>
            <tbody>
              {rows.slice(0, 40).map((row, i) => {
                const cells = record(row).cells
                return (
                  <tr key={i}>
                    {Array.isArray(cells) &&
                      cells.map((cell, j) => <td key={j}>{inline(cell)}</td>)}
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : null
        break
      }
      default:
        body = (
          <p className="text-muted-foreground">
            {typeof props.caption === "string" && props.caption
              ? props.caption
              : "Opening embedded content…"}
          </p>
        )
    }
    return (
      <div key={typeof block.id === "string" ? block.id : index}>
        {body}
        {Array.isArray(block.children) && block.children.length > 0 && (
          <div className="pl-6">
            {blocks(block.children, budget, depth + 1)}
          </div>
        )}
      </div>
    )
  })
}

export function DocumentPreview({
  content,
  onScroll,
}: {
  content: unknown[] | string
  onScroll?: (top: number) => void
}) {
  // Keep the opening preview bounded even for thousands of blocks. The full
  // editor still receives the complete document through collaboration.
  const budget = { remaining: 80, truncated: false }
  const preview = Array.isArray(content) ? (
    blocks(content, budget)
  ) : (
    <p>{content}</p>
  )
  return (
    <div
      data-document-preview
      onScroll={(event) => onScroll?.(event.currentTarget.scrollTop)}
      className="h-full overflow-auto bg-background"
    >
      <article className="worktable-markdown mx-auto w-full max-w-3xl px-6 py-8 sm:px-8 md:px-12">
        <div role="status" className="mb-4 text-xs text-muted-foreground">
          Saved preview · Opening editor…
        </div>
        {preview}
        {budget.truncated && (
          <p className="text-sm text-muted-foreground">
            More content is opening…
          </p>
        )}
      </article>
    </div>
  )
}
