import { expect, it } from "bun:test"
import { WELCOME } from "./registry"
import { welcomeKey, welcomeRole, welcomesOnItsOwn } from "./welcome"
import { welcomeContent } from "./welcome-content"

it("gives owners the owner copy and people joining the team copy, named for the team", () => {
  const owner = welcomeContent(welcomeRole("owner"), "Northwind")
  expect(owner.eyebrow).toBe(WELCOME.owner.eyebrow)
  expect(owner.screens.map((screen) => screen.title)).toEqual(
    WELCOME.owner.screens.map((screen) => screen.title)
  )
  expect(owner.screens[0]!.picture).toBe("agents")

  const joiner = welcomeContent(welcomeRole("member"), "Northwind")
  expect(joiner.eyebrow).toBe("Welcome to Northwind")
  expect(joiner.screens[0]!.title).toBe(WELCOME.joiner.screens[0].title)
  // The team's work comes first for someone joining it.
  expect(joiner.screens[0]!.picture).toBe("space")
})

it("opens on its own once per person: owners during setup, people joining in the app", () => {
  const base = { enabled: true, welcomed: false } as const
  expect(welcomesOnItsOwn({ ...base, role: "owner", where: "setup" })).toBe(true)
  expect(welcomesOnItsOwn({ ...base, role: "owner", where: "app" })).toBe(false)
  expect(welcomesOnItsOwn({ ...base, role: "member", where: "app" })).toBe(true)
  expect(welcomesOnItsOwn({ ...base, role: "member", where: "setup" })).toBe(false)
  // Seen it, or help is off: never on its own.
  expect(welcomesOnItsOwn({ ...base, welcomed: true, role: "owner", where: "setup" })).toBe(false)
  expect(welcomesOnItsOwn({ ...base, enabled: false, role: "member", where: "app" })).toBe(false)
  // Who they are isn't known yet.
  expect(welcomesOnItsOwn({ ...base, role: undefined, where: "setup" })).toBe(false)
})

it("moves with Enter and the arrows, and lets Escape out only from the last screen", () => {
  expect(welcomeKey("Enter", 0, 3)).toBe("next")
  expect(welcomeKey("ArrowRight", 1, 3)).toBe("next")
  expect(welcomeKey("ArrowRight", 2, 3)).toBe("finish")
  expect(welcomeKey("ArrowLeft", 0, 3)).toBeNull()
  expect(welcomeKey("ArrowLeft", 2, 3)).toBe("back")
  expect(welcomeKey("Escape", 0, 3)).toBeNull()
  expect(welcomeKey("Escape", 1, 3)).toBeNull()
  expect(welcomeKey("Escape", 2, 3)).toBe("finish")
})
