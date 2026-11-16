import { beforeEach, expect, it } from "bun:test"
import { claim, currentTip, resetHelpForTests } from "./state"

beforeEach(() => resetHelpForTests())

it("keeps a tip on screen while any copy of it still wants it", () => {
  // A Doc's byline shows in its stand-in, then in the editor that replaces it.
  const standIn = claim("temporary-doc", 30)
  const editor = claim("temporary-doc", 30)
  standIn()
  expect(currentTip()).toBe("temporary-doc")
  editor()
  expect(currentTip()).toBeNull()
})
