import { describe, expect, test } from "bun:test"
import { commentPlaceholder } from "./comment-recipients"
import { threadPlaceholder } from "./thread-presentation"

describe("commentPlaceholder", () => {
  test("names who the comment goes to", () => {
    expect(commentPlaceholder({ kind: "agent", name: "Claude Code" })).toBe(
      "Ask Claude Code…"
    )
    expect(commentPlaceholder({ kind: "human", name: "Sam" })).toBe("Write to Sam…")
  })

  test("a comment to no one is a note", () => {
    expect(commentPlaceholder(undefined)).toBe("Leave a note…")
  })
})

describe("threadPlaceholder", () => {
  test("just you and one agent: names the agent", () => {
    expect(threadPlaceholder(2, "Claude Code")).toBe("Message Claude Code…")
  })

  test("in a group, says how to get a reply", () => {
    expect(threadPlaceholder(3, undefined)).toBe("@mention an agent to get a reply")
  })

  test("otherwise keeps the plain reply prompt", () => {
    expect(threadPlaceholder(2, undefined)).toBe("Reply in this thread…")
  })
})
