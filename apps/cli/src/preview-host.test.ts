import { describe, expect, test } from "bun:test"
import { renderAppArmorProfile } from "./preview-host.ts"

describe("preview AppArmor profile", () => {
  test("covers every release of this install and escapes glob characters", () => {
    const releaseDir = "/home/sam/.config/work [table]/releases/0.1.24"
    const profile = renderAppArmorProfile(
      releaseDir,
      `${releaseDir}/preview-runtime/browser/chrome-headless-shell-linux64/chrome-headless-shell`
    )
    expect(profile).toContain(
      'profile worktable-chrome-headless-shell "/home/sam/.config/work \\[table\\]/releases/*/preview-runtime/browser/chrome-headless-shell-linux64/chrome-headless-shell" flags=(unconfined) {'
    )
    expect(profile).toContain("  userns,")
  })
})
