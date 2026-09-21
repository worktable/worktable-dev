import { describe, expect, test } from "bun:test"

import {
  insertThreadMention,
  retainedThreadMentionIds,
  threadMentionSegments,
  threadMentionQuery,
} from "./thread-mentions"

const targets = [
  { id: "idt_research", name: "Research", description: "Atlas" },
  { id: "idt_review", name: "Review", description: "Atlas" },
]

describe("thread mentions", () => {
  test("finds, inserts, and removes inline mentions with the text", () => {
    const query = threadMentionQuery("Please ask @rese", 16)
    expect(query).toEqual({ start: 11, end: 16, query: "rese" })

    const inserted = insertThreadMention(
      "Please ask @rese",
      query!,
      targets[0]!
    )
    expect(inserted).toEqual({ value: "Please ask @Research ", cursor: 21 })
    expect(
      retainedThreadMentionIds(inserted.value, ["idt_research"], targets)
    ).toEqual(["idt_research"])
    expect(
      retainedThreadMentionIds("Please ask Research", ["idt_research"], targets)
    ).toEqual([])

    expect(
      threadMentionSegments(
        "Ask (@research), then tell email@Research and @Review.",
        targets.map((target) => target.name)
      )
    ).toEqual([
      { text: "Ask (", mention: false },
      { text: "@research", mention: true },
      { text: "), then tell email@Research and ", mention: false },
      { text: "@Review", mention: true },
      { text: ".", mention: false },
    ])

    expect(threadMentionQuery("Ask (@Research", 14)).toEqual({
      start: 5,
      end: 14,
      query: "Research",
    })
    expect(threadMentionQuery("email@Research", 14)).toBeUndefined()

    const existingSpace = insertThreadMention(
      "Ask @rese about this",
      threadMentionQuery("Ask @rese", 9)!,
      targets[0]!
    )
    expect(existingSpace).toEqual({
      value: "Ask @Research about this",
      cursor: 13,
    })

    const longName = "N".repeat(120)
    expect(threadMentionQuery(`@${longName}`, 121)?.query).toBe(longName)
  })
})
