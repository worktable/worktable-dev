import { afterEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  antigravitySource,
  devinSource,
  removeProjectedSkills,
  setUpSkills,
  type CommandResult,
  type SkillPluginDependencies,
} from "./skill-plugin.ts"
import {
  applySkillProjection,
  previewSkillProjection,
} from "./skill-projection.ts"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A home with skills copied the way install-skills copies them. */
function homeWithCopiedSkills(): { env: NodeJS.ProcessEnv; skills: string } {
  const root = mkdtempSync(join(tmpdir(), "worktable-skill-plugin-"))
  roots.push(root)
  const sourceDir = join(root, "release", "skills")
  mkdirSync(join(sourceDir, "worktable-library"), { recursive: true })
  writeFileSync(join(sourceDir, "worktable-library", "SKILL.md"), "# Library\n")
  const env = {
    WORKTABLE_SKILL_HOME: join(root, "home"),
    WORKTABLE_APP_DIR: join(root, "app"),
  }
  mkdirSync(env.WORKTABLE_SKILL_HOME, { recursive: true })
  const projection = {
    homeDir: env.WORKTABLE_SKILL_HOME,
    appDataDir: env.WORKTABLE_APP_DIR,
    sourceDir,
    sourceVersion: "1.0.0",
  }
  const request = { targetId: "claude" as const, operation: "install" as const }
  applySkillProjection(
    request,
    previewSkillProjection(request, projection).planId,
    projection
  )
  return { env, skills: join(env.WORKTABLE_SKILL_HOME, ".claude", "skills") }
}

const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" })

/** A client CLI that keeps its installed plugins in memory. */
function fakeCli(
  client: "claude-code" | "codex",
  options: { installed?: string[]; marketplaceHas?: string[]; stale?: boolean } = {}
): { run: SkillPluginDependencies["run"]; calls: string[] } {
  const installed = new Set(options.installed ?? [])
  const listed = options.marketplaceHas ?? ["worktable-skills"]
  // A stale copy of the marketplace lists nothing until it is refreshed.
  const available = new Set(options.stale ? [] : listed)
  const calls: string[] = []
  const run = (_command: string, args: string[]): CommandResult => {
    calls.push(args.join(" "))
    if (args[1] === "list") {
      return ok(
        client === "claude-code"
          ? JSON.stringify([...installed].map((name) => ({ id: `${name}@worktable` })))
          : JSON.stringify({ installed: [...installed].map((name) => ({ name, enabled: true })) })
      )
    }
    if (args[1] === "marketplace") {
      if (args[2] === "update" || args[2] === "upgrade") for (const name of listed) available.add(name)
      return ok(JSON.stringify({ marketplaceName: "worktable" }))
    }
    const name = args[2]!.split("@")[0]!
    if (!available.has(name)) {
      return client === "claude-code"
        ? { status: 1, stdout: JSON.stringify({ failureCode: "not_found", message: `Plugin "${name}" not found` }), stderr: "" }
        : { status: 1, stdout: "", stderr: `Error: plugin \`${name}\` was not found in marketplace \`worktable\`` }
    }
    installed.add(name)
    return ok(JSON.stringify({ outcome: "ok" }))
  }
  return { run, calls }
}

describe("Worktable's skills for a connected coding agent", () => {
  it("installs Worktable Skills from the chosen marketplace, removes earlier copies, and runs again as already installed", async () => {
    const home = homeWithCopiedSkills()
    expect(existsSync(join(home.skills, "worktable-library"))).toBe(true)
    const cli = fakeCli("claude-code")
    const dependencies = {
      run: cli.run,
      env: { WORKTABLE_PLUGIN_MARKETPLACE: "/mirror/worktable-plugin" },
      removeProjectedSkills: (target: "claude" | "agents") =>
        removeProjectedSkills(target, home.env),
      projectSkills: async () => {
        throw new Error("must not copy when the plugin installs")
      },
    }

    const first = await setUpSkills("claude-code", dependencies)
    expect(first.outcome).toEqual({ via: "plugin", alreadyInstalled: false })
    expect(cli.calls).toContain(
      "plugin install worktable-skills --marketplace /mirror/worktable-plugin --json"
    )
    expect(existsSync(join(home.skills, "worktable-library"))).toBe(false)
    expect(first.lines.join("\n")).toContain("Worktable skills plugin installed")
    expect(first.restartHint).toContain("/reload-plugins")

    cli.calls.length = 0
    const again = await setUpSkills("claude-code", dependencies)
    expect(again.outcome).toEqual({ via: "plugin", alreadyInstalled: true })
    expect(cli.calls).toEqual(["plugin list --json"])
  })

  it("refreshes a copy of the marketplace taken before it listed the plugin", async () => {
    for (const client of ["claude-code", "codex"] as const) {
      const cli = fakeCli(client, { stale: true })
      const report = await setUpSkills(client, {
        run: cli.run,
        env: {},
        removeProjectedSkills: () => ({ removed: false }),
      })
      expect(report.outcome).toEqual({ via: "plugin", alreadyInstalled: false })
    }
  })

  it("leaves the full Worktable plugin to bring the skills, and never installs both", async () => {
    const cli = fakeCli("codex", { installed: ["worktable"] })
    const report = await setUpSkills("codex", {
      run: cli.run,
      env: {},
      removeProjectedSkills: () => ({ removed: false }),
    })
    expect(report.outcome).toEqual({ via: "full-plugin" })
    expect(cli.calls).toEqual(["plugin list --json"])
  })

  it("copies the skills when the plugin can't be installed, and says so without failing", async () => {
    const copied: string[] = []
    const missing = fakeCli("codex", { marketplaceHas: [] })
    const report = await setUpSkills("codex", {
      run: missing.run,
      env: {},
      removeProjectedSkills: () => ({ removed: false }),
      projectSkills: async (target) => {
        copied.push(target)
        return null
      },
    })
    expect(copied).toEqual(["agents"])
    expect(report.outcome).toMatchObject({ via: "copy", copied: true })
    expect(report.lines).toEqual([
      "  Couldn't install the Worktable plugin in Codex (plugin `worktable-skills` was not found in marketplace `worktable`), so its skills were copied to ~/.agents/skills instead.",
    ])

    // No CLI to ask, and the copy fails too: still only a line to show.
    const offline = await setUpSkills("claude-code", {
      run: () => ({ status: null, stdout: "", stderr: "spawnSync claude ENOENT" }),
      env: {},
      removeProjectedSkills: () => ({ removed: false }),
      projectSkills: async () => "couldn't download the skill installer",
    })
    expect(offline.outcome).toMatchObject({ via: "copy", copied: false })
    expect(offline.lines[0]).toContain("Couldn't add Worktable's skills to Claude Code (no claude command found;")
  })

  it("installs Worktable Skills with Copilot CLI for Copilot CLI and VS Code, and counts only installed plugins", async () => {
    for (const client of ["copilot", "vscode"] as const) {
      const installed = new Set<string>()
      const calls: string[] = []
      const run = (command: string, args: string[]): CommandResult => {
        calls.push(`${command} ${args.join(" ")}`)
        if (args[1] === "list")
          // A marketplace in a local folder lists each plugin it offers.
          return ok(
            JSON.stringify([
              { name: "worktable", enabled: false, source: "live" },
              { name: "browser-use", enabled: false, source: "builtin" },
              ...[...installed].map((name) => ({ name, enabled: true, source: "installed" })),
            ])
          )
        if (args[1] === "marketplace")
          return { status: 1, stdout: "", stderr: 'Failed to add marketplace: Marketplace "worktable" already registered' }
        installed.add(args[2]!.split("@")[0]!)
        return ok()
      }
      const report = await setUpSkills(client, {
        run,
        env: {},
        removeProjectedSkills: () => {
          throw new Error("~/.agents/skills is shared with other agents")
        },
      })
      expect(report.outcome).toEqual({ via: "plugin", alreadyInstalled: false })
      expect(calls).toContain("copilot plugin install worktable-skills@worktable")
    }

    // The full plugin's server replaces this connection in Copilot CLI.
    const full = await setUpSkills("copilot", {
      run: () => ok(JSON.stringify([{ name: "worktable", enabled: true, source: "installed" }])),
      env: {},
    })
    expect(full.outcome).toEqual({ via: "full-plugin" })
    expect(full.lines[1]).toContain("copilot plugin uninstall worktable")
  })

  it("installs Antigravity's plugin from the marketplace's folder, else from the Worktable's skills", async () => {
    expect(antigravitySource("worktable/worktable-plugin")).toBe(
      "https://github.com/worktable/worktable-plugin/tree/main/plugins/worktable-skills"
    )
    expect(antigravitySource("/mirror/plugin")).toBe("/mirror/plugin/plugins/worktable-skills")

    const installed = new Set<string>()
    const calls: string[] = []
    const run = (_command: string, args: string[]): CommandResult => {
      calls.push(args.join(" "))
      if (args[1] === "list") return ok(JSON.stringify([...installed].map((name) => ({ name }))))
      return { status: 1, stdout: "", stderr: "Error: install target must be a directory: /mirror/plugin/plugins/worktable-skills" }
    }
    const fromWorktable: string[] = []
    const report = await setUpSkills(
      "antigravity",
      {
        run,
        env: { WORKTABLE_PLUGIN_MARKETPLACE: "/mirror/plugin" },
        projectSkills: async () => {
          throw new Error("Antigravity reads no folder install-skills writes")
        },
        installFromWorktable: async (origin) => {
          fromWorktable.push(origin)
          installed.add("worktable-skills")
          return null
        },
      },
      "http://127.0.0.1:7480"
    )
    expect(calls).toContain("plugin install /mirror/plugin/plugins/worktable-skills")
    expect(fromWorktable).toEqual(["http://127.0.0.1:7480"])
    expect(report.outcome).toMatchObject({ via: "worktable" })
    expect(report.lines).toEqual([
      "  Couldn't install the Worktable plugin in Antigravity (install target must be a directory: /mirror/plugin/plugins/worktable-skills), so it was installed from this Worktable's skills instead.",
    ])

    // Without agy there is nothing to install with: a line, and the connection stands.
    const missing = await setUpSkills(
      "antigravity",
      {
        run: () => ({ status: null, stdout: "", stderr: "spawnSync agy ENOENT" }),
        env: {},
        installFromWorktable: async () => {
          throw new Error("needs agy")
        },
      },
      "http://127.0.0.1:7480"
    )
    expect(missing.outcome).toMatchObject({ via: "copy", copied: false })
    expect(missing.lines[0]).toContain("Couldn't add Worktable's skills to Antigravity (no agy command found).")
  })

  it("installs Worktable Skills in Devin when it is signed in, sees them in its skills list, and copies them when it isn't", async () => {
    expect(devinSource("worktable/worktable-plugin")).toBe("worktable/worktable-plugin#plugins/worktable-skills")
    expect(devinSource("/mirror/plugin")).toBe("/mirror/plugin/plugins/worktable-skills")

    // `devin skills list` shows a plugin's skills as /<plugin>:<skill>.
    const devin = (signedIn: boolean, plugins: string[] = []) => {
      const calls: string[] = []
      const run = (_command: string, args: string[]): CommandResult => {
        calls.push(args.join(" "))
        if (args[0] === "skills")
          return ok(
            [
              "Available skills",
              "",
              "  /worktable-library [user,model] (~/.agents/skills/worktable-library) - Check the Library",
              ...plugins.map((name) => `  /${name}:worktable-library [user,model] (plugin) - Check the Library`),
            ].join("\n")
          )
        if (!signedIn)
          return { status: 1, stdout: "", stderr: "Error: You must be logged in to manage plugins. Run `devin auth login` first." }
        plugins.push("worktable-skills")
        return ok()
      }
      return { run, calls }
    }

    const signedIn = devin(true)
    const installed = await setUpSkills("devin", {
      run: signedIn.run,
      env: {},
      projectSkills: async () => {
        throw new Error("must not copy when the plugin installs")
      },
      removeProjectedSkills: () => {
        throw new Error("~/.agents/skills is shared with other agents")
      },
    })
    expect(installed.outcome).toEqual({ via: "plugin", alreadyInstalled: false })
    expect(signedIn.calls).toContain("plugins install --local --yes worktable/worktable-plugin#plugins/worktable-skills")

    const copied: string[] = []
    const signedOut = await setUpSkills("devin", {
      run: devin(false).run,
      env: {},
      projectSkills: async (target) => {
        copied.push(target)
        return null
      },
    })
    expect(copied).toEqual(["agents"])
    expect(signedOut.lines).toEqual([
      "  Couldn't install the Worktable plugin in Devin (You must be logged in to manage plugins), so its skills were copied to ~/.agents/skills instead.",
    ])

    const full = devin(true, ["worktable"])
    expect((await setUpSkills("devin", { run: full.run, env: {} })).outcome).toEqual({ via: "full-plugin" })
    expect(full.calls).toEqual(["skills list"])
  })

  it("copies the skills for Junie, which installs plugins only from its own prompt", async () => {
    const copied: string[] = []
    const report = await setUpSkills("junie", {
      run: () => {
        throw new Error("Junie has no plugin command")
      },
      env: {},
      projectSkills: async (target) => {
        copied.push(target)
        return null
      },
    })
    expect(copied).toEqual(["agents"])
    expect(report.lines).toEqual(["  Junie: skills copied to ~/.agents/skills"])
  })
})
