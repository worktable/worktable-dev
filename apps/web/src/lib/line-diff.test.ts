import { describe, expect, it } from "bun:test"
import { diffLines, foldUnchanged } from "./line-diff"

describe("diffLines", () => {
  it("keeps the new text in order with dropped lines in place", () => {
    const lines = diffLines("a\nb\nc\nd", "a\nB\nc\nd\ne")!
    expect(lines.map((line) => `${line.kind[0]}:${line.text}`)).toEqual([
      "s:a",
      "r:b",
      "a:B",
      "s:c",
      "s:d",
      "a:e",
    ])
    expect(
      lines.filter((line) => line.kind !== "removed").map((line) => line.text)
    ).toEqual(["a", "B", "c", "d", "e"])
  })

  it("folds long unchanged runs and keeps lines beside each change", () => {
    const before = Array.from({ length: 12 }, (_, n) => `line ${n}`)
    const after = [...before]
    after[6] = "changed"
    const parts = foldUnchanged(diffLines(before.join("\n"), after.join("\n"))!)
    expect(parts.map((part) => [part.kind, part.lines.length])).toEqual([
      ["unchanged", 4],
      ["lines", 6],
      ["unchanged", 3],
    ])
  })
})
