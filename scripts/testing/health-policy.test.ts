import { describe, expect, test } from "bun:test"
import {
  comparableRequiredDuration,
  completeBrowserCleanStreak,
  isBroadRequiredHealthPortfolio,
  isCompleteBrowserSample,
  isPassingCompleteBrowserSample,
  isPeakRssWithinBudget,
  partitionPortfolioRevisionSamples,
} from "./health-policy.ts"

describe("canonical health policy", () => {
  test("compares only samples from the exact portfolio revision", () => {
    expect(
      partitionPortfolioRevisionSamples(
        [
          { revision: undefined, id: "legacy" },
          { revision: "prior", id: "prior" },
          { revision: "current", id: "current" },
          { revision: "future", id: "future" },
        ],
        "current"
      )
    ).toEqual({
      current: [{ revision: "current", id: "current" }],
      excluded: 3,
    })
  })

  test("does not count heavy-lane time in a required-CI sample", () => {
    expect(
      comparableRequiredDuration(
        { profile: "required", durationMs: 180_000 },
        175_000
      )
    ).toBe(180_000)
    expect(
      comparableRequiredDuration(
        { profile: "full", durationMs: 600_000 },
        175_000
      )
    ).toBe(175_000)
  })

  test("excludes targeted selected runs from broad required health", () => {
    expect(
      isBroadRequiredHealthPortfolio({
        profile: "required",
        durationMs: 12_000,
        targeted: true,
      })
    ).toBe(false)
    expect(
      isBroadRequiredHealthPortfolio({
        profile: "required",
        durationMs: 120_000,
        targeted: false,
      })
    ).toBe(true)
  })

  test("counts consecutive complete browser portfolios and ignores selected partial runs", () => {
    expect(
      completeBrowserCleanStreak([
        { complete: true, passed: false },
        { complete: true, passed: true },
        { complete: false, passed: true },
        { complete: true, passed: true },
        { complete: false, passed: false },
      ])
    ).toBe(2)
  })

  test("a failed complete browser portfolio resets the streak", () => {
    expect(
      completeBrowserCleanStreak([
        { complete: true, passed: true },
        { complete: true, passed: false },
        { complete: false, passed: true },
      ])
    ).toBe(0)
  })

  test("an aborted un-targeted full browser portfolio resets the streak", () => {
    expect(
      isCompleteBrowserSample(0, 3, {
        profile: "full",
        durationMs: 0,
        status: "failed",
        targeted: false,
        schedule: "distributed-ci",
      })
    ).toBe(true)
    expect(
      isCompleteBrowserSample(1, 3, {
        profile: "full",
        durationMs: 120_000,
        status: "failed",
        targeted: false,
      })
    ).toBe(true)
    expect(
      isCompleteBrowserSample(1, 3, {
        profile: "changed",
        durationMs: 30_000,
        status: "failed",
        targeted: true,
      })
    ).toBe(false)
  })

  test("only un-targeted full portfolios count as complete browser runs", () => {
    expect(
      isCompleteBrowserSample(3, 3, {
        profile: "changed",
        durationMs: 30_000,
        status: "passed",
        targeted: true,
      })
    ).toBe(false)
    expect(
      isCompleteBrowserSample(3, 3, {
        profile: "full",
        durationMs: 120_000,
        status: "passed",
        targeted: false,
      })
    ).toBe(true)
  })

  test("an aborted partial full portfolio cannot advance the observation streak", () => {
    expect(isPassingCompleteBrowserSample(1, 3, true)).toBe(false)
    expect(isPassingCompleteBrowserSample(3, 3, true)).toBe(true)
    expect(isPassingCompleteBrowserSample(3, 3, false)).toBe(false)
  })

  test("the peak RSS budget is a hard inclusive limit", () => {
    expect(isPeakRssWithinBudget(6_144, 6_144)).toBe(true)
    expect(isPeakRssWithinBudget(6_145, 6_144)).toBe(false)
  })
})
