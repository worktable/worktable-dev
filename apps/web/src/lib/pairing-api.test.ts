import { describe, expect, it } from "bun:test"
import {
  latestPairingFailure,
  shouldPollPairing,
  type PairingEvent,
  type PairingSession,
} from "./pairing-api.ts"

function event(name: PairingEvent["event"]): PairingEvent {
  return { at: "2026-07-16T00:00:00.000Z", event: name }
}

describe("latestPairingFailure", () => {
  it("ignores stale rollback events after a verified terminal outcome", () => {
    expect(
      latestPairingFailure({
        status: "verified",
        events: [event("verified"), event("rolled_back")],
      })
    ).toBeUndefined()
  })

  it("returns the latest failure for a failed session", () => {
    const failure = event("rolled_back")
    expect(
      latestPairingFailure({
        status: "failed",
        events: [event("failed"), failure],
      })
    ).toBe(failure)
  })
})

describe("shouldPollPairing", () => {
  it("keeps watching pending and redeemed pairings", () => {
    expect(shouldPollPairing({ status: "pending" } as PairingSession)).toBe(
      true
    )
    expect(shouldPollPairing({ status: "redeemed" } as PairingSession)).toBe(
      true
    )
  })

  it("stops watching every terminal state", () => {
    expect(shouldPollPairing({ status: "verified" } as PairingSession)).toBe(
      false
    )
    expect(shouldPollPairing({ status: "failed" } as PairingSession)).toBe(
      false
    )
    expect(shouldPollPairing({ status: "expired" } as PairingSession)).toBe(
      false
    )
  })
})
