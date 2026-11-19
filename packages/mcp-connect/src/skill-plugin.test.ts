import { afterEach, describe, expect, it } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  antigravitySource,
  devinSource,
  installFromWorktable,
  piSource,
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
      "  Couldn't install the Worktable plugin in Antigravity (install target must be a directory: /mirror/plugin/plugins/worktable-skills), so it was built from Worktable's skills instead.",
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

  it("copies the skills for apps with no plugin command, which read ~/.agents/skills", async () => {
    for (const [client, label] of [
      ["junie", "Junie"],
      ["zed", "Zed"],
      ["cline", "Cline"],
      ["warp", "Warp"],
      ["amp", "Amp"],
    ] as const) {
      const copied: string[] = []
      const report = await setUpSkills(client, {
        run: () => {
          throw new Error(`${label} has no plugin command`)
        },
        env: {},
        projectSkills: async (target) => {
          copied.push(target)
          return null
        },
      })
      expect(copied).toEqual(["agents"])
      expect(report.lines).toEqual([`  ${label}: skills copied to ~/.agents/skills`])
    }
  })

  it("installs Worktable Skills as a Pi package and a Droid plugin, and copies them without the command", async () => {
    expect(piSource("worktable/worktable-plugin")).toBe("git:github.com/worktable/worktable-plugin")
    expect(piSource("/mirror/plugin")).toBe("/mirror/plugin")

    // `pi list` prints the user's packages, then a project's, which loads only
    // there. A folder shows relative to Pi's own, with its full path below.
    const project =
      "Project packages:\n  git:github.com/worktable/worktable-plugin\n    /work/.pi/git/github.com/worktable/worktable-plugin\n"
    for (const [marketplace, listed] of [
      [undefined, "  git:github.com/worktable/worktable-plugin\n    /home/.pi/agent/git/github.com/worktable/worktable-plugin"],
      ["/mirror/my plugin", "  ../../../mirror/my plugin\n    /mirror/my plugin"],
    ] as const) {
      const piPackages: string[] = []
      const pi = await setUpSkills("pi", {
        run: (_command, args) => {
          if (args[0] === "list") return ok(`${piPackages.length ? `User packages:\n${listed}\n\n` : ""}${project}`)
          piPackages.push(args[1]!)
          return ok()
        },
        env: marketplace ? { WORKTABLE_PLUGIN_MARKETPLACE: marketplace } : {},
        projectSkills: async () => {
          throw new Error("must not copy when the package installs")
        },
      })
      expect(piPackages).toEqual([piSource(marketplace ?? "worktable/worktable-plugin")])
      expect(pi.outcome).toEqual({ via: "plugin", alreadyInstalled: false })
    }
    // A package that only shares part of the name isn't Worktable's.
    const unrelated: string[] = []
    const other = await setUpSkills("pi", {
      run: (_command, args) => {
        if (args[0] === "list")
          return ok(`User packages:\n  git:github.com/acme/not-worktable-plugin\n    /home/.pi/agent/git/github.com/acme/not-worktable-plugin\n${unrelated.length ? "  /mirror/plugin\n    /mirror/plugin\n" : ""}`)
        unrelated.push(args[1]!)
        return ok()
      },
      env: { WORKTABLE_PLUGIN_MARKETPLACE: "/mirror/plugin" },
    })
    expect(unrelated).toEqual(["/mirror/plugin"])
    expect(other.outcome).toEqual({ via: "plugin", alreadyInstalled: false })

    // Droid names the marketplace after its repository, already added or not.
    const droidCalls: string[] = []
    const droidPlugins: string[] = []
    const droid = (added: boolean, name = "worktable-plugin") => (_command: string, args: string[]): CommandResult => {
      droidCalls.push(args.join(" "))
      if (args[1] === "list")
        return ok(droidPlugins.length ? `PLUGIN  STATUS  SOURCE  VERSION\n${droidPlugins.map((id) => `${id}  Enabled  user  494ae5835a99`).join("\n")}\n` : "No plugins installed in user scope.\n")
      if (args[1] === "marketplace")
        return added
          ? { status: 1, stdout: "", stderr: `Error: Marketplace "${name}" already exists` }
          : ok(`Successfully added marketplace: ${name}\n`)
      droidPlugins.push(args[2]!)
      return ok()
    }
    for (const added of [false, true]) {
      droidPlugins.length = 0
      const report = await setUpSkills("droid", { run: droid(added), env: {} })
      expect(report.outcome).toEqual({ via: "plugin", alreadyInstalled: false })
    }
    expect(droidCalls).toContain("plugin install worktable-skills@worktable-plugin --scope user")
    // A pinned marketplace's name carries its pin.
    droidPlugins.length = 0
    const pinned = await setUpSkills("droid", { run: droid(false, "worktable-plugin@v1.2.0"), env: {} })
    expect(pinned.outcome).toEqual({ via: "plugin", alreadyInstalled: false })
    expect(droidCalls).toContain("plugin install worktable-skills@worktable-plugin@v1.2.0 --scope user")
    // The full plugin, from Factory's or our marketplace, already carries the skills.
    droidPlugins.splice(0, droidPlugins.length, "worktable@worktable-plugin")
    expect((await setUpSkills("droid", { run: droid(true), env: {} })).outcome).toEqual({ via: "full-plugin" })

    const copied: string[] = []
    const missing = await setUpSkills("pi", {
      run: () => ({ status: null, stdout: "", stderr: "spawnSync pi ENOENT" }),
      env: {},
      projectSkills: async (target) => {
        copied.push(target)
        return null
      },
    })
    expect(copied).toEqual(["agents"])
    expect(missing.lines).toEqual([
      "  Couldn't install the Worktable plugin in Pi (no pi command found), so its skills were copied to ~/.agents/skills instead.",
    ])
  })

  it("builds Worktable Skills as a Kiro Power and an Antigravity plugin from the served skills", async () => {
    const requested: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname
        requested.push(path)
        // As the public skills address lists them: ChatGPT's file in a folder too.
        return path.endsWith("/index.json")
          ? Response.json({
              skills: [{ name: "worktable-library", version: "1", files: ["SKILL.md", "agents/openai.yaml"] }],
            })
          : new Response("# Library\n")
      },
    })
    try {
      const manifests: Record<string, unknown> = {}
      const run = (command: string, args: string[]): CommandResult => {
        const folder = args[args.length - 1]!
        const path = command === "agy" ? join(folder, ".antigravity-plugin", "plugin.json") : join(folder, "plugin.json")
        manifests[command] = JSON.parse(readFileSync(path, "utf8"))
        expect(readFileSync(join(folder, "skills", "worktable-library", "SKILL.md"), "utf8")).toBe("# Library\n")
        return ok()
      }
      const origin = `http://127.0.0.1:${server.port}`
      expect(await installFromWorktable(origin, "kiro", run)).toBeNull()
      expect(await installFromWorktable(origin, "antigravity", run)).toBeNull()
      // Kiro requires these, and its schema takes nothing else at the top.
      const power = manifests["kiro-cli"] as Record<string, unknown>
      expect(Object.keys(power).sort()).toEqual(["$schema", "author", "description", "keywords", "name", "version"])
      expect(power).toMatchObject({ name: "worktable-skills", author: { name: "Reva Labs" } })
      expect(power["keywords"]).toContain("worktable")
      expect(manifests["agy"]).toMatchObject({ name: "worktable-skills", displayName: "Worktable" })
      expect(requested.some((path) => path.includes("/agents/"))).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  it("installs Worktable Skills in Kiro as a Power built from the Worktable's skills", async () => {
    const root = mkdtempSync(join(tmpdir(), "worktable-skill-plugin-"))
    roots.push(root)
    const env = { WORKTABLE_SKILL_HOME: root }
    const powers = join(root, ".kiro", "powers")
    const built: string[] = []
    const report = await setUpSkills(
      "kiro",
      {
        run: () => {
          throw new Error("Kiro installs Powers only from a folder")
        },
        env,
        installFromWorktable: async (origin, client) => {
          built.push(`${client} ${origin}`)
          mkdirSync(powers, { recursive: true })
          writeFileSync(join(powers, "installed.json"), JSON.stringify({ installedPowers: [{ name: "worktable-skills" }] }))
          return null
        },
      },
      "http://127.0.0.1:7480"
    )
    expect(built).toEqual(["kiro http://127.0.0.1:7480"])
    expect(report.lines).toEqual(["  Kiro: Worktable skills Power installed"])
    // Installed once, it is left as it is.
    const again = await setUpSkills("kiro", { env, installFromWorktable: async () => "must not install twice" })
    expect(again.outcome).toEqual({ via: "plugin", alreadyInstalled: true })

    // A list it can't read is Kiro's failure, never a reason to install in Antigravity.
    writeFileSync(join(powers, "installed.json"), JSON.stringify({ installedPowers: "broken" }))
    built.length = 0
    const unreadable = await setUpSkills(
      "kiro",
      {
        env,
        installFromWorktable: async (origin, client) => {
          built.push(`${client} ${origin}`)
          return null
        },
      },
      "http://127.0.0.1:7480"
    )
    expect(built).toEqual([])
    expect(unreadable.lines).toEqual([
      "  Couldn't add Worktable's skills to Kiro (couldn't read its installed Powers). See https://docs.worktable.dev/agents/skills/",
    ])

    rmSync(powers, { recursive: true })
    const missing = await setUpSkills("kiro", { env, installFromWorktable: async () => "no kiro-cli command found" }, "http://127.0.0.1:7480")
    expect(missing.lines).toEqual([
      "  Couldn't add Worktable's skills to Kiro (no kiro-cli command found). See https://docs.worktable.dev/agents/skills/",
    ])
  })
})
