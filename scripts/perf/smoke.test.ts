import { describe, expect, test } from "bun:test"
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
