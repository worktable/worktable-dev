import { describe, expect, it } from "bun:test"
import type { DeploymentInfo } from "@/lib/system-api"
import { getHelpResources } from "./sections/help-resources"
import { getSettingsSections } from "./sections"

const capabilities: DeploymentInfo["capabilities"] = {
  cloudAccount: false,
  workspaceName: true,
  workspacePath: true,
  workspaceUrl: true,
  workspacePortability: true,
  editorSettings: true,
  historySettings: true,
  softwareUpdates: true,
  updateChecks: true,
  documentSharing: false,
  shareLinks: false,
  files: true,
}

describe("settings sections", () => {
  it("lists the Worktable's settings first, then the person's, then Support", () => {
    const labels = (deployment: DeploymentInfo) =>
      getSettingsSections(deployment).map(
        (section) => `${section.group}/${section.label}`
      )

    expect(
      labels({
        mode: "cloud",
        capabilities: { ...capabilities, cloudAccount: true, shareLinks: true },
      })
    ).toEqual([
      "Worktable/General",
      "Worktable/Team",
      "Worktable/Agents",
      "Worktable/Sharing",
      "Worktable/Billing",
      "Worktable/Data",
      "You/Profile",
      "You/Appearance",
      "You/Privacy",
      "Support/Help",
      "Support/About",
    ])
    expect(labels({ mode: "self-managed", capabilities })).toEqual([
      "Worktable/General",
      "Worktable/Team",
      "Worktable/Agents",
      "Worktable/Remote",
      "Worktable/Data",
      "You/Profile",
      "You/Appearance",
      "Support/Help",
      "Support/System",
    ])
  })

  it("shows Data while any of History, Backups, or Import & Export applies", () => {
    const ids = (mode: DeploymentInfo["mode"]) =>
      getSettingsSections({
        mode,
        capabilities: {
          ...capabilities,
          historySettings: false,
          workspacePortability: false,
        },
      }).map((section) => section.id)

    // Cloud always has Backups.
    expect(ids("cloud")).toContain("data")
    expect(ids("self-managed")).not.toContain("data")
  })

  it("offers Sharing only to people who may oversee share links", () => {
    for (const mode of ["self-managed", "cloud"] as const) {
      const ids = (shareLinks: boolean) =>
        getSettingsSections({
          mode,
          capabilities: { ...capabilities, documentSharing: true, shareLinks },
        }).map((section) => section.id)
      expect(ids(true)).toContain("sharing")
      expect(ids(false)).not.toContain("sharing")
    }
  })

  it("uses the policies for the active deployment", () => {
    const selfManaged = getHelpResources("self-managed").map(
      (resource) => resource.href
    )
    const cloud = getHelpResources("cloud").map((resource) => resource.href)

    expect(selfManaged).toContain("https://www.worktable.dev/privacy")
    expect(selfManaged).toContain("https://www.worktable.dev/terms")
    expect(cloud).toContain("https://www.worktable.cloud/privacy")
    expect(cloud).toContain("https://www.worktable.cloud/terms")
  })
})
