import type { BigIntStats } from "node:fs"
import { readFileSync, statSync } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { DOCUMENT_GENERATION_MAX_ENTRY_BYTES } from "@worktable/types"
import { FingerprintCache, fingerprintOf } from "./file-fingerprint.ts"
import {
  checkRichTextBlocks,
  RICH_TEXT_SOURCE_BUDGET,
  richTextSourceIsDoc,
} from "./rich-text-blocks.ts"
import {
  readStagedFile,
  readStagedFilePrefix,
  type StagedFile,
} from "./staged-file.ts"

// ============================================================
// Whether a `.json` below docs/ is a Doc or a plain file
// ============================================================
//
// One rule wherever a `.json` path could become a Doc's key: the catalog, the
// Doc store, filesystem events and lifecycle recovery. The inventory's claim
// decides first, so a file stays a file whatever is written into it and a Doc
// stays a Doc, unreadable while its bytes aren't Doc blocks. A source without
// a claim is a Doc only when it holds Doc blocks and is no larger than a Doc
// can be written. A plain file goes by its whole filename.
//
// Costs stats: the parsed inventory and each file's answer are kept while
// their fingerprints hold, and the catalog's title read fills the latter. A
// file changed within the racy window, or one that could not be read, is
// read again next time.

const inventoryFormats = new FingerprintCache<ReadonlyMap<string, string>>(
  1_024
)
const richTextFiles = new FingerprintCache<boolean>(50_000)
const INVENTORY_FILE = "documents.meta.json"
const MAX_DOC_BYTES = BigInt(DOCUMENT_GENERATION_MAX_ENTRY_BYTES)

/** Kept by the catalog from the read that names a Doc. */
export function rememberRichTextFile(
  file: string,
  fingerprintKey: string,
  doc: boolean
): void {
  richTextFiles.set(file, fingerprintKey, doc)
}

function parseInventoryFormats(text: string): ReadonlyMap<string, string> {
  const formats = new Map<string, string>()
  try {
    const inventory = JSON.parse(text) as {
      documents?: Record<
        string,
        {
          format?: { id?: unknown }
          source?: { kind?: unknown; relativePath?: unknown }
        }
      >
    }
    for (const entry of Object.values(inventory.documents ?? {})) {
      if (
        entry?.source?.kind === "file" &&
        typeof entry.source.relativePath === "string" &&
        typeof entry.format?.id === "string"
      ) {
        formats.set(entry.source.relativePath, entry.format.id)
      }
    }
  } catch {
    // An unreadable inventory claims nothing; the catalog reports it.
  }
  return formats
}

type Io = {
  stat: (path: string) => BigIntStats | null | Promise<BigIntStats | null>
  read: (path: string) => string | Promise<string>
}

const asyncIo: Io = {
  stat: (path) => stat(path, { bigint: true }).catch(() => null),
  read: (path) => readFile(path, "utf8"),
}

const syncIo: Io = {
  stat: (path) => {
    try {
      return statSync(path, { bigint: true })
    } catch {
      return null
    }
  },
  read: (path) => readFileSync(path, "utf8"),
}

function* classify(
  spaceRoot: string,
  relativePath: string
): Generator<
  { stat: string } | { read: string },
  boolean,
  BigIntStats | null | string
> {
  const inventoryPath = join(spaceRoot, INVENTORY_FILE)
  const inventoryInfo = (yield { stat: inventoryPath }) as BigIntStats | null
  let formats: ReadonlyMap<string, string> = new Map()
  if (inventoryInfo) {
    const fingerprint = fingerprintOf(inventoryInfo)
    const cached = inventoryFormats.get(inventoryPath, fingerprint.key)
    if (cached) {
      formats = cached
    } else {
      let text: string | null = null
      try {
        text = (yield { read: inventoryPath }) as string
      } catch {
        // Unreadable now; nothing is kept, so the next call reads again.
      }
      if (text !== null) {
        formats = parseInventoryFormats(text)
        if (!fingerprint.racy) {
          inventoryFormats.set(inventoryPath, fingerprint.key, formats)
        }
      }
    }
  }
  const registered = formats.get(relativePath)
  if (registered !== undefined) return registered !== "worktable.file"

  const file = join(spaceRoot, relativePath)
  const info = (yield { stat: file }) as BigIntStats | null
  // Gone, or not a regular file: whatever reads it next reports why.
  if (!info || !info.isFile()) return true
  if (info.size > MAX_DOC_BYTES) return false
  const fingerprint = fingerprintOf(info)
  const cached = richTextFiles.get(file, fingerprint.key)
  if (cached !== undefined) return cached
  let text: string
  try {
    text = (yield { read: file }) as string
  } catch {
    // Unreadable now: it stays what its name says for this call only.
    return true
  }
  const doc = richTextSourceIsDoc(text)
  if (!fingerprint.racy) richTextFiles.set(file, fingerprint.key, doc)
  return doc
}

/**
 * Whether `relativePath` (such as `docs/plan.json`) is the Doc its name
 * gives, rather than a plain file. For request paths and event dispatch.
 */
export async function jsonSourceIsDoc(
  spaceRoot: string,
  relativePath: string
): Promise<boolean> {
  const steps = classify(spaceRoot, relativePath)
  let next = steps.next()
  while (!next.done) {
    const step = next.value
    try {
      next = steps.next(
        "stat" in step ? await asyncIo.stat(step.stat) : await asyncIo.read(step.read)
      )
    } catch (error) {
      next = steps.throw(error)
    }
  }
  return next.value
}

/**
 * The same decision, synchronously, for checkpoints that must not yield,
 * such as lifecycle recovery's scan.
 */
export function jsonSourceIsDocSync(
  spaceRoot: string,
  relativePath: string
): boolean {
  const steps = classify(spaceRoot, relativePath)
  let next = steps.next()
  while (!next.done) {
    const step = next.value
    try {
      next = steps.next(
        "stat" in step
          ? (syncIo.stat(step.stat) as BigIntStats | null)
          : (syncIo.read(step.read) as string)
      )
    } catch (error) {
      next = steps.throw(error)
    }
  }
  return next.value
}

// ── An upload staged on disk ─────────────────────────────────

/** How much of a staged `.json` is read to tell that it isn't a Doc. */
const STAGED_PREFIX_BYTES = 1024 * 1024

/**
 * Whether an uploaded `.json`, staged on disk, holds Doc blocks. This is the
 * answer `richTextSourceIsDoc` gives for its whole text, without reading
 * all of a file that plainly isn't one. The block check walks the array in
 * document order and fails at the first element that isn't a block, so a
 * file that doesn't open an array, or whose first element isn't a block, is
 * decided from its first bytes. Only a file whose first element is a block
 * is read whole: one shaped like a Doc, no larger than a Doc can be written.
 */
export async function stagedJsonIsDoc(file: StagedFile): Promise<boolean> {
  if (BigInt(file.byteLength) > MAX_DOC_BYTES) return false
  const prefix = await readStagedFilePrefix(file, STAGED_PREFIX_BYTES)
  const complete = prefix.byteLength === file.byteLength
  // Decoded as uploads always are; a character cut off at the end of the
  // prefix waits for bytes that aren't read.
  const text = new TextDecoder().decode(prefix, { stream: !complete })
  if (complete) return richTextSourceIsDoc(text)
  if (firstElementIsNotABlock(text)) return false
  const whole = new Uint8Array(file.byteLength)
  let at = 0
  await readStagedFile(file, (chunk) => {
    whole.set(chunk, at)
    at += chunk.byteLength
  })
  return richTextSourceIsDoc(new TextDecoder().decode(whole))
}

const JSON_WHITESPACE = new Set([" ", "\t", "\n", "\r"])

function skipWhitespace(text: string, from: number): number {
  let at = from
  while (at < text.length && JSON_WHITESPACE.has(text[at]!)) at += 1
  return at
}

/**
 * Whether the start of a `.json`'s text already shows it can't be Doc
 * blocks: it doesn't open an array, or its first element isn't a block. A
 * false answer only means the start doesn't tell.
 */
function firstElementIsNotABlock(text: string): boolean {
  let at = skipWhitespace(text, text.startsWith("\uFEFF") ? 1 : 0)
  if (at >= text.length) return false
  // Not JSON, or JSON that isn't an array.
  if (text[at] !== "[") return true
  at = skipWhitespace(text, at + 1)
  if (at >= text.length || text[at] === "]") return false
  // An element that isn't an object isn't a block.
  if (text[at] !== "{") return true
  const end = endOfValue(text, at)
  if (end < 0) return false
  let first: unknown
  try {
    first = JSON.parse(text.slice(at, end))
  } catch {
    // The first element's text isn't JSON, so neither is the file's.
    return true
  }
  // The check counts and fails in document order, so the first element and
  // what it holds are judged alone exactly as within the whole array.
  return checkRichTextBlocks([first], RICH_TEXT_SOURCE_BUDGET) === "not-blocks"
}

/** Where the object or array opening at `start` ends, or -1 past the text. */
function endOfValue(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let at = start; at < text.length; at += 1) {
    const char = text[at]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') {
      inString = true
    } else if (char === "{" || char === "[") {
      depth += 1
    } else if (char === "}" || char === "]") {
      depth -= 1
      if (depth === 0) return at + 1
    }
  }
  return -1
}
