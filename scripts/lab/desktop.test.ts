import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  desktopBundleMayBeReused,
  desktopEnvironment,
  desktopInputFingerprint,
  assertDesktopRunPathsSafe,
  makeDesktopLabName,
  prepareDesktopRun,
  removeOwnedDesktopLabs,
  ttlMilliseconds,
  type DesktopLabManifest,
  type DesktopLabPaths,
} from "./desktop.ts"
import {
  commandMatchesExecutable,
  processGroupMatchesPid,
  recordDesktopPort,
} from "./desktop-watchdog.ts"
import {
  renderDesktopGuide,
  renderDesktopGuideSummary,
} from "./render-guide.ts"

function paths(root: string): DesktopLabPaths {
  return {
    root,
    home: join(root, "home"),
    appData: join(root, "desktop-app-data"),
    workspaces: join(root, "workspaces"),
    defaultWorkspace: join(root, "home", "Worktable"),
    stdoutLog: join(root, "desktop.stdout.log"),
    stderrLog: join(root, "desktop.stderr.log"),
    guide: join(root, "WORKTABLE_DESKTOP_LAB.txt"),
  }
}

function writeRun(
  base: string,
  name: string,
  owner: string,
  overrides: Partial<DesktopLabManifest> = {}
): string {
  const root = join(base, name)
  mkdirSync(root, { recursive: true })
  const manifest: DesktopLabManifest = {
    schemaVersion: 1,
    kind: "worktable.desktop-lab",
    name,
    owner,
    createdAt: "2026-07-16T00:00:00.000Z",
    expiresAt: "2026-07-16T02:00:00.000Z",
    sourceCommit: "abc",
    inputFingerprint: "fingerprint",
    paths: paths(root),
    pid: null,
    status: "stopped",
    ...overrides,
  }
  writeFileSync(
    join(root, ".worktable-desktop-lab.json"),
    `${JSON.stringify(manifest)}\n`
  )
  return root
}

describe("Desktop manual lab", () => {
  test("uses exact build provenance before reusing a bundle", () => {
    const marker = {
      schemaVersion: 1 as const,
      sourceCommit: "abc",
      inputFingerprint: "fingerprint",
      arch: "arm64" as const,
      builtAt: "2026-07-16T00:00:00.000Z",
    }
    expect(
      desktopBundleMayBeReused({
        executableExists: true,
        marker,
        sourceCommit: "abc",
        runtimeSourceCommit: "abc",
        expectedArch: "arm64",
        runtimeArch: "arm64",
        inputFingerprint: "fingerprint",
      })
    ).toBeTrue()
    expect(
      desktopBundleMayBeReused({
        executableExists: true,
        marker,
        sourceCommit: "abc",
        runtimeSourceCommit: "old",
        expectedArch: "arm64",
        runtimeArch: "arm64",
        inputFingerprint: "fingerprint",
      })
    ).toBeFalse()
    expect(
      desktopBundleMayBeReused({
        executableExists: true,
        marker,
        sourceCommit: "abc",
        runtimeSourceCommit: "abc",
        expectedArch: "arm64",
        runtimeArch: "arm64",
        inputFingerprint: "changed",
      })
    ).toBeFalse()
    expect(
      desktopBundleMayBeReused({
        executableExists: true,
        marker,
        sourceCommit: "abc",
        runtimeSourceCommit: "abc",
        expectedArch: "x64",
        runtimeArch: "x64",
        inputFingerprint: "fingerprint",
      })
    ).toBeFalse()
    expect(
      desktopBundleMayBeReused({
        executableExists: true,
        marker: { ...marker, arch: "x64" },
        sourceCommit: "abc",
        runtimeSourceCommit: "abc",
        expectedArch: "x64",
        runtimeArch: "arm64",
        inputFingerprint: "fingerprint",
      })
    ).toBeFalse()
  })

  test("fingerprints the current Desktop input closure deterministically", () => {
    const first = desktopInputFingerprint()
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(desktopInputFingerprint()).toBe(first)
  })

  test("isolates every Desktop path authority and drops ambient overrides", () => {
    const root = "/tmp/worktable-desktop-test"
    const value = desktopEnvironment(paths(root), {
      HOME: "/Users/real",
      WORKTABLE_DESKTOP_WORKSPACE: "/Users/real/Worktable",
      WORKTABLE_DESKTOP_PORT: "1234",
      WORKTABLE_DESKTOP_PREVIEW_PROVIDERS: "1",
      WORKTABLE_DESKTOP_ALLOW_MULTIPLE_INSTANCES: "0",
      WORKTABLE_WORKSPACE: "/Users/real/Worktable",
      WORKTABLE_APP_DIR: "/Users/real/.worktable",
      WORKTABLE_CODEX_CONFIG: "/Users/real/.codex/config.toml",
      WORKTABLE_CURSOR_MCP_CONFIG: "/Users/real/.cursor/mcp.json",
      WORKTABLE_OPENCODE_CONFIG: "/Users/real/.config/opencode/opencode.json",
      WORKTABLE_VSCODE_MCP_CONFIG: "/Users/real/Library/Code/mcp.json",
      ANTHROPIC_API_KEY: "anthropic-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-secret",
      OPENAI_API_KEY: "openai-secret",
      CLAUDE_CONFIG_DIR: "/Users/real/.claude",
      CODEX_HOME: "/Users/real/.codex",
      HOST: "0.0.0.0",
      PORT: "7432",
      SAFE_VALUE: "preserved",
    })
    expect(value.HOME).toBe(join(root, "home"))
    expect(value.WORKTABLE_DESKTOP_APP_DIR).toBe(join(root, "desktop-app-data"))
    expect(value.WORKTABLE_DESKTOP_LOCAL_APP_DIR).toBe(
      join(root, "local-app-data")
    )
    expect(value.XDG_CONFIG_HOME).toStartWith(join(root, "home"))
    expect(value.WORKTABLE_DESKTOP_ALLOW_MULTIPLE_INSTANCES).toBe("1")
    expect(value.SAFE_VALUE).toBe("preserved")
    expect(value.WORKTABLE_DESKTOP_ALLOW_MULTIPLE_INSTANCES).toBe("1")
    for (const key of [
      "WORKTABLE_DESKTOP_WORKSPACE",
      "WORKTABLE_DESKTOP_PORT",
      "WORKTABLE_DESKTOP_PREVIEW_PROVIDERS",
      "WORKTABLE_WORKSPACE",
      "WORKTABLE_APP_DIR",
      "WORKTABLE_CODEX_CONFIG",
      "WORKTABLE_CURSOR_MCP_CONFIG",
      "WORKTABLE_OPENCODE_CONFIG",
      "WORKTABLE_VSCODE_MCP_CONFIG",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "CLAUDE_CONFIG_DIR",
      "CODEX_HOME",
      "HOST",
      "PORT",
    ])
      expect(value[key]).toBeUndefined()
  })

  test("parses validated lifetimes and creates recognizable names", () => {
    expect(ttlMilliseconds("30s")).toBe(30_000)
    expect(ttlMilliseconds("15m")).toBe(900_000)
    expect(ttlMilliseconds("2h")).toBe(7_200_000)
    expect(() => ttlMilliseconds("forever")).toThrow("Invalid")
    expect(makeDesktopLabName("review")).toBe("review")
    expect(makeDesktopLabName()).toMatch(
      /^worktable-desktop-\d{14}-[a-f0-9]{6}$/
    )
  })

  test("watchdog identity requires the exact packaged executable", () => {
    const executable =
      "/Applications/Worktable.app/Contents/MacOS/worktable-desktop"
    expect(commandMatchesExecutable(`${executable}\n`, executable)).toBeTrue()
    expect(
      commandMatchesExecutable(`${executable} --other`, executable)
    ).toBeFalse()
    expect(
      commandMatchesExecutable("/tmp/another-worktable", executable)
    ).toBeFalse()
    expect(processGroupMatchesPid(42, "  42\n")).toBeTrue()
    expect(processGroupMatchesPid(42, "41\n")).toBeFalse()
  })

  test("watchdog records the sidecar port before force-killing Desktop", () => {
    const root = mkdtempSync(join(tmpdir(), "worktable-watchdog-port-test-"))
    const appData = join(root, "app")
    mkdirSync(appData)
    const manifestPath = join(root, "manifest.json")
    const portFile = join(appData, "desktop-port")
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ kind: "worktable.desktop-lab", pid: 42, status: "running" })}\n`
    )
    writeFileSync(portFile, "17432\n")
    try {
      expect(recordDesktopPort(manifestPath, portFile, 42)).toBe(17432)
      expect(JSON.parse(readFileSync(manifestPath, "utf8")).port).toBe(17432)
      expect(recordDesktopPort(manifestPath, portFile, 7)).toBeUndefined()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("cleanup removes only inactive owned manifests", () => {
    const base = mkdtempSync(join(tmpdir(), "worktable-desktop-clean-test-"))
    const owned = writeRun(base, "owned", "owner")
    const active = writeRun(base, "active", "owner", { pid: 42 })
    const portActive = writeRun(base, "port-active", "owner", { port: 17432 })
    const discoveredPort = writeRun(base, "discovered-port", "owner")
    mkdirSync(paths(discoveredPort).appData, { recursive: true })
    writeFileSync(
      join(paths(discoveredPort).appData, "desktop-port"),
      "17433\n"
    )
    const foreign = writeRun(base, "foreign", "someone-else")
    const invalid = join(base, "invalid")
    mkdirSync(invalid)
    writeFileSync(join(invalid, "note"), "not a lab")
    const symlink = join(base, "link")
    symlinkSync(owned, symlink)
    try {
      const preview = removeOwnedDesktopLabs({
        dryRun: true,
        base,
        owner: "owner",
        pidIsActive: () => true,
        portIsActive: () => true,
      })
      expect(preview.removed).toEqual([owned])
      expect(preview.running).toEqual([active, discoveredPort, portActive])
      expect(preview.ignored).toEqual([foreign, invalid, symlink])
      expect(
        readFileSync(join(owned, ".worktable-desktop-lab.json"), "utf8")
      ).toContain("worktable.desktop-lab")

      const removed = removeOwnedDesktopLabs({
        base,
        owner: "owner",
        pidIsActive: () => true,
        portIsActive: () => true,
      })
      expect(removed.removed).toEqual([owned])
      expect(existsSync(owned)).toBeFalse()
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("named-run resume rejects owned processes but ignores reused pids", () => {
    const base = mkdtempSync(join(tmpdir(), "worktable-desktop-resume-test-"))
    try {
      const manifest = prepareDesktopRun({
        name: "resume",
        ttl: "2h",
        sourceCommit: "abc",
        inputFingerprint: "fingerprint",
        base,
        owner: "owner",
      })
      writeFileSync(
        join(manifest.paths.root, ".worktable-desktop-lab.json"),
        `${JSON.stringify({ ...manifest, pid: 42 })}\n`
      )
      expect(() =>
        prepareDesktopRun({
          name: "resume",
          ttl: "2h",
          sourceCommit: "abc",
          inputFingerprint: "fingerprint",
          base,
          owner: "owner",
          pidIsActive: () => true,
        })
      ).toThrow("already running as pid 42")
      const resumed = prepareDesktopRun({
        name: "resume",
        ttl: "2h",
        sourceCommit: "abc",
        inputFingerprint: "fingerprint",
        base,
        owner: "owner",
        pidIsActive: () => false,
      })
      expect(resumed.pid).toBeNull()
      writeFileSync(join(manifest.paths.appData, "desktop-port"), "17433\n")
      expect(() =>
        prepareDesktopRun({
          name: "resume",
          ttl: "2h",
          sourceCommit: "abc",
          inputFingerprint: "fingerprint",
          base,
          owner: "owner",
          portIsActive: (port) => port === 17433,
        })
      ).toThrow("still has a Worktable sidecar on port 17433")
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("cleanup retains a stopped Desktop run while an agent session is active", () => {
    const base = mkdtempSync(join(tmpdir(), "worktable-desktop-agent-clean-"))
    const root = join(base, "agent-run")
    const runPaths = paths(root)
    runPaths.agentSessions = join(root, "agent-sessions")
    const run = writeRun(base, "agent-run", "owner", {
      schemaVersion: 2,
      paths: runPaths,
      keep: false,
    })
    mkdirSync(runPaths.agentSessions)
    writeFileSync(
      join(runPaths.agentSessions, "42.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "worktable.desktop-lab-agent",
        runName: "agent-run",
        client: "codex",
        pid: 42,
        executable: "codex",
        startedAt: "2026-07-16T00:00:00.000Z",
      })}\n`
    )
    try {
      const retained = removeOwnedDesktopLabs({
        base,
        owner: "owner",
        pidIsActive: () => false,
        portIsActive: () => false,
        agentSessionIsActive: () => true,
      })
      expect(retained.running).toEqual([run])
      expect(existsSync(run)).toBeTrue()
      const removed = removeOwnedDesktopLabs({
        base,
        owner: "owner",
        pidIsActive: () => false,
        portIsActive: () => false,
        agentSessionIsActive: () => false,
      })
      expect(removed.removed).toEqual([run])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("agent launch rejects an owned manifest whose isolated home escapes the run", () => {
    const base = mkdtempSync(join(tmpdir(), "worktable-desktop-agent-paths-"))
    const outside = mkdtempSync(join(tmpdir(), "worktable-desktop-agent-home-"))
    try {
      const run = prepareDesktopRun({
        name: "unsafe-home",
        ttl: "2h",
        sourceCommit: "abc",
        inputFingerprint: "fingerprint",
        base,
        owner: "owner",
      })
      expect(() =>
        assertDesktopRunPathsSafe({ ...run.paths, home: outside })
      ).toThrow("escapes its run root")
    } finally {
      rmSync(base, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  test("guide keeps host agent configuration outside the acceptance flow", () => {
    const options = {
      name: "review",
      ttl: "2h",
      root: "/tmp/review",
      home: "/tmp/review/home",
      appData: "/tmp/review/app",
      defaultWorkspace: "/tmp/review/home/Worktable",
      fixture: "basic-docs",
      fixtureWorkspace: "/tmp/review/workspaces/basic-docs",
      sourceCommit: "abc",
      stdoutLog: "/tmp/review/stdout.log",
      stderrLog: "/tmp/review/stderr.log",
      guide: "/tmp/review/WORKTABLE_DESKTOP_LAB.txt",
      keep: false,
    }
    const guide = renderDesktopGuide(options)
    expect(guide).toContain("Open an existing workspace")
    expect(guide).toContain("## UI review")
    expect(guide).toContain("## Agent and MCP review")
    expect(guide).toContain("bun run lab -- agent codex --name review")
    expect(guide).toContain("Isolated HOME: /tmp/review/home")
    expect(guide).not.toContain("env -u WORKTABLE_CODEX_CONFIG")
    expect(guide).not.toContain("WORKTABLE_VSCODE_MCP_CONFIG=")
    expect(guide).toContain("does not set the ephemeral workspace override")
    const summary = renderDesktopGuideSummary(options)
    expect(summary).toStartWith("Desktop lab: basic-docs\n\nCommands in order")
    expect(summary).not.toContain("Isolated HOME")
    expect(summary).not.toContain("Run: review")
    expect(summary).toEndWith(
      "Detailed guide and logs: /tmp/review/WORKTABLE_DESKTOP_LAB.txt"
    )
  })

  test("named fixture supplies only its parent as a trusted picker hint", () => {
    const root = "/tmp/worktable-desktop-picker-env"
    const labPaths = paths(root)
    labPaths.fixtureWorkspace = join(root, "workspaces", "basic-docs")
    const value = desktopEnvironment(
      labPaths,
      {
        WORKTABLE_DESKTOP_PICKER_DIRECTORY: "/Users/real/private",
      },
      labPaths.workspaces
    )
    expect(value.WORKTABLE_DESKTOP_PICKER_DIRECTORY).toBe(
      join(root, "workspaces")
    )
    const withoutFixture = desktopEnvironment(labPaths, {
      WORKTABLE_DESKTOP_PICKER_DIRECTORY: "/Users/real/private",
    })
    expect(withoutFixture.WORKTABLE_DESKTOP_PICKER_DIRECTORY).toBeUndefined()
  })
})
