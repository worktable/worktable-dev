import { describe, expect, test } from "bun:test"

import { markdownPlainText } from "./markdown"

describe("markdownPlainText", () => {
  test("removes headings, links, images, tasks, and emphasis syntax", () => {
    expect(
      markdownPlainText(
        "# Heading\n- [x] Read [the guide](https://example.com)\n![Diagram](diagram.png) and **finish**"
      )
    ).toBe("Heading\nRead the guide\nDiagram and finish")
  })

  test("keeps fenced and inline code while removing fence metadata", () => {
    const result = markdownPlainText(
      "Use `bun test`.\n```ts\nconst answer = 42\n```"
    )
    expect(result).toContain("Use bun test.")
    expect(result).toContain("const answer = 42")
    expect(result).not.toContain("```ts")
  })

  test("flattens tables without separator rows", () => {
    const result = markdownPlainText(
      "| Name | Role |\n| --- | --- |\n| Ada | Engineer |"
    )
    expect(result).toContain("Name   Role")
    expect(result).toContain("Ada   Engineer")
    expect(result).not.toContain("---")
  })

  test("removes tag-like HTML while preserving comparison text and boundaries", () => {
    expect(markdownPlainText("alpha<br>beta and 2 < 3")).toMatch(
      /alpha\s+beta and 2 < 3/
    )
  })
})
