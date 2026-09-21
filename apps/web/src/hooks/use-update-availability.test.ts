import { describe, expect, it } from "bun:test"
import type { SystemVersion } from "@/lib/system-api"
import { updateAvailabilityPollInterval } from "./use-update-availability"

const uncheckedVersion = { checkStatus: "unchecked" } as SystemVersion

describe("update availability polling", () => {
  it("polls an unchecked startup briefly, then settles to the steady interval", () => {
    const startedAt = 1_000_000

    expect(updateAvailabilityPollInterval(undefined, null, startedAt)).toBe(
      10_000
    )
    expect(
      updateAvailabilityPollInterval(undefined, startedAt, startedAt + 59_999)
    ).toBe(10_000)
    expect(
      updateAvailabilityPollInterval(
        uncheckedVersion,
        startedAt,
        startedAt + 60_000
      )
    ).toBe(5 * 60_000)
  })
})
