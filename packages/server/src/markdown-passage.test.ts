import { describe, expect, it } from "bun:test"
import { locateMarkdownPassage } from "./markdown-passage.ts"

describe("locateMarkdownPassage", () => {
  it("finds the written source of text that escapes and entities change", () => {
    const source = "# Notes\n\nTom &amp; Jo \\*really\\* like\nthe target passage here.\n"
    const found = locateMarkdownPassage(source, {
      quote: "*really* like the target passage",
    })
    expect(found).toMatchObject({ match: "exact", startLine: 3, endLine: 4 })
    expect(source.slice(found!.start, found!.end)).toBe(
      "\\*really\\* like\nthe target passage"
    )
  })

  it("finds text the reader shows from raw HTML, and none from scripts", () => {
    const source =
      "Intro.\n\n<div>Review <b>this</b> passage.<script>hidden()</script></div>\n"
    const found = locateMarkdownPassage(source, { quote: "Review this passage" })
    expect(found).toMatchObject({ match: "exact", startLine: 3, endLine: 3 })
    expect(source.slice(found!.start, found!.end)).toBe(
      "Review <b>this</b> passage"
    )
    expect(locateMarkdownPassage(source, { quote: "hidden()" })).toBeNull()
  })
})
