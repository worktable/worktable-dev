// ============================================================
// What is inside a plain file, for agents
// ============================================================
//
// One way to read any file's contents: lines of text, a page at a time,
// saying which lines they are and what is missing. A file's type names its
// reader (the file type table's contents surface), and every reader gives
// the same page, so a new type adds a reader and nothing else.
//
// The text reader reads the file itself, at one revision, a chunk at a time:
// it keeps only the lines of the page asked for and counts the rest, so a
// file of any size pages without being held whole. A page stops at a line
// count and at a byte limit. A line longer than the byte limit is cut, and
// the page says so. Text that isn't UTF-8 has no contents.

import { fileTypeFor, fileTypePolicy } from "@worktable/types"
import { readCurrentFileSource, type CurrentFileSource } from "./current-file-source.ts"
import {
  CONTENTS_DEFAULT_LINES,
  CONTENTS_PAGE_MAX_BYTES,
} from "./file-contents-limits.ts"
import { readsAsText } from "./mcp/file-results.ts"


/** A file's contents reader. */
export type ContentsReader = "text"

/**
 * Whether a page holds everything it covers (ready), leaves part of it out
 * (partial, with what and why under missing), or the file has no contents
 * Worktable can read (unsupported, with why).
 */
export type ContentsState = "ready" | "partial" | "unsupported"

/** Something a page leaves out: where, when it is one place, and why. */
export interface ContentsGap {
  where?: string
  why: string
}

export interface ContentsPage {
  state: ContentsState
  /** The page's lines, each with its own line ending, exactly as stored. */
  text: string
  /** The first line on the page, from 1. */
  startLine: number
  /** The last line on the page; startLine - 1 when the page is empty. */
  endLine: number
  /** Lines in the whole file. */
  totalLines: number
  /** Where the next page starts, when there is more. */
  nextOffset?: number
  missing: ContentsGap[]
}

/** The reader for a file's contents, by its name, or null when it has none. */
export function contentsReaderFor(path: string): ContentsReader | null {
  if (fileTypePolicy(fileTypeFor(path), "contents") === "text") return "text"
  return readsAsText(path) ? "text" : null
}

const NEWLINE = 0x0a

/** Bytes of a UTF-8 text that end on a whole character, at most `max`. */
function wholeCharacters(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.byteLength <= max) return bytes
  let end = max
  // Step back over continuation bytes (10xxxxxx) to a character's start.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return bytes.subarray(0, end)
}

/**
 * One page of a text file's lines, taken from its bytes as they are read.
 * Holds the page's bytes and at most one line beyond it; counts the rest.
 */
export class TextLinePage {
  readonly #offset: number
  readonly #limit: number
  readonly #maxBytes: number
  /** The line the next byte belongs to, from 1. */
  #line = 1
  #size = 0
  #lastByte = -1
  /** Whole lines on the page, and their size. */
  #kept: Uint8Array[] = []
  #keptBytes = 0
  #endLine: number
  /** The page's line still being read, up to the byte limit. */
  #pending: Uint8Array[] = []
  #pendingBytes = 0
  /** Whether the page took all it will take. */
  #closed = false
  #cutLine: number | undefined

  constructor(
    offset = 1,
    limit = CONTENTS_DEFAULT_LINES,
    maxBytes = CONTENTS_PAGE_MAX_BYTES
  ) {
    this.#offset = offset
    this.#limit = limit
    this.#maxBytes = maxBytes
    this.#endLine = offset - 1
  }

  update(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return
    this.#size += chunk.byteLength
    this.#lastByte = chunk[chunk.byteLength - 1]!
    for (let start = 0; start < chunk.byteLength; ) {
      const newline = chunk.indexOf(NEWLINE, start)
      const end = newline === -1 ? chunk.byteLength : newline + 1
      if (this.#onPage()) this.#hold(chunk.subarray(start, end))
      if (newline !== -1) {
        if (this.#onPage()) this.#settle()
        this.#line += 1
      }
      start = end
    }
  }

  /** The page, once every byte of the file has been seen. */
  page(): ContentsPage {
    // A last line without a line ending is still a line.
    if (this.#pendingBytes > 0 && this.#onPage()) this.#settle()
    const totalLines =
      this.#size === 0 ? 0 : this.#lastByte === NEWLINE ? this.#line - 1 : this.#line
    const bytes = new Uint8Array(this.#keptBytes)
    let position = 0
    for (const part of this.#kept) {
      bytes.set(part, position)
      position += part.byteLength
    }
    let text: string
    try {
      // A byte-order mark stays, so the text is the file's exactly.
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    } catch {
      return {
        state: "unsupported",
        text: "",
        startLine: this.#offset,
        endLine: this.#offset - 1,
        totalLines,
        missing: [{ why: "This file isn't UTF-8 text. Download it to read its bytes." }],
      }
    }
    const endLine = this.#endLine
    return {
      state: this.#cutLine === undefined ? "ready" : "partial",
      text,
      startLine: this.#offset,
      endLine,
      totalLines,
      ...(endLine < totalLines ? { nextOffset: endLine + 1 } : {}),
      missing:
        this.#cutLine === undefined
          ? []
          : [
              {
                where: `line ${this.#cutLine}`,
                why: `The line is longer than ${this.#maxBytes / 1024} KiB, so it is cut there. Download the file to read all of it.`,
              },
            ],
    }
  }

  #onPage(): boolean {
    return (
      !this.#closed &&
      this.#line >= this.#offset &&
      this.#line < this.#offset + this.#limit
    )
  }

  /** Holds a piece of the current line, never more than the page could take. */
  #hold(piece: Uint8Array): void {
    const room = this.#maxBytes - this.#pendingBytes
    if (room <= 0) {
      this.#pendingBytes += piece.byteLength
      return
    }
    // Four bytes past the limit leave room to end on a whole character.
    const kept = piece.subarray(0, Math.min(piece.byteLength, room + 4))
    this.#pending.push(kept.slice())
    this.#pendingBytes += piece.byteLength
  }

  /** Puts the line just read on the page, or closes the page before it. */
  #settle(): void {
    const line = this.#pending
    const length = this.#pendingBytes
    this.#pending = []
    this.#pendingBytes = 0
    if (this.#keptBytes + length <= this.#maxBytes) {
      this.#kept.push(...line)
      this.#keptBytes += length
      this.#endLine = this.#line
      return
    }
    // Past the byte limit: the page ends before this line, unless it is the
    // page's first, which is kept up to the limit and marked as cut.
    if (this.#kept.length === 0) {
      const joined = new Uint8Array(line.reduce((sum, part) => sum + part.byteLength, 0))
      let position = 0
      for (const part of line) {
        joined.set(part, position)
        position += part.byteLength
      }
      const cut = wholeCharacters(joined, this.#maxBytes)
      this.#kept.push(cut)
      this.#keptBytes = cut.byteLength
      this.#endLine = this.#line
      this.#cutLine = this.#line
    }
    this.#closed = true
  }
}

/**
 * One page of a plain file's contents at its current revision, read outside
 * its Space's lock; null when `path` names no plain file or the file has no
 * contents reader. Throws as readCurrentFileSource does.
 */
export async function readFileContents(options: {
  spaceId: string
  path: string
  offset?: number
  limit?: number
}): Promise<(CurrentFileSource & { contents: ContentsPage }) | null> {
  if (contentsReaderFor(options.path) !== "text") return null
  let page: TextLinePage | undefined
  const file = await readCurrentFileSource({
    spaceId: options.spaceId,
    path: options.path,
    consume: () => (page = new TextLinePage(options.offset, options.limit)),
  })
  if (!file || !page) return null
  return { ...file, contents: page.page() }
}
