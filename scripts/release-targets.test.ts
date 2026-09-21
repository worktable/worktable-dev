import { describe, expect, test } from "bun:test"
import {
  parseReleaseProfile,
  releaseOutputNames,
  selectReleaseTargets,
  skillInstallerArtifact,
} from "./release-targets.ts"

describe("release target profiles", () => {
  test("keeps the public release complete by default", () => {
    expect(parseReleaseProfile([])).toBe("full")
    const selection = selectReleaseTargets({
      profile: "full",
      platform: "linux",
      arch: "x64",
    })
    expect(selection.cli.map((target) => target.artifact)).toEqual([
      "worktable-darwin-arm64.tar.gz",
      "worktable-darwin-x64.tar.gz",
      "worktable-linux-x64.tar.gz",
      "worktable-linux-arm64.tar.gz",
    ])
    expect(selection.server.map((target) => target.artifact)).toEqual([
      "worktable-server-linux-x64.tar.gz",
    ])
    expect(selection.cli.map(skillInstallerArtifact)).toEqual([
      "worktable-skills-darwin-arm64.tar.gz",
      "worktable-skills-darwin-x64.tar.gz",
      "worktable-skills-linux-x64.tar.gz",
      "worktable-skills-linux-arm64.tar.gz",
    ])
  })

  test("builds the Linux guest CLI matching the host architecture", () => {
    expect(parseReleaseProfile(["--profile", "lab"])).toBe("lab")
    expect(releaseOutputNames("lab")).toEqual({
      artifacts: "lab-releases",
      work: "lab-release-work",
    })
    expect(releaseOutputNames("full")).toEqual({
      artifacts: "releases",
      work: "release-work",
    })
    expect(
      selectReleaseTargets({
        profile: "lab",
        platform: "linux",
        arch: "x86_64",
      }).cli.map((target) => target.artifact)
    ).toEqual(["worktable-linux-x64.tar.gz"])
    expect(
      selectReleaseTargets({
        profile: "lab",
        platform: "darwin",
        arch: "arm64",
      }).cli.map((target) => target.artifact)
    ).toEqual(["worktable-linux-arm64.tar.gz"])
  })

  test("rejects ambiguous profiles and unsupported hosts", () => {
    expect(() => parseReleaseProfile(["--profile"])).toThrow("missing")
    expect(() => parseReleaseProfile(["--profile", "tiny"])).toThrow("tiny")
    expect(() =>
      selectReleaseTargets({
        profile: "lab",
        platform: "win32",
        arch: "x64",
      })
    ).toThrow("win32")
    expect(() =>
      selectReleaseTargets({
        profile: "lab",
        platform: "linux",
        arch: "riscv64",
      })
    ).toThrow("riscv64")
  })
})
