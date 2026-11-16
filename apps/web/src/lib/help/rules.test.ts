import { expect, it } from "bun:test"
import { TIPS, type Tip } from "./registry"
import { offersDontShowAgain, pickTip, tipMayShow, type HelpContext } from "./rules"

const session = "2026-11-16T12:00:00.000Z"
const earlier = "2026-11-15T12:00:00.000Z"
const later = "2026-11-16T12:05:00.000Z"

function context(overrides: Partial<HelpContext> = {}): HelpContext {
  return {
    enabled: true,
    sessionStartedAt: session,
    conditions: { files: true, links: true, teams: false, library: true },
    evidence: {},
    ...overrides,
  }
}

const once: Tip = TIPS.temporaryDoc
const never: Tip = TIPS.recordsMeet
const always: Tip = { ...TIPS.recordsView, comesBack: "always" }

it("shows a tip until it's closed, then once more in a later session at most", () => {
  expect(tipMayShow(once, undefined, context())).toBe(true)
  // Shown and still open: keeps showing.
  expect(tipMayShow(once, { shown: 1, version: 1 }, context())).toBe(true)
  // Closed this session: gone until a later one.
  expect(tipMayShow(once, { shown: 1, version: 1, closedAt: later }, context())).toBe(false)
  // Closed in an earlier session: back once.
  expect(tipMayShow(once, { shown: 1, version: 1, closedAt: earlier }, context())).toBe(true)
  expect(tipMayShow(once, { shown: 2, version: 1, closedAt: earlier }, context())).toBe(false)
  // Tips that never come back, and opted-out ones, stay closed.
  expect(tipMayShow(never, { shown: 1, version: 1, closedAt: earlier }, context())).toBe(false)
  expect(
    tipMayShow(always, { shown: 5, version: 1, closedAt: earlier, optedOut: true }, context())
  ).toBe(false)
  expect(tipMayShow(always, { shown: 5, version: 1, closedAt: earlier }, context())).toBe(true)
})

it("never shows a tip that's done, off, or about something this Worktable lacks", () => {
  expect(tipMayShow(once, { shown: 1, version: 1, doneAt: later }, context())).toBe(false)
  expect(
    tipMayShow(once, undefined, context({ evidence: { "temporary-kept": { at: later } } }))
  ).toBe(false)
  expect(tipMayShow(once, undefined, context({ enabled: false }))).toBe(false)
  expect(tipMayShow(TIPS.fileMeet, undefined, context({ conditions: { files: false } }))).toBe(false)
})

it("shows a rewritten tip again", () => {
  const closed = { shown: 2, version: 1, closedAt: later }
  expect(tipMayShow(once, closed, context())).toBe(false)
  expect(tipMayShow({ ...once, version: 2 }, closed, context())).toBe(true)
})

it("offers Don't Show Again only on tips that come back every time", () => {
  expect(offersDontShowAgain(once, { shown: 1 })).toBe(false)
  expect(offersDontShowAgain(always, { shown: 0 })).toBe(false)
  expect(offersDontShowAgain(always, { shown: 1 })).toBe(true)
})

it("gives the screen to the highest priority, then the first to ask", () => {
  expect(pickTip([])).toBeNull()
  expect(
    pickTip([
      { id: "a", priority: 10, order: 0 },
      { id: "b", priority: 20, order: 1 },
      { id: "c", priority: 20, order: 2 },
    ])?.id
  ).toBe("b")
})
