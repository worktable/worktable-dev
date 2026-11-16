import { describe, expect, it } from "bun:test"
import { codingPluginStep, pluginReaches } from "./agent-app-steps"

describe("agent app steps", () => {
  it("offers the plugin only where its shared address reaches this Worktable", () => {
    expect(pluginReaches("https://app.worktable.cloud/api/mcp")).toBe(true)
    // Another Worktable on the same account has its own address.
    expect(pluginReaches("https://app.worktable.cloud/api/mcp/w/wt_123")).toBe(false)
    expect(pluginReaches("http://127.0.0.1:7480/mcp")).toBe(false)
  })

  it("has a plugin for Claude Code and Codex, and none for other coding agents", () => {
    expect(codingPluginStep("claude-code")?.command).toContain("worktable/worktable-plugin")
    expect(codingPluginStep("codex")?.command).toContain("worktable@openai-curated-remote")
    expect(codingPluginStep("cursor")).toBeNull()
    expect(codingPluginStep(null)).toBeNull()
  })
})
