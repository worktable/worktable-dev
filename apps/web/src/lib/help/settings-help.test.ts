import { expect, test } from "bun:test"
import { CONCEPTS } from "./registry"
import { visibleConcepts } from "./settings-help"

const ids = (conditions: Parameters<typeof visibleConcepts>[0]) =>
  visibleConcepts(conditions).map((concept) => concept.id)

test("How Worktable Works lists every idea in order where everything is on", () => {
  expect(ids({ teams: true, links: true, files: true, library: true, local: true })).toEqual(
    CONCEPTS.map((concept) => concept.id)
  )
})

test("it leaves out parts this Worktable lacks", () => {
  const shown = ids({})
  expect(shown).not.toContain("who-can-see-it")
  expect(shown).not.toContain("share-links")
  expect(shown).not.toContain("files")
  expect(shown).not.toContain("library")
  expect(shown).not.toContain("worktable-link")
  expect(shown).toContain("spaces")
})
