// A line-by-line comparison of two texts, for showing what a change to a
// skill would change for agents.

export interface DiffLine {
  kind: "same" | "added" | "removed"
  text: string
}

/** Beyond this many lines on either side the texts are shown without marks. */
const MAX_LINES = 2000

const linesOf = (text: string) => text.replace(/\r\n?/g, "\n").split("\n")

/**
 * The lines of `after`, with the lines `before` had and `after` dropped in
 * place. Null when a text is too long to compare.
 */
export function diffLines(before: string, after: string): DiffLine[] | null {
  const a = linesOf(before)
  const b = linesOf(after)
  if (a.length > MAX_LINES || b.length > MAX_LINES) return null
  // Longest common subsequence, by suffix lengths.
  const width = b.length + 1
  const lengths = new Uint16Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!)
    }
  }
  const lines: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ kind: "same", text: b[j]! })
      i++
      j++
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
      lines.push({ kind: "removed", text: a[i++]! })
    } else {
      lines.push({ kind: "added", text: b[j++]! })
    }
  }
  while (i < a.length) lines.push({ kind: "removed", text: a[i++]! })
  while (j < b.length) lines.push({ kind: "added", text: b[j++]! })
  return lines
}

export type DiffPart<Line = DiffLine> =
  | { kind: "lines"; lines: Line[] }
  | { kind: "unchanged"; lines: Line[] }

/**
 * A comparison in parts, with each long run of unchanged lines set apart so
 * it can stay folded: `context` lines stay beside every change.
 */
export function foldUnchanged<Line extends { kind: string }>(
  lines: Line[],
  context = 2
): DiffPart<Line>[] {
  const parts: DiffPart<Line>[] = []
  const push = (kind: DiffPart["kind"], chunk: Line[]) => {
    if (chunk.length === 0) return
    const last = parts.at(-1)
    if (last && last.kind === kind) last.lines.push(...chunk)
    else parts.push({ kind, lines: [...chunk] })
  }
  let index = 0
  while (index < lines.length) {
    if (lines[index]!.kind !== "same") {
      push("lines", [lines[index++]!])
      continue
    }
    let end = index
    while (end < lines.length && lines[end]!.kind === "same") end++
    const run = lines.slice(index, end)
    const head = index === 0 ? 0 : context
    const tail = end === lines.length ? 0 : context
    // Folding fewer than three lines hides less than it costs to show.
    if (run.length - head - tail < 3) push("lines", run)
    else {
      push("lines", run.slice(0, head))
      parts.push({
        kind: "unchanged",
        lines: run.slice(head, run.length - tail),
      })
      push("lines", run.slice(run.length - tail))
    }
    index = end
  }
  return parts
}
