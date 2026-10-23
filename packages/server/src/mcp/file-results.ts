// How a file reads for an agent on the preview surface: an image as an image,
// text as text, and an overwritten CSV or TSV with what changed in it.

import {
  delimiterForFilename,
  parseDelimitedText,
} from "@worktable/types"

const IMAGE_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}
const TEXT_NAME =
  /\.(?:csv|tsv|txt|log|md|json|jsonl|ya?ml|xml|svg|html?|css|js|ts|ini|toml)$/i
export const DELIMITED_NAME = /\.(?:csv|tsv)$/i

/** Images up to this size travel as images; larger ones as base64. */
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
/** Text up to this size travels as text. */
const TEXT_MAX_BYTES = 1024 * 1024

function extension(path: string): string {
  const dot = path.lastIndexOf(".")
  return dot > path.lastIndexOf("/") ? path.slice(dot).toLowerCase() : ""
}

/** A file as an image or as text, when it is one and small enough. */
export function readableFileSource(
  path: string,
  bytes: Uint8Array
):
  | { kind: "image"; mediaType: string }
  | { kind: "text"; text: string }
  | null {
  const mediaType = IMAGE_TYPES[extension(path)]
  if (mediaType) {
    return bytes.byteLength <= IMAGE_MAX_BYTES ? { kind: "image", mediaType } : null
  }
  if (!TEXT_NAME.test(path) || bytes.byteLength > TEXT_MAX_BYTES) return null
  try {
    return {
      kind: "text",
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
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

/** What overwriting a CSV or TSV changed, row by row as whole rows. */
export function delimitedChanges(
  path: string,
  before: Uint8Array,
  after: Uint8Array
): DelimitedChanges {
  const delimiter = delimiterForFilename(path)
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
  const old = parseDelimitedText(decode(before), delimiter)
  const next = parseDelimitedText(decode(after), delimiter)
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
