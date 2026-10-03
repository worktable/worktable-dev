import { describe, expect, it } from "bun:test"
import { unifiedLineDiff } from "./text-diff.ts"

const diff = (before: string, after: string, context = 1, maxBytes = 64 * 1024) =>
  unifiedLineDiff({ before, after, fromLabel: "a", toLabel: "b", context, maxBytes })

/** Apply a unified diff to `before`, proving the hunks describe the change. */
function apply(before: string, unified: string): string {
  const source = before.split("\n").slice(0, -1)
  const output: string[] = []
  let cursor = 0
  for (const hunk of unified.split(/^@@ /m).slice(1)) {
    const [header, ...body] = hunk.split("\n")
    const start = Number(/^-(\d+)(?:,(\d+))?/.exec(header!)![1])
    const oldCount = Number(/^-\d+,(\d+)/.exec(header!)?.[1] ?? 1)
    const first = oldCount === 0 ? start : start - 1
    output.push(...source.slice(cursor, first))
    cursor = first
    for (const line of body.filter((entry) => entry.length > 0)) {
      if (line[0] !== "+") cursor += 1
      if (line[0] !== "-") output.push(line.slice(1))
    }
  }
  output.push(...source.slice(cursor))
  return output.map((line) => `${line}\n`).join("")
}

describe("unified line diffs", () => {
  it("emits minimal hunks with context and merges nearby changes", () => {
    const before = "a\nb\nc\nd\ne\nf\ng\nh\ni\n"
    const after = "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\n"
    const result = diff(before, after)
    expect(result).toEqual({
      unified: "--- a\n+++ b\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -9 +9,2 @@\n i\n+j\n",
      added: 2,
      removed: 1,
      truncated: false,
    })
    expect(diff(before, after, 3).unified.match(/^@@/gm)).toHaveLength(2)
    expect(diff(before, after, 4).unified.match(/^@@/gm)).toHaveLength(1)
    expect(diff("x\n", "x\n")).toEqual({ unified: "", added: 0, removed: 0, truncated: false })
    expect(diff("", "x\n").unified).toBe("--- a\n+++ b\n@@ -0,0 +1 @@\n+x\n")
  })

  it("stays correct past the minimal-edit bound and truncates at a line", () => {
    const before = Array.from({ length: 3000 }, (_, i) => `old ${i}\n`).join("")
    const changedEvery = (step: number) =>
      Array.from({ length: 3000 }, (_, i) => (i % step ? `old ${i}\n` : `new ${i}\n`)).join("")
    // 600 edits stay minimal; 3000 edits exceed the bound and fall back.
    const sparse = diff(before, changedEvery(10), 3, 10 * 1024 * 1024)
    expect([sparse.added, sparse.removed]).toEqual([300, 300])
    expect(apply(before, sparse.unified)).toBe(changedEvery(10))
    const after = changedEvery(2)
    const full = diff(before, after, 3, 10 * 1024 * 1024)
    expect(full.truncated).toBe(false)
    expect(apply(before, full.unified)).toBe(after)

    const shortened = diff(before, after, 3, 1024)
    expect(shortened.truncated).toBe(true)
    expect(shortened.unified.endsWith("\n")).toBe(true)
    expect(Buffer.byteLength(shortened.unified)).toBeLessThanOrEqual(1024)
    expect([shortened.added, shortened.removed]).toEqual([full.added, full.removed])
  })
})
