import {
  getMermaidSource,
  isCustomMermaidBlock,
  isMermaidCodeBlock,
  isMermaidLanguage,
  normalizeMermaidBlocks,
  type MermaidDocumentIssue,
  type MermaidDocumentRepair,
  type MermaidRepresentation,
} from "@worktable/types"
import { fromMarkdown } from "mdast-util-from-markdown"
import { validateMermaid } from "./mermaid.ts"

interface SourceLine {
  text: string
  ending: string
  start: number
}

interface EscapedFenceMarker {
  character: "`" | "~"
  count: number
  markerStart: number
  markerEnd: number
  rest: string
}

interface MarkdownAstNode {
  type: string
  lang?: string | null
  value?: string
  position?: {
    start: { line: number }
    end: { line: number }
  }
  children?: MarkdownAstNode[]
}

export interface MermaidDocumentDiagram {
  source: string
  representation: MermaidRepresentation
  diagramIndex: number
  startLine?: number
  endLine?: number
  blockId?: string
}

export interface PreparedDocumentContent {
  content: string | unknown[]
  diagrams: MermaidDocumentDiagram[]
  repairs: MermaidDocumentRepair[]
  issues: MermaidDocumentIssue[]
}

export class MermaidDocumentValidationError extends Error {
  readonly code = "INVALID_MERMAID_DOCUMENT" as const
  readonly issues: MermaidDocumentIssue[]

  constructor(issues: MermaidDocumentIssue[]) {
    super("The document contains invalid Mermaid; no changes were saved.")
    this.name = "MermaidDocumentValidationError"
    this.issues = issues
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      issues: this.issues,
    }
  }
}

function sourceLines(markdown: string): SourceLine[] {
  const lines: SourceLine[] = []
  let cursor = 0
  while (cursor < markdown.length) {
    const match = /\r\n|\n|\r/.exec(markdown.slice(cursor))
    if (!match || match.index === undefined) {
      lines.push({ text: markdown.slice(cursor), ending: "", start: cursor })
      cursor = markdown.length
      break
    }
    const end = cursor + match.index
    lines.push({
      text: markdown.slice(cursor, end),
      ending: match[0],
      start: cursor,
    })
    cursor = end + match[0].length
  }
  if (markdown.length === 0 || /(?:\r\n|\n|\r)$/.test(markdown)) {
    lines.push({ text: "", ending: "", start: markdown.length })
  }
  return lines
}

function openingLanguage(marker: EscapedFenceMarker): string {
  return marker.rest.trim().split(/\s+/, 1)[0] ?? ""
}

function escapedFenceMarker(line: string): EscapedFenceMarker | null {
  const matches = [
    ...line.matchAll(/(?:\\`){3,}/g),
    ...line.matchAll(/(?:\\~){3,}/g),
  ].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))

  for (const match of matches) {
    const markerStart = match.index ?? 0
    const markerEnd = markerStart + match[0].length
    const rest = line.slice(markerEnd)
    const character = match[0].includes("`") ? "`" : "~"
    const marker = {
      character,
      count: match[0].length / 2,
      markerStart,
      markerEnd,
      rest,
    } satisfies EscapedFenceMarker
    if (rest.trim().length === 0 || isMermaidLanguage(openingLanguage(marker))) {
      return marker
    }
  }
  return null
}

function markdownCodeNodes(markdown: string): MarkdownAstNode[] {
  const codes: MarkdownAstNode[] = []
  const walk = (node: MarkdownAstNode) => {
    if (
      node.type === "code" &&
      isMermaidLanguage(node.lang) &&
      node.position
    ) {
      codes.push(node)
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(fromMarkdown(markdown) as MarkdownAstNode)
  return codes
}

function unescapePotentialMermaidFences(lines: SourceLine[]): string {
  return lines
    .map((line) => {
      const marker = escapedFenceMarker(line.text)
      const text = marker
        ? line.text.slice(0, marker.markerStart) +
          marker.character.repeat(marker.count) +
          line.text.slice(marker.markerEnd)
        : line.text
      return text + line.ending
    })
    .join("")
}

interface MarkdownScanResult {
  diagrams: MermaidDocumentDiagram[]
  repairs: MermaidDocumentRepair[]
  issues: MermaidDocumentIssue[]
  replacements: Array<{ start: number; end: number; text: string }>
  escapedRanges: Array<{
    start: number
    end: number
    markdown: string
    containerPrefix: string
  }>
}

function scanMarkdown(markdown: string): MarkdownScanResult {
  const lines = sourceLines(markdown)
  const diagrams: MermaidDocumentDiagram[] = []
  const repairs: MermaidDocumentRepair[] = []
  const issues: MermaidDocumentIssue[] = []
  const replacements: MarkdownScanResult["replacements"] = []
  const escapedRanges: MarkdownScanResult["escapedRanges"] = []
  if (
    !/(?:`{3,}|~{3,}|(?:\\`){3,}|(?:\\~){3,})[^\S\r\n]*(?:mermaid|mmd)\b/i.test(
      markdown
    )
  ) {
    return { diagrams, repairs, issues, replacements, escapedRanges }
  }

  const unescaped = unescapePotentialMermaidFences(lines)
  const escapedNodes =
    unescaped === markdown ? [] : markdownCodeNodes(unescaped)
  const candidates = [
    ...markdownCodeNodes(markdown).map((node) => ({ node, escaped: false })),
    ...escapedNodes
      .filter((node) => {
        const startLine = node.position!.start.line
        const opening = escapedFenceMarker(lines[startLine - 1]?.text ?? "")
        return !!opening && isMermaidLanguage(openingLanguage(opening))
      })
      .map((node) => ({ node, escaped: true })),
  ].sort(
    (a, b) => a.node.position!.start.line - b.node.position!.start.line
  )

  for (const [index, candidate] of candidates.entries()) {
    const { node, escaped } = candidate
    const diagramIndex = index + 1
    const startLine = node.position!.start.line
    const endLine = node.position!.end.line
    if (!escaped) {
      diagrams.push({
        source: node.value ?? "",
        representation: "markdown-fence",
        diagramIndex,
        startLine,
        endLine,
      })
      continue
    }

    const openingLine = lines[startLine - 1]!
    const opening = escapedFenceMarker(openingLine.text)!
    const closingLine = lines[endLine - 1]
    const closing = closingLine
      ? escapedFenceMarker(closingLine.text)
      : null
    if (
      !closing ||
      closing.character !== opening.character ||
      closing.count < opening.count ||
      closing.rest.trim().length > 0
    ) {
      issues.push({
        code: "UNPAIRED_ESCAPED_MERMAID_FENCE",
        representation: "escaped-markdown-fence",
        diagramIndex,
        startLine,
        message:
          "Escaped Mermaid opening fence has no paired escaped closing fence.",
      })
      continue
    }

    replacements.push({
      start: openingLine.start + opening.markerStart,
      end: openingLine.start + opening.markerEnd,
      text: opening.character.repeat(opening.count),
    })
    replacements.push({
      start: closingLine.start + closing.markerStart,
      end: closingLine.start + closing.markerEnd,
      text: closing.character.repeat(closing.count),
    })
    repairs.push({
      code: "ESCAPED_MERMAID_FENCE_REPAIRED",
      diagramIndex,
      startLine,
      endLine,
    })
    const rangeStart = openingLine.start
    const rangeEnd = closingLine.start + closingLine.text.length
    escapedRanges.push({
      start: rangeStart,
      end: rangeEnd,
      markdown: markdown.slice(rangeStart, rangeEnd),
      containerPrefix: openingLine.text.slice(0, opening.markerStart),
    })
  }

  return { diagrams, repairs, issues, replacements, escapedRanges }
}

export interface EscapedMermaidFenceProtection {
  markdown: string
  literals: Array<{ placeholder: string; markdown: string }>
}

export function protectEscapedMermaidFences(
  markdown: string
): EscapedMermaidFenceProtection {
  const scanned = scanMarkdown(markdown)
  const literals = scanned.escapedRanges.map((range, index) => {
    let suffix = index + 1
    let placeholder = `WorktableEscapedMermaidPlaceholder${suffix}`
    while (markdown.includes(placeholder)) {
      suffix += scanned.escapedRanges.length + 1
      placeholder = `WorktableEscapedMermaidPlaceholder${suffix}`
    }
    return { ...range, placeholder }
  })
  let protectedMarkdown = markdown
  for (const literal of [...literals].sort((a, b) => b.start - a.start)) {
    protectedMarkdown =
      protectedMarkdown.slice(0, literal.start) +
      literal.containerPrefix +
      literal.placeholder +
      protectedMarkdown.slice(literal.end)
  }
  return {
    markdown: protectedMarkdown,
    literals: literals.map(({ placeholder, markdown: literalMarkdown }) => ({
      placeholder,
      markdown: literalMarkdown,
    })),
  }
}

export function restoreEscapedMermaidFences(
  markdown: string,
  protection: EscapedMermaidFenceProtection
): string {
  let restored = markdown
  for (const literal of protection.literals) {
    const placeholderAt = restored.indexOf(literal.placeholder)
    if (placeholderAt === -1) continue
    const lineStart = Math.max(
      restored.lastIndexOf("\n", placeholderAt - 1),
      restored.lastIndexOf("\r", placeholderAt - 1)
    ) + 1
    const nextLineFeed = restored.indexOf("\n", placeholderAt)
    const nextCarriageReturn = restored.indexOf("\r", placeholderAt)
    const lineEndCandidates = [nextLineFeed, nextCarriageReturn].filter(
      (index) => index !== -1
    )
    const lineEnd = lineEndCandidates.length
      ? Math.min(...lineEndCandidates)
      : restored.length
    restored =
      restored.slice(0, lineStart) +
      literal.markdown +
      restored.slice(lineEnd)
  }
  return restored
}

export function repairEscapedMermaidFences(markdown: string): {
  markdown: string
  repairs: MermaidDocumentRepair[]
  issues: MermaidDocumentIssue[]
} {
  const scanned = scanMarkdown(markdown)
  let repaired = markdown
  for (const replacement of [...scanned.replacements].sort(
    (a, b) => b.start - a.start
  )) {
    repaired =
      repaired.slice(0, replacement.start) +
      replacement.text +
      repaired.slice(replacement.end)
  }
  return {
    markdown: repaired,
    repairs: scanned.repairs,
    issues: scanned.issues,
  }
}

export function extractMarkdownMermaid(
  markdown: string
): MermaidDocumentDiagram[] {
  return scanMarkdown(markdown).diagrams
}

function extractBlockMermaid(blocks: unknown[]): MermaidDocumentDiagram[] {
  const diagrams: MermaidDocumentDiagram[] = []

  const walk = (values: unknown[]) => {
    for (const value of values) {
      if (!value || typeof value !== "object") continue
      const block = value as Record<string, unknown>
      if (isCustomMermaidBlock(block) || isMermaidCodeBlock(block)) {
        diagrams.push({
          source: getMermaidSource(block) ?? "",
          representation: isCustomMermaidBlock(block)
            ? "custom-block"
            : "code-block",
          diagramIndex: diagrams.length + 1,
          blockId: typeof block.id === "string" ? block.id : undefined,
        })
      }
      if (Array.isArray(block.children)) walk(block.children)
    }
  }

  walk(blocks)
  return diagrams
}

async function validationIssues(
  diagrams: MermaidDocumentDiagram[]
): Promise<MermaidDocumentIssue[]> {
  const issues: MermaidDocumentIssue[] = []
  for (const diagram of diagrams) {
    if (!diagram.source.trim()) {
      issues.push({
        code: "EMPTY_MERMAID",
        representation: diagram.representation,
        diagramIndex: diagram.diagramIndex,
        startLine: diagram.startLine,
        endLine: diagram.endLine,
        blockId: diagram.blockId,
        message: "Mermaid source is empty.",
      })
      continue
    }
    const result = await validateMermaid(diagram.source)
    if (!result.ok) {
      issues.push({
        code: "INVALID_MERMAID",
        representation: diagram.representation,
        diagramIndex: diagram.diagramIndex,
        startLine: diagram.startLine,
        endLine: diagram.endLine,
        blockId: diagram.blockId,
        message: result.error ?? "Mermaid source is invalid.",
      })
    }
  }
  return issues
}

export async function prepareDocumentContent(
  content: string | unknown[],
  options: {
    validation: "strict" | "allow-invalid"
    repairEscapedFences?: boolean
  }
): Promise<PreparedDocumentContent> {
  let preparedContent: string | unknown[] = content
  let repairs: MermaidDocumentRepair[] = []
  let issues: MermaidDocumentIssue[] = []
  let diagrams: MermaidDocumentDiagram[]

  if (typeof content === "string") {
    const repaired = options.repairEscapedFences === false
      ? { markdown: content, repairs: [], issues: [] }
      : repairEscapedMermaidFences(content)
    preparedContent = repaired.markdown
    repairs = repaired.repairs
    issues = repaired.issues
    diagrams = extractMarkdownMermaid(repaired.markdown)
  } else {
    const normalized = normalizeMermaidBlocks(content)
    preparedContent = normalized.blocks
    diagrams = extractBlockMermaid(normalized.blocks)
  }

  if (options.validation === "strict") {
    issues.push(...(await validationIssues(diagrams)))
    if (issues.length > 0) {
      throw new MermaidDocumentValidationError(issues)
    }
  }

  return { content: preparedContent, diagrams, repairs, issues }
}
