import { Parser } from "htmlparser2"
import type { DocumentTextProjection } from "@worktable/types"
import type { DocumentOperationBudget } from "./document-format-registry.ts"

const FATAL_UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
})

export type DocumentProjectionFailure =
  | "invalid"
  | "too-large"
  | "temporarily-unavailable"

export class DocumentProjectionError extends Error {
  readonly reason: DocumentProjectionFailure

  constructor(reason: DocumentProjectionFailure, message: string) {
    super(message)
    this.reason = reason
  }
}

function checkBudget(signal: AbortSignal, deadline: number): void {
  if (signal.aborted || performance.now() > deadline) {
    throw new DocumentProjectionError(
      "temporarily-unavailable",
      "document projection exceeded its deadline"
    )
  }
}

function truncateUtf8(
  value: string,
  maxBytes: number
): {
  value: string
  truncated: boolean
} {
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= maxBytes) return { value, truncated: false }
  const decoder = new TextDecoder("utf-8", { fatal: true })
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 4); end -= 1) {
    try {
      return {
        value: decoder.decode(encoded.subarray(0, end)),
        truncated: true,
      }
    } catch {
      // A UTF-8 code point can span at most four bytes.
    }
  }
  return { value: "", truncated: true }
}

function boundedHeadings(
  headings: readonly string[],
  budget: DocumentOperationBudget
): string[] {
  const result: string[] = []
  let bytes = 0
  const maxBytes = Math.min(16 * 1024, Math.floor(budget.maxOutputBytes / 4))
  for (const heading of headings.slice(0, 200)) {
    const normalized = heading.replace(/\s+/g, " ").trim()
    if (!normalized) continue
    const bounded = truncateUtf8(normalized, 512).value
    const size = Buffer.byteLength(bounded)
    if (bytes + size > maxBytes) break
    result.push(bounded)
    bytes += size
  }
  return result
}

function textProjection(
  text: string,
  headings: readonly string[],
  budget: DocumentOperationBudget,
  alreadyTruncated = false
): DocumentTextProjection {
  const bounded = truncateUtf8(text, budget.maxOutputBytes)
  return {
    kind: "text",
    text: bounded.value,
    headings: boundedHeadings(headings, budget),
    truncated: alreadyTruncated || bounded.truncated,
  }
}

async function readUtf8(input: {
  read: (maxBytes: number) => Promise<Uint8Array>
  budget: DocumentOperationBudget
  signal: AbortSignal
  deadline: number
}): Promise<string> {
  checkBudget(input.signal, input.deadline)
  let rejectForAbort: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const unavailable = () =>
    new DocumentProjectionError(
      "temporarily-unavailable",
      "document projection exceeded its deadline"
    )
  const interrupted = new Promise<never>((_, reject) => {
    rejectForAbort = () => reject(unavailable())
    input.signal.addEventListener("abort", rejectForAbort, { once: true })
    timer = setTimeout(
      () => reject(unavailable()),
      Math.max(0, input.deadline - performance.now())
    )
  })
  let bytes: Uint8Array
  try {
    bytes = await Promise.race([
      input.read(input.budget.maxInputBytes),
      interrupted,
    ])
  } finally {
    if (rejectForAbort)
      input.signal.removeEventListener("abort", rejectForAbort)
    if (timer) clearTimeout(timer)
  }
  try {
    return FATAL_UTF8_DECODER.decode(bytes)
  } catch {
    throw new DocumentProjectionError(
      "invalid",
      "document source is not valid UTF-8"
    )
  }
}

export async function projectMarkdownText(input: {
  read: (maxBytes: number) => Promise<Uint8Array>
  budget: DocumentOperationBudget
  signal: AbortSignal
}): Promise<DocumentTextProjection> {
  const deadline = performance.now() + input.budget.timeoutMs
  const source = await readUtf8({ ...input, deadline })
  const headings: string[] = []
  let fence: { marker: "`" | "~"; length: number } | null = null
  let lines = 0
  for (const line of source.split(/\r?\n/)) {
    checkBudget(input.signal, deadline)
    lines += 1
    if (lines > input.budget.maxElements) {
      throw new DocumentProjectionError(
        "too-large",
        "Markdown projection exceeds its line budget"
      )
    }
    const fenceRun = /^ {0,3}(`+|~+)(.*)$/.exec(line)
    if (fence) {
      if (
        fenceRun?.[1]?.[0] === fence.marker &&
        fenceRun[1].length >= fence.length &&
        /^\s*$/.test(fenceRun[2] ?? "")
      ) {
        fence = null
      }
      continue
    }
    if (
      fenceRun?.[1] &&
      fenceRun[1].length >= 3 &&
      (fenceRun[1][0] === "~" || !(fenceRun[2] ?? "").includes("`"))
    ) {
      fence = {
        marker: fenceRun[1][0] as "`" | "~",
        length: fenceRun[1].length,
      }
      continue
    }
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match?.[1]) headings.push(match[1].replace(/\s+#+\s*$/, "").trimEnd())
  }
  return textProjection(source, headings, input.budget)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export async function projectRichText(input: {
  read: (maxBytes: number) => Promise<Uint8Array>
  budget: DocumentOperationBudget
  signal: AbortSignal
}): Promise<DocumentTextProjection> {
  const deadline = performance.now() + input.budget.timeoutMs
  const source = await readUtf8({ ...input, deadline })
  let blocks: unknown
  try {
    blocks = JSON.parse(source)
  } catch {
    throw new DocumentProjectionError(
      "invalid",
      "rich-text source is not valid JSON"
    )
  }
  if (!Array.isArray(blocks)) {
    throw new DocumentProjectionError(
      "invalid",
      "rich-text source must contain a block array"
    )
  }

  let elements = 0
  const headings: string[] = []
  const paragraphs: string[] = []
  const visit = (value: unknown, depth: number): string => {
    checkBudget(input.signal, deadline)
    elements += 1
    if (elements > input.budget.maxElements || depth > input.budget.maxDepth) {
      throw new DocumentProjectionError(
        "too-large",
        "rich-text projection exceeds its structural budget"
      )
    }
    if (typeof value === "string") return value
    if (Array.isArray(value)) {
      return value.map((item) => visit(item, depth + 1)).join("")
    }
    if (!isRecord(value)) return ""
    if (typeof value["text"] === "string") return value["text"]
    if (value["content"] !== undefined) {
      return visit(value["content"], depth + 1)
    }
    if (Array.isArray(value["rows"])) {
      return value["rows"].map((row) => visit(row, depth + 1)).join("\n")
    }
    if (Array.isArray(value["cells"])) {
      return value["cells"].map((cell) => visit(cell, depth + 1)).join("\t")
    }
    return ""
  }
  const visitBlock = (value: unknown, depth: number): void => {
    checkBudget(input.signal, deadline)
    elements += 1
    if (elements > input.budget.maxElements || depth > input.budget.maxDepth) {
      throw new DocumentProjectionError(
        "too-large",
        "rich-text projection exceeds its structural budget"
      )
    }
    if (!isRecord(value)) return
    const preserveWhitespace = value["type"] === "codeBlock"
    let text = visit(value["content"], depth + 1)
    if (!preserveWhitespace) text = text.trim()
    const props = value["props"]
    if (
      !text &&
      isRecord(props) &&
      typeof props["data"] === "string" &&
      (value["type"] === "codeBlock" || value["type"] === "mermaid")
    ) {
      text = preserveWhitespace ? props["data"] : props["data"].trim()
    }
    if (
      isRecord(props) &&
      (value["type"] === "image" ||
        value["type"] === "audio" ||
        value["type"] === "video" ||
        value["type"] === "file")
    ) {
      const mediaText = [props["name"], props["caption"]]
        .flatMap((candidate) =>
          typeof candidate === "string" && candidate.trim()
            ? [candidate.trim()]
            : []
        )
        .join("\n")
      text = [text, mediaText].filter(Boolean).join("\n")
    }
    if (text) {
      paragraphs.push(text)
      if (value["type"] === "heading") headings.push(text)
    }
    if (Array.isArray(value["children"])) {
      for (const child of value["children"]) visitBlock(child, depth + 1)
    }
  }
  for (const block of blocks) visitBlock(block, 1)
  return textProjection(paragraphs.join("\n\n"), headings, input.budget)
}

const SUPPRESSED_HTML_ELEMENTS = new Set([
  "script",
  "style",
  "template",
  "noscript",
])
const BLOCK_HTML_ELEMENTS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "td",
  "th",
  "title",
  "tr",
  "ul",
])

export async function projectHtmlText(input: {
  read: (maxBytes: number) => Promise<Uint8Array>
  budget: DocumentOperationBudget
  signal: AbortSignal
}): Promise<DocumentTextProjection> {
  const deadline = performance.now() + input.budget.timeoutMs
  const source = await readUtf8({ ...input, deadline })
  const chunks: string[] = []
  const headings: string[] = []
  const suppressed: boolean[] = []
  const activeHeadings: Array<{ depth: number; text: string }> = []
  let suppressedDepth = 0
  let depth = 0
  let elements = 0
  let bytes = 0
  let truncated = false
  let pendingNewline = false
  let pendingSpace = false
  let preformattedDepth = 0

  const appendCollapsed = (value: string): void => {
    const normalized = value.replace(/\s+/g, " ")
    if (!normalized) return
    for (const heading of activeHeadings) heading.text += normalized
    if (truncated) return
    const visible = normalized.trim()
    if (!visible) {
      if (chunks.length > 0 && !pendingNewline) pendingSpace = true
      return
    }
    let separator = ""
    if (chunks.length > 0 && !chunks.at(-1)?.endsWith("\n")) {
      if (pendingNewline) separator = "\n"
      else if (pendingSpace || normalized.startsWith(" ")) separator = " "
    }
    pendingNewline = false
    pendingSpace = false
    if (separator) {
      if (bytes >= input.budget.maxOutputBytes) {
        truncated = true
        return
      }
      chunks.push(separator)
      bytes += 1
    }
    const remaining = input.budget.maxOutputBytes - bytes
    if (remaining <= 0) {
      truncated = true
      return
    }
    const bounded = truncateUtf8(visible, remaining)
    if (bounded.value) {
      chunks.push(bounded.value)
      bytes += Buffer.byteLength(bounded.value)
    }
    if (bounded.truncated) truncated = true
    else if (normalized.endsWith(" ")) pendingSpace = true
  }
  const appendPreformatted = (value: string): void => {
    if (!value) return
    for (const heading of activeHeadings) heading.text += value
    if (truncated) return
    if (
      pendingNewline &&
      chunks.length > 0 &&
      !chunks.at(-1)?.endsWith("\n") &&
      !value.startsWith("\n")
    ) {
      if (bytes >= input.budget.maxOutputBytes) {
        truncated = true
        return
      }
      chunks.push("\n")
      bytes += 1
    }
    pendingNewline = false
    pendingSpace = false
    const remaining = input.budget.maxOutputBytes - bytes
    if (remaining <= 0) {
      truncated = true
      return
    }
    const bounded = truncateUtf8(value, remaining)
    if (bounded.value) {
      chunks.push(bounded.value)
      bytes += Buffer.byteLength(bounded.value)
    }
    if (bounded.truncated) truncated = true
  }
  const newline = (): void => {
    if (!truncated && chunks.length > 0) {
      pendingNewline = true
      pendingSpace = false
    }
  }
  const tick = (): void => {
    checkBudget(input.signal, deadline)
    elements += 1
    if (elements > input.budget.maxElements) {
      throw new DocumentProjectionError(
        "too-large",
        "HTML projection exceeds its element budget"
      )
    }
  }

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        tick()
        depth += 1
        if (depth > input.budget.maxDepth) {
          throw new DocumentProjectionError(
            "too-large",
            "HTML projection exceeds its depth budget"
          )
        }
        const hidden =
          SUPPRESSED_HTML_ELEMENTS.has(name) || "hidden" in attributes
        suppressed.push(hidden)
        if (hidden) suppressedDepth += 1
        if (suppressedDepth > 0) return
        if (BLOCK_HTML_ELEMENTS.has(name)) newline()
        if (name === "pre") preformattedDepth += 1
        if (/^h[1-6]$/.test(name)) {
          activeHeadings.push({ depth, text: "" })
        }
      },
      ontext(text) {
        tick()
        if (suppressedDepth === 0) {
          if (preformattedDepth > 0) appendPreformatted(text)
          else appendCollapsed(text)
        }
      },
      onclosetag(name) {
        tick()
        if (suppressedDepth === 0 && /^h[1-6]$/.test(name)) {
          const heading = activeHeadings.pop()
          if (heading) headings.push(heading.text)
        }
        if (suppressedDepth === 0 && name === "pre") {
          preformattedDepth = Math.max(0, preformattedDepth - 1)
        }
        if (suppressedDepth === 0 && BLOCK_HTML_ELEMENTS.has(name)) newline()
        const hidden = suppressed.pop()
        if (hidden) suppressedDepth -= 1
        depth = Math.max(0, depth - 1)
      },
    },
    {
      decodeEntities: true,
      lowerCaseTags: true,
      recognizeSelfClosing: true,
    }
  )
  parser.end(source)
  const text = chunks.join("")
  return textProjection(text, headings, input.budget, truncated)
}
