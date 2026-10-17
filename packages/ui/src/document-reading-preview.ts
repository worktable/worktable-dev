import {
  cloneElement,
  createElement as h,
  Fragment,
  type ComponentProps,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type UIEvent,
} from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { DocumentStatus } from "./components/document-status"
import { codeLanguageName } from "./lib/code-language"
import { NumberedList } from "./lib/numbered-list"
import { COPY_ICON, WRAP_ICON } from "./lib/code-icons"

type Props = Record<string, unknown>
type Budget = { remaining: number; truncated: boolean }

function record(value: unknown): Props {
  return value && typeof value === "object" ? (value as Props) : {}
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

// A deliberately non-editable projection of a validated saved snapshot.
// Never insert these blocks into Yjs: IndexedDB and the server own live state.
// It draws each block as the editor will, with the shared document styles
// (@worktable/ui/document-content.css), so nothing moves when it opens.

/** Colors and alignment, as data attributes the shared palette styles. */
function blockAttributes(props: Props): Record<string, string> {
  const attributes: Record<string, string> = {}
  const textColor = text(props.textColor)
  const backgroundColor = text(props.backgroundColor)
  const alignment = text(props.textAlignment)
  if (textColor && textColor !== "default")
    attributes["data-text-color"] = textColor
  if (backgroundColor && backgroundColor !== "default")
    attributes["data-background-color"] = backgroundColor
  if (alignment && alignment !== "left")
    attributes["data-text-alignment"] = alignment
  return attributes
}

function inline(value: unknown, depth = 0): ReactNode {
  if (value == null || depth > 32) return null
  if (typeof value === "string") return value
  if (Array.isArray(value))
    return value.map((item, index) =>
      h("span", { key: index }, inline(item, depth + 1))
    )
  const node = record(value)
  if (node.type === "link") return h("a", null, inline(node.content, depth + 1))
  let content: ReactNode =
    typeof node.text === "string" ? node.text : inline(node.content, depth + 1)
  const styles = record(node.styles)
  if (styles.bold) content = h("strong", null, content)
  if (styles.italic) content = h("em", null, content)
  if (styles.code) content = h("code", null, content)
  if (styles.strike) content = h("s", null, content)
  if (styles.underline) content = h("u", null, content)
  const colors = blockAttributes({
    textColor: styles.textColor,
    backgroundColor: styles.backgroundColor,
  })
  if (Object.keys(colors).length > 0) content = h("span", colors, content)
  return content
}

/** Whether a toggle was left open on this device, as BlockNote records it. */
function toggleOpen(id: unknown): boolean {
  try {
    return (
      typeof id === "string" &&
      typeof localStorage !== "undefined" &&
      localStorage.getItem(`toggle-${id}`) === "true"
    )
  } catch {
    return false
  }
}

function scrollableTable(children: ReactNode): ReactNode {
  return h(
    "div",
    { className: "worktable-table-scroll" },
    h("table", null, children)
  )
}

/** The language and the editor's Wrap and Copy icons, inert until it opens. */
function codeHeader(language: string | undefined): ReactNode {
  const control = (icon: string, className: string) =>
    h("span", {
      className: `worktable-code-button ${className}`,
      "aria-hidden": true,
      dangerouslySetInnerHTML: { __html: icon },
    })
  return h(
    "div",
    { className: "worktable-code-header" },
    h(
      "span",
      { className: "worktable-code-language" },
      codeLanguageName(language)
    ),
    control(WRAP_ICON, "worktable-code-wrap"),
    control(COPY_ICON, "worktable-code-copy")
  )
}

function codeBlock(language: string | undefined, code: ReactNode): ReactNode {
  return h(
    "div",
    { className: "worktable-code" },
    codeHeader(language),
    h("pre", null, h("code", null, code))
  )
}

function table(block: Props): ReactNode {
  const content = record(block.content)
  const rows = Array.isArray(content.rows) ? content.rows : []
  const headerRows = Number(content.headerRows) || 0
  const headerCols = Number(content.headerCols) || 0
  // Laid out as the editor lays out tables (prosemirror-tables): fixed
  // columns, set widths on their columns, unset ones at least 120px, filling
  // the text column unless some width was set.
  const columns = Math.max(
    0,
    ...rows.map((row) => {
      const cells = record(row).cells
      return Array.isArray(cells) ? cells.length : 0
    })
  )
  const stored = Array.isArray(content.columnWidths) ? content.columnWidths : []
  const widths = Array.from({ length: columns }, (_, index) =>
    typeof stored[index] === "number" ? (stored[index] as number) : null
  )
  const sized = widths.some((width) => width !== null)
  const minWidth = widths.reduce<number>(
    (sum, width) => sum + (width ?? 120),
    0
  )
  return h(
    "div",
    { className: "worktable-table-scroll" },
    h(
      "table",
      {
        className: "worktable-fixed-table",
        style: { minWidth: `${minWidth}px`, width: sized ? "auto" : undefined },
      },
      h(
        "colgroup",
        null,
        widths.map((width, index) =>
          h("col", {
            key: index,
            style: width === null ? undefined : { width: `${width}px` },
          })
        )
      ),
      h(
        "tbody",
        null,
        rows.slice(0, 40).map((row, rowIndex) => {
          const cells = record(row).cells
          return h(
            "tr",
            { key: rowIndex },
            Array.isArray(cells) &&
              cells.map((cell, cellIndex) => {
                const cellContent = Array.isArray(cell)
                  ? cell
                  : record(cell).content
                return h(
                  rowIndex < headerRows || cellIndex < headerCols ? "th" : "td",
                  { key: cellIndex },
                  inline(cellContent)
                )
              })
          )
        })
      )
    )
  )
}

function media(block: Props, props: Props): ReactNode {
  const url = text(props.url)
  const caption = text(props.caption)
  const width =
    typeof props.previewWidth === "number" ? props.previewWidth : undefined
  const alignment = text(props.textAlignment)
  const place =
    alignment === "center"
      ? { marginInline: "auto" }
      : alignment === "right"
        ? { marginLeft: "auto" }
        : undefined
  if (!url) return h("div", { className: "worktable-preview-media-empty" })
  let body: ReactNode
  if (block.type === "image")
    body = h("img", { src: url, alt: caption ?? text(props.name) ?? "" })
  else if (block.type === "file")
    return h(
      "div",
      { className: "worktable-preview-file" },
      text(props.name) ?? url
    )
  else
    body = h("div", {
      className: `worktable-preview-media worktable-preview-${String(block.type)}`,
    })
  return h(
    "figure",
    {
      style: {
        width: width ? `${width}px` : undefined,
        maxWidth: "100%",
        ...place,
      },
    },
    body,
    caption && h("figcaption", null, caption)
  )
}

/** A diagram's name, unless it still has the placeholder title. */
function diagramName(props: Props): string | undefined {
  const title = text(props.title)
  return title && title !== "Untitled Diagram" ? title : undefined
}

const LISTS: Record<string, { tag: "ul" | "ol"; className?: string }> = {
  bulletListItem: { tag: "ul" },
  numberedListItem: { tag: "ol" },
  checkListItem: { tag: "ul", className: "contains-task-list" },
}

function children(block: Props, budget: Budget, depth: number): ReactNode[] {
  return Array.isArray(block.children) && block.children.length > 0
    ? blocks(block.children, budget, depth + 1)
    : []
}

function listItem(
  block: Props,
  budget: Budget,
  depth: number,
  number?: number
): ReactNode {
  const props = record(block.props)
  const nested = children(block, budget, depth)
  const key = typeof block.id === "string" ? block.id : undefined
  if (block.type === "checkListItem")
    return h(
      "li",
      { key, className: "task-list-item", ...blockAttributes(props) },
      h("input", {
        type: "checkbox",
        checked: Boolean(props.checked),
        disabled: true,
        readOnly: true,
      }),
      inline(block.content),
      nested
    )
  return h(
    "li",
    { key, "data-index": number, ...blockAttributes(props) },
    inline(block.content),
    nested
  )
}

function single(
  block: Props,
  budget: Budget,
  depth: number,
  key: string | number
): ReactNode {
  const props = record(block.props)
  const attributes = { key, ...blockAttributes(props) }
  const content = inline(block.content)
  const nested = children(block, budget, depth)
  const indented =
    nested.length > 0 &&
    h(
      "div",
      { key: `${key}-children`, className: "worktable-preview-children" },
      nested
    )
  switch (block.type) {
    case "paragraph": {
      const empty = !Array.isArray(block.content) || block.content.length === 0
      return [h("p", attributes, empty ? h("br") : content), indented]
    }
    case "heading": {
      const tag = `h${Math.max(1, Math.min(6, Number(props.level) || 1))}`
      if (props.isToggleable)
        return h(
          "details",
          { key, open: toggleOpen(block.id) },
          h("summary", null, h(tag, blockAttributes(props), content)),
          nested
        )
      return [h(tag, attributes, content), indented]
    }
    case "toggleListItem":
      return h(
        "details",
        { key, open: toggleOpen(block.id), ...blockAttributes(props) },
        h("summary", null, content),
        nested
      )
    case "quote":
      return [h("blockquote", attributes, content), indented]
    case "codeBlock":
      return [
        h("div", { key }, codeBlock(text(props.language), content)),
        indented,
      ]
    case "table":
      if (
        Array.isArray(record(block.content).rows) &&
        (record(block.content).rows as unknown[]).length > 40
      )
        budget.truncated = true
      return h("div", { key }, table(block))
    case "divider":
      return h("hr", { key })
    case "image":
    case "video":
    case "audio":
    case "file":
      return h("div", { key }, media(block, props))
    case "mermaid":
      if (props.collapsed === "true")
        return h(
          "div",
          { key, className: "worktable-diagram-collapsed" },
          h(
            "svg",
            { viewBox: "0 0 24 24", "aria-hidden": true },
            h("path", { d: "m9 18 6-6-6-6" })
          ),
          h(
            "span",
            { className: "worktable-diagram-name" },
            diagramName(props) ?? "Diagram"
          ),
          diagramName(props) &&
            h("span", { className: "worktable-diagram-kind" }, "Diagram")
        )
      return h(
        "div",
        { key, className: "worktable-diagram worktable-preview-diagram" },
        diagramName(props) &&
          h("span", { className: "worktable-caption" }, diagramName(props))
      )
    default:
      return h(
        "p",
        { key, className: "text-muted-foreground" },
        text(props.caption) ?? "Opening embedded content…"
      )
  }
}

function blocks(value: unknown[], budget: Budget, depth = 0): ReactNode[] {
  if (depth > 32) return []
  const output: ReactNode[] = []
  let index = 0
  while (index < value.length && budget.remaining > 0) {
    const block = record(value[index])
    const list = typeof block.type === "string" ? LISTS[block.type] : undefined
    if (list) {
      const first = record(block.props)
      const items: ReactNode[] = []
      // Numbered items carry their number, so the marker is one kerned string.
      let number = list.tag === "ol" ? Number(first.start) || 1 : undefined
      while (
        index < value.length &&
        budget.remaining > 0 &&
        record(value[index]).type === block.type
      ) {
        budget.remaining -= 1
        items.push(listItem(record(value[index]), budget, depth, number))
        if (number !== undefined) number += 1
        index += 1
      }
      output.push(
        h(
          list.tag,
          {
            key: `list-${index}`,
            className: list.className,
            start:
              list.tag === "ol" && Number(first.start) > 1
                ? Number(first.start)
                : undefined,
          },
          items
        )
      )
      continue
    }
    budget.remaining -= 1
    output.push(
      single(
        block,
        budget,
        depth,
        typeof block.id === "string" ? block.id : index
      )
    )
    index += 1
  }
  if (index < value.length) budget.truncated = true
  return depth === 0 ? output.map(markBlock) : output
}

/** Top-level blocks carry data-preview-block, which readiness checks find. */
function markBlock(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(markBlock)
  return isValidElement(node)
    ? cloneElement(node as ReactElement<Record<string, unknown>>, {
        "data-preview-block": true,
      })
    : node
}

/** Markdown code keeps the same header strip it has once the Doc opens. */
function markdownPre({ children }: { children?: ReactNode }): ReactNode {
  const child = Array.isArray(children) ? children[0] : children
  const className = isValidElement<{ className?: string }>(child)
    ? child.props.className
    : undefined
  const language = className?.match(/(?:^|\s)language-([\w+#.-]+)/)?.[1]
  return h(
    "div",
    { className: "worktable-code" },
    codeHeader(language),
    h("pre", null, children)
  )
}

/**
 * Whether a Doc opens with a level-one heading, its title. Content that opens
 * with anything else shows what goes under the title above everything else.
 */
export function documentOpensWithTitle(content: unknown[] | string): boolean {
  if (typeof content === "string") return markdownTitleLine(content) !== null
  const first = record(content[0])
  return (
    first.type === "heading" &&
    (Number(record(first.props).level) || 1) === 1 &&
    !record(first.props).isToggleable
  )
}

/** The 1-based source line of a Markdown Doc's opening level-one heading. */
export function markdownTitleLine(markdown: string): number | null {
  const lines = markdown.split("\n")
  const first = lines.findIndex((line) => line.trim() !== "")
  if (first === -1) return null
  return /^\uFEFF? {0,3}#[ \t]+\S/.test(lines[first]!) ||
    /^ {0,3}=+[ \t]*$/.test(lines[first + 1] ?? "")
    ? first + 1
    : null
}

export function DocumentReadingPreview({
  content,
  onScroll,
  showStatus = true,
  afterTitle,
}: {
  content: unknown[] | string
  onScroll?: (top: number) => void
  showStatus?: boolean
  /** Shown under the title (the opening level-one heading), as the open Doc shows it. */
  afterTitle?: ReactNode
}) {
  // Keep the opening preview bounded even for thousands of blocks. The full
  // editor still receives the complete document through collaboration.
  const budget = {
    remaining: 80,
    truncated: typeof content === "string" && content.length > 64 * 1024,
  }
  const titled = afterTitle != null && documentOpensWithTitle(content)
  let titleShown = false
  const preview = Array.isArray(content)
    ? titled
      ? (([title, ...rest]) => [
          title,
          h(Fragment, { key: "after-title" }, afterTitle),
          ...rest,
        ])(blocks(content, budget))
      : blocks(content, budget)
    : h(Markdown, {
        remarkPlugins: [remarkGfm],
        skipHtml: true,
        components: {
          ...(titled
            ? {
                h1: ({
                  node,
                  ...props
                }: ComponentProps<"h1"> & { node?: unknown }) => {
                  void node
                  if (titleShown) return h("h1", props)
                  titleShown = true
                  return h(Fragment, null, h("h1", props), afterTitle)
                },
              }
            : {}),
          table: ({ children }: { children?: ReactNode }) =>
            scrollableTable(children),
          pre: markdownPre,
          ol: ({
            node,
            ...props
          }: ComponentProps<"ol"> & { node?: unknown }) => {
            void node
            return h(NumberedList, props)
          },
        },
        children: content.slice(0, 64 * 1024),
      })
  return h(
    "div",
    {
      "data-document-preview": true,
      onScroll: (event: UIEvent<HTMLDivElement>) =>
        onScroll?.(event.currentTarget.scrollTop),
      className: "relative h-full overflow-auto bg-background",
    },
    h(
      "article",
      {
        className: `worktable-markdown worktable-document-content${Array.isArray(content) ? " worktable-rich-preview" : ""}`,
      },
      afterTitle != null && !titled ? afterTitle : null,
      preview,
      budget.truncated &&
        h(
          "p",
          { className: "text-sm text-muted-foreground" },
          "More content is opening…"
        )
    ),
    showStatus && h(DocumentStatus, { state: "opening", announce: false })
  )
}
