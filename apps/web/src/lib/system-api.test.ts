import { describe, expect, it } from "bun:test"
import { normalizeSystemVersion, UPDATE_CHECK_FRESH_MS } from "./system-api"

const baseVersion = {
  current: "1.2.3",
  canUpdate: true,
  hasEmbeddedInstaller: true,
  latest: "1.2.4",
  updateAvailable: true,
}

describe("system version normalization", () => {
  it("preserves the remaining TTL when deriving freshness for a legacy response", () => {
    const remaining = 5_000
    const normalized = normalizeSystemVersion({
      ...baseVersion,
      checkedAt: new Date(
        Date.now() - UPDATE_CHECK_FRESH_MS + remaining
      ).toISOString(),
    })

    expect(normalized.checkStatus).toBe("fresh")
    expect(normalized.checkTtlRemainingMs).toBeGreaterThan(0)
    expect(normalized.checkTtlRemainingMs).toBeLessThanOrEqual(remaining)
  })

  it("honors server freshness and remaining TTL with either browser clock skew", () => {
    for (const offset of [-24 * 60 * 60_000, 24 * 60 * 60_000]) {
      for (const remaining of [undefined, 5_000, 0]) {
        const normalized = normalizeSystemVersion({
          ...baseVersion,
          checkedAt: new Date(Date.now() + offset).toISOString(),
          lastAttemptAt: new Date().toISOString(),
          checkStatus: "fresh",
          checkTtlRemainingMs: remaining,
        })
        expect(normalized.checkStatus).toBe("fresh")
        expect(normalized.checkTtlRemainingMs).toBe(
          remaining ?? UPDATE_CHECK_FRESH_MS
        )
      }
    }
  })
})
