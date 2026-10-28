import { describe, expect, test } from "bun:test"
import { parseAnalyticsCookie, parseAnalyticsPreference } from "./analytics"

describe("explicit analytics consent", () => {
  test("absence, old opt-in guesses, and unknown policy versions never grant consent", () => {
    for (const value of [
      undefined,
      null,
      true,
      "on",
      {},
      { version: 0, enabled: true, updatedAt: 1 },
      { version: 1, enabled: "true", updatedAt: 1 },
      { version: 1, enabled: true, updatedAt: Infinity },
    ])
      expect(parseAnalyticsPreference(value)).toBeNull()
    for (const cookie of [
      "",
      "wt_analytics=on",
      "wt_analytics=%not-json",
      'other={"enabled":true}',
    ])
      expect(parseAnalyticsCookie(cookie)).toBeNull()
  })
  test("only a bounded versioned choice survives cookie parsing", () => {
    const preference = { version: 1 as const, enabled: false, updatedAt: 100 }
    expect(
      parseAnalyticsCookie(
        `session=private; wt_analytics=${encodeURIComponent(JSON.stringify(preference))}; theme=dark`
      )
    ).toEqual(preference)
    expect(parseAnalyticsCookie(`wt_analytics=${"x".repeat(513)}`)).toBeNull()
  })
})
