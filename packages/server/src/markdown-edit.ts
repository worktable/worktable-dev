/**
 * Exact-text editing of Worktable Docs.
 *
 * Agents read a Doc as Markdown and change it by exact string replacement.
 * For Markdown files that is plain string replacement on the stored text. For
 * BlockNote documents the Markdown is a projection, so this module:
 *
 * 1. projects the blocks into "units" — one top-level block, or a run of
 *    adjacent list items that Markdown writes as one list — joined by a blank
 *    line (`projectBlocks`). `docs.read` returns exactly this text;
 * 2. applies the edits to that text, remembering which original spans changed
 *    (`applyTextEdits`);
 * 3. re-parses only the units an edit touched, and inside them keeps every
 *    block whose own Markdown is unchanged verbatim. A changed block keeps its
 *    id, the properties Markdown cannot express (colors, alignment, toggles,
 *    diagram titles, image widths, table column widths) and the inline styles
 *    of characters the edit did not touch (`spliceBlocks`).
 *
 * Blocks whose Markdown cannot be parsed back into the same shape (a toggle
 * heading with children, files, media, unknown types) are kept when untouched
 * and refused with `unsupported_block` when an edit would change them.
 *
 * The result also lists, per top-level region, which blocks were replaced by
 * which. A live collaborative session can use those regions to apply the same
 * change surgically instead of replacing the whole document.
 */

import { serverSchema } from "./blocknote.ts"
import {
  blocksToMarkdownSafe,
  cellInlines,
  isMarkdownSafe,
  markdownToBlocks,
} from "./markdown.ts"

type Block = Record<string, any>

// ── Errors ──────────────────────────────────────────────────

export type DocEditErrorCode =
  | "no_match"
  | "ambiguous"
  | "empty_old_text"
  | "no_change"
  | "revision_conflict"
  | "revision_required"
  | "unsupported_block"
  | "formatting_dropped"

/** A refused edit or write. Nothing was written. `code` is stable. */
export class DocEditError extends Error {
  readonly code: DocEditErrorCode
  readonly details: Record<string, unknown>

  constructor(
    code: DocEditErrorCode,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = "DocEditError"
    this.code = code
    this.details = details
  }
}

export interface TextEdit {
  oldText: string
  newText: string
  replaceAll?: boolean
}

// ── Exact text edits ────────────────────────────────────────

/**
 * A span of the edited text. `edited` pieces carry the original span they
 * replaced, so the change can be traced back to the units it touched.
 */
interface Piece {
  text: string
  /** Start of the original span this piece covers or replaced. */
  os: number
  /** End (exclusive) of the original span. */
  oe: number
  edited: boolean
}

export interface TextEditResult {
  text: string
  /** Original spans that changed. Never empty spans. */
  originalRanges: Array<{ start: number; end: number }>
  /** Where the replacement text sits in the edited text. */
  editedRanges: Array<{ start: number; end: number }>
  /** Edited-text offset of an original offset just after a kept character. */
  mapAfter(original: number): number
  /** Edited-text offset of an original offset just before a kept character. */
  mapBefore(original: number): number
}

function lineAt(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text.charCodeAt(index) === 10) line++
  }
  return line
}

function bigrams(value: string): Map<string, number> {
  const grams = new Map<string, number>()
  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim()
  for (let index = 0; index < normalized.length - 1; index++) {
    const gram = normalized.slice(index, index + 2)
    grams.set(gram, (grams.get(gram) ?? 0) + 1)
  }
  return grams
}

function similarity(left: Map<string, number>, right: string): number {
  const other = bigrams(right)
  let overlap = 0
  let total = 0
  for (const count of left.values()) total += count
  for (const [gram, count] of other) {
    total += count
    overlap += Math.min(count, left.get(gram) ?? 0)
  }
  return total === 0 ? 0 : (2 * overlap) / total
}

function closestLines(
  text: string,
  oldText: string
): Array<{ line: number; text: string }> {
  const needle =
    oldText
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? oldText
  const grams = bigrams(needle)
  return text
    .split("\n")
    .map((line, index) => ({
      line: index + 1,
      text: line.length > 200 ? `${line.slice(0, 200)}…` : line,
      score: line.trim() ? similarity(grams, line) : 0,
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.line - b.line)
    .slice(0, 3)
    .map(({ line, text }) => ({ line, text }))
}

function findAll(text: string, needle: string): number[] {
  const matches: number[] = []
  let from = 0
  while (from <= text.length) {
    const index = text.indexOf(needle, from)
    if (index === -1) break
    matches.push(index)
    from = index + needle.length
  }
  return matches
}

function splitPiece(piece: Piece, at: number): [Piece, Piece] {
  const left = piece.text.slice(0, at)
  const right = piece.text.slice(at)
  if (piece.edited) {
    return [
      { ...piece, text: left },
      { ...piece, text: right },
    ]
  }
  return [
    { text: left, os: piece.os, oe: piece.os + at, edited: false },
    { text: right, os: piece.os + at, oe: piece.oe, edited: false },
  ]
}

function replaceRange(
  pieces: Piece[],
  start: number,
  end: number,
  text: string
): Piece[] {
  const before: Piece[] = []
  const covered: Piece[] = []
  const after: Piece[] = []
  let cursor = 0
  for (const piece of pieces) {
    const pieceStart = cursor
    const pieceEnd = cursor + piece.text.length
    cursor = pieceEnd
    if (pieceEnd <= start && !(piece.text.length === 0 && pieceStart === start && piece.edited)) {
      before.push(piece)
      continue
    }
    if (pieceStart >= end && !(piece.text.length === 0 && pieceStart === end && start === end)) {
      after.push(piece)
      continue
    }
    let middle = piece
    let middleStart = pieceStart
    if (start > middleStart) {
      const [left, right] = splitPiece(middle, start - middleStart)
      before.push(left)
      middle = right
      middleStart = start
    }
    const middleEnd = middleStart + middle.text.length
    if (end < middleEnd) {
      const [left, right] = splitPiece(middle, end - middleStart)
      covered.push(left)
      after.push(right)
    } else {
      covered.push(middle)
    }
  }
  const os = Math.min(...covered.map((piece) => piece.os))
  const oe = Math.max(...covered.map((piece) => piece.oe))
  return [
    ...before.filter((piece) => piece.edited || piece.text.length > 0),
    { text, os, oe, edited: true },
    ...after.filter((piece) => piece.edited || piece.text.length > 0),
  ]
}

/**
 * Apply exact replacements in order. Each `oldText` must match the current
 * text (including earlier edits' output) exactly once unless `replaceAll`.
 * Throws a DocEditError; the caller writes nothing.
 */
export function applyTextEdits(
  original: string,
  edits: readonly TextEdit[]
): TextEditResult {
  let pieces: Piece[] = [
    { text: original, os: 0, oe: original.length, edited: false },
  ]
  edits.forEach((edit, index) => {
    const label = `Edit ${index + 1}`
    if (typeof edit.oldText !== "string" || edit.oldText.length === 0) {
      throw new DocEditError(
        "empty_old_text",
        `${label}: oldText is empty. Copy the exact text to replace from the document.`,
        { editIndex: index }
      )
    }
    const current = pieces.map((piece) => piece.text).join("")
    const matches = findAll(current, edit.oldText)
    if (matches.length === 0) {
      const closest = closestLines(current, edit.oldText)
      const hint = closest.length
        ? ` Closest lines: ${closest
            .map((candidate) => `${candidate.line}: ${JSON.stringify(candidate.text)}`)
            .join("; ")}.`
        : ""
      throw new DocEditError(
        "no_match",
        `${label}: oldText was not found${index > 0 ? " after the earlier edits" : ""}.${hint} Read the document again and copy the text exactly.`,
        { editIndex: index, closest }
      )
    }
    if (matches.length > 1 && !edit.replaceAll) {
      const lines = matches.map((match) => lineAt(current, match))
      throw new DocEditError(
        "ambiguous",
        `${label}: oldText matches ${matches.length} times (lines ${lines.join(", ")}). Include more surrounding text so it matches once, or set replaceAll.`,
        { editIndex: index, matchCount: matches.length, lines }
      )
    }
    for (const match of [...matches].reverse()) {
      pieces = replaceRange(
        pieces,
        match,
        match + edit.oldText.length,
        edit.newText
      )
    }
  })

  const text = pieces.map((piece) => piece.text).join("")
  const originalRanges: Array<{ start: number; end: number }> = []
  const editedRanges: Array<{ start: number; end: number }> = []
  const kept: Array<{ os: number; oe: number; fs: number }> = []
  let cursor = 0
  for (const piece of pieces) {
    if (piece.edited) {
      originalRanges.push({ start: piece.os, end: piece.oe })
      editedRanges.push({ start: cursor, end: cursor + piece.text.length })
    } else {
      kept.push({ os: piece.os, oe: piece.oe, fs: cursor })
    }
    cursor += piece.text.length
  }
  const mapAfter = (offset: number): number => {
    if (offset === 0) return 0
    const piece = kept.find((span) => span.os < offset && offset <= span.oe)
    if (!piece) throw new Error(`offset ${offset} does not follow kept text`)
    return piece.fs + (offset - piece.os)
  }
  const mapBefore = (offset: number): number => {
    if (offset === original.length) return text.length
    const piece = kept.find((span) => span.os <= offset && offset < span.oe)
    if (!piece) throw new Error(`offset ${offset} does not precede kept text`)
    return piece.fs + (offset - piece.os)
  }
  return { text, originalRanges, editedRanges, mapAfter, mapBefore }
}

// ── Projection ──────────────────────────────────────────────

const LIST_FAMILY: Record<string, string> = {
  bulletListItem: "bullet",
  checkListItem: "bullet",
  toggleListItem: "bullet",
  numberedListItem: "numbered",
}

export interface ProjectionUnit {
  blocks: Block[]
  /** Markdown of the unit without trailing newlines. */
  markdown: string
  /** False for units with no Markdown, such as empty paragraphs. */
  visible: boolean
  /** The unit could not be converted to Markdown at all. */
  opaque: boolean
  /** Offsets of a visible unit in the projection. */
  start: number
  end: number
}

export interface MarkdownProjection {
  markdown: string
  units: ProjectionUnit[]
}

const UNIT_SEPARATOR = "\n\n"
const MARKDOWN_CACHE_LIMIT = 20_000
const markdownCache = new Map<string, string | null>()

function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds)
  if (!value || typeof value !== "object") return value
  const { id: _id, ...rest } = value as Block
  if (Array.isArray(rest.children)) rest.children = rest.children.map(withoutIds)
  return rest
}

/** Markdown for a block list, cached by content (ids never affect Markdown). */
async function serialize(blocks: Block[]): Promise<string | null> {
  const key = JSON.stringify(withoutIds(blocks))
  if (markdownCache.has(key)) {
    const cached = markdownCache.get(key)!
    markdownCache.delete(key)
    markdownCache.set(key, cached)
    return cached
  }
  const markdown = await blocksToMarkdownSafe(blocks)
  markdownCache.set(key, markdown)
  if (markdownCache.size > MARKDOWN_CACHE_LIMIT) {
    markdownCache.delete(markdownCache.keys().next().value!)
  }
  return markdown
}

function trimTrailingNewlines(markdown: string): string {
  return markdown.replace(/\n+$/, "")
}

function groupUnits(blocks: Block[]): Block[][] {
  const groups: Block[][] = []
  for (const block of blocks) {
    const family = LIST_FAMILY[String(block?.type)]
    const last = groups.at(-1)
    const lastFamily = last ? LIST_FAMILY[String(last.at(-1)?.type)] : undefined
    if (family && last && lastFamily === family) last.push(block)
    else groups.push([block])
  }
  return groups
}

/**
 * The Markdown agents read and edit for a BlockNote document. Built the same
 * way for `read` and `edit`, so `oldText` copied from a read always matches.
 */
export async function projectBlocks(blocks: unknown[]): Promise<MarkdownProjection> {
  const units: ProjectionUnit[] = []
  const parts: string[] = []
  let offset = 0
  for (const group of groupUnits(blocks as Block[])) {
    const serialized = await serialize(group)
    const opaque = serialized === null
    const markdown = opaque
      ? `<!-- ${group.map((block) => String(block?.type ?? "unknown")).join(", ")} block cannot be shown as Markdown -->`
      : trimTrailingNewlines(serialized)
    const visible = opaque || markdown.trim().length > 0
    if (!visible) {
      units.push({ blocks: group, markdown: "", visible, opaque, start: offset, end: offset })
      continue
    }
    if (parts.length > 0) offset += UNIT_SEPARATOR.length
    units.push({
      blocks: group,
      markdown,
      visible,
      opaque,
      start: offset,
      end: offset + markdown.length,
    })
    parts.push(markdown)
    offset += markdown.length
  }
  return {
    markdown: parts.length > 0 ? `${parts.join(UNIT_SEPARATOR)}\n` : "",
    units,
  }
}

// ── Block splicing ──────────────────────────────────────────

export interface FormattingDrop {
  blockId: string
  fields: string[]
}

/** One contiguous run of top-level blocks that was re-parsed. */
export interface SpliceRegion {
  /** Ids of the top-level blocks this region replaced, in order. */
  replacedBlockIds: string[]
  /** The blocks now in their place (kept blocks keep their ids). */
  blocks: Block[]
}

export interface SpliceResult {
  blocks: Block[]
  /** Markdown that was parsed — the edited projection. */
  editedMarkdown: string
  regions: SpliceRegion[]
  changed: {
    kept: number
    modified: string[]
    inserted: number
    removed: number
  }
  removedIds: string[]
  formattingDropped: FormattingDrop[]
}

interface SpliceContext {
  mode: "edit" | "write"
  line: number
  kept: number
  modified: string[]
  inserted: number
  removedIds: string[]
  formattingDropped: FormattingDrop[]
}

function countNodes(blocks: Block[]): number {
  let count = 0
  for (const block of blocks) {
    count += 1
    if (Array.isArray(block?.children)) count += countNodes(block.children)
  }
  return count
}

function collectIds(blocks: Block[], into: string[]): void {
  for (const block of blocks) {
    if (typeof block?.id === "string") into.push(block.id)
    if (Array.isArray(block?.children)) collectIds(block.children, into)
  }
}

function stripIds(block: Block): Block {
  return withoutIds(block) as Block
}

function isEmptyParagraph(block: Block): boolean {
  return (
    block?.type === "paragraph" &&
    (!Array.isArray(block.content) || block.content.length === 0) &&
    (!Array.isArray(block.children) || block.children.length === 0)
  )
}

function contentKind(type: unknown): string | undefined {
  return (serverSchema as any).blockSchema[String(type)]?.content
}

function propSchemaOf(type: unknown): Record<string, unknown> | undefined {
  return (serverSchema as any).blockSchema[String(type)]?.propSchema
}

async function fullMarkdown(block: Block): Promise<string> {
  return trimTrailingNewlines((await serialize([block])) ?? `\u0000opaque:${block?.id}`)
}

async function ownMarkdown(block: Block): Promise<string> {
  return fullMarkdown({ ...block, children: [] })
}

interface RoundTrip {
  supported: boolean
  block?: Block
}

const roundTripCache = new WeakMap<Block, RoundTrip>()

function sameShape(stored: Block, parsed: Block): boolean {
  if (!propSchemaOf(stored?.type)) return false
  const typeOk =
    stored.type === parsed.type ||
    (contentKind(stored.type) === "inline" && contentKind(parsed.type) === "inline")
  if (!typeOk) return false
  const storedChildren: Block[] = Array.isArray(stored.children) ? stored.children : []
  const parsedChildren: Block[] = Array.isArray(parsed.children) ? parsed.children : []
  return (
    storedChildren.length === parsedChildren.length &&
    storedChildren.every((child, index) => sameShape(child, parsedChildren[index]!))
  )
}

/** How a stored block reads back from its own Markdown. */
async function roundTrip(block: Block): Promise<RoundTrip> {
  const cached = roundTripCache.get(block)
  if (cached) return cached
  let result: RoundTrip = { supported: false }
  const markdown = await serialize([block])
  if (markdown !== null) {
    const parsed = (await markdownToBlocks(markdown)) as Block[]
    if (parsed.length === 1 && sameShape(block, parsed[0]!)) {
      result = { supported: true, block: parsed[0] }
    }
  }
  roundTripCache.set(block, result)
  return result
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

// Inline content as characters, so styles Markdown cannot show can follow
// the characters an edit left alone.
interface InlineChar {
  ch: string
  styles: Record<string, unknown>
  href?: string
}

function flattenInline(content: unknown): InlineChar[] | null {
  if (!Array.isArray(content)) return null
  const chars: InlineChar[] = []
  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string") {
      for (const ch of item.text) chars.push({ ch, styles: item.styles ?? {} })
    } else if (item?.type === "link" && Array.isArray(item.content)) {
      for (const run of item.content) {
        if (typeof run?.text !== "string") return null
        for (const ch of run.text) {
          chars.push({ ch, styles: run.styles ?? {}, href: item.href })
        }
      }
    } else {
      return null
    }
  }
  return chars
}

function buildInline(chars: InlineChar[]): Block[] {
  const items: Block[] = []
  for (const char of chars) {
    const last = items.at(-1)
    const styleKey = JSON.stringify(char.styles)
    if (char.href !== undefined) {
      const link =
        last?.type === "link" && last.href === char.href ? last : undefined
      const target = link ?? { type: "link", href: char.href, content: [] as Block[] }
      if (!link) items.push(target)
      const run = target.content.at(-1)
      if (run && JSON.stringify(run.styles) === styleKey) run.text += char.ch
      else target.content.push({ type: "text", text: char.ch, styles: { ...char.styles } })
      continue
    }
    if (last?.type === "text" && JSON.stringify(last.styles) === styleKey) {
      last.text += char.ch
    } else {
      items.push({ type: "text", text: char.ch, styles: { ...char.styles } })
    }
  }
  return items
}

/**
 * Re-apply styles that were lost in Markdown (colors, underline) to the
 * characters before and after the edited part of the text.
 */
function carryInlineStyles(
  stored: unknown,
  parsedBack: unknown,
  next: unknown
): unknown {
  const storedChars = flattenInline(stored)
  const backChars = flattenInline(parsedBack)
  const nextChars = flattenInline(next)
  if (!storedChars || !backChars || !nextChars) return next
  if (storedChars.map((c) => c.ch).join("") !== backChars.map((c) => c.ch).join("")) {
    return next
  }
  const lost = storedChars.map((char, index) => {
    const lostStyles: Record<string, unknown> = {}
    for (const [style, value] of Object.entries(char.styles)) {
      if (!sameValue(backChars[index]!.styles[style], value)) lostStyles[style] = value
    }
    return lostStyles
  })
  if (lost.every((styles) => Object.keys(styles).length === 0)) return next

  const storedText = storedChars.map((c) => c.ch)
  const nextText = nextChars.map((c) => c.ch)
  let prefix = 0
  while (
    prefix < storedText.length &&
    prefix < nextText.length &&
    storedText[prefix] === nextText[prefix]
  ) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < storedText.length - prefix &&
    suffix < nextText.length - prefix &&
    storedText[storedText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) {
    suffix++
  }
  // New characters take the lost styles their untouched neighbours share, the
  // way typing inside a colored run stays colored.
  const neighbours = [
    prefix > 0 ? lost[prefix - 1]! : undefined,
    suffix > 0 ? lost[storedChars.length - suffix]! : undefined,
  ].filter((styles): styles is Record<string, unknown> => styles !== undefined)
  const inherited: Record<string, unknown> = {}
  if (neighbours.length > 0) {
    for (const [style, value] of Object.entries(neighbours[0]!)) {
      if (neighbours.every((styles) => sameValue(styles[style], value))) {
        inherited[style] = value
      }
    }
  }
  const merged = nextChars.map((char, index) => {
    let styles: Record<string, unknown> = inherited
    if (index < prefix) styles = lost[index]!
    else if (index >= nextChars.length - suffix) {
      styles = lost[storedChars.length - (nextChars.length - index)]!
    }
    return { ...char, styles: { ...char.styles, ...styles } }
  })
  return buildInline(merged)
}

function cellProps(cell: unknown): Record<string, unknown> {
  if (Array.isArray(cell) || !cell || typeof cell !== "object") return {}
  return ((cell as Block).props as Record<string, unknown>) ?? {}
}

function columnCount(table: Block | undefined): number {
  const rows = table?.content?.rows
  if (!Array.isArray(rows) || rows.length === 0) return 0
  return Array.isArray(rows[0]?.cells) ? rows[0].cells.length : 0
}

function carryTable(stored: Block, parsedBack: Block, next: Block): unknown {
  const content = structuredClone(next.content)
  if (!content || content.type !== "tableContent") return next.content
  const storedContent = stored.content
  const backContent = parsedBack.content
  if (columnCount(stored) === columnCount(next) && Array.isArray(storedContent?.columnWidths)) {
    content.columnWidths = [...storedContent.columnWidths]
  }
  const storedRows = storedContent?.rows ?? []
  const backRows = backContent?.rows ?? []
  if (
    storedRows.length === content.rows.length &&
    backRows.length === storedRows.length &&
    columnCount(stored) === columnCount(next)
  ) {
    content.rows.forEach((row: Block, rowIndex: number) => {
      row.cells = row.cells.map((cell: Block, cellIndex: number) => {
        const storedCell = storedRows[rowIndex]?.cells?.[cellIndex]
        const backCell = backRows[rowIndex]?.cells?.[cellIndex]
        if (!cell || typeof cell !== "object" || Array.isArray(cell)) return cell
        const props = { ...(cell.props ?? {}) }
        for (const [key, value] of Object.entries(cellProps(storedCell))) {
          if (
            !sameValue(cellProps(backCell)[key], value) &&
            sameValue(props[key], cellProps(backCell)[key])
          ) {
            props[key] = value
          }
        }
        return {
          ...cell,
          props,
          content: carryInlineStyles(
            cellInlines(storedCell),
            cellInlines(backCell),
            cell.content
          ),
        }
      })
    })
  }
  return content
}

function ownLossyFields(block: Block): string[] {
  const fields = new Set(isMarkdownSafe([{ ...block, children: [] }]).lossyFields)
  if (
    block?.type === "table" &&
    Array.isArray(block.content?.columnWidths) &&
    block.content.columnWidths.some((width: unknown) => width !== null && width !== undefined)
  ) {
    fields.add("table:columnWidths")
  }
  return [...fields]
}

/** A changed block: the parsed block, with what Markdown could not say carried over. */
function mergeChanged(stored: Block, parsedBack: Block, next: Block): Block {
  let type = next.type
  if (
    parsedBack.type !== stored.type &&
    next.type === parsedBack.type &&
    contentKind(stored.type) === contentKind(next.type)
  ) {
    type = stored.type
  }
  const schema = propSchemaOf(type) ?? {}
  const props: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(next.props ?? {})) {
    if (key in schema) props[key] = value
  }
  for (const [key, value] of Object.entries(stored.props ?? {})) {
    if (!(key in schema)) continue
    const lostInMarkdown = !sameValue(parsedBack.props?.[key], value)
    const unchangedByEdit = sameValue(next.props?.[key], parsedBack.props?.[key])
    if (lostInMarkdown && unchangedByEdit) props[key] = value
  }
  let content = next.content
  if (Array.isArray(next.content) && Array.isArray(stored.content)) {
    content = carryInlineStyles(stored.content, parsedBack.content, next.content)
  } else if (stored.type === "table" && next.type === "table") {
    content = carryTable(stored, parsedBack, next)
  }
  return { ...next, id: stored.id, type, props, content }
}

/** Longest common subsequence of two key lists, as index pairs. */
function lcs<T>(left: T[], right: T[], equal: (a: T, b: T) => boolean): Array<[number, number]> {
  let start = 0
  while (start < left.length && start < right.length && equal(left[start]!, right[start]!)) {
    start++
  }
  let end = 0
  while (
    end < left.length - start &&
    end < right.length - start &&
    equal(left[left.length - 1 - end]!, right[right.length - 1 - end]!)
  ) {
    end++
  }
  const pairs: Array<[number, number]> = []
  for (let index = 0; index < start; index++) pairs.push([index, index])
  const a = left.slice(start, left.length - end)
  const b = right.slice(start, right.length - end)
  if (a.length > 0 && b.length > 0) {
    if (a.length * b.length > 4_000_000) {
      // Too large for a table: match greedily in order.
      let from = 0
      a.forEach((item, i) => {
        for (let j = from; j < b.length; j++) {
          if (equal(item, b[j]!)) {
            pairs.push([start + i, start + j])
            from = j + 1
            break
          }
        }
      })
    } else {
      const width = b.length + 1
      const table = new Uint32Array((a.length + 1) * width)
      for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
          table[i * width + j] = equal(a[i]!, b[j]!)
            ? table[(i + 1) * width + j + 1]! + 1
            : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
        }
      }
      let i = 0
      let j = 0
      while (i < a.length && j < b.length) {
        if (equal(a[i]!, b[j]!)) {
          pairs.push([start + i, start + j])
          i++
          j++
        } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
          i++
        } else {
          j++
        }
      }
    }
  }
  for (let index = 0; index < end; index++) {
    pairs.push([left.length - end + index, right.length - end + index])
  }
  return pairs
}

async function spliceSequence(
  stored: Block[],
  parsed: Block[],
  context: SpliceContext
): Promise<Block[]> {
  // Empty paragraphs have no Markdown; keep them where they were.
  const visibleStored = stored
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => !isEmptyParagraph(block))
  const storedKeys = await Promise.all(visibleStored.map(({ block }) => fullMarkdown(block)))
  const parsedKeys = await Promise.all(parsed.map((block) => fullMarkdown(block)))
  const anchors = lcs(
    storedKeys.map((key, index) => ({ key, index })),
    parsedKeys.map((key, index) => ({ key, index })),
    (a, b) => a.key === b.key
  )

  const output: Block[] = []
  let flushedStored = 0
  const flushEmpty = (untilIndex: number) => {
    for (; flushedStored < untilIndex; flushedStored++) {
      const block = stored[flushedStored]!
      if (isEmptyParagraph(block)) {
        output.push(block)
        context.kept += 1
      }
    }
  }

  let storedCursor = 0
  let parsedCursor = 0
  const boundaries = [...anchors, [visibleStored.length, parsed.length] as [number, number]]
  for (const [anchorStored, anchorParsed] of boundaries) {
    const gapStored = visibleStored.slice(storedCursor, anchorStored)
    const gapParsed = parsed.slice(parsedCursor, anchorParsed)
    if (gapStored.length > 0) flushEmpty(gapStored[0]!.index)
    output.push(
      ...(await spliceGap(
        gapStored.map(({ block }) => block),
        gapParsed,
        context
      ))
    )
    if (gapStored.length > 0) flushEmpty(gapStored.at(-1)!.index + 1)
    if (anchorStored < visibleStored.length) {
      const { block, index } = visibleStored[anchorStored]!
      flushEmpty(index)
      output.push(block)
      context.kept += countNodes([block])
      flushedStored = index + 1
    }
    storedCursor = anchorStored + 1
    parsedCursor = anchorParsed + 1
  }
  flushEmpty(stored.length)
  return output
}

function compatibleTypes(storedType: unknown, parsedType: unknown): boolean {
  return (
    storedType === parsedType ||
    (contentKind(storedType) === "inline" && contentKind(parsedType) === "inline")
  )
}

function ownText(block: Block): string {
  return blocksPlainText([{ ...block, children: [] }]).trim()
}

function textSimilarity(left: string, right: string): number {
  if (left === right) return 1
  if (left.length < 2 || right.length < 2) return 0
  return similarity(bigrams(left), right)
}

/** Below this, a changed block is treated as removed and a new one inserted. */
const PAIR_SIMILARITY = 0.3
const MAX_PAIRING_CELLS = 250_000

/**
 * Which stored blocks the changed blocks are edits of, in order. Blocks pair
 * by text similarity, so a block deleted next to an edited one never lends its
 * id (and its comments) to unrelated text. A lone block rewritten in place
 * keeps its identity even when little of its text survives.
 */
function pairChangedBlocks(
  stored: Block[],
  storedTypes: unknown[],
  parsed: Block[]
): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  if (stored.length * parsed.length <= MAX_PAIRING_CELLS) {
    const storedTexts = stored.map(ownText)
    const parsedTexts = parsed.map(ownText)
    const weight = (s: number, p: number): number => {
      if (!compatibleTypes(storedTypes[s], parsed[p]!.type)) return 0
      const score = textSimilarity(storedTexts[s]!, parsedTexts[p]!)
      return score >= PAIR_SIMILARITY ? score : 0
    }
    // Order-preserving alignment with the greatest total similarity.
    const width = parsed.length + 1
    const best = new Float64Array((stored.length + 1) * width)
    for (let s = stored.length - 1; s >= 0; s--) {
      for (let p = parsed.length - 1; p >= 0; p--) {
        const w = weight(s, p)
        best[s * width + p] = Math.max(
          best[(s + 1) * width + p]!,
          best[s * width + p + 1]!,
          w > 0 ? w + best[(s + 1) * width + p + 1]! : 0
        )
      }
    }
    let s = 0
    let p = 0
    while (s < stored.length && p < parsed.length) {
      const w = weight(s, p)
      if (w > 0 && best[s * width + p] === w + best[(s + 1) * width + p + 1]!) {
        pairs.push([s, p])
        s++
        p++
      } else if (best[(s + 1) * width + p]! >= best[s * width + p + 1]!) {
        s++
      } else {
        p++
      }
    }
  }
  // A single stored block replaced by a single block of a compatible type is
  // an in-place rewrite.
  const filled: Array<[number, number]> = []
  let storedCursor = 0
  let parsedCursor = 0
  for (const pair of [...pairs, [stored.length, parsed.length] as [number, number]]) {
    const [s, p] = pair
    if (
      s - storedCursor === 1 &&
      p - parsedCursor === 1 &&
      compatibleTypes(storedTypes[storedCursor], parsed[parsedCursor]!.type)
    ) {
      filled.push([storedCursor, parsedCursor])
    }
    if (s < stored.length) filled.push(pair)
    storedCursor = s + 1
    parsedCursor = p + 1
  }
  return filled
}

async function spliceGap(
  stored: Block[],
  parsed: Block[],
  context: SpliceContext
): Promise<Block[]> {
  if (stored.length === 0) {
    context.inserted += countNodes(parsed)
    return parsed.map(stripIds)
  }
  if (parsed.length === 0) {
    collectIds(stored, context.removedIds)
    return []
  }
  const trips = await Promise.all(stored.map(roundTrip))
  // Text replacing a block Markdown cannot represent cannot be told apart
  // from an edit of it. Deleting such a block outright is fine.
  const unsupported = stored.findIndex((_, index) => !trips[index]!.supported)
  if (unsupported !== -1 && context.mode === "edit") {
    refuseUnsupported(stored[unsupported]!, context)
  }
  const storedTypes = stored.map((block, index) => trips[index]!.block?.type ?? block.type)
  const pairs = pairChangedBlocks(stored, storedTypes, parsed)

  const output: Block[] = []
  let parsedEmitted = 0
  const pairedStored = new Set(pairs.map(([s]) => s))
  for (let index = 0; index < stored.length; index++) {
    if (!pairedStored.has(index)) collectIds([stored[index]!], context.removedIds)
  }
  for (const [s, p] of pairs) {
    for (; parsedEmitted < p; parsedEmitted++) {
      context.inserted += countNodes([parsed[parsedEmitted]!])
      output.push(stripIds(parsed[parsedEmitted]!))
    }
    output.push(...(await splicePair(stored[s]!, trips[s]!, parsed[p]!, context)))
    parsedEmitted = p + 1
  }
  for (; parsedEmitted < parsed.length; parsedEmitted++) {
    context.inserted += countNodes([parsed[parsedEmitted]!])
    output.push(stripIds(parsed[parsedEmitted]!))
  }
  return output
}

function refuseUnsupported(block: Block, context: SpliceContext): never {
  throw new DocEditError(
    "unsupported_block",
    `The edit changes a ${String(block.type)} block near line ${context.line} that Markdown cannot represent intact. Leave that block's text unchanged, or edit it in Worktable.`,
    { line: context.line, blockType: block.type, blockId: block.id }
  )
}

async function splicePair(
  stored: Block,
  trip: RoundTrip,
  parsed: Block,
  context: SpliceContext
): Promise<Block[]> {
  if (!trip.supported || !trip.block) {
    if (context.mode === "edit") refuseUnsupported(stored, context)
    collectIds([stored], context.removedIds)
    context.inserted += countNodes([parsed])
    context.formattingDropped.push({
      blockId: String(stored.id),
      fields: [`block:${String(stored.type)}`],
    })
    return [stripIds(parsed)]
  }

  const storedChildren: Block[] = Array.isArray(stored.children) ? stored.children : []
  const parsedChildren: Block[] = Array.isArray(parsed.children) ? parsed.children : []
  if ((await ownMarkdown(stored)) === (await ownMarkdown(parsed))) {
    context.kept += 1
    return [
      { ...stored, children: await spliceSequence(storedChildren, parsedChildren, context) },
    ]
  }

  const merged = mergeChanged(stored, trip.block, parsed)
  merged.children = await spliceSequence(storedChildren, parsedChildren, context)
  context.modified.push(String(stored.id))
  const remaining = new Set(ownLossyFields(merged))
  const dropped = ownLossyFields(stored).filter((field) => !remaining.has(field))
  if (dropped.length > 0) {
    context.formattingDropped.push({ blockId: String(stored.id), fields: dropped })
  }
  return [merged]
}

async function spliceProjection(
  projection: MarkdownProjection,
  edited: TextEditResult,
  mode: "edit" | "write"
): Promise<SpliceResult> {
  const units = projection.units
  const visible = units
    .map((unit, index) => ({ unit, index }))
    .filter(({ unit }) => unit.visible)
  const dirty = new Set<number>()
  for (const range of edited.originalRanges) {
    visible.forEach(({ unit }, v) => {
      if (range.start < unit.end && range.end > unit.start) dirty.add(v)
      // A changed separator (or trailing newline) joins or splits its neighbours.
      const separatorEnd =
        v + 1 < visible.length ? visible[v + 1]!.unit.start : projection.markdown.length
      if (range.start < separatorEnd && range.end > unit.end) {
        dirty.add(v)
        if (v + 1 < visible.length) dirty.add(v + 1)
      }
    })
  }

  const context: SpliceContext = {
    mode,
    line: 1,
    kept: 0,
    modified: [],
    inserted: 0,
    removedIds: [],
    formattingDropped: [],
  }
  const regions: SpliceRegion[] = []
  const blocks: Block[] = []

  if (visible.length === 0) {
    // Nothing visible to anchor to: the whole text is one region.
    const parsed = (await markdownToBlocks(edited.text)) as Block[]
    const stored = units.flatMap((unit) => unit.blocks)
    const result = await spliceSequence(stored, parsed, context)
    regions.push({ replacedBlockIds: stored.map((block) => String(block.id)), blocks: result })
    blocks.push(...result)
  } else {
    let unitIndex = 0
    let v = 0
    while (unitIndex < units.length) {
      const unit = units[unitIndex]!
      if (!unit.visible || !dirty.has(v)) {
        blocks.push(...unit.blocks)
        context.kept += countNodes(unit.blocks)
        if (unit.visible) v++
        unitIndex++
        continue
      }
      // A run of dirty visible units, with the invisible units between them.
      const firstV = v
      let lastV = v
      while (lastV + 1 < visible.length && dirty.has(lastV + 1)) lastV++
      const lastUnitIndex = visible[lastV]!.index
      const regionUnits = units.slice(unitIndex, lastUnitIndex + 1)
      const opaque = regionUnits.find((candidate) => candidate.opaque)
      const startLine = lineAt(projection.markdown, unit.start)
      if (opaque) {
        if (mode === "edit") {
          throw new DocEditError(
            "unsupported_block",
            `The edit changes a ${String(opaque.blocks[0]?.type)} block near line ${lineAt(projection.markdown, opaque.start)} that cannot be shown as Markdown. Leave it unchanged, or edit it in Worktable.`,
            {
              line: lineAt(projection.markdown, opaque.start),
              blockType: opaque.blocks[0]?.type,
              blockId: opaque.blocks[0]?.id,
            }
          )
        }
      }
      const start = firstV === 0 ? 0 : edited.mapAfter(unit.start)
      const end =
        lastV === visible.length - 1
          ? edited.text.length
          : edited.mapBefore(visible[lastV]!.unit.end)
      const regionText = edited.text.slice(start, end)
      const parsed = (await markdownToBlocks(regionText)) as Block[]
      const stored = regionUnits.flatMap((candidate) => candidate.blocks)
      // In write mode, opaque blocks are replaced like any unsupported block.
      context.line = startLine
      const result = await spliceSequence(stored, parsed, context)
      regions.push({ replacedBlockIds: stored.map((block) => String(block.id)), blocks: result })
      blocks.push(...result)
      unitIndex = lastUnitIndex + 1
      v = lastV + 1
    }
  }

  return {
    blocks,
    editedMarkdown: edited.text,
    regions,
    changed: {
      kept: context.kept,
      modified: context.modified,
      inserted: context.inserted,
      removed: context.removedIds.length,
    },
    removedIds: context.removedIds,
    formattingDropped: context.formattingDropped,
  }
}

/**
 * Apply exact-text edits to a BlockNote document through its Markdown
 * projection. Unchanged blocks are returned as the same objects.
 */
export async function spliceBlockEdits(
  blocks: unknown[],
  edits: readonly TextEdit[]
): Promise<SpliceResult & { projection: MarkdownProjection; edit: TextEditResult }> {
  const projection = await projectBlocks(blocks)
  const edit = applyTextEdits(projection.markdown, edits)
  if (edit.text === projection.markdown) {
    throw new DocEditError("no_change", "The edits leave the document unchanged.")
  }
  return { ...(await spliceProjection(projection, edit, "edit")), projection, edit }
}

/**
 * Replace a BlockNote document's whole Markdown. Blocks whose Markdown is
 * unchanged keep their ids and formatting; blocks Markdown cannot represent
 * are replaced and reported in `formattingDropped`.
 */
export async function spliceBlockReplacement(
  blocks: unknown[],
  markdown: string
): Promise<SpliceResult & { projection: MarkdownProjection }> {
  const projection = await projectBlocks(blocks)
  const whole: TextEditResult = {
    text: markdown,
    originalRanges: [{ start: 0, end: Math.max(1, projection.markdown.length) }],
    editedRanges: [{ start: 0, end: markdown.length }],
    mapAfter: () => 0,
    mapBefore: () => markdown.length,
  }
  return { ...(await spliceProjection(projection, whole, "write")), projection }
}

/**
 * Edited region of the final text with line numbers, for the agent to check
 * its change without another read.
 */
export function editSnippet(
  text: string,
  ranges: ReadonlyArray<{ start: number; end: number }>,
  context = 1,
  maxLines = 40
): string {
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  const wanted = new Set<number>()
  for (const range of ranges) {
    const first = lineAt(text, range.start)
    const last = lineAt(text, Math.max(range.start, range.end - 1))
    for (let line = first - context; line <= last + context; line++) {
      if (line >= 1 && line <= lines.length) wanted.add(line)
    }
  }
  const ordered = [...wanted].sort((a, b) => a - b)
  const output: string[] = []
  let previous = 0
  for (const line of ordered) {
    if (output.length >= maxLines) {
      output.push("…")
      break
    }
    if (previous && line > previous + 1) output.push("…")
    output.push(`${line}: ${lines[line - 1]}`)
    previous = line
  }
  return output.join("\n")
}

/** Plain text of blocks, for checking whether an annotation quote survived. */
export function blocksPlainText(blocks: unknown[]): string {
  const parts: string[] = []
  const inline = (content: unknown) => {
    if (!Array.isArray(content)) return
    for (const item of content) {
      if (typeof item?.text === "string") parts.push(item.text)
      else if (Array.isArray(item?.content)) inline(item.content)
    }
  }
  const walk = (values: unknown[]) => {
    for (const value of values) {
      const block = value as Block
      if (Array.isArray(block?.content)) inline(block.content)
      else if (block?.content?.type === "tableContent") {
        for (const row of block.content.rows ?? []) {
          for (const cell of row.cells ?? []) inline(cellInlines(cell))
        }
      }
      if (typeof block?.props?.data === "string") parts.push(block.props.data)
      parts.push("\n")
      if (Array.isArray(block?.children)) walk(block.children)
    }
  }
  walk(blocks)
  return parts.join("")
}
