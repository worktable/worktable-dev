import { describe, expect, it } from "bun:test"
import { ORIENT_FOLDER_LIMIT, orientItems } from "./mcp/space-orientation.ts"

const at = (day: number) => `2026-11-${String(day).padStart(2, "0")}T10:00:00.000Z`

describe("what an agent is told about a Space's files", () => {
  it("counts files by top-level folder and names the latest changes", () => {
    const told = orientItems([
      { path: "start-here", title: "Start here", changedAt: at(2) },
      { path: "plans/q1", title: "Q1", changedAt: at(5) },
      { path: "plans/archive/2025", title: "2025", changedAt: at(1) },
      { path: "research/interviews/anna", title: "Anna", changedAt: at(9) },
      { path: "research/old", title: "Old" },
    ])
    expect(told.items).toBe(5)
    expect(told.folders).toEqual([
      { path: "research", items: 2, changedAt: at(9) },
      { path: "plans", items: 2, changedAt: at(5) },
    ])
    expect(told.recent.map((item) => item.path)).toEqual([
      "research/interviews/anna",
      "plans/q1",
      "start-here",
      "plans/archive/2025",
    ])
  })

  it("stays small however much the Space holds", () => {
    // Shaped like a large real Space: long dated folder names, and far more
    // top-level folders than anyone keeps.
    const items = Array.from({ length: 5000 }, (_, index) => ({
      path: `research-2026-11-${String(index % 300).padStart(3, "0")}-interviews-and-synthesis/${index}-notes-from-the-customer-call`,
      title: `Notes from the customer call, with what we decided and what is still open (${index})`,
      changedAt: at((index % 28) + 1),
    }))
    const told = orientItems(items)
    expect(told.items).toBe(5000)
    expect(told.folders).toHaveLength(ORIENT_FOLDER_LIMIT)
    expect(told.moreFolders).toBe(300 - ORIENT_FOLDER_LIMIT)
    expect(told.recent).toHaveLength(10)
    // An agent's app refuses a result somewhere past 40,000 characters, and
    // cuts one at about 10,000 tokens. This leaves room for pins and skills.
    expect(JSON.stringify(told).length).toBeLessThan(8000)
  })

  it("names fewer files and folders when their paths are very long, and cuts none", () => {
    // A path may be 4,096 characters, and a cut path opens nothing.
    const long = (index: number) => `${String(index).padStart(3, "0")}-${"x".repeat(1500)}`
    const items = Array.from({ length: 60 }, (_, index) => ({
      path: `${long(index)}/${long(index)}`,
      changedAt: at((index % 28) + 1),
    }))
    const told = orientItems(items)
    expect(told.items).toBe(60)
    expect(told.folders.length).toBeGreaterThan(0)
    expect(told.folders.length + told.moreFolders!).toBe(60)
    expect(told.recent.length).toBeGreaterThan(0)
    for (const row of [...told.folders, ...told.recent]) {
      expect(items.some((item) => item.path === row.path || item.path.startsWith(`${row.path}/`))).toBe(true)
    }
    expect(JSON.stringify(told).length).toBeLessThan(13000)
  })
})
