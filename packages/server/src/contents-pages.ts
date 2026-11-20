// A page of a parsed file's contents, as agents get it, from what the store
// keeps: its lines, and what it leaves out. Every parsed type pages the same
// way, so a new reader needs nothing here.

import type { DerivedKey, DerivedStore } from "./derived-store.ts"
import type { ContentsPage } from "./file-contents.ts"
import { CONTENTS_PAGE_MAX_BYTES } from "./file-contents-limits.ts"

const PENDING = "Worktable is still reading this file. Ask again in a moment."

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
  const missing = [
    ...stored.missing,
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
    outline: stored.outline,
    facts: stored.facts,
  }
}
