import type { TableCellProps } from "@blocknote/core"
import { serverSchema } from "./blocknote.ts"

// ============================================================
// Whether JSON is a rich-text Doc
// ============================================================
//
// A `.json` file is a rich-text Doc only when every element is a block the
// server's BlockNote schema knows, in the shape that type takes: its id, its
// props, its content and its children, all the way down. Anything else is a
// plain file, so the editor never imports data it would drop on save.
//
// Blocks may be partial, as agents and earlier versions wrote them: an id,
// props, content and children can each be left out, content can be a string,
// and styled text can leave out its type. A prop must be one the editor's
// schema gives that block type, or one an earlier Worktable wrote there: the
// editor drops any other on its next save, so a Doc holding one opens as
// unreadable instead, and a write that holds one is refused.

export type RichTextBlocksCheck =
  /** Every element is a block the editor holds as written. */
  | "blocks"
  /** Something here is not a block, so this is a plain file. */
  | "not-blocks"
  /** The blocks read so far are well formed, but the limit came first. */
  | "too-large"

export interface RichTextBlocksBudget {
  maxDepth: number
  maxElements: number
}

type ContentKind = "inline" | "plain" | "table" | "none"

const BLOCK_KEYS = new Set(["id", "type", "props", "content", "children"])
const STYLED_TEXT_KEYS = new Set(["type", "text", "styles"])
const LINK_KEYS = new Set(["type", "href", "content"])
const CUSTOM_INLINE_KEYS = new Set(["type", "props", "content"])
const TABLE_KEYS = new Set([
  "type",
  "columnWidths",
  "headerRows",
  "headerCols",
  "rows",
])
const TABLE_ROW_KEYS = new Set(["cells"])
const TABLE_CELL_KEYS = new Set(["type", "props", "content"])

/**
 * Props earlier Worktables wrote that today's schema no longer gives the type.
 * The code block's and table's are in Docs AgentDash's editor wrote, always
 * at their default values; the editor drops them on save, which changes
 * nothing the Doc shows. Mermaid's are the pre-Worktable block's source and
 * language, which `normalizeMermaidBlocks` turns into today's shape. Every
 * BlockNote release Worktable shipped (0.46.2, 0.51.0, 0.51.4, 0.54.2) gives
 * the other types the same props as today. Never remove an entry: a Doc
 * that holds it would stop opening.
 */
const EARLIER_BLOCK_PROPS: Readonly<Record<string, readonly string[]>> = {
  codeBlock: ["backgroundColor", "textColor", "textAlignment"],
  table: ["backgroundColor", "textAlignment"],
  mermaid: ["code", "language"],
}

/** A table cell's props, as BlockNote types them; the record keeps all. */
const TABLE_CELL_PROPS: ReadonlySet<string> = new Set(
  Object.keys({
    backgroundColor: true,
    textColor: true,
    textAlignment: true,
    colspan: true,
    rowspan: true,
  } satisfies Record<keyof TableCellProps, true>)
)

let schemaTables:
  | {
      blocks: ReadonlyMap<string, ContentKind>
      props: ReadonlyMap<string, ReadonlySet<string>>
      inline: ReadonlyMap<string, ReadonlySet<string>>
    }
  | undefined

type SchemaConfig = { content: ContentKind; propSchema?: Record<string, unknown> }

function schema(): NonNullable<typeof schemaTables> {
  if (schemaTables) return schemaTables
  const blockSchema = serverSchema.blockSchema as Record<string, SchemaConfig>
  const inlineSchema = serverSchema.inlineContentSchema as Record<
    string,
    "text" | "link" | { propSchema?: Record<string, unknown> }
  >
  schemaTables = {
    blocks: new Map(
      Object.entries(blockSchema).map(([type, config]) => [type, config.content])
    ),
    props: new Map(
      Object.entries(blockSchema).map(([type, config]) => [
        type,
        new Set([
          ...Object.keys(config.propSchema ?? {}),
          ...(EARLIER_BLOCK_PROPS[type] ?? []),
        ]),
      ])
    ),
    inline: new Map(
      Object.entries(inlineSchema).map(([type, config]) => [
        type,
        new Set(
          typeof config === "object" ? Object.keys(config.propSchema ?? {}) : []
        ),
      ])
    ),
  }
  return schemaTables
}

/** The first prop a record holds that `known` doesn't, if any. */
function unknownKey(
  props: Record<string, unknown>,
  known: ReadonlySet<string> | undefined
): string | undefined {
  for (const key in props) {
    if (props[key] !== undefined && !known?.has(key)) return key
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !ArrayBuffer.isView(value)
  )
}

/** Keys left undefined are absent, as they are once written as JSON. */
function onlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>) {
  for (const key in value) {
    if (value[key] !== undefined && !keys.has(key)) return false
  }
  return true
}

function primitiveRecord(value: unknown): boolean {
  if (!isRecord(value)) return false
  for (const entry of Object.values(value)) {
    if (entry !== null && typeof entry === "object") return false
  }
  return true
}

class NotBlocks extends Error {
  /** What a refused write is told, when the check knows more than "not blocks". */
  readonly problem: string | undefined
  constructor(problem?: string) {
    super(problem)
    this.problem = problem
  }
}
class TooLarge extends Error {}

/**
 * Check a parsed `.json` source against the block schema, within the same
 * structural budget its writes have. Shape problems are found in document
 * order, so a data file fails at its first element however large it is.
 */
export function checkRichTextBlocks(
  value: unknown,
  budget: RichTextBlocksBudget,
  signal?: AbortSignal
): RichTextBlocksCheck {
  return inspectRichTextBlocks(value, budget, signal).check
}

/**
 * Why a value isn't Doc blocks, for a refused write: a named unknown field,
 * or null when the check has nothing more specific than "not Doc blocks".
 */
export function richTextBlocksProblem(
  value: unknown,
  budget: RichTextBlocksBudget
): string | null {
  return inspectRichTextBlocks(value, budget).problem ?? null
}

function inspectRichTextBlocks(
  value: unknown,
  budget: RichTextBlocksBudget,
  signal?: AbortSignal
): { check: RichTextBlocksCheck; problem?: string } {
  if (!Array.isArray(value)) return { check: "not-blocks" }
  const { blocks, props: blockProps, inline } = schema()
  let elements = 0
  const count = (depth: number) => {
    elements += 1
    if (elements > budget.maxElements || depth > budget.maxDepth) {
      throw new TooLarge()
    }
  }
  const fail: (problem?: string) => never = (problem) => {
    throw new NotBlocks(problem)
  }
  const knownProps = (
    props: unknown,
    known: ReadonlySet<string> | undefined,
    on: string
  ) => {
    if (props === undefined) return
    if (!primitiveRecord(props)) fail()
    const field = unknownKey(props as Record<string, unknown>, known)
    if (field !== undefined) fail(`Unknown field \`${field}\` on ${on}`)
  }

  const styledText = (item: Record<string, unknown>) => {
    if (
      !onlyKeys(item, STYLED_TEXT_KEYS) ||
      typeof item["text"] !== "string" ||
      (item["styles"] !== undefined && !primitiveRecord(item["styles"]))
    ) {
      fail()
    }
  }
  const inlineContent = (content: unknown, depth: number, links: boolean) => {
    if (typeof content === "string") return
    if (!Array.isArray(content)) fail()
    for (const item of content as unknown[]) {
      count(depth)
      if (typeof item === "string") continue
      if (!isRecord(item)) fail()
      const entry = item as Record<string, unknown>
      const type = entry["type"]
      if (type === undefined || type === "text") {
        styledText(entry)
      } else if (type === "link" && links) {
        if (!onlyKeys(entry, LINK_KEYS) || typeof entry["href"] !== "string") {
          fail()
        }
        const linked = entry["content"]
        if (typeof linked === "string") continue
        if (!Array.isArray(linked)) fail()
        for (const text of linked as unknown[]) {
          count(depth + 1)
          if (!isRecord(text) || (text["type"] ?? "text") !== "text") fail()
          styledText(text as Record<string, unknown>)
        }
      } else if (
        typeof type === "string" &&
        type !== "link" &&
        inline.has(type)
      ) {
        if (!onlyKeys(entry, CUSTOM_INLINE_KEYS)) fail()
        knownProps(entry["props"], inline.get(type as string), type as string)
        if (entry["content"] !== undefined) {
          inlineContent(entry["content"], depth + 1, false)
        }
      } else {
        fail()
      }
    }
  }
  const tableContent = (content: unknown, depth: number) => {
    if (!isRecord(content)) fail()
    const table = content as Record<string, unknown>
    if (
      !onlyKeys(table, TABLE_KEYS) ||
      table["type"] !== "tableContent" ||
      !Array.isArray(table["rows"]) ||
      (table["headerRows"] !== undefined &&
        typeof table["headerRows"] !== "number") ||
      (table["headerCols"] !== undefined &&
        typeof table["headerCols"] !== "number") ||
      (table["columnWidths"] !== undefined &&
        (!Array.isArray(table["columnWidths"]) ||
          table["columnWidths"].some(
            (width) => width != null && typeof width !== "number"
          )))
    ) {
      fail()
    }
    for (const row of table["rows"] as unknown[]) {
      count(depth)
      if (!isRecord(row) || !onlyKeys(row, TABLE_ROW_KEYS)) fail()
      const cells = (row as Record<string, unknown>)["cells"]
      if (!Array.isArray(cells)) fail()
      for (const cell of cells as unknown[]) {
        count(depth + 1)
        if (isRecord(cell)) {
          if (!onlyKeys(cell, TABLE_CELL_KEYS) || cell["type"] !== "tableCell") {
            fail()
          }
          knownProps(cell["props"], TABLE_CELL_PROPS, "a table cell")
          if (cell["content"] !== undefined) {
            inlineContent(cell["content"], depth + 2, true)
          }
        } else {
          inlineContent(cell, depth + 2, true)
        }
      }
    }
  }

  const stack: Array<{ value: unknown; depth: number }> = []
  for (let index = value.length - 1; index >= 0; index -= 1) {
    stack.push({ value: value[index], depth: 1 })
  }
  try {
    while (stack.length > 0) {
      if (signal?.aborted) throw signal.reason
      const { value: candidate, depth } = stack.pop()!
      count(depth)
      if (!isRecord(candidate) || !onlyKeys(candidate, BLOCK_KEYS)) fail()
      const block = candidate as Record<string, unknown>
      const kind =
        typeof block["type"] === "string"
          ? blocks.get(block["type"])
          : undefined
      if (
        kind === undefined ||
        (block["id"] !== undefined && typeof block["id"] !== "string")
      ) {
        fail()
      }
      const type = block["type"] as string
      knownProps(block["props"], blockProps.get(type), type)
      const content = block["content"]
      if (content !== undefined) {
        if (kind === "inline") inlineContent(content, depth + 1, true)
        else if (kind === "plain") inlineContent(content, depth + 1, false)
        else if (kind === "table") tableContent(content, depth + 1)
        else if (!Array.isArray(content) || content.length > 0) {
          // Content-less blocks carry none, except the legacy Mermaid
          // shape that the editor's import turns into its source.
          if (block["type"] !== "mermaid") fail()
          inlineContent(content, depth + 1, false)
        }
      }
      const children = block["children"]
      if (children !== undefined) {
        if (!Array.isArray(children)) fail()
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push({ value: children[index], depth: depth + 1 })
        }
      }
    }
  } catch (error) {
    if (error instanceof NotBlocks) {
      return error.problem === undefined
        ? { check: "not-blocks" }
        : { check: "not-blocks", problem: error.problem }
    }
    if (error instanceof TooLarge) return { check: "too-large" }
    throw error
  }
  return { check: "blocks" }
}

/** The structural limits of a rich-text Doc's writes. */
export const RICH_TEXT_SOURCE_BUDGET: RichTextBlocksBudget = {
  maxDepth: 128,
  maxElements: 100_000,
}

/**
 * Whether a `.json` source's text can be opened as a rich-text Doc. Blocks
 * past the structural limit stay Docs, so a long Doc is never mistaken for
 * data; whatever reads them applies its own limits.
 */
export function richTextSourceIsDoc(text: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.startsWith("\uFEFF") ? text.slice(1) : text)
  } catch {
    return false
  }
  return checkRichTextBlocks(parsed, RICH_TEXT_SOURCE_BUDGET) !== "not-blocks"
}
