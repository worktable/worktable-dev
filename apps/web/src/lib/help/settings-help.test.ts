import { describe, expect, test } from "bun:test"
import { CONCEPTS } from "./registry"
import { conceptGroups, tipSeen, visibleTips } from "./settings-help"

const ids = (groups: ReturnType<typeof conceptGroups>) =>
  groups.flatMap((group) => group.concepts.map((concept) => concept.id))

describe("Settings > Help", () => {
  test("lists every concept, in two groups, where everything is on", () => {
    const groups = conceptGroups({
      teams: true,
      links: true,
      files: true,
      library: true,
    })
    expect(groups.map((group) => group.title)).toEqual([
      "What's in Worktable",
      "How It Behaves",
    ])
    expect(ids(groups)).toEqual(CONCEPTS.map((concept) => concept.id))
  })

  test("leaves out concepts and tips for parts this Worktable lacks", () => {
    const shown = ids(conceptGroups({}))
    expect(shown).not.toContain("who-can-see-it")
    expect(shown).not.toContain("share-links")
    expect(shown).not.toContain("files")
    expect(shown).not.toContain("library")
    expect(shown).toContain("spaces")

    const tips = visibleTips({ files: true }).map((tip) => tip.id)
    expect(tips).toContain("file-meet")
    expect(tips).not.toContain("library-meet")
  })

  test("a tip is seen once it has shown, been closed or been done", () => {
    expect(tipSeen(undefined)).toBe(false)
    expect(tipSeen({ shown: 0 })).toBe(false)
    expect(tipSeen({ shown: 1 })).toBe(true)
    expect(tipSeen({ shown: 0, doneAt: "2026-11-16T00:00:00.000Z" })).toBe(true)
  })
})
