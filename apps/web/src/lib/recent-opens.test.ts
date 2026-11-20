import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  readRecentOpens,
  recordRecentOpen,
  RECENT_OPENS_LIMIT,
  type RecentOpen,
} from "./recent-opens"

const doc = (name: string, at: number): RecentOpen => ({
  path: `/spaces/hub/documents/${name}`,
  title: name,
  role: "document",
  at,
})

describe("recent opens", () => {
  const stored = new Map<string, string>()
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  beforeEach(() => {
    stored.clear()
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      writable: true,
      value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
      },
    })
  })
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original)
    else Reflect.deleteProperty(globalThis, "localStorage")
  })

  it("keeps the newest first, each page once, under its latest name", () => {
    recordRecentOpen("wt", doc("plan", 1))
    recordRecentOpen("wt", doc("notes", 2))
    recordRecentOpen("wt", { ...doc("plan", 3), title: "The Plan" })
    expect(readRecentOpens("wt").map((open) => open.title)).toEqual([
      "The Plan",
      "notes",
    ])
  })

  it("forgets the oldest past its limit, and keeps each Worktable's own", () => {
    for (let at = 0; at < RECENT_OPENS_LIMIT + 3; at += 1) {
      recordRecentOpen("wt", doc(`doc-${at}`, at))
    }
    const opens = readRecentOpens("wt")
    expect(opens).toHaveLength(RECENT_OPENS_LIMIT)
    expect(opens[0]?.title).toBe(`doc-${RECENT_OPENS_LIMIT + 2}`)
    expect(readRecentOpens("other")).toEqual([])
  })

  it("reads nothing from storage it can't use", () => {
    stored.set("worktable-recent-opens:wt", "not json")
    expect(readRecentOpens("wt")).toEqual([])
    stored.set(
      "worktable-recent-opens:wt",
      JSON.stringify([
        { path: "/spaces/hub", title: 4 },
        { ...doc("elsewhere", 2), path: "//elsewhere.example" },
        doc("ok", 1),
      ])
    )
    expect(readRecentOpens("wt").map((open) => open.title)).toEqual(["ok"])
  })
})
