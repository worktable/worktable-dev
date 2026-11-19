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
})
