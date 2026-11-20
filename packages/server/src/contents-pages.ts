// A page of a parsed file's contents, as agents get it, from what the store
// keeps: its lines, and what it leaves out. Every parsed type pages the same
// way, so a new reader needs nothing here.

import type { DerivedKey, DerivedStore } from "./derived-store.ts"
import type { ContentsPage } from "./file-contents.ts"
import { CONTENTS_PAGE_MAX_BYTES } from "./file-contents-limits.ts"

const PENDING = "Worktable is still reading this file. Ask again in a moment."

/** Outline entries one page carries: its own parts and those after them. */
export const OUTLINE_WINDOW = 200

/**
 * What one page says of a parsed file's outline and gaps: the parts from the
 * one the page starts in, up to a window's worth, and the gaps of the parts
 * the page covers, so a long file's page stays the size of its text. Gaps
 * further on are counted, and say what they are when read.
 */
function aroundPage(
  outline: { label: string; line: number }[],
  missing: { where?: string; why: string }[],
  startLine: number,
  endLine: number
) {
  let first = 0
  while (first + 1 < outline.length && outline[first + 1]!.line <= startLine) first += 1
  const window = outline.slice(first, first + OUTLINE_WINDOW)
  const onPage = new Set<string>()
  for (let index = first; index < outline.length && outline[index]!.line <= Math.max(endLine, startLine); index += 1) {
    onPage.add(outline[index]!.label)
  }
  const here = missing.filter((gap) => gap.where === undefined || onPage.has(gap.where))
  const elsewhere = missing.length - here.length
  return {
    outline: window,
    missing:
      elsewhere > 0
        ? [...here, { why: `${elsewhere} more ${elsewhere === 1 ? "part leaves" : "parts leave"} something out. Reading ${elsewhere === 1 ? "it says" : "them says"} what.` }]
        : here,
  }
}

/** A page of kept contents, or that they are still being made. */
export function contentsPageFromStore(
  store: DerivedStore,
  key: DerivedKey,
  offset = 1,
  limit?: number
): ContentsPage {
  const empty = { text: "", startLine: offset, endLine: offset - 1, totalLines: 0 }
  const stored = store.getContents(key)
  if (!stored) return { state: "pending", ...empty, missing: [{ why: PENDING }] }
  if (stored.state === "refused") {
    return {
      state: stored.reason === "encrypted" ? "encrypted" : "unsupported",
      ...empty,
      missing: [{ why: stored.message }],
    }
  }
  if (stored.state === "failed") {
    return { state: "failed", ...empty, missing: [{ why: stored.message }] }
  }
  const lines = store.readContentsLines(key, offset, limit)
  if (!lines) return { state: "pending", ...empty, missing: [{ why: PENDING }] }
  const around = aroundPage(stored.outline, stored.missing, lines.startLine, lines.endLine)
  const missing = [
    ...around.missing,
    ...(lines.cutLine !== undefined
      ? [
          {
            where: `line ${lines.cutLine}`,
            why: `The line is longer than ${CONTENTS_PAGE_MAX_BYTES / 1024} KiB, so it is cut there.`,
          },
        ]
      : []),
  ]
  return {
    state: missing.length > 0 ? "partial" : "ready",
    text: lines.text,
    startLine: lines.startLine,
    endLine: lines.endLine,
    totalLines: lines.totalLines,
    ...(lines.nextOffset !== undefined ? { nextOffset: lines.nextOffset } : {}),
    missing,
    outline: around.outline,
    facts: stored.facts,
  }
}
