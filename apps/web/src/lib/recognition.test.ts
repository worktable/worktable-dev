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
  it("come from the name's words, not brackets or marks", () => {
    expect(participantInitials("Ada Lovelace")).toBe("AL")
    expect(participantInitials("Sage (Claude)")).toBe("S")
    expect(participantInitials("Q-Bot!")).toBe("Q")
  })
})
