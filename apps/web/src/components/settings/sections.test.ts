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
}

describe("settings sections", () => {
  it("offers Help in self-managed and cloud deployments", () => {
    const selfManaged = getSettingsSections({
      mode: "self-managed",
      capabilities,
    }).map((section) => section.id)
    const cloud = getSettingsSections({
      mode: "cloud",
      capabilities: { ...capabilities, cloudAccount: true },
    }).map((section) => section.id)

    expect(selfManaged.filter((id) => id === "help")).toHaveLength(1)
    expect(cloud.filter((id) => id === "help")).toHaveLength(1)
    expect(cloud).toContain("backups")
    expect(selfManaged).not.toContain("backups")
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
