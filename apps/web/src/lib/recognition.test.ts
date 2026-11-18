import { describe, expect, it } from "bun:test"
import { RECOGNITION_COLORS } from "@worktable/types/recognition"
import { themeConfig } from "@worktable/ui/theme"
import { participantInitials } from "./recognition"

describe("recognition colors", () => {
  it("are all defined by the theme", () => {
    expect(Object.keys(themeConfig.recognition)).toEqual([...RECOGNITION_COLORS])
  })
})

describe("participant initials", () => {
  it("take the first and last word's first letter, skipping punctuation", () => {
    expect(participantInitials("Ada Lovelace")).toBe("AL")
    expect(participantInitials("Ada (Claude)")).toBe("AC")
    expect(participantInitials("codex@laptop")).toBe("C")
    expect(participantInitials("(  )")).toBe("")
  })
})
