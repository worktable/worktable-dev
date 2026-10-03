/**
 * Unified line diffs for document text.
 *
 * Uses Myers' O(ND) algorithm on the lines between the common prefix and
 * suffix. When the remaining edit distance exceeds a fixed bound, the middle
 * is reported as one replaced block: still a correct diff, just not minimal,
 * with bounded time and memory for any input.
 */

export const DOCUMENT_DIFF_DEFAULT_CONTEXT = 3
export const DOCUMENT_DIFF_MAX_CONTEXT = 10
const MAX_EDIT_DISTANCE = 1000

type Op = { kind: " " | "-" | "+"; line: string }

export interface UnifiedLineDiff {
  unified: string
  added: number
  removed: number
  truncated: boolean
}

function splitLines(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}

/** Minimal edit script between a and b, or null past the edit bound. */
function myers(a: readonly number[], b: readonly number[]): Op["kind"][] | null {
  const n = a.length
  const m = b.length
  const limit = Math.min(n + m, MAX_EDIT_DISTANCE)
  const offset = limit + 1
  const v = new Int32Array(2 * limit + 3)
  // trace[d] holds diagonals -(d+1)..(d+1) as they were before step d.
  const trace: Int32Array[] = []
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x += 1
        y += 1
      }
      v[offset + k] = x
      if (x >= n && y >= m) return backtrack(trace, n, m)
    }
  }
  return null
}

function backtrack(trace: Int32Array[], n: number, m: number): Op["kind"][] {
  const ops: Op["kind"][] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const snapshot = trace[d]!
    const at = (k: number) => snapshot[k + d + 1]!
    const k = x - y
    const prevK =
      k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push(" ")
      x -= 1
      y -= 1
    }
    if (d > 0) ops.push(x === prevX ? "+" : "-")
    x = prevX
    y = prevY
  }
  return ops.reverse()
}

function editScript(before: string[], after: string[]): Op[] {
  let prefix = 0
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1
  }
  let suffix = 0
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const a = before.slice(prefix, before.length - suffix)
  const b = after.slice(prefix, after.length - suffix)
  const ids = new Map<string, number>()
  const intern = (line: string) => {
    let id = ids.get(line)
    if (id === undefined) {
      id = ids.size
      ids.set(line, id)
    }
    return id
  }
  const kinds = myers(a.map(intern), b.map(intern)) ?? [
    ...a.map(() => "-" as const),
    ...b.map(() => "+" as const),
  ]
  const ops: Op[] = before
    .slice(0, prefix)
    .map((line) => ({ kind: " ", line }))
  let i = 0
  let j = 0
  for (const kind of kinds) {
    if (kind === " ") {
      ops.push({ kind, line: a[i]! })
      i += 1
      j += 1
    } else if (kind === "-") {
      ops.push({ kind, line: a[i]! })
      i += 1
    } else {
      ops.push({ kind, line: b[j]! })
      j += 1
    }
  }
  for (const line of before.slice(before.length - suffix)) {
    ops.push({ kind: " ", line })
  }
  return ops
}

function range(start: number, count: number): string {
  // Unified diff convention: an empty range names the line before it.
  return count === 1 ? `${start}` : `${count === 0 ? start - 1 : start},${count}`
}

/**
 * Render a unified diff with `context` unchanged lines around each change.
 * Statistics always cover the whole diff; the text stops at a line boundary
 * once it would exceed `maxBytes`.
 */
export function unifiedLineDiff(input: {
  before: string
  after: string
  fromLabel: string
  toLabel: string
  context: number
  maxBytes: number
}): UnifiedLineDiff {
  const ops = editScript(splitLines(input.before), splitLines(input.after))
  const added = ops.filter((op) => op.kind === "+").length
  const removed = ops.filter((op) => op.kind === "-").length
  if (added === 0 && removed === 0) {
    return { unified: "", added, removed, truncated: false }
  }

  const lines = [`--- ${input.fromLabel}`, `+++ ${input.toLabel}`]
  let index = 0
  let oldLine = 1
  let newLine = 1
  while (index < ops.length) {
    // Find the next change and widen it into a hunk that absorbs any change
    // separated by at most 2 * context unchanged lines.
    let first = index
    while (first < ops.length && ops[first]!.kind === " ") first += 1
    if (first === ops.length) break
    const start = Math.max(index, first - input.context)
    let end = first
    let lastChange = first
    while (end < ops.length) {
      if (ops[end]!.kind !== " ") lastChange = end
      else if (end - lastChange > 2 * input.context) break
      end += 1
    }
    end = Math.min(ops.length, lastChange + input.context + 1)
    for (let skip = index; skip < start; skip += 1) {
      oldLine += 1
      newLine += 1
    }
    const hunk = ops.slice(start, end)
    const oldCount = hunk.filter((op) => op.kind !== "+").length
    const newCount = hunk.filter((op) => op.kind !== "-").length
    lines.push(
      `@@ -${range(oldLine, oldCount)} +${range(newLine, newCount)} @@`,
      ...hunk.map((op) => `${op.kind}${op.line}`)
    )
    oldLine += oldCount
    newLine += newCount
    index = end
  }

  let unified = ""
  let bytes = 0
  for (const line of lines) {
    const size = Buffer.byteLength(line) + 1
    if (bytes + size > input.maxBytes) {
      return { unified, added, removed, truncated: true }
    }
    unified += `${line}\n`
    bytes += size
  }
  return { unified, added, removed, truncated: false }
}
