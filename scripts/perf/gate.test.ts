import { describe, expect, test } from "bun:test"
import { compare, confirm } from "./gate.ts"

function clicks(commit: string, markdown: number | null, space: number) {
  const click = (journey: string, contentMs: number | null) => ({
    network: "desktop",
    pass: "first",
    journey,
    contentMs,
  })
  return {
    commit,
    clicks: [click("open Markdown doc", markdown), click("open Space", space)],
  }
}

function server(commit: string, workspace: number, recent: number) {
  return {
    commit,
    timing: {
      timings: [
        { role: "solo", endpoint: "workspace", p95: workspace },
        { role: "solo", endpoint: "recent", p95: recent },
      ],
    },
  }
}

const ids = (results: unknown[]) =>
  compare(results, "aaaa", "bbbb").regressions.map((item) => item.id)

describe("paired speed gate", () => {
  test("applies max(10%, 30 ms) to click medians and 10%, or 1 ms under 1 ms, to server p95", () => {
    const base = [
      clicks("aaaa", 100, 400),
      clicks("aaaa", 110, 420),
      clicks("aaaa", 90, 410),
      server("aaaa", 0.4, 20),
      server("aaaa", 0.5, 22),
    ]
    // Markdown +29 ms (under 30), Space +40 ms (under 10% of 410), server
    // +0.9 ms under 1 ms and +2 ms on 20.
    expect(
      ids([
        ...base,
        clicks("bbbb", 129, 450),
        clicks("bbbb", 139, 450),
        clicks("bbbb", 120, 440),
        server("bbbb", 1.3, 22),
        server("bbbb", 1.4, 22),
      ])
    ).toEqual([])
    expect(
      ids([
        ...base,
        clicks("bbbb", 140, 460),
        clicks("bbbb", null, 460),
        clicks("bbbb", 140, 460),
        server("bbbb", 1.6, 24),
        server("bbbb", 1.6, 25),
      ])
    ).toEqual([
      "click:desktop:first:open_markdown_doc",
      "click:desktop:first:open_space",
      "server:p95:workspace",
      "server:p95:recent",
    ])
  })

  test("a measure with more runs on one side does not pair", () => {
    expect(
      compare(
        [
          clicks("aaaa", 100, 400),
          clicks("aaaa", 100, 400),
          clicks("bbbb", 100, 400),
          server("aaaa", 1, 1),
          server("bbbb", 1, 1),
        ],
        "aaaa",
        "bbbb"
      ).incomplete
    ).toEqual([
      "clicks:desktop: 2 base runs, 1 head runs",
      "click desktop:first:open_markdown_doc: 2 base runs, 1 head runs",
      "click desktop:first:open_space: 2 base runs, 1 head runs",
    ])
    // A journey the head never ran, and one the base never showed.
    const head = clicks("bbbb", 100, 400)
    head.clicks.pop()
    expect(
      compare([clicks("aaaa", null, 400), head], "aaaa", "bbbb").incomplete
    ).toEqual([
      "click desktop:first:open_space: 1 base runs, 0 head runs",
      "click desktop:first:open_markdown_doc: the base never showed its content",
    ])
  })

  test("a confirmation run keeps only the regressions found both times", () => {
    const first = compare(
      [clicks("aaaa", 100, 400), clicks("bbbb", 200, 500)],
      "aaaa",
      "bbbb"
    )
    const second = compare(
      [clicks("aaaa", 100, 400), clicks("bbbb", 200, 400)],
      "aaaa",
      "bbbb"
    )
    expect(confirm(second, first).regressions.map((item) => item.id)).toEqual([
      "click:desktop:first:open_markdown_doc",
    ])
  })
})
