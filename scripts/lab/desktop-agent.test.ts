import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import {
  desktopAgentEnvironment,
  desktopAgentSessionMarker,
  selectDesktopAgentRun,
  withDesktopAgentEnvironment,
} from "./desktop-agent.ts"
import type { DesktopLabManifest } from "./desktop.ts"

function manifest(name: string, pid: number | null = 42): DesktopLabManifest {
  const root = join("/tmp", name)
  return {
    schemaVersion: 2,
    kind: "worktable.desktop-lab",
    name,
    owner: "tester",
    createdAt: "2026-07-16T00:00:00.000Z",
    expiresAt: "2026-07-16T02:00:00.000Z",
    sourceCommit: "abc",
    inputFingerprint: "fingerprint",
    keep: false,
    paths: {
      root,
      home: join(root, "home"),
      appData: join(root, "desktop-app-data"),
      workspaces: join(root, "workspaces"),
      defaultWorkspace: join(root, "home", "Worktable"),
      stdoutLog: join(root, "stdout.log"),
      stderrLog: join(root, "stderr.log"),
      guide: join(root, "guide.md"),
      agentWorkdir: join(root, "agent-workdir"),
      agentSessions: join(root, "agent-sessions"),
      mcpReview: join(root, "agent-workdir", "MCP_REVIEW.md"),
    },
    pid,
    status: pid ? "running" : "stopped",
  }
}

describe("Desktop lab agent launcher", () => {
  test("isolates client homes and removes ambient credentials and overrides", () => {
    const run = manifest("isolated")
    const environment = desktopAgentEnvironment(run, {
      PATH: "/usr/bin",
      HOME: "/Users/real",
      CODEX_HOME: "/Users/real/.codex",
      CLAUDE_CONFIG_DIR: "/Users/real/.claude",
      WORKTABLE_CODEX_CONFIG: "/Users/real/.codex/config.toml",
      WORKTABLE_DESKTOP_WORKSPACE: "/Users/real/Worktable",
      WORKTABLE_DESKTOP_PICKER_DIRECTORY: "/Users/real",
      WORKTABLE_MCP_TOKEN: "worktable-token",
      WORKTABLE_OWNER_PASSWORD: "owner-password",
      OPENAI_API_KEY: "secret",
      ANTHROPIC_API_KEY: "secret",
      CLAUDE_CODE_OAUTH_TOKEN: "secret",
    })
    expect(environment.HOME).toBe(run.paths.home)
    expect(environment.CODEX_HOME).toBe(join(run.paths.home, ".codex"))
    expect(environment.CLAUDE_CONFIG_DIR).toBe(join(run.paths.home, ".claude"))
    expect(environment.XDG_CONFIG_HOME).toBe(join(run.paths.home, ".config"))
    expect(environment.WORKTABLE_CODEX_CONFIG).toBe(
      join(run.paths.home, ".codex", "config.toml")
    )
    expect(environment.WORKTABLE_OPENCODE_CONFIG).toBe(
      join(run.paths.home, ".config", "opencode", "opencode.json")
    )
    expect(environment.PATH).toBe("/usr/bin")
    for (const key of [
      "WORKTABLE_DESKTOP_WORKSPACE",
      "WORKTABLE_DESKTOP_PICKER_DIRECTORY",
      "WORKTABLE_MCP_TOKEN",
      "WORKTABLE_OWNER_PASSWORD",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ])
      expect(environment[key]).toBeUndefined()
  })

  test("auto-selects exactly one active run and requires a name for ambiguity", () => {
    const first = manifest("first", 41)
    const second = manifest("second", 42)
    const active = (pid: number): boolean => pid === 42
    expect(selectDesktopAgentRun(undefined, [first, second], active).name).toBe(
      "second"
    )
    expect(selectDesktopAgentRun("second", [first, second], active).name).toBe(
      "second"
    )
    expect(() =>
      selectDesktopAgentRun(undefined, [first, second], () => true)
    ).toThrow("More than one")
    expect(() =>
      selectDesktopAgentRun("missing", [first, second], () => true)
    ).toThrow("not an active owned run")
    expect(() => selectDesktopAgentRun(undefined, [], () => true)).toThrow(
      "No active Desktop lab"
    )
  })

  test("pins connector path resolution while pairing and restores the host environment", async () => {
    const run = manifest("pairing")
    const environment = desktopAgentEnvironment(run, process.env)
    const beforeCodex = process.env.WORKTABLE_CODEX_CONFIG
    const beforeOpenCode = process.env.WORKTABLE_OPENCODE_CONFIG
    await withDesktopAgentEnvironment(environment, async () => {
      expect(process.env.WORKTABLE_CODEX_CONFIG).toBe(
        join(run.paths.home, ".codex", "config.toml")
      )
      expect(process.env.WORKTABLE_OPENCODE_CONFIG).toBe(
        join(run.paths.home, ".config", "opencode", "opencode.json")
      )
    })
    expect(process.env.WORKTABLE_CODEX_CONFIG).toBe(beforeCodex)
    expect(process.env.WORKTABLE_OPENCODE_CONFIG).toBe(beforeOpenCode)
  })

  test("session markers contain executable identity but never command arguments", () => {
    const marker = desktopAgentSessionMarker("review", "codex", 42, "codex")
    expect(Object.keys(marker).sort()).toEqual([
      "client",
      "executable",
      "kind",
      "pid",
      "runName",
      "schemaVersion",
      "startedAt",
    ])
    expect(JSON.stringify(marker)).not.toContain("pairing-code")
  })
})
