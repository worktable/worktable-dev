import { expect, it } from "bun:test"
import {
  resolvePageContextualAction,
  type PageContextualAction,
} from "./use-page-meta"

const action = (label: string): PageContextualAction => ({
  label,
  onClick: () => {},
})

it("keeps contextual header ownership stable across overlapping callers", () => {
  const first = Symbol("first")
  const second = Symbol("second")
  const comment = action("Comment")
  const exportAction = action("Export")

  const activeFirst = resolvePageContextualAction(null, first, comment)
  expect(activeFirst).toEqual({ owner: first, action: comment })
  // Re-applying the same action keeps referential identity.
  expect(resolvePageContextualAction(activeFirst, first, comment)).toBe(
    activeFirst
  )

  // A newer caller takes over the slot; the previous caller's cleanup leaves it intact.
  const activeSecond = resolvePageContextualAction(
    activeFirst,
    second,
    exportAction
  )
  expect(activeSecond).toEqual({ owner: second, action: exportAction })
  expect(resolvePageContextualAction(activeSecond, first, null)).toBe(
    activeSecond
  )

  // Clearing from the active owner restores the default header actions.
  expect(resolvePageContextualAction(activeSecond, second, null)).toBeNull()
})
