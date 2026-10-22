import { describe, expect, test } from "bun:test"
import { criticalChain, type Req } from "./click-trace.ts"
import {
  check,
  failing as fails,
  type Measurement,
  type SmokeBudgets,
} from "./smoke.ts"

const budgets: SmokeBudgets = {
  metrics: {
    requests: { why: "" },
    chain: { why: "" },
    "revisit content": { why: "" },
    "idle requests": { why: "" },
    redirects: { why: "" },
    "cold js": { why: "" },
    dom: { why: "", headroom: 0.1 },
    "io stat": { why: "", slack: 0.5 },
    "io read": { why: "", slack: 0.5 },
    "io sql": { why: "", slack: 0.5 },
  },
  budgets: {
    "requests, revisit, open rich doc": { max: 3 },
    "requests, revisit, open HTML doc": { max: 2 },
    "io stat, recent": { max: 65 },
  },
}

function measured(rich: number, html: number, stat: number): Measurement[] {
  return [
    {
      key: "requests, revisit, open rich doc",
      metric: "requests",
      value: rich,
    },
    {
      key: "requests, revisit, open HTML doc",
      metric: "requests",
      value: html,
    },
    { key: "io stat, recent", metric: "io stat", value: stat },
  ]
}

const failing = (measurements: Measurement[]) =>
  check(measurements, budgets)
    .filter(fails)
    .map((verdict) => verdict.key)

describe("perf-smoke budgets", () => {
  test("cached content has no request chain, while a live gate retains its dependencies", () => {
    const request = (label: string, start: number, end: number): Req => ({
      url: `https://localhost${label}`,
      label,
      kind: "api",
      start,
      end,
      queue: 0,
      wait: 0,
      download: 0,
      server: null,
      transfer: 0,
      encoded: 0,
      decoded: 0,
      cached: false,
      status: 200,
      protocol: "h2",
      initiator: null,
    })
    // Recorded warm Home: cached Recent rows appear before its refresh ends.
    const pending = request("/api/pending", 42.2, 85.6)
    const recent = request("/api/recent", 48.5, 169.4)
    expect(criticalChain([pending, recent], 88, /\/api\/recent/, 100)).toEqual([])
    expect(criticalChain([pending], 88, /\/api\/recent/, 100)).toEqual([])
    expect(
      criticalChain([pending, recent], 175, /\/api\/recent/, 100).map(
        (step) => step.label
      )
    ).toEqual(["/api/recent"])
    const sequential = [
      request("/api/workspace", 0, 20),
      request("/api/recent", 25, 60),
      request("/api/pending", 30, 70),
    ]
    expect(
      criticalChain(sequential, 80, /\/api\/recent/, 100).map((step) => step.label)
    ).toEqual(["/api/workspace", "/api/recent"])
    expect(
      criticalChain([pending, recent], 88, null, 100).map((step) => step.label)
    ).toEqual(["/api/pending"])
  })

  test("an extra request or a whole extra file call per request fails", () => {
    expect(failing(measured(3, 2, 65.4))).toEqual([])
    expect(failing(measured(3, 3, 65))).toEqual([
      "requests, revisit, open HTML doc",
    ])
    expect(failing(measured(3, 2, 66))).toEqual(["io stat, recent"])
  })

  test("a new measurement without a budget, or a budget nothing measured, fails", () => {
    expect(
      failing([
        ...measured(3, 2, 65).slice(1),
        {
          key: "requests, revisit, open Records",
          metric: "requests",
          value: 1,
        },
      ])
    ).toEqual([
      "requests, revisit, open Records",
      "requests, revisit, open rich doc",
    ])
  })

  test("a late request counted in the next click passes while the pass total holds", () => {
    const verdicts = check(measured(2, 3, 65), budgets)
    expect(verdicts.map((verdict) => verdict.status)).toEqual([
      "ok",
      "moved",
      "ok",
    ])
  })
})
