import { expect, test } from "bun:test"
import {
  formatAnalyticsLocation,
  isConsentRequiredLocation,
  parseAnalyticsLocation,
} from "./analytics-region"

test("asks only in the EEA, UK, Crown Dependencies, Gibraltar, Switzerland and Quebec", () => {
  for (const [country, subdivision] of [
    ["DE"],
    ["FR"],
    ["NO"],
    ["GB"],
    ["JE"],
    ["GI"],
    ["CH"],
    ["CA", "QC"],
  ] as const)
    expect(isConsentRequiredLocation(country, subdivision)).toBe(true)
  // Unknown, anonymized or malformed locations start with analytics.
  for (const [country, subdivision] of [
    ["US", "CA"],
    ["CA", "ON"],
    ["CA"],
    ["BR"],
    ["XX"],
    ["T1"],
    ["de"],
    [""],
    [undefined],
  ] as const)
    expect(isConsentRequiredLocation(country, subdivision)).toBe(false)
  // The gateway forwards only well-formed codes; anything else is unknown.
  expect(parseAnalyticsLocation(formatAnalyticsLocation("CA", "QC"))).toEqual({
    country: "CA",
    region: "QC",
  })
  expect(parseAnalyticsLocation(formatAnalyticsLocation("DE", 12))).toEqual({
    country: "DE",
  })
  expect(formatAnalyticsLocation("xx", "QC")).toBeUndefined()
  expect(parseAnalyticsLocation("CA-QC; DROP")).toBeUndefined()
})
