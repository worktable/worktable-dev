/**
 * Exact-text editing of Worktable Docs.
 *
 * Agents read a Doc as Markdown and change it by exact string replacement.
 * For Markdown files that is plain string replacement on the stored text. For
 * BlockNote documents the Markdown is a projection, so this module:
 *
 * 1. projects the blocks to Markdown block by block (`projectBlocks`),
 *    recording where every block — and its own text, apart from its nested
 *    blocks — sits in the projection. `docs.read` returns exactly this text;
 * 2. applies the edits to that text, remembering which original spans changed
 *    (`applyTextEdits`; a whole-document write is turned into the same kind of
 *    change by a line diff, `diffTextEdit`);
 * 3. keeps, unparsed and byte-identical, every block whose text and
 *    surrounding separators the change did not touch. An edit inside one
 *    block's own text is spliced into its stored inline content, so characters
 *    the edit did not touch keep their exact text and styles. Only text between
 *    kept blocks is parsed; there, blocks whose Markdown is unchanged are kept
 *    verbatim and changed blocks keep their id, the properties Markdown cannot
 *    express and the styles of untouched characters (`spliceBlockEdits`).
 *
 * A block whose Markdown cannot be parsed back into the same shape (a toggle
 * heading with children, files, media, unknown types) or that carries
 * properties Worktable does not recognize is refused with `unsupported_block`
 * only when an edit changes its own text in a way that needs parsing.
 *
 * The result also lists, per top-level region, which blocks were replaced by
 * which. A Doc open in a live session receives the change through those
 * regions, replacing only the blocks they name (`block-regions.ts`).
 */

import { randomUUID } from "node:crypto"
import { normalizeMermaidBlocks } from "@worktable/types"
import { getServerEditor, serverSchema, unknownPropKeys } from "./blocknote.ts"
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
 * replaced, so the change can be traced back to the blocks it touched.
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

export function lineAt(text: string, offset: number): number {
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
    if (pieceStart >= end) {
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

function editResult(original: string, pieces: Piece[]): TextEditResult {
  const text = pieces.map((piece) => piece.text).join("")
  const originalRanges: Array<{ start: number; end: number }> = []
  const editedRanges: Array<{ start: number; end: number }> = []
  const kept: Array<{ os: number; oe: number; fs: number }> = []
  let cursor = 0
  for (const piece of pieces) {
    if (piece.edited) {
      originalRanges.push({ start: piece.os, end: piece.oe })
      editedRanges.push({ start: cursor, end: cursor + piece.text.length })
    } else if (piece.oe > piece.os) {
      kept.push({ os: piece.os, oe: piece.oe, fs: cursor })
    }
    cursor += piece.text.length
  }
  // Kept spans are ordered by original offset: binary search them.
  const find = (test: (span: (typeof kept)[number]) => -1 | 0 | 1) => {
    let low = 0
    let high = kept.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const order = test(kept[mid]!)
      if (order === 0) return kept[mid]
      if (order < 0) high = mid - 1
      else low = mid + 1
    }
    return undefined
  }
  const mapAfter = (offset: number): number => {
    if (offset === 0) return 0
    const span = find((s) => (offset <= s.os ? -1 : offset > s.oe ? 1 : 0))
    if (!span) throw new Error(`offset ${offset} does not follow kept text`)
    return span.fs + (offset - span.os)
  }
  const mapBefore = (offset: number): number => {
    if (offset === original.length) return text.length
    const span = find((s) => (offset < s.os ? -1 : offset >= s.oe ? 1 : 0))
    if (!span) throw new Error(`offset ${offset} does not precede kept text`)
    return span.fs + (offset - span.os)
  }
  return { text, originalRanges, editedRanges, mapAfter, mapBefore }
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
      pieces = replaceRange(pieces, match, match + edit.oldText.length, edit.newText)
    }
  })
  return editResult(original, pieces)
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/**
 * The change from `original` to `next` as replaced spans, found by a line
 * diff and trimmed to the characters that differ, so a whole-document write
 * touches only the blocks whose text changed.
 */
export function diffTextEdit(original: string, next: string): TextEditResult {
  if (original === next) {
    return editResult(original, [{ text: original, os: 0, oe: original.length, edited: false }])
  }
  if (original.length === 0) {
    return editResult(original, [{ text: next, os: 0, oe: 0, edited: true }])
  }
  const oldLines = splitLines(original)
  const newLines = splitLines(next)
  const oldOffsets = [0]
  for (const line of oldLines) oldOffsets.push(oldOffsets.at(-1)! + line.length)
  const anchors = lcs(oldLines, newLines, (a, b) => a === b)

  // Hunks of differing lines, in line indices.
  const hunks: Array<{ o0: number; o1: number; n0: number; n1: number }> = []
  let o = 0
  let n = 0
  for (const [ao, an] of [...anchors, [oldLines.length, newLines.length] as [number, number]]) {
    if (ao > o || an > n) hunks.push({ o0: o, o1: ao, n0: n, n1: an })
    o = ao + 1
    n = an + 1
  }
  // A pure insertion replaces a neighbouring unchanged line, so every hunk
  // covers original text. Overlapping hunks merge.
  for (const hunk of hunks) {
    if (hunk.o0 < hunk.o1) continue
    if (hunk.o0 > 0) {
      hunk.o0 -= 1
      hunk.n0 -= 1
    } else {
      hunk.o1 += 1
      hunk.n1 += 1
    }
  }
  const merged: typeof hunks = []
  for (const hunk of hunks) {
    const last = merged.at(-1)
    if (last && hunk.o0 <= last.o1) {
      last.o1 = Math.max(last.o1, hunk.o1)
      last.n1 = Math.max(last.n1, hunk.n1)
    } else {
      merged.push({ ...hunk })
    }
  }

  const pieces: Piece[] = []
  let keptFrom = 0
  for (const hunk of merged) {
    let start = oldOffsets[hunk.o0]!
    let end = oldOffsets[hunk.o1]!
    let replacement = newLines.slice(hunk.n0, hunk.n1).join("")
    const removed = original.slice(start, end)
    // Trim characters the hunk shares at both ends, keeping one original
    // character so the span stays traceable.
    let prefix = 0
    while (
      prefix < removed.length - 1 &&
      prefix < replacement.length &&
      removed[prefix] === replacement[prefix]
    ) {
      prefix++
    }
    let suffix = 0
    while (
      suffix < removed.length - prefix - 1 &&
      suffix < replacement.length - prefix &&
      removed[removed.length - 1 - suffix] === replacement[replacement.length - 1 - suffix]
    ) {
      suffix++
    }
    start += prefix
    end -= suffix
    replacement = replacement.slice(prefix, replacement.length - suffix)
    if (start > keptFrom) {
      pieces.push({ text: original.slice(keptFrom, start), os: keptFrom, oe: start, edited: false })
    }
    pieces.push({ text: replacement, os: start, oe: end, edited: true })
    keptFrom = end
  }
  if (keptFrom < original.length) {
    pieces.push({ text: original.slice(keptFrom), os: keptFrom, oe: original.length, edited: false })
  }
  return editResult(original, pieces)
}

// ── Markdown of a block's own text ──────────────────────────

const LIST_FAMILY: Record<string, string> = {
  bulletListItem: "bullet",
  checkListItem: "bullet",
  toggleListItem: "bullet",
  numberedListItem: "numbered",
}

const SEPARATOR_TEXT = "WorktableBlockSeparator7f3a"
const OWN_CACHE_ENTRIES = 50_000
const OWN_CACHE_CHARS = 32 * 1024 * 1024
const ownCache = new Map<string, string | null>()
let ownCacheChars = 0

function rememberOwn(key: string, markdown: string | null): void {
  const previous = ownCache.get(key)
  if (previous !== undefined || ownCache.has(key)) {
    ownCacheChars -= key.length + (previous?.length ?? 0)
    ownCache.delete(key)
  }
  ownCache.set(key, markdown)
  ownCacheChars += key.length + (markdown?.length ?? 0)
  while (ownCache.size > OWN_CACHE_ENTRIES || ownCacheChars > OWN_CACHE_CHARS) {
    const oldest = ownCache.keys().next().value
    if (oldest === undefined) break
    ownCacheChars -= oldest.length + (ownCache.get(oldest)?.length ?? 0)
    ownCache.delete(oldest)
  }
}

/**
 * A copy of a block without its id and nested blocks. Deep, because the
 * editor's serializer fills in default props in place.
 */
function ownBlock(block: Block): Block {
  const { id: _id, children: _children, ...rest } = block ?? {}
  return { ...structuredClone(rest), children: [] }
}

function ownKey(block: Block): string {
  const { id: _id, children: _children, ...rest } = block ?? {}
  return JSON.stringify({ ...rest, children: [] })
}

function blockText(block: Block): string {
  const parts: string[] = []
  const inline = (content: unknown) => {
    if (!Array.isArray(content)) return
    for (const item of content) {
      if (typeof item?.text === "string") parts.push(item.text)
      else if (Array.isArray(item?.content)) inline(item.content)
    }
  }
  inline(block?.content)
  return parts.join("")
}

function normalizeOwn(block: Block, markdown: string | null): string | null {
  if (markdown === null) return null
  const trimmed = markdown.replace(/\n+$/, "")
  // Numbering is assigned by position when composing a list.
  return block?.type === "numberedListItem" ? trimmed.replace(/^\d+\./, "1.") : trimmed
}

type ChunkKind = "simple" | "bullet" | "numbered" | "single"

function chunkKind(block: Block): ChunkKind {
  const type = String(block?.type)
  const inline = Array.isArray(block?.content)
  const text = blockText(block)
  if (inline && (block.content.length === 0 || text.length === 0)) return "single"
  if (text.includes("\n")) return "single"
  if (LIST_FAMILY[type] === "bullet") return "bullet"
  if (type === "numberedListItem") return "numbered"
  if (["paragraph", "heading", "quote", "image", "divider", "file", "video", "audio", "table"].includes(type)) {
    return "simple"
  }
  return "single"
}

const SEPARATOR = { type: "paragraph", content: [{ type: "text", text: SEPARATOR_TEXT, styles: {} }] }

/**
 * Serialize groups of blocks in one call, each group between separator
 * paragraphs. The serializer trims whitespace at the very start and end of
 * its output only, so fencing every group keeps a block's leading and
 * trailing spaces wherever it sits. Null when the output does not split back
 * into one part per group.
 */
async function fencedMarkdown(groups: unknown[][], safe: boolean): Promise<string[] | null> {
  const batch: unknown[] = [SEPARATOR]
  for (const group of groups) batch.push(...group, SEPARATOR)
  let output: string | null
  if (safe) {
    output = await blocksToMarkdownSafe(batch)
  } else {
    try {
      const editor = await getServerEditor()
      output = await editor.blocksToMarkdownLossy(normalizeMermaidBlocks(batch).blocks)
    } catch {
      output = null
    }
  }
  if (output === null) return null
  const text = output.replace(/\n+$/, "")
  const open = `${SEPARATOR_TEXT}\n\n`
  const close = `\n\n${SEPARATOR_TEXT}`
  if (!text.startsWith(open) || !text.endsWith(close) || text.length < open.length + SEPARATOR_TEXT.length) {
    return null
  }
  const inner = text.length === open.length + SEPARATOR_TEXT.length ? "" : text.slice(open.length, -close.length)
  const parts = inner.split(`\n\n${SEPARATOR_TEXT}\n\n`)
  return parts.length === groups.length ? parts : null
}

/**
 * Serialize the own text of every block not yet cached, in as few editor
 * calls as possible: simple blocks share a call and split on blank lines,
 * list items split on lines, and anything that may contain blank lines is
 * fenced off by separator paragraphs.
 */
async function primeOwnMarkdown(blocks: Block[]): Promise<void> {
  const pending = new Map<string, Block>()
  const walk = (values: unknown[]) => {
    for (const value of values) {
      const block = value as Block
      if (!block || typeof block !== "object") continue
      const key = ownKey(block)
      if (!ownCache.has(key) && !pending.has(key)) pending.set(key, ownBlock(block))
      if (Array.isArray(block.children)) walk(block.children)
    }
  }
  walk(blocks)
  if (pending.size === 0) return

  const entries = [...pending]
  const chunks: Array<{ kind: ChunkKind; entries: Array<[string, Block]> }> = []
  for (const entry of entries) {
    const kind = chunkKind(entry[1])
    const last = chunks.at(-1)
    if (last && last.kind === kind && kind !== "single" && last.entries.length < 500) {
      last.entries.push(entry)
    } else {
      chunks.push({ kind, entries: [entry] })
    }
  }
  const individually = async (chunk: (typeof chunks)[number]) => {
    for (const [key, block] of chunk.entries) {
      const fenced = await fencedMarkdown([[structuredClone(block)]], true)
      const markdown = fenced ? fenced[0]! : await blocksToMarkdownSafe([structuredClone(block)])
      rememberOwn(key, normalizeOwn(block, markdown))
    }
  }

  const parts = await fencedMarkdown(
    chunks.map((chunk) => chunk.entries.map(([, block]) => block)),
    false
  )
  if (!parts) {
    for (const chunk of chunks) await individually(chunk)
    return
  }
  for (const [index, chunk] of chunks.entries()) {
    const part = parts[index]!
    const pieces =
      chunk.kind === "single"
        ? [part]
        : part.split(chunk.kind === "simple" ? "\n\n" : "\n")
    if (pieces.length !== chunk.entries.length) {
      await individually(chunk)
      continue
    }
    chunk.entries.forEach(([key, block], position) => {
      rememberOwn(key, normalizeOwn(block, pieces[position]!))
    })
  }
}

// ── Projection ──────────────────────────────────────────────

/** Where one block sits in the projection. Offsets are absolute. */
export interface SpanNode {
  block: Block
  visible: boolean
  /** The block could not be converted to Markdown at all. */
  opaque: boolean
  start: number
  /** End of the block's own text, before its nested blocks. */
  ownEnd: number
  end: number
  /** Indentation of the block's first line. */
  indent: number
  /** Indentation of its nested blocks. */
  childIndent: number
  /** What starts each continuation line of its own text. */
  contPrefix: string
  children: SpanNode[]
}

export interface MarkdownProjection {
  markdown: string
  nodes: SpanNode[]
}

const pad = (count: number) => " ".repeat(count)

function ownMarkdown(block: Block): { text: string; opaque: boolean } {
  const markdown = ownCache.get(ownKey(block))
  if (markdown === undefined || markdown === null) {
    return {
      text: `<!-- ${String(block?.type ?? "unknown")} block cannot be shown as Markdown -->`,
      opaque: true,
    }
  }
  return { text: markdown, opaque: false }
}

function isVisible(block: Block): boolean {
  if (ownMarkdown(block).text.trim().length > 0) return true
  return Array.isArray(block?.children) && block.children.some(isVisible)
}

class Builder {
  parts: string[] = []
  length = 0
  emit(text: string): void {
    this.parts.push(text)
    this.length += text.length
  }
}

function composeBlock(block: Block, indent: number, number: number | undefined, out: Builder): SpanNode {
  const own = ownMarkdown(block)
  const family = LIST_FAMILY[String(block?.type)]
  let text = own.text
  let markerWidth = 0
  if (family) {
    if (number !== undefined) text = text.replace(/^1\./, `${number}.`)
    markerWidth = family === "numbered" ? (text.match(/^\d+\./)?.[0].length ?? 2) + 1 : 2
  }
  const contIndent = family ? indent + markerWidth : indent
  const contPrefix =
    pad(contIndent) + (block?.type === "quote" && !family ? "> " : "")
  const lines = text.split("\n").map((line, index) => {
    if (index === 0) return line.length > 0 ? pad(indent) + line : line
    // BlockNote leaves continuation lines of list items unindented, which
    // Markdown would read as a new paragraph.
    if (line.length === 0) return line
    return family ? pad(contIndent) + line : pad(indent) + line
  })
  const node: SpanNode = {
    block,
    visible: isVisible(block),
    opaque: own.opaque,
    start: out.length,
    ownEnd: out.length,
    end: out.length,
    indent,
    childIndent: contIndent,
    contPrefix,
    children: [],
  }
  const ownText = text.trim().length > 0 ? lines.join("\n") : ""
  out.emit(ownText)
  node.ownEnd = out.length
  const children: Block[] = Array.isArray(block?.children) ? block.children : []
  const firstVisible = children.find(isVisible)
  if (firstVisible) {
    if (ownText.length > 0) {
      out.emit(family && LIST_FAMILY[String(firstVisible.type)] ? "\n" : "\n\n")
    }
    node.children = composeSequence(children, contIndent, out)
  } else {
    node.children = children.map((child) => ({
      block: child,
      visible: false,
      opaque: false,
      start: out.length,
      ownEnd: out.length,
      end: out.length,
      indent: contIndent,
      childIndent: contIndent,
      contPrefix,
      children: [],
    }))
  }
  node.end = out.length
  return node
}

/**
 * Blocks of one level: runs of list items of one kind are written as one
 * tight list, everything else is separated by a blank line.
 */
function composeSequence(blocks: Block[], indent: number, out: Builder): SpanNode[] {
  const nodes: SpanNode[] = []
  let previous: Block | undefined
  let emitted = false
  let runNumber = 0
  for (const block of blocks) {
    if (!isVisible(block)) {
      nodes.push({
        block,
        visible: false,
        opaque: false,
        start: out.length,
        ownEnd: out.length,
        end: out.length,
        indent,
        childIndent: indent,
        contPrefix: pad(indent),
        children: [],
      })
      previous = undefined
      continue
    }
    const family = LIST_FAMILY[String(block.type)]
    const sameRun = Boolean(previous && family && LIST_FAMILY[String(previous.type)] === family)
    if (emitted) out.emit(sameRun ? "\n" : "\n\n")
    emitted = true
    let number: number | undefined
    if (family === "numbered") {
      runNumber = sameRun ? runNumber + 1 : Number(block.props?.start ?? 1) || 1
      number = runNumber
    }
    nodes.push(composeBlock(block, indent, number, out))
    previous = block
  }
  return nodes
}

/**
 * The Markdown agents read and edit for a BlockNote document, with the span
 * of every block. Built the same way for `read`, `grep` and `edit`.
 */
export async function projectBlocks(blocks: unknown[]): Promise<MarkdownProjection> {
  const normalized = normalizeMermaidBlocks(blocks).blocks as Block[]
  await primeOwnMarkdown(normalized)
  const out = new Builder()
  const nodes = composeSequence(normalized, 0, out)
  return {
    markdown: out.length > 0 ? `${out.parts.join("")}\n` : "",
    nodes,
  }
}

/** Markdown of one block (with its nested blocks) as it reads on its own. */
async function standaloneMarkdown(block: Block): Promise<{ full: string; own: string; node: SpanNode }> {
  await primeOwnMarkdown([block])
  const out = new Builder()
  const [node] = composeSequence([block], 0, out)
  const full = out.parts.join("")
  return { full, own: full.slice(node!.start, node!.ownEnd), node: node! }
}

// ── Block splicing ──────────────────────────────────────────

export interface FormattingDrop {
  blockId: string
  fields: string[]
}

/** One contiguous run of top-level blocks that changed. */
export interface SpliceRegion {
  /** Ids of the top-level blocks this region replaced, in order. */
  replacedBlockIds: string[]
  /** The blocks now in their place (kept blocks keep their ids). */
  blocks: Block[]
  /** The first unchanged top-level block after the region, if any. */
  followingBlockId?: string
}

export interface SpliceResult {
  blocks: Block[]
  /** The edited projection. */
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
  projection: MarkdownProjection
  edited: TextEditResult
  line: number
  kept: number
  modified: string[]
  inserted: number
  removedIds: string[]
  formattingDropped: FormattingDrop[]
  removals: Array<{ block: Block; key: string }>
  insertions: Array<{ holder: Block; key: string; nodes: number }>
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

/** New blocks get ids here, so storage can never mistake them for old ones. */
function withFreshIds(block: Block): Block {
  return {
    ...block,
    id: randomUUID(),
    children: Array.isArray(block.children) ? block.children.map(withFreshIds) : [],
  }
}

function contentKind(type: unknown): string | undefined {
  return (serverSchema as any).blockSchema[String(type)]?.content
}

function propSchemaOf(type: unknown): Record<string, unknown> | undefined {
  return (serverSchema as any).blockSchema[String(type)]?.propSchema
}

const foreignProps = unknownPropKeys

interface RoundTrip {
  supported: boolean
  block?: Block
}

const roundTripCache = new WeakMap<Block, RoundTrip>()

function shapeOf(blocks: Block[]): string {
  return JSON.stringify(
    blocks.map(function shape(block: Block): unknown {
      return [block.type, (block.children ?? []).map(shape)]
    })
  )
}

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

/** How a stored block's own text reads back from its Markdown. */
async function roundTrip(block: Block): Promise<RoundTrip> {
  const cached = roundTripCache.get(block)
  if (cached) return cached
  let result: RoundTrip = { supported: false }
  const own = { ...block, children: [] }
  const { own: markdown, node } = await standaloneMarkdown(own)
  if (!node.opaque) {
    const parsed = (await markdownToBlocks(markdown)) as Block[]
    if (parsed.length === 1 && sameShape(own, parsed[0]!)) {
      result = { supported: true, block: parsed[0] }
    }
  }
  roundTripCache.set(block, result)
  return result
}

const fullRoundTripCache = new WeakMap<Block, boolean>()

/** Whether a stored block, with its nested blocks, reads back in the same shape. */
async function fullyRoundTrips(block: Block): Promise<boolean> {
  const cached = fullRoundTripCache.get(block)
  if (cached !== undefined) return cached
  const { full, node } = await standaloneMarkdown(block)
  const parsed = node.opaque ? [] : ((await markdownToBlocks(full)) as Block[])
  const result = parsed.length === 1 && sameShape(block, parsed[0]!)
  fullRoundTripCache.set(block, result)
  return result
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

// Inline content as characters, so an edit can replace exactly the characters
// it changed and every other character keeps its text and styles.
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
        for (const ch of run.text) chars.push({ ch, styles: run.styles ?? {}, href: item.href })
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
      const link = last?.type === "link" && last.href === char.href ? last : undefined
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

function commonStyles(chars: InlineChar[]): Pick<InlineChar, "styles" | "href"> {
  const [first, ...rest] = chars
  if (!first) return { styles: {} }
  const styles: Record<string, unknown> = {}
  for (const [style, value] of Object.entries(first.styles)) {
    if (rest.every((char) => sameValue(char.styles[style], value))) styles[style] = value
  }
  const href = rest.every((char) => char.href === first.href) ? first.href : undefined
  return href === undefined ? { styles } : { styles, href }
}

/**
 * Re-apply styles that were lost in Markdown (colors, underline) to the
 * characters before and after the edited part of the text.
 */
function carryInlineStyles(stored: unknown, parsedBack: unknown, next: unknown): unknown {
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
  while (prefix < storedText.length && prefix < nextText.length && storedText[prefix] === nextText[prefix]) {
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
  const neighbours = [
    prefix > 0 ? lost[prefix - 1]! : undefined,
    suffix > 0 ? lost[storedChars.length - suffix]! : undefined,
  ].filter((styles): styles is Record<string, unknown> => styles !== undefined)
  const inherited: Record<string, unknown> = {}
  if (neighbours.length > 0) {
    for (const [style, value] of Object.entries(neighbours[0]!)) {
      if (neighbours.every((styles) => sameValue(styles[style], value))) inherited[style] = value
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
          if (!sameValue(cellProps(backCell)[key], value) && sameValue(props[key], cellProps(backCell)[key])) {
            props[key] = value
          }
        }
        return {
          ...cell,
          props,
          content: carryInlineStyles(cellInlines(storedCell), cellInlines(backCell), cell.content),
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
  for (const key of foreignProps(block)) fields.add(`prop:${key}`)
  return [...fields]
}

/** A re-parsed block, with what Markdown could not say carried over. */
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

function dedent(text: string, indent: number): string {
  if (indent === 0) return text
  const pattern = new RegExp(`^ {0,${indent}}`, "gm")
  return text.replace(pattern, "")
}

interface AlignedChar extends InlineChar {
  /** Span of the character in the block's Markdown. */
  from: number
  to: number
}

const DELIMITERS = /^[*_`~[\]!]*$/

/**
 * Locate every character of a block's inline content in its own Markdown.
 * Text is written verbatim between markup; a stored line break is written as
 * a hard break followed by the continuation prefix.
 */
function alignInline(
  content: Block[],
  markdown: string,
  contPrefix: string,
  plain: boolean
): AlignedChar[] | null {
  const aligned: AlignedChar[] = []
  let cursor = 0
  let first = true
  const matchAt = (text: string, at: number, styles: Record<string, unknown>, href?: string): AlignedChar[] | null => {
    const out: AlignedChar[] = []
    let m = at
    for (const ch of text) {
      const from = m
      if (ch === "\n") {
        if (!plain) {
          if (markdown[m] === "\\" && markdown[m + 1] === "\n") m += 1
          else while (markdown[m] === " " && markdown.slice(m).match(/^ +\n/)) m += 1
        }
        if (markdown[m] !== "\n") return null
        m += 1
        if (markdown.startsWith(contPrefix, m)) m += contPrefix.length
        else if (markdown.startsWith(contPrefix.trimEnd(), m)) m += contPrefix.trimEnd().length
      } else {
        if (!markdown.startsWith(ch, m)) return null
        m += ch.length
      }
      out.push({ ch, styles, ...(href === undefined ? {} : { href }), from, to: m })
    }
    return out
  }
  const place = (text: string, styles: Record<string, unknown>, href?: string): boolean => {
    if (text.length === 0) return true
    for (let at = cursor; at <= markdown.length; at++) {
      if (!first && !DELIMITERS.test(markdown.slice(cursor, at))) return false
      const chars = matchAt(text, at, styles, href)
      if (chars) {
        aligned.push(...chars)
        cursor = chars.at(-1)!.to
        first = false
        return true
      }
    }
    return false
  }
  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string") {
      if (!place(item.text, item.styles ?? {})) return null
    } else if (item?.type === "link" && Array.isArray(item.content)) {
      for (const run of item.content) {
        if (typeof run?.text !== "string" || !place(run.text, run.styles ?? {}, item.href)) return null
      }
      // Skip the destination so link text never aligns inside a URL.
      const tail = markdown.slice(cursor).match(/^[*_`~]*\]\(/)
      if (!tail) return null
      const close = markdown.indexOf(")", cursor + tail[0].length)
      if (close === -1) return null
      cursor = close + 1
    } else {
      return null
    }
  }
  return aligned
}

/**
 * Inline content for replacement Markdown typed into a block: plain text
 * takes the styles of the text it replaces, Markdown markup adds its own.
 */
async function replacementChars(
  text: string,
  base: Pick<InlineChar, "styles" | "href">,
  contPrefix: string,
  plain: boolean
): Promise<InlineChar[] | null> {
  const literal = (value: string): InlineChar[] =>
    [...value].map((ch) => ({ ch, styles: { ...base.styles }, ...(base.href === undefined ? {} : { href: base.href }) }))
  const breakPattern = plain ? /\n/ : /(?:\\|  +)?\n/
  const prefixes = [contPrefix, contPrefix.trimEnd()].filter((value) => value.length > 0)
  const segments = text.split(breakPattern).map((segment, index) => {
    if (index === 0) return segment
    const prefix = prefixes.find((candidate) => segment.startsWith(candidate))
    return prefix ? segment.slice(prefix.length) : segment
  })
  const out: InlineChar[] = []
  for (const [index, segment] of segments.entries()) {
    if (index > 0) out.push(...literal("\n"))
    if (plain || !/[\\`*_[\]<>!~&]/.test(segment)) {
      out.push(...literal(segment))
      continue
    }
    const lead = segment.match(/^\s*/)![0]
    const trail = segment.slice(lead.length).match(/\s*$/)![0]
    const core = segment.slice(lead.length, segment.length - trail.length)
    const parsed = (await markdownToBlocks(core)) as Block[]
    const paragraph = parsed[0]
    if (
      parsed.length !== 1 ||
      paragraph?.type !== "paragraph" ||
      (paragraph.children?.length ?? 0) > 0
    ) {
      return null
    }
    const chars = flattenInline(paragraph.content)
    if (!chars) return null
    out.push(...literal(lead))
    for (const char of chars) {
      const href = char.href ?? base.href
      out.push({ ch: char.ch, styles: { ...base.styles, ...char.styles }, ...(href === undefined ? {} : { href }) })
    }
    out.push(...literal(trail))
  }
  return out
}

/**
 * Apply a change of a block's own Markdown to its stored inline content,
 * replacing only the characters that changed. Null when the change is not a
 * text change inside the block's content (markup, block type, structure).
 */
async function spliceInline(
  block: Block,
  oldMarkdown: string,
  newMarkdown: string,
  indent: number,
  contPrefix: string
): Promise<Block | null> {
  const kind = contentKind(block?.type)
  if (!Array.isArray(block?.content) || (kind !== "inline" && kind !== "plain")) return null
  const plain = kind === "plain"
  const aligned = alignInline(block.content, oldMarkdown, contPrefix, plain)
  if (!aligned) return null

  let start = 0
  while (start < oldMarkdown.length && start < newMarkdown.length && oldMarkdown[start] === newMarkdown[start]) {
    start++
  }
  let suffix = 0
  while (
    suffix < oldMarkdown.length - start &&
    suffix < newMarkdown.length - start &&
    oldMarkdown[oldMarkdown.length - 1 - suffix] === newMarkdown[newMarkdown.length - 1 - suffix]
  ) {
    suffix++
  }
  let end = oldMarkdown.length - suffix
  let newEnd = newMarkdown.length - suffix
  // Never split a line break's Markdown.
  for (const char of aligned) {
    if (char.from < start && start < char.to) start = char.from
    if (char.from < end && end < char.to) {
      newEnd += char.to - end
      end = char.to
    }
  }
  const middle = newMarkdown.slice(start, newEnd)

  let from: number
  let to: number
  let base: Pick<InlineChar, "styles" | "href">
  if (start === end) {
    const right = aligned.findIndex((char) => char.from === start)
    const left = aligned.findIndex((char) => char.to === start)
    if (right === -1 && left === -1) return null
    from = to = right !== -1 ? right : left + 1
    base = commonStyles(
      [left !== -1 ? aligned[left] : undefined, right !== -1 ? aligned[right] : undefined].filter(
        (char): char is AlignedChar => char !== undefined
      )
    )
  } else {
    from = aligned.findIndex((char) => char.from === start)
    const last = aligned.findIndex((char) => char.to === end)
    if (from === -1 || last === -1 || last < from) return null
    for (let index = from; index < last; index++) {
      if (aligned[index]!.to !== aligned[index + 1]!.from) return null
    }
    to = last + 1
    base = commonStyles(aligned.slice(from, to))
  }

  // The change must leave the block's structure as the parser sees it.
  const [before, after] = await Promise.all([
    markdownToBlocks(dedent(oldMarkdown, indent)),
    markdownToBlocks(dedent(newMarkdown, indent)),
  ])
  if (shapeOf(before as Block[]) !== shapeOf(after as Block[])) return null

  const inserted = await replacementChars(middle, base, contPrefix, plain)
  if (!inserted) return null
  const chars = [...aligned.slice(0, from), ...inserted, ...aligned.slice(to)].map(
    ({ ch, styles, href }) => ({ ch, styles, ...(href === undefined ? {} : { href }) })
  )
  return { ...block, content: buildInline(chars) }
}

function refuseUnsupported(block: Block, context: SpliceContext, reason?: string): never {
  const foreign = foreignProps(block)
  const why =
    reason ??
    (foreign.length > 0
      ? `has properties Worktable does not recognize (${foreign.join(", ")}) that would be lost`
      : "cannot be represented intact in Markdown")
  throw new DocEditError(
    "unsupported_block",
    `The edit changes a ${String(block.type)} block near line ${context.line} that ${why}. Leave that block's text unchanged, or edit it in Worktable.`,
    { line: context.line, blockType: block.type, blockId: block.id, ...(foreign.length ? { fields: foreign } : {}) }
  )
}

function recordModified(stored: Block, result: Block, context: SpliceContext): void {
  context.modified.push(String(stored.id))
  // A changed block loses properties the schema does not know; untouched
  // blocks keep theirs.
  const remaining = new Set(ownLossyFields(result).filter((field) => !field.startsWith("prop:")))
  const dropped = ownLossyFields(stored).filter((field) => !remaining.has(field))
  if (dropped.length > 0) {
    context.formattingDropped.push({ blockId: String(stored.id), fields: dropped })
  }
}

/**
 * Change a block's own text from `oldMarkdown` to `newMarkdown`. Null when
 * the new text is not a single block (the caller re-parses more context).
 */
async function changeOwn(
  stored: Block,
  oldMarkdown: string,
  newMarkdown: string,
  indent: number,
  contPrefix: string,
  context: SpliceContext,
  parsedHint?: Block
): Promise<Block | null> {
  if (foreignProps(stored).length > 0 && context.mode === "edit") refuseUnsupported(stored, context)
  const spliced = await spliceInline(stored, oldMarkdown, newMarkdown, indent, contPrefix)
  if (spliced) {
    const foreign = foreignProps(spliced)
    const result =
      foreign.length > 0
        ? {
            ...spliced,
            props: Object.fromEntries(
              Object.entries(spliced.props).filter(([key]) => !foreign.includes(key))
            ),
          }
        : spliced
    recordModified(stored, result, context)
    return result
  }
  let parsed = parsedHint
  if (!parsed) {
    const blocks = (await markdownToBlocks(dedent(newMarkdown, indent))) as Block[]
    if (blocks.length !== 1 || (blocks[0]!.children?.length ?? 0) > 0) return null
    parsed = blocks[0]!
  }
  const trip = await roundTrip(stored)
  if (!trip.supported || !trip.block) {
    if (context.mode === "edit") refuseUnsupported(stored, context)
    context.formattingDropped.push({ blockId: String(stored.id), fields: [`block:${String(stored.type)}`] })
    context.modified.push(String(stored.id))
    return { ...parsed, id: stored.id }
  }
  const merged = mergeChanged(stored, trip.block, parsed)
  recordModified(stored, merged, context)
  return merged
}

// Text similarity for deciding which changed block an edit came from.
function words(text: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    counts.set(word, (counts.get(word) ?? 0) + 1)
  }
  return counts
}

function wordSimilarity(left: string, right: string): number {
  if (left === right) return 1
  const a = words(left)
  const b = words(right)
  let overlap = 0
  let total = 0
  for (const count of a.values()) total += count
  for (const [word, count] of b) {
    total += count
    overlap += Math.min(count, a.get(word) ?? 0)
  }
  return total === 0 ? 0 : (2 * overlap) / total
}

function compatibleTypes(storedType: unknown, parsedType: unknown): boolean {
  return (
    storedType === parsedType ||
    (contentKind(storedType) === "inline" && contentKind(parsedType) === "inline")
  )
}

/** Below this word overlap, changed blocks of unequal runs never pair. */
const PAIR_SIMILARITY = 0.5
const MAX_PAIRING_CELLS = 250_000

/**
 * Which stored blocks the changed blocks are edits of, in order. Clearly
 * similar blocks pair first; between them, runs of equal length pair slot by
 * slot (an in-place rewrite keeps its identity however much text changed).
 * Blocks merged or split into a different number never lend an id to
 * dissimilar text.
 */
function pairChangedBlocks(
  stored: Block[],
  storedTypes: unknown[],
  parsed: Block[]
): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  if (stored.length * parsed.length <= MAX_PAIRING_CELLS) {
    const storedTexts = stored.map((block) => blocksPlainText([{ ...block, children: [] }]))
    const parsedTexts = parsed.map((block) => blocksPlainText([{ ...block, children: [] }]))
    const weight = (s: number, p: number): number => {
      if (!compatibleTypes(storedTypes[s], parsed[p]!.type)) return 0
      const score = wordSimilarity(storedTexts[s]!, parsedTexts[p]!)
      return score >= PAIR_SIMILARITY ? score : 0
    }
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
  const filled: Array<[number, number]> = []
  let storedCursor = 0
  let parsedCursor = 0
  for (const pair of [...pairs, [stored.length, parsed.length] as [number, number]]) {
    const [s, p] = pair
    if (s - storedCursor === p - parsedCursor) {
      for (let offset = 0; offset < s - storedCursor; offset++) {
        if (compatibleTypes(storedTypes[storedCursor + offset], parsed[parsedCursor + offset]!.type)) {
          filled.push([storedCursor + offset, parsedCursor + offset])
        }
      }
    }
    if (s < stored.length) filled.push(pair)
    storedCursor = s + 1
    parsedCursor = p + 1
  }
  return filled
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

function insertBlocks(parsed: Block[], context: SpliceContext, keys: string[]): Block[] {
  return parsed.map((block, index) => {
    const holder = withFreshIds(block)
    const nodes = countNodes([holder])
    context.inserted += nodes
    context.insertions.push({ holder, key: keys[index]!, nodes })
    return holder
  })
}

function removeBlock(block: Block, key: string, context: SpliceContext): void {
  collectIds([block], context.removedIds)
  context.removals.push({ block, key })
}

/**
 * Splice freshly parsed blocks against the stored blocks they replace:
 * blocks whose Markdown is unchanged are kept verbatim, changed blocks pair
 * with the block they are an edit of, the rest are removed or inserted.
 * Invisible stored blocks (empty paragraphs) stay where they were.
 */
async function spliceParsed(stored: Block[], parsed: Block[], context: SpliceContext): Promise<Block[]> {
  await primeOwnMarkdown([...stored, ...parsed])
  const visibleStored = stored
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => isVisible(block))
  const storedKeys = await Promise.all(visibleStored.map(async ({ block }) => (await standaloneMarkdown(block)).full))
  const parsedKeys = await Promise.all(parsed.map(async (block) => (await standaloneMarkdown(block)).full))
  const anchors = lcs(storedKeys, parsedKeys, (a, b) => a === b)

  const output: Block[] = []
  let flushed = 0
  const flushInvisible = (until: number) => {
    for (; flushed < until; flushed++) {
      const block = stored[flushed]!
      if (!isVisible(block)) {
        output.push(block)
        context.kept += countNodes([block])
      }
    }
  }
  let storedCursor = 0
  let parsedCursor = 0
  for (const [anchorStored, anchorParsed] of [...anchors, [visibleStored.length, parsed.length] as [number, number]]) {
    const gapStored = visibleStored.slice(storedCursor, anchorStored)
    const gapParsed = parsed.slice(parsedCursor, anchorParsed)
    if (gapStored.length > 0) flushInvisible(gapStored[0]!.index)
    output.push(
      ...(await spliceChanged(
        gapStored.map(({ block }) => block),
        storedKeys.slice(storedCursor, anchorStored),
        gapParsed,
        parsedKeys.slice(parsedCursor, anchorParsed),
        context
      ))
    )
    if (gapStored.length > 0) flushInvisible(gapStored.at(-1)!.index + 1)
    if (anchorStored < visibleStored.length) {
      const { block, index } = visibleStored[anchorStored]!
      flushInvisible(index)
      output.push(block)
      context.kept += countNodes([block])
      flushed = index + 1
    }
    storedCursor = anchorStored + 1
    parsedCursor = anchorParsed + 1
  }
  flushInvisible(stored.length)
  return output
}

function containsRun(keys: readonly string[], run: readonly string[]): boolean {
  for (let start = 0; start + run.length <= keys.length; start++) {
    if (run.every((key, offset) => keys[start + offset] === key)) return true
  }
  return false
}

/**
 * Split a changed block whose nested blocks reappear, unchanged and in order,
 * among the parsed blocks into its own text and those nested blocks: its own
 * line was removed or its nested blocks were outdented. The nested blocks
 * then pair with themselves and keep their ids.
 */
async function promoteChildren(
  stored: Block[],
  storedKeys: string[],
  parsedKeys: string[]
): Promise<{ stored: Block[]; storedKeys: string[] }> {
  const blocks: Block[] = []
  const keys: string[] = []
  for (const [index, block] of stored.entries()) {
    const children: Block[] = Array.isArray(block.children) ? block.children.filter(isVisible) : []
    if (children.length > 0) {
      const childKeys = await Promise.all(children.map(async (child) => (await standaloneMarkdown(child)).full))
      if (containsRun(parsedKeys, childKeys)) {
        const own = { ...block, children: [] }
        blocks.push(own, ...children)
        keys.push((await standaloneMarkdown(own)).full, ...childKeys)
        continue
      }
    }
    blocks.push(block)
    keys.push(storedKeys[index]!)
  }
  return { stored: blocks, storedKeys: keys }
}

async function spliceChanged(
  storedBlocks: Block[],
  storedBlockKeys: string[],
  parsed: Block[],
  parsedKeys: string[],
  context: SpliceContext
): Promise<Block[]> {
  const { stored, storedKeys } = await promoteChildren(storedBlocks, storedBlockKeys, parsedKeys)
  if (stored.length === 0) return insertBlocks(parsed, context, parsedKeys)
  if (parsed.length === 0) {
    stored.forEach((block, index) => removeBlock(block, storedKeys[index]!, context))
    return []
  }
  const trips = await Promise.all(stored.map(roundTrip))
  // Re-parsed text around a block Markdown cannot represent cannot be told
  // apart from an edit of it. Deleting such a block outright is fine.
  if (context.mode === "edit") {
    const whole = await Promise.all(stored.map(fullyRoundTrips))
    const unsupported = stored.findIndex((_, index) => !trips[index]!.supported || !whole[index])
    if (unsupported !== -1) refuseUnsupported(stored[unsupported]!, context)
  }
  const storedTypes = stored.map((block, index) => trips[index]!.block?.type ?? block.type)
  const pairs = pairChangedBlocks(stored, storedTypes, parsed)
  const paired = new Set(pairs.map(([s]) => s))
  stored.forEach((block, index) => {
    if (!paired.has(index)) removeBlock(block, storedKeys[index]!, context)
  })
  const output: Block[] = []
  let parsedEmitted = 0
  for (const [s, p] of pairs) {
    output.push(...insertBlocks(parsed.slice(parsedEmitted, p), context, parsedKeys.slice(parsedEmitted, p)))
    output.push(await splicePair(stored[s]!, parsed[p]!, context))
    parsedEmitted = p + 1
  }
  output.push(...insertBlocks(parsed.slice(parsedEmitted), context, parsedKeys.slice(parsedEmitted)))
  return output
}

async function splicePair(stored: Block, parsed: Block, context: SpliceContext): Promise<Block> {
  const storedChildren: Block[] = Array.isArray(stored.children) ? stored.children : []
  const parsedChildren: Block[] = Array.isArray(parsed.children) ? parsed.children : []
  const storedOwn = await standaloneMarkdown({ ...stored, children: [] })
  const parsedOwn = await standaloneMarkdown({ ...parsed, children: [] })
  let result: Block
  if (storedOwn.full === parsedOwn.full) {
    context.kept += 1
    result = { ...stored }
  } else {
    const changed = await changeOwn(
      stored,
      storedOwn.own,
      parsedOwn.own,
      0,
      storedOwn.node.contPrefix,
      context,
      { ...parsed, children: [] }
    )
    result = changed ?? { ...stored }
  }
  result.children = await spliceParsed(storedChildren, parsedChildren, context)
  return result
}

/** Strip list numbering the parser inferred from where a region starts. */
function settleNumbering(parsed: Block[], continuesList: boolean): void {
  parsed.forEach((block, index) => {
    if (block.type !== "numberedListItem" || !block.props) return
    const runStart = index === 0 ? !continuesList : parsed[index - 1]!.type !== "numberedListItem"
    if (!runStart || Number(block.props.start) === 1) delete block.props.start
  })
}

interface Plan {
  node: SpanNode
  kind: "clean" | "internal" | "dirty"
  /** Where the node sits in the edited text. */
  from: number
  to: number
  own?: Block
  ownTouched?: boolean
  childrenTouched?: boolean
}

/**
 * Splice one level of blocks: keep blocks the change did not touch, apply
 * changes inside single blocks in place, and re-parse the text between kept
 * blocks.
 */
async function spliceLevel(
  nodes: SpanNode[],
  bounds: { from: number; to: number },
  top: boolean,
  context: SpliceContext
): Promise<{ blocks: Block[]; regions: SpliceRegion[] }> {
  const { projection, edited } = context
  const original = projection.markdown
  const ranges = edited.originalRanges
  const overlaps = (start: number, end: number) =>
    ranges.some((range) => range.start < end && range.end > start)
  const visible = nodes.filter((node) => node.visible)
  const plans = new Map<SpanNode, Plan>()

  for (const [index, node] of visible.entries()) {
    const previous = visible[index - 1]
    const next = visible[index + 1]
    const leftSeparator = previous ? ([previous.end, node.start] as const) : undefined
    const rightSeparator = next
      ? ([node.end, next.start] as const)
      : top
        ? ([node.end, original.length] as const)
        : undefined
    const touching = ranges.filter((range) => range.start < node.end && range.end > node.start)
    if (touching.length === 0) {
      // Untouched: keep it if the text around it still separates it the same way.
      const from = edited.mapBefore(node.start)
      const to = edited.mapAfter(node.end)
      const leftText = leftSeparator ? original.slice(...leftSeparator) : top ? "\n\n" : ""
      const rightText = rightSeparator ? original.slice(...rightSeparator) : ""
      const leftOk =
        (top && !previous && from === 0) || edited.text.slice(from - leftText.length, from) === leftText
      const rightOk = edited.text.startsWith(rightText, to)
      plans.set(node, { node, kind: leftOk && rightOk ? "clean" : "dirty", from, to })
      continue
    }
    const separatorTouched =
      (leftSeparator !== undefined && overlaps(...leftSeparator)) ||
      (rightSeparator !== undefined && overlaps(...rightSeparator))
    const visibleChildren = node.children.filter((child) => child.visible)
    const childrenFrom = visibleChildren[0]?.start
    const childrenTo = visibleChildren.at(-1)?.end
    let ownTouched = false
    let childrenTouched = false
    const internal = touching.every((range) => {
      if (node.ownEnd > node.start && range.start >= node.start && range.end <= node.ownEnd) {
        ownTouched = true
        return true
      }
      if (childrenFrom !== undefined && range.start >= childrenFrom && range.end <= childrenTo!) {
        childrenTouched = true
        return true
      }
      return false
    })
    if (separatorTouched || !internal || (ownTouched && node.opaque)) {
      plans.set(node, { node, kind: "dirty", from: 0, to: 0 })
      continue
    }
    const from = node.start === 0 ? 0 : edited.mapAfter(node.start)
    const to = edited.mapBefore(node.end)
    const plan: Plan = { node, kind: "internal", from, to, ownTouched, childrenTouched }
    if (ownTouched) {
      context.line = lineAt(original, node.start)
      const ownFrom = from
      const ownTo = edited.mapBefore(node.ownEnd)
      const own = await changeOwn(
        node.block,
        original.slice(node.start, node.ownEnd),
        edited.text.slice(ownFrom, ownTo),
        node.indent,
        node.contPrefix,
        context
      )
      if (!own) {
        plans.set(node, { node, kind: "dirty", from: 0, to: 0 })
        continue
      }
      plan.own = own
    }
    plans.set(node, plan)
  }

  const blocks: Block[] = []
  const regions: SpliceRegion[] = []
  let pending: SpanNode[] = []
  let cursor = bounds.from
  let previousAnchor: SpanNode | undefined

  const flushGap = async (until: number, following?: SpanNode) => {
    const dirty = pending.filter((node) => node.visible)
    const text = edited.text.slice(cursor, until)
    if (dirty.length === 0 && text.trim().length === 0) {
      for (const node of pending) {
        blocks.push(node.block)
        context.kept += countNodes([node.block])
      }
      pending = []
      return
    }
    if (dirty[0]) context.line = lineAt(original, dirty[0].start)
    else context.line = lineAt(edited.text, cursor)
    const opaque = dirty.find((node) => node.opaque)
    if (opaque && context.mode === "edit") {
      context.line = lineAt(original, opaque.start)
      refuseUnsupported(opaque.block, context, "cannot be shown as Markdown")
    }
    const indent = pending[0]?.indent ?? following?.indent ?? previousAnchor?.indent ?? 0
    // Blank text holds no blocks; the parser would invent an empty paragraph.
    let parsed = text.trim().length > 0 ? ((await markdownToBlocks(dedent(text, indent))) as Block[]) : []
    await primeOwnMarkdown(parsed)
    parsed = parsed.filter(isVisible)
    settleNumbering(parsed, previousAnchor?.block.type === "numberedListItem")
    const stored = pending.map((node) => node.block)
    const result = await spliceParsed(stored, parsed, context)
    blocks.push(...result)
    regions.push({
      replacedBlockIds: stored.map((block) => String(block.id)),
      blocks: result,
      ...(following ? { followingBlockId: String(following.block.id) } : {}),
    })
    pending = []
  }

  for (const node of nodes) {
    const plan = node.visible ? plans.get(node)! : undefined
    if (!plan || plan.kind === "dirty") {
      pending.push(node)
      continue
    }
    await flushGap(plan.from, node)
    if (plan.kind === "clean") {
      blocks.push(node.block)
      context.kept += countNodes([node.block])
    } else {
      const block: Block = plan.own ? { ...plan.own } : { ...node.block }
      if (!plan.ownTouched) context.kept += 1
      if (plan.childrenTouched) {
        const children = node.children
        const visibleChildren = children.filter((child) => child.visible)
        const childBounds = {
          from: edited.mapAfter(visibleChildren[0]!.start),
          to: edited.mapBefore(visibleChildren.at(-1)!.end),
        }
        block.children = (await spliceLevel(children, childBounds, false, context)).blocks
      } else {
        block.children = node.block.children ?? []
        context.kept += countNodes(block.children)
      }
      blocks.push(block)
      regions.push({ replacedBlockIds: [String(node.block.id)], blocks: [block] })
    }
    cursor = plan.to
    previousAnchor = node
  }
  await flushGap(bounds.to)
  return { blocks, regions }
}

/** Turn removed-and-reinserted blocks with identical Markdown back into the stored block. */
function settleMoves(context: SpliceContext): void {
  const removed = new Map<string, Block[]>()
  for (const { block, key } of context.removals) {
    const list = removed.get(key)
    if (list) list.push(block)
    else removed.set(key, [block])
  }
  for (const insertion of context.insertions) {
    const original = removed.get(insertion.key)?.shift()
    if (!original) continue
    for (const key of Object.keys(insertion.holder)) delete insertion.holder[key]
    Object.assign(insertion.holder, original)
    context.inserted -= insertion.nodes
    const ids: string[] = []
    collectIds([original], ids)
    const moved = new Set(ids)
    context.removedIds = context.removedIds.filter((id) => !moved.has(id))
    context.kept += ids.length
  }
}

async function spliceProjection(
  projection: MarkdownProjection,
  edited: TextEditResult,
  mode: "edit" | "write"
): Promise<SpliceResult> {
  const context: SpliceContext = {
    mode,
    projection,
    edited,
    line: 1,
    kept: 0,
    modified: [],
    inserted: 0,
    removedIds: [],
    formattingDropped: [],
    removals: [],
    insertions: [],
  }
  const { blocks, regions } = await spliceLevel(
    projection.nodes,
    { from: 0, to: edited.text.length },
    true,
    context
  )
  settleMoves(context)
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
 * Replace a BlockNote document's whole Markdown. The difference to the
 * current projection is applied like an edit: blocks whose text is unchanged
 * keep their ids and formatting; blocks Markdown cannot represent are
 * replaced and reported in `formattingDropped`.
 */
export async function spliceBlockReplacement(
  blocks: unknown[],
  markdown: string
): Promise<SpliceResult & { projection: MarkdownProjection }> {
  const projection = await projectBlocks(blocks)
  const edit = diffTextEdit(projection.markdown, markdown)
  return { ...(await spliceProjection(projection, edit, "write")), projection }
}

/** Numbered lines `first`…`last` of `text`, with `…` between distant runs. */
function numberedLines(text: string, wanted: Set<number>, maxLines: number): string {
  const lines = text.split("\n")
  if (text.endsWith("\n")) lines.pop()
  const ordered = [...wanted].filter((line) => line >= 1 && line <= lines.length).sort((a, b) => a - b)
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

/**
 * Edited region of a text with line numbers, for the agent to check its
 * change without another read.
 */
export function editSnippet(
  text: string,
  ranges: ReadonlyArray<{ start: number; end: number }>,
  context = 1,
  maxLines = 40
): string {
  const wanted = new Set<number>()
  for (const range of ranges) {
    const first = lineAt(text, range.start)
    const last = lineAt(text, Math.max(range.start, range.end - 1))
    for (let line = first - context; line <= last + context; line++) wanted.add(line)
  }
  return numberedLines(text, wanted, maxLines)
}

/**
 * The changed regions in the stored document's projection, with line
 * numbers: each region's blocks, or where removed blocks used to be.
 */
export function regionSnippet(
  projection: MarkdownProjection,
  regions: readonly SpliceRegion[],
  context = 1,
  maxLines = 40
): string {
  const spans = new Map<string, SpanNode>()
  for (const node of projection.nodes) spans.set(String(node.block.id), node)
  const ranges: Array<{ start: number; end: number }> = []
  for (const region of regions) {
    const nodes = region.blocks
      .map((block) => spans.get(String(block.id)))
      .filter((node): node is SpanNode => node !== undefined && node.visible)
    if (nodes.length > 0) {
      ranges.push({ start: nodes[0]!.start, end: nodes.at(-1)!.end })
      continue
    }
    const following = region.followingBlockId ? spans.get(region.followingBlockId) : undefined
    const at = following?.visible ? following.start : Math.max(0, projection.markdown.length - 1)
    ranges.push({ start: at, end: at + 1 })
  }
  return editSnippet(projection.markdown, ranges, context, maxLines)
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
      if (typeof block?.props?.caption === "string") parts.push(block.props.caption)
      parts.push("\n")
      if (Array.isArray(block?.children)) walk(block.children)
    }
  }
  walk(blocks)
  return parts.join("")
}
