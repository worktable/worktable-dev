import { describe, expect, it } from "bun:test"
import { RECOGNITION_COLORS } from "@worktable/types"
import { themeConfig } from "@worktable/ui/theme"

describe("recognition colors", () => {
  it("are all defined by the theme", () => {
    expect(Object.keys(themeConfig.recognition)).toEqual([...RECOGNITION_COLORS])
  })
})
