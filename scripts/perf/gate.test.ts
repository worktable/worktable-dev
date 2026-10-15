import { describe, expect, test } from "bun:test"
import { compare, confirm, confirmationPlan } from "./gate.ts"

const JOURNEYS = ["Home", "Space", "Markdown", "rich", "HTML", "thread"]

/** One run: every journey's base time scaled, with per-journey jitter. */
function run(
  commit: string,
  scale: number,
  jitter: number[],
  network = "phone"
) {
  return {
    commit,
    clicks: JOURNEYS.map((journey, index) => ({
      network,
      round: 1,
      pass: "cold",
      journey,
      contentMs: ((1000 + 100 * index) * scale * (1 + (jitter[index] ?? 0))) as
        | number
        | null,
    })),
  }
}

/** Repeating spreads of about ±15%, like the phone lane between runs. */
const NOISY = [
  [0.15, -0.1, 0.05, -0.15, 0.1, 0],
  [-0.12, 0.14, -0.05, 0.1, -0.14, 0.12],
  [0, -0.02, 0.12, 0.02, 0.03, -0.12],
]
const QUIET = [
  [0.01, -0.01, 0, 0.01, -0.01, 0],
  [-0.01, 0.01, 0.01, -0.01, 0, 0.01],
  [0, 0, -0.01, 0, 0.01, -0.01],
]

function ids(results: unknown[], k = 3) {
  return compare(results, "aaaa", "bbbb", k).regressions.map((item) => item.id)
}

describe("paired speed gate", () => {
  test("a change inside the lane's noise passes; the same change in a quiet lane fails", () => {
    // The head's middle run swaps in another run's jitter: medians move by
    // 12 to 15% while nothing changed but luck.
    const base = NOISY.map((jitter) => run("aaaa", 1, jitter))
    const head = [NOISY[1]!, NOISY[0]!, NOISY[0]!].map((jitter) =>
      run("bbbb", 1, jitter)
    )
    expect(ids([...base, ...head])).toEqual([])

    const quietBase = QUIET.map((jitter) => run("aaaa", 1, jitter))
    const slower = QUIET.map((jitter) => run("bbbb", 1.2, jitter))
    expect(ids([...quietBase, ...slower])).toEqual([
      ...JOURNEYS.map((journey) => `click:phone:cold:${journey.toLowerCase()}`),
      "pass:phone:cold",
    ])
  })

  test("a slowdown on every screen shows in the pass before any single journey", () => {
    const base = NOISY.map((jitter) => run("aaaa", 1, jitter))
    const head = NOISY.map((jitter) => run("bbbb", 1.4, jitter))
    expect(ids([...base, ...head])).toEqual(["pass:phone:cold"])
  })

  test("a timeout ranks as the slowest run, and rounds inside one result count apart", () => {
    const base = QUIET.map((jitter) => run("aaaa", 1, jitter))
    const head = QUIET.map((jitter) => run("bbbb", 1, jitter))
    head[0]!.clicks[0]!.contentMs = null
    head[1]!.clicks[0]!.contentMs = null
    expect(ids([...base, ...head])).toEqual(["click:phone:cold:home"])
    // The same three runs as rounds of one result per side.
    const merged = (runs: ReturnType<typeof run>[], commit: string) => ({
      commit,
      clicks: runs.flatMap((item, index) =>
        item.clicks.map((click) => ({ ...click, round: index + 1 }))
      ),
    })
    const verdict = compare(
      [merged(base, "aaaa"), merged(head, "bbbb")],
      "aaaa",
      "bbbb"
    )
    expect(verdict.comparisons[0]!.runs).toEqual({ base: 3, head: 3 })
  })

  test("server routes keep the 1 ms floor under 1 ms", () => {
    const server = (commit: string, p95: number) => ({
      commit,
      timing: { timings: [{ role: "solo", endpoint: "workspace", p95 }] },
    })
    expect(
      ids([
        server("aaaa", 0.4),
        server("aaaa", 0.4),
        server("bbbb", 1.3),
        server("bbbb", 1.3),
      ])
    ).toEqual([])
    expect(
      ids([
        server("aaaa", 0.4),
        server("aaaa", 0.4),
        server("bbbb", 1.5),
        server("bbbb", 1.5),
      ])
    ).toEqual(["server:p95:workspace"])
  })

  test("sides that do not pair cannot be judged; keys only the head has are noted", () => {
    const verdict = compare(
      [
        run("aaaa", 1, QUIET[0]!),
        run("aaaa", 1, QUIET[1]!),
        run("bbbb", 1, QUIET[0]!),
      ],
      "aaaa",
      "bbbb"
    )
    expect(verdict.incomplete[0]).toBe("clicks:phone: 2 base runs, 1 head runs")
    const old = run("aaaa", 1, QUIET[0]!)
    old.clicks.pop()
    expect(
      compare([old, run("bbbb", 1, QUIET[0]!)], "aaaa", "bbbb").headOnly
    ).toEqual(["click phone:cold:thread"])
  })

  test("only a regression both independent stages found counts, and the plan re-times its pass", () => {
    const base = QUIET.map((jitter) => run("aaaa", 1, jitter))
    const first = compare(
      [...base, ...QUIET.map((jitter) => run("bbbb", 1.2, jitter))],
      "aaaa",
      "bbbb",
      2
    )
    expect(confirmationPlan(first)).toEqual([
      { network: "phone", passes: "cold" },
    ])
    const second = compare(
      [...base, ...QUIET.map((jitter) => run("bbbb", 1, jitter))],
      "aaaa",
      "bbbb"
    )
    expect(confirm(second, first).regressions).toEqual([])
    const again = compare(
      [...base, ...QUIET.map((jitter) => run("bbbb", 1.2, jitter))],
      "aaaa",
      "bbbb"
    )
    expect(confirm(again, first).regressions.length).toBe(7)
  })
})
