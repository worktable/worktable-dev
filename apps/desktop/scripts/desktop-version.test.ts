import { describe, expect, test } from "bun:test"
import { desktopReleaseTag, resolveDesktopVersion } from "./desktop-version"

const commit = "abc1234".padEnd(40, "0")

describe("Desktop build version", () => {
  test("is the prepared release unless a beta build of this commit is named", () => {
    const base = { configVersion: "0.1.23", commit }
    expect(resolveDesktopVersion({ ...base, buildVersion: undefined })).toBe(
      "0.1.23"
    )
    expect(resolveDesktopVersion({ ...base, buildVersion: "0.1.23" })).toBe(
      "0.1.23"
    )
    expect(
      resolveDesktopVersion({ ...base, buildVersion: "0.1.24-dev.140+abc1234" })
    ).toBe("0.1.24-dev.140+abc1234")
    for (const buildVersion of [
      "0.1.24",
      "0.1.24-dev.140+fffffff",
      "0.1.24-beta.1",
    ]) {
      expect(() => resolveDesktopVersion({ ...base, buildVersion })).toThrow(
        "WORKTABLE_VERSION"
      )
    }
  })

  test("publishes under the tag without build metadata", () => {
    expect(desktopReleaseTag("0.1.24-dev.140+abc1234")).toBe("v0.1.24-dev.140")
    expect(desktopReleaseTag("0.1.24")).toBe("v0.1.24")
  })
})

describe("release bundle build", () => {
  test("overrides Tauri's version only for a beta build", async () => {
    const { releaseBundleArguments } = await import("./build-release-bundle")
    const release = releaseBundleArguments("0.1.23", "0.1.23")
    expect(release).toEqual([
      "build",
      "--bundles",
      "app,dmg",
      "--config",
      "src-tauri/tauri.release.conf.json",
    ])
    expect(releaseBundleArguments("0.1.24-dev.140+abc1234", "0.1.23")).toEqual([
      ...release,
      "--config",
      '{"version":"0.1.24-dev.140+abc1234"}',
    ])
  })
})
