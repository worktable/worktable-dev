import { expect, test } from "bun:test"
import { labelledForChange, toolSurfaceChanges } from "./check-tool-surface.ts"

test("names each tool surface change and accepts it only with the label", () => {
  const search = {
    name: "search",
    description: "Search Worktable.",
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  }
  const fetch = { name: "fetch", description: "Fetch one result." }
  const surface = [search, fetch]

  expect(toolSurfaceChanges(surface, structuredClone(surface))).toEqual([])
  expect(
    toolSurfaceChanges(surface, [
      { ...search, description: "Search everything." },
      fetch,
    ])
  ).toEqual(["changed search: description"])
  expect(
    toolSurfaceChanges(surface, [
      { ...search, annotations: { readOnlyHint: false }, title: "Search" },
      { name: "worktable_new", description: "New." },
    ])
  ).toEqual([
    "changed search: annotations, title",
    "added worktable_new",
    "removed fetch",
  ])
  expect(toolSurfaceChanges(surface, [fetch, search])).toEqual([
    "changed the order of tools",
  ])

  const labelled = (...names: string[]) => ({
    pull_request: { labels: names.map((name) => ({ name })) },
  })
  expect(labelledForChange(labelled("docs", "tool-surface-change"))).toBe(true)
  expect(labelledForChange(labelled("docs"))).toBe(false)
  expect(labelledForChange({})).toBe(false)
})
