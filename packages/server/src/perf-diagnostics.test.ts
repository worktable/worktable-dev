import { describe, expect, it } from "bun:test"
import {
  LatencyHistogram,
  RollingHistogram,
  timerDrift,
} from "./perf-diagnostics.ts"

describe("performance histograms", () => {
  it("reports percentiles within one bucket and never above the maximum", () => {
    const histogram = new LatencyHistogram()
    for (let ms = 1; ms <= 100; ms += 1) histogram.record(ms)
    const summary = histogram.summary()
    expect(summary.count).toBe(100)
    expect(summary.meanMs).toBe(50.5)
    expect(summary.p50Ms).toBeGreaterThanOrEqual(50)
    expect(summary.p50Ms).toBeLessThanOrEqual(50 * 1.19)
    expect(summary.p99Ms).toBeGreaterThanOrEqual(99)
    expect(summary.p99Ms).toBeLessThanOrEqual(100)
    expect(summary.maxMs).toBe(100)

    const tiny = new LatencyHistogram()
    tiny.record(0)
    tiny.record(-1)
    expect(tiny.summary()).toMatchObject({ count: 2, p99Ms: 0, maxMs: 0 })
  })

  it("forgets samples older than the rolling window", () => {
    const window = new RollingHistogram(10_000, 6, 0)
    window.record(500, 0)
    window.record(1, 30_000)
    expect(window.snapshot(59_999).max).toBe(500)
    const later = window.snapshot(65_000)
    expect(later.count).toBe(1)
    expect(later.max).toBe(1)
    expect(window.snapshot(10 * 60_000).count).toBe(0)
  })

  it("measures lag as lateness beyond the timer interval", () => {
    expect(timerDrift(1_000, 1_050, 50)).toBe(0)
    expect(timerDrift(1_000, 1_040, 50)).toBe(0)
    expect(timerDrift(1_000, 1_250, 50)).toBe(200)
  })
})
