import { afterEach, describe, expect, it } from "bun:test"
import {
  applyDesktopAgentSkillOperation,
  getDesktopAgentSkillStatuses,
  previewDesktopAgentSkillOperation,
} from "./desktop-agent-skills"

interface TestGlobal {
  __TAURI__?: {
    core: { invoke: (command: string, args?: unknown) => Promise<unknown> }
  }
}

const desktopGlobal = globalThis as typeof globalThis & TestGlobal

function status(targetId: "claude" | "agents" = "agents") {
  return {
    targetId,
    label: targetId === "claude" ? "Claude" : "Other agents",
    state: "current",
    detail: "Installed skills match this Worktable release.",
    targetRoot: `/tmp/home/.${targetId}/skills`,
    resolvedTargetRoot: `/tmp/home/.${targetId}/skills`,
    sourcePackageDigest: "package-v1",
    installedPackageDigest: "package-v1",
    missingSkills: [],
    modifiedSkills: [],
    allowedOperations: ["remove"],
  }
}

function allStatuses() {
  return [status("claude"), status("agents")]
}

afterEach(() => {
  delete desktopGlobal.__TAURI__
})

describe("Desktop agent skill bridge", () => {
  it("stays absent outside Desktop and on a denied workspace surface", async () => {
    expect(await getDesktopAgentSkillStatuses()).toBeNull()
    for (const message of [
      "native agent skill command requires the active local Desktop workspace",
      "desktop_agent_skills_status not allowed. Permissions associated with this command do not allow this invocation.",
    ]) {
      desktopGlobal.__TAURI__ = {
        core: {
          invoke: async () => {
            throw new Error(message)
          },
        },
      }
      expect(await getDesktopAgentSkillStatuses()).toBeNull()
    }
  })

  it("rejects malformed or incomplete native status", async () => {
    desktopGlobal.__TAURI__ = {
      core: {
        invoke: async () => ({ schemaVersion: 2, statuses: [status()] }),
      },
    }
    await expect(getDesktopAgentSkillStatuses()).rejects.toThrow(
      "incomplete agent skill status"
    )
  })

  it("uses the target-based status, preview, and apply contract", async () => {
    const calls: Array<{ command: string; args?: unknown }> = []
    desktopGlobal.__TAURI__ = {
      core: {
        invoke: async (command, args) => {
          calls.push({ command, args })
          if (command === "desktop_agent_skills_status") {
            return { schemaVersion: 2, statuses: allStatuses() }
          }
          if (command === "desktop_agent_skills_preview") {
            return {
              schemaVersion: 2,
              preview: {
                planId: "a".repeat(64),
                allowed: true,
                action: "remove",
                changes: ["Remove six unchanged Worktable skill folders."],
                status: status(),
              },
            }
          }
          return {
            schemaVersion: 2,
            result: {
              applied: true,
              statusAfter: {
                ...status(),
                state: "not-installed",
                allowedOperations: ["install"],
              },
            },
          }
        },
      },
    }

    expect(await getDesktopAgentSkillStatuses()).toHaveLength(2)
    expect(
      await previewDesktopAgentSkillOperation("agents", "remove")
    ).toMatchObject({ action: "remove", allowed: true })
    expect(
      await applyDesktopAgentSkillOperation("agents", "remove", "a".repeat(64))
    ).toMatchObject({ applied: true, statusAfter: { state: "not-installed" } })
    expect(calls).toEqual([
      { command: "desktop_agent_skills_status", args: undefined },
      {
        command: "desktop_agent_skills_preview",
        args: { targetId: "agents", operation: "remove" },
      },
      {
        command: "desktop_agent_skills_apply",
        args: {
          targetId: "agents",
          operation: "remove",
          planId: "a".repeat(64),
        },
      },
    ])
  })

  it("rejects operations the native contract does not support", async () => {
    desktopGlobal.__TAURI__ = {
      core: {
        invoke: async () => ({
          schemaVersion: 2,
          statuses: [
            { ...status("claude"), allowedOperations: ["rollback"] },
            status("agents"),
          ],
        }),
      },
    }
    await expect(getDesktopAgentSkillStatuses()).rejects.toThrow(
      "invalid agent skill status"
    )
  })
})
