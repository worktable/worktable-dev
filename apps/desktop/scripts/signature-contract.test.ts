import { describe, expect, test } from "bun:test"
import { assertDeveloperIdSignature } from "./signature-contract"

const expectation = {
  signingIdentity: "Developer ID Application: Example Developer (ABCDE12345)",
  teamId: "ABCDE12345",
}

const validDetails = `Executable=/tmp/Worktable.app
Identifier=dev.worktable.desktop
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=1+7 location=embedded
Authority=Developer ID Application: Example Developer (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
Timestamp=Jul 20, 2026 at 3:00:00 PM
TeamIdentifier=ABCDE12345`

describe("Developer ID signature contract", () => {
  test("accepts the exact identity, team, timestamp, and hardened runtime", () => {
    expect(() =>
      assertDeveloperIdSignature(validDetails, "Worktable.app", expectation, {
        hardenedRuntime: true,
      })
    ).not.toThrow()
  })

  test("rejects an ad-hoc or wrong-team signature", () => {
    expect(() =>
      assertDeveloperIdSignature(
        validDetails.replace(
          `Authority=${expectation.signingIdentity}`,
          "Signature=adhoc"
        ),
        "Worktable.app",
        expectation,
        { hardenedRuntime: true }
      )
    ).toThrow(`Authority=${expectation.signingIdentity}`)
    expect(() =>
      assertDeveloperIdSignature(
        validDetails.replaceAll(expectation.teamId, "WRONGTEAM01"),
        "Worktable.app",
        expectation,
        { hardenedRuntime: true }
      )
    ).toThrow(`Authority=${expectation.signingIdentity}`)
  })

  test("rejects missing timestamps and hardened runtime", () => {
    expect(() =>
      assertDeveloperIdSignature(
        validDetails.replace(
          "Timestamp=Jul 20, 2026 at 3:00:00 PM",
          "Timestamp=none"
        ),
        "Worktable.app",
        expectation,
        { hardenedRuntime: true }
      )
    ).toThrow("secure signing timestamp")
    expect(() =>
      assertDeveloperIdSignature(
        validDetails.replace("flags=0x10000(runtime)", "flags=0x0(none)"),
        "Worktable.app",
        expectation,
        { hardenedRuntime: true }
      )
    ).toThrow("hardened runtime")
  })

  test("does not require a hardened-runtime flag on a disk image", () => {
    expect(() =>
      assertDeveloperIdSignature(validDetails, "Worktable.dmg", expectation, {
        hardenedRuntime: false,
      })
    ).not.toThrow()
  })
})
