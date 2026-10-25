import { describe, expect, it } from "bun:test"
import { findPassage, passageSelector } from "./passage"

describe("findPassage", () => {
  it("tells a repeated quote apart by the text around it", () => {
    const text = "Ship it on Monday. Review it on Monday. Ship it on Friday."
    const second = text.indexOf("it on Monday", 10)
    const selector = passageSelector(text, second, second + "it on Monday".length)
    const rewritten = `Intro.\n\n${text}`
    expect(findPassage(rewritten, selector)).toEqual({
      start: rewritten.indexOf("it on Monday", 18),
      end: rewritten.indexOf("it on Monday", 18) + "it on Monday".length,
      match: "exact",
    })
  })

  it("matches across changed whitespace and line breaks", () => {
    const found = findPassage("one  two\n\nthree four", { quote: "two three" })
    expect(found).toEqual({ start: 5, end: 15, match: "exact" })
  })

  it("follows a lightly reworded passage, and lets go of a rewritten one", () => {
    const selector = { quote: "the pilot starts with three design partners in March" }
    const reworded = "Plan: the pilot starts with four design partners in March. Then more."
    const found = findPassage(reworded, selector)
    expect(found?.match).toBe("fuzzy")
    expect(reworded.slice(found!.start, found!.end)).toBe(
      "the pilot starts with four design partners in March"
    )
    expect(findPassage("We will decide the rollout later.", selector)).toBeNull()
  })
})
