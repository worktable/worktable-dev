import { describe, expect, it } from "bun:test"
import { awaitingRequestedCheck } from "./use-desktop-update"
import type { DesktopUpdateStatus } from "@/lib/desktop-updates"

const requestedAt = 1_791_605_530_400

function checkedAt(seconds: number): DesktopUpdateStatus {
  return {
    currentVersion: "0.1.21",
    state: "idle",
    availableVersion: null,
    notes: null,
    downloadedBytes: 0,
    totalBytes: null,
    canRestart: false,
    lastCheck: { checkedAt: seconds, outcome: "current", message: null },
  }
}

describe("requested Desktop update checks", () => {
  it("keeps polling quickly until the requested check is recorded", () => {
    const now = requestedAt + 2_000
    expect(awaitingRequestedCheck(null, now, requestedAt)).toBe(true)
    expect(
      awaitingRequestedCheck(checkedAt(1_791_605_400), now, requestedAt)
    ).toBe(true)
    // Desktop's whole-second timestamp for a check started in the same second.
    expect(
      awaitingRequestedCheck(checkedAt(1_791_605_530), now, requestedAt)
    ).toBe(false)
  })

  it("stops waiting when nothing was requested or the window passed", () => {
    expect(awaitingRequestedCheck(null, requestedAt, 0)).toBe(false)
    expect(
      awaitingRequestedCheck(null, requestedAt + 30_001, requestedAt)
    ).toBe(false)
  })
})
