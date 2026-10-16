import { describe, expect, it } from "bun:test"
import { startingNavigation } from "./personal-navigation"

describe("startingNavigation", () => {
  it("copies the groups Spaces name into groups a person can save", () => {
    const long = "x".repeat(80)
    const navigation = startingNavigation([
      { id: "a", group: "side-quests" },
      { id: "b", group: "Side-Quests" },
      { id: "c", group: "a/b" },
      { id: "d", group: "a?b" },
      { id: "e", group: "   " },
      { id: "f", group: long },
      { id: "g" },
    ])
    expect(navigation.groups.map((group) => group.name)).toEqual([
      "Side Quests",
      "A/b",
      "A?b",
      "X".concat("x".repeat(59)),
    ])
    // Same name ignoring case is one group; distinct names never merge.
    expect(navigation.spaceGroups.a).toBe(navigation.spaceGroups.b)
    expect(navigation.spaceGroups.c).not.toBe(navigation.spaceGroups.d)
    expect(navigation.spaceGroups).not.toHaveProperty("e")
    expect(navigation.spaceGroups).not.toHaveProperty("g")
  })
})
