import { describe, expect, test } from "bun:test"
import {
  appArmorProfileName,
  renderAppArmorProfile,
} from "./preview-host.ts"

describe("preview AppArmor profile", () => {
  test("covers every release of this install and escapes glob characters", () => {
    const releaseDir = "/home/sam/.config/work [table]/releases/0.1.24"
    const profile = renderAppArmorProfile(
      releaseDir,
      `${releaseDir}/preview-runtime/browser/chrome-headless-shell-linux64/chrome-headless-shell`
    )
    expect(profile).toContain(
      `profile ${appArmorProfileName(releaseDir)} "/home/sam/.config/work \\[table\\]/releases/*/preview-runtime/browser/chrome-headless-shell-linux64/chrome-headless-shell" flags=(unconfined) {`
    )
    expect(profile).toContain("  userns,")
  })

  test("gives each install its own profile", () => {
    expect(appArmorProfileName("/home/sam/.config/worktable/releases/1")).toBe(
      appArmorProfileName("/home/sam/.config/worktable/releases/2")
    )
    expect(appArmorProfileName("/home/sam/.config/worktable/releases/1")).not.toBe(
      appArmorProfileName("/home/alex/.config/worktable/releases/1")
    )
  })
})
