// ============================================================
// What is inside a plain file, for agents
// ============================================================
//
// One way to read any file's contents: lines of text, a page at a time,
// saying which lines they are and what is missing. A file's type names its
// reader (the file type table's contents surface), and every reader gives
// the same page, so a new type adds a reader and nothing else.
//
// A file a reader must parse (PDF) is parsed in the contents lane and its
// contents kept in the derived store (parsed-contents.ts); its pages come
// from there.
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
import type { ParsingReaderId } from "./contents-reader-versions.ts"
import { readParsedContents } from "./parsed-contents.ts"


/** A file's contents reader: the text itself, or a reader that parses it. */
export type ContentsReader = "text" | ParsingReaderId

/**
 * Whether a page holds everything it covers (ready), leaves part of it out
 * (partial, with what and why under missing), is still being read
 * (pending), or the file has no contents Worktable can read: of a kind or
 * past a limit it doesn't read (unsupported), password protected
 * (encrypted), or a reader that stopped (failed), each with why.
 */
export type ContentsState =
  | "ready"
  | "partial"
  | "pending"
  | "unsupported"
  | "encrypted"
  | "failed"

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
  /** For a parsed file: where each part (a page) starts. */
  outline?: { label: string; line: number }[]
  /** For a parsed file: what it is, such as its page count. */
  facts?: Record<string, string | number | boolean>
}

/** The reader for a file's contents, by its name, or null when it has none. */
export function contentsReaderFor(path: string): ContentsReader | null {
  const reader = fileTypePolicy(fileTypeFor(path), "contents")
  if (reader !== "none") return reader
  return readsAsText(path) ? "text" : null
}

const NEWLINE = 0x0a

/**
 * At most `max` bytes of UTF-8 text, ending on a whole character: a last
 * character the limit splits is left out. Decided from the bytes kept alone.
 */
function wholeCharacters(bytes: Uint8Array, max: number): Uint8Array {
  const end = Math.min(bytes.byteLength, max)
  if (end === 0) return bytes.subarray(0, 0)
  // The last character starts at the last byte that isn't a continuation
  // byte (10xxxxxx), at most three bytes back.
  let start = end - 1
  while (start > 0 && end - start < 4 && (bytes[start]! & 0xc0) === 0x80) start -= 1
  const lead = bytes[start]!
  const length = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return bytes.subarray(0, start + length <= end ? end : start)
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
    const length = chunk.byteLength
    if (length === 0) return
    this.#size += length
    this.#lastByte = chunk[length - 1]!
    for (let at = 0; at < length; ) {
      if (this.#onPage()) {
        // On the page, line by line: at most `limit` lines.
        const newline = chunk.indexOf(NEWLINE, at)
        const end = newline === -1 ? length : newline + 1
        this.#hold(chunk.subarray(at, end))
        if (newline === -1) return
        this.#settle()
        this.#line += 1
        at = end
      } else if (!this.#closed && this.#line < this.#offset) {
        // Before the page, lines are only counted, a byte at a time, until
        // the page's first line starts.
        while (at < length) {
          if (chunk[at++] === NEWLINE && ++this.#line === this.#offset) break
        }
      } else {
        // After it, the rest is counted the same way: no work per line, so
        // a file of nothing but line endings costs what hashing it does.
        let lines = 0
        for (; at < length; at += 1) if (chunk[at] === NEWLINE) lines += 1
        this.#line += lines
      }
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
    if (room > 0) this.#pending.push(piece.subarray(0, room).slice())
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
  const reader = contentsReaderFor(options.path)
  if (reader === null) return null
  if (reader !== "text") return readParsedContents({ ...options, reader })
  let page: TextLinePage | undefined
  const file = await readCurrentFileSource({
    spaceId: options.spaceId,
    path: options.path,
    consume: () => (page = new TextLinePage(options.offset, options.limit)),
  })
  if (!file || !page) return null
  return { ...file, contents: page.page() }
}
