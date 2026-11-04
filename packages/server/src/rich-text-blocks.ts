import { serverSchema } from "./blocknote.ts"
import { FingerprintCache } from "./file-fingerprint.ts"

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
// and styled text can leave out its type. Unknown props are kept by writes,
// so any primitive prop is accepted; keys the editor has no place for are not.

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

let schemaTables:
  | {
      blocks: ReadonlyMap<string, ContentKind>
      inline: ReadonlySet<string>
    }
  | undefined

function schema(): NonNullable<typeof schemaTables> {
  schemaTables ??= {
    blocks: new Map(
      Object.entries(
        serverSchema.blockSchema as Record<string, { content: ContentKind }>
      ).map(([type, config]) => [type, config.content])
    ),
    inline: new Set(Object.keys(serverSchema.inlineContentSchema)),
  }
  return schemaTables
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

class NotBlocks extends Error {}
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
  if (!Array.isArray(value)) return "not-blocks"
  const { blocks, inline } = schema()
  let elements = 0
  const count = (depth: number) => {
    elements += 1
    if (elements > budget.maxElements || depth > budget.maxDepth) {
      throw new TooLarge()
    }
  }
  const fail: () => never = () => {
    throw new NotBlocks()
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
        if (
          !onlyKeys(entry, CUSTOM_INLINE_KEYS) ||
          (entry["props"] !== undefined && !primitiveRecord(entry["props"]))
        ) {
          fail()
        }
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
          if (
            !onlyKeys(cell, TABLE_CELL_KEYS) ||
            cell["type"] !== "tableCell" ||
            (cell["props"] !== undefined && !primitiveRecord(cell["props"]))
          ) {
            fail()
          }
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
        (block["id"] !== undefined && typeof block["id"] !== "string") ||
        (block["props"] !== undefined && !primitiveRecord(block["props"]))
      ) {
        fail()
      }
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
    if (error instanceof NotBlocks) return "not-blocks"
    if (error instanceof TooLarge) return "too-large"
    throw error
  }
  return "blocks"
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

/**
 * Whether each `.json` holds Doc blocks, by file path and fingerprint. The
 * catalog fills it from the read that gives a Doc its title, so the Doc
 * store's own lookups rarely read anything.
 */
const richTextFiles = new FingerprintCache<boolean>(50_000)

export function rememberRichTextFile(
  file: string,
  fingerprintKey: string,
  doc: boolean
): void {
  richTextFiles.set(file, fingerprintKey, doc)
}

/**
 * Whether a `.json` file holds Doc blocks, read only when its fingerprint
 * is new. Without a key (changed too recently to identify) it is read, and
 * the answer is not kept.
 */
export function richTextFileIsDoc(
  file: string,
  fingerprintKey: string | undefined,
  read: () => string
): boolean {
  const cached =
    fingerprintKey !== undefined
      ? richTextFiles.get(file, fingerprintKey)
      : undefined
  if (cached !== undefined) return cached
  let doc: boolean
  try {
    doc = richTextSourceIsDoc(read())
  } catch {
    // An unreadable file stays what its name says; its reader reports why.
    doc = true
  }
  if (fingerprintKey !== undefined) richTextFiles.set(file, fingerprintKey, doc)
  return doc
}
