// How a file reads for an agent, as the file type
// table's agent policy says: an image as an image, text as text, and an
// overwritten CSV or TSV with what changed in it.

import {
  FILE_TYPES,
  delimiterForFilename,
  fileDelimiter,
  fileTypeFor,
  fileTypePolicy,
  foldFileName,
  parseDelimitedText,
} from "@worktable/types"

/** Whether a file is a delimited table, whose overwrite says what changed. */
export function isDelimitedFile(path: string): boolean {
  return fileDelimiter(path) !== null
}

/** Images up to this size travel as images; larger ones as base64. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** Text up to this size travels as text. */
const TEXT_MAX_BYTES = 1024 * 1024

/**
 * Source code the file type table doesn't list, by extension, which agents
 * on the preview surface read as text. Its page still shows it as a file.
 */
const PREVIEW_CODE_EXTENSIONS = new Set([
  "py", "pyi", "rb", "go", "rs", "java", "kt", "kts", "scala", "swift", "m",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "fs", "php", "pl", "pm",
  "lua", "r", "jl", "dart", "ex", "exs", "erl", "hrl", "hs", "clj", "cljs",
  "ml", "mli", "nim", "zig", "sh", "bash", "zsh", "fish", "ps1", "sql",
  "graphql", "gql", "proto", "tsx", "jsx", "mjs", "cjs", "mts", "cts", "vue",
  "svelte", "scss", "sass", "less", "tf", "hcl", "gradle", "cmake", "mk",
])

/** A path's extension under the file type table's case rule, or "". */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  return dot <= 0 ? "" : foldFileName(base.slice(dot + 1))
}

/**
 * How an agent reads a file of this type: on the preview surface, source
 * code the table doesn't list and a Dockerfile come as text.
 */
function agentReads(path: string, preview: boolean) {
  const type = fileTypeFor(path)
  const reads = fileTypePolicy(type, "agent")
  if (
    preview &&
    reads === "bytes" &&
    (type === "dockerfile" ||
      (type === null && PREVIEW_CODE_EXTENSIONS.has(extensionOf(path))))
  ) {
    return { type, reads: "text" as const }
  }
  return { type, reads }
}

/** Whether a file is an AVIF, which the preview surface converts for agents. */
export function isAvifFile(path: string): boolean {
  return fileTypeFor(path) === "avif"
}

/**
 * How a file of this name and size may read: as an image or as text when it
 * is one and small enough, else null. Decided without its bytes, so a file
 * that reads as neither needn't be loaded to find that out.
 */
export function fileReadsAs(
  path: string,
  byteLength: number,
  options: { preview?: boolean } = {}
): "image" | "text" | null {
  const { type, reads } = agentReads(path, options.preview === true)
  if (type !== null && reads === "image") {
    return byteLength <= IMAGE_MAX_BYTES ? "image" : null
  }
  return reads === "text" && byteLength <= TEXT_MAX_BYTES ? "text" : null
}

/** A file as an image or as text, when it is one and small enough. */
export function readableFileSource(
  path: string,
  bytes: Uint8Array,
  options: { preview?: boolean } = {}
):
  | { kind: "image"; mediaType: string }
  | { kind: "text"; text: string }
  | null {
  const reads = fileReadsAs(path, bytes.byteLength, options)
  if (reads === null) return null
  if (reads === "image") {
    return { kind: "image", mediaType: FILE_TYPES[fileTypeFor(path)!].mediaType }
  }
  try {
    return {
      kind: "text",
      // A byte-order mark stays, so writing the text back keeps the file.
      text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
    }
  } catch {
    return null
  }
}

export interface DelimitedChanges {
  header: "unchanged" | "changed"
  rowsBefore: number
  rowsAfter: number
  /** Rows the file still has exactly as before. */
  rowsKept: number
  rowsAdded: number
  rowsRemoved: number
}

/** Tables larger than these get no summary; the write itself still lands. */
const CHANGES_MAX_BYTES = 4 * 1024 * 1024
const CHANGES_MAX_ROWS = 20_000

/**
 * What overwriting a CSV or TSV changed, row by row as whole rows, or null
 * for tables too large to compare.
 */
export function delimitedChanges(
  path: string,
  before: Uint8Array,
  after: Uint8Array
): DelimitedChanges | null {
  if (
    before.byteLength > CHANGES_MAX_BYTES ||
    after.byteLength > CHANGES_MAX_BYTES
  ) {
    return null
  }
  const delimiter = delimiterForFilename(path)
  // Bytes that aren't UTF-8 could read as equal when they differ, so such
  // tables get no summary rather than a wrong one.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  let old: ReturnType<typeof parseDelimitedText>
  let next: ReturnType<typeof parseDelimitedText>
  try {
    old = parseDelimitedText(decoder.decode(before), delimiter, {
      maxRows: CHANGES_MAX_ROWS,
    })
    next = parseDelimitedText(decoder.decode(after), delimiter, {
      maxRows: CHANGES_MAX_ROWS,
    })
  } catch {
    return null
  }
  if (old.rowCount > CHANGES_MAX_ROWS || next.rowCount > CHANGES_MAX_ROWS) {
    return null
  }
  const key = (row: string[]) => JSON.stringify(row)
  const remaining = new Map<string, number>()
  for (const row of old.rows) {
    remaining.set(key(row), (remaining.get(key(row)) ?? 0) + 1)
  }
  let kept = 0
  for (const row of next.rows) {
    const count = remaining.get(key(row)) ?? 0
    if (count > 0) {
      kept += 1
      remaining.set(key(row), count - 1)
    }
  }
  return {
    header: key(old.header) === key(next.header) ? "unchanged" : "changed",
    rowsBefore: old.rows.length,
    rowsAfter: next.rows.length,
    rowsKept: kept,
    rowsAdded: next.rows.length - kept,
    rowsRemoved: old.rows.length - kept,
  }
}
