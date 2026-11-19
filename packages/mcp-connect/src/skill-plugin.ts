import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import type { SkillProjectionTargetId } from "@worktable/types"
import { claudeCodeCommand } from "./client-config.ts"
import {
  applySkillProjection,
  getSkillProjectionStatus,
  previewSkillProjection,
  type SkillProjectionEnvironment,
} from "./skill-projection.ts"

// ============================================================
// Worktable's skills for a connected coding agent
// ============================================================
//
// After the connect command sets up Claude Code, Codex, Copilot CLI, VS Code,
// Antigravity or Devin, it installs Worktable Skills (the skills-only build of
// the Worktable plugin) with the agent's own plugin command: `claude`,
// `codex`, `agy`, `devin`, and `copilot` for both Copilot CLI and VS Code,
// which loads Copilot CLI's plugins. The full Worktable plugin already
// carries the skills, so it is left alone. When the plugin can't be
// installed, the skills are copied as before, by the same installer `curl
// https://worktable.dev/install-skills | sh` runs; Antigravity, which reads no
// folder that installer writes, gets the plugin built from the skills the
// Worktable serves instead. Factory Droid installs Worktable Skills from the
// same marketplace with `droid plugin`, and Pi takes the plugin's repository
// as a Pi package with `pi install`. Kiro installs it as a Power with
// `kiro-cli powers install`, built from the skills the Worktable serves, since
// Kiro reads none of the folders the installer writes. Junie, Zed, Cline,
// Warp and Amp have no plugin command, so they always get the copy, which
// each reads from ~/.agents/skills. Nothing here can fail the connection:
// every outcome is a line to show.
//
// Must stay runnable under plain Node 18+, like the rest of the connector.

export type SkillPluginClient =
  | "claude-code"
  | "codex"
  | "copilot"
  | "vscode"
  | "antigravity"
  | "devin"
  | "junie"
  | "zed"
  | "cline"
  | "warp"
  | "pi"
  | "droid"
  | "amp"
  | "kiro"

export const SKILL_PLUGIN_CLIENTS: readonly SkillPluginClient[] = [
  "claude-code",
  "codex",
  "copilot",
  "vscode",
  "antigravity",
  "devin",
  "junie",
  "zed",
  "cline",
  "warp",
  "pi",
  "droid",
  "amp",
  "kiro",
]

/** Where the plugins are listed. Self-hosted mirrors and tests point elsewhere. */
export const DEFAULT_PLUGIN_MARKETPLACE = "worktable/worktable-plugin"
export const SKILLS_PLUGIN = "worktable-skills"
/** Its folder in the marketplace's repository. */
const SKILLS_PLUGIN_PATH = `plugins/${SKILLS_PLUGIN}`
const FULL_PLUGIN = "worktable"
const MARKETPLACE_NAME = "worktable"
const SKILLS_INSTALLER = "https://worktable.dev/install-skills"
const SKILLS_GUIDE = "https://docs.worktable.dev/agents/skills/"

export function isSkillPluginClient(id: string | null): id is SkillPluginClient {
  return (SKILL_PLUGIN_CLIENTS as readonly string[]).includes(id ?? "")
}

export interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
}

export interface SkillPluginDependencies {
  run(command: string, args: string[]): CommandResult
  /** Copies the skills the way install-skills does. Null when it worked. */
  projectSkills(target: SkillProjectionTargetId): Promise<string | null>
  /** Removes the skill folders an earlier copy left. */
  removeProjectedSkills(target: SkillProjectionTargetId): {
    removed: boolean
    error?: string
  }
  /** Installs Worktable Skills in Antigravity or Kiro from the skills a Worktable serves. */
  installFromWorktable(origin: string, client: WorktableBuiltClient): Promise<string | null>
  env: NodeJS.ProcessEnv
}

export type SkillsOutcome =
  | { via: "full-plugin" }
  | { via: "plugin"; alreadyInstalled: boolean }
  /** Antigravity's plugin, built from the skills the Worktable serves. */
  | { via: "worktable"; reason: string }
  /** OpenCode and Kilo load them from the Worktable's skills address. */
  | { via: "catalog"; alreadyAdded: boolean }
  | { via: "copy"; reason: string; copied: boolean; copyError?: string }

export interface SkillsReport {
  outcome: SkillsOutcome
  lines: string[]
  /** How to load the connection and skills, shown last. */
  restartHint: string
}

const LABELS: Record<SkillPluginClient, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  copilot: "Copilot CLI",
  vscode: "VS Code",
  antigravity: "Antigravity",
  devin: "Devin",
  junie: "Junie",
  zed: "Zed",
  cline: "Cline",
  warp: "Warp",
  pi: "Pi",
  droid: "Factory Droid",
  amp: "Amp",
  kiro: "Kiro",
}

/** Where each copies to; Antigravity and Kiro read neither, so they never copy. */
const TARGETS: Record<SkillPluginClient, SkillProjectionTargetId | null> = {
  "claude-code": "claude",
  codex: "agents",
  copilot: "agents",
  vscode: "agents",
  antigravity: null,
  devin: "agents",
  junie: "agents",
  zed: "agents",
  cline: "agents",
  warp: "agents",
  pi: "agents",
  droid: "agents",
  amp: "agents",
  kiro: null,
}

/**
 * Copies a plugin makes redundant, removed so each skill shows once. The
 * others share ~/.agents/skills with other agents, so their copies stay.
 */
const REMOVES_COPIES: Record<SkillPluginClient, boolean> = {
  "claude-code": true,
  codex: true,
  copilot: false,
  vscode: false,
  antigravity: false,
  devin: false,
  junie: false,
  zed: false,
  cline: false,
  warp: false,
  pi: false,
  droid: false,
  amp: false,
  kiro: false,
}

/**
 * The command that installs plugins: VS Code loads Copilot CLI's. Null for
 * Junie, which installs them only from its own /extensions prompt, and for
 * apps with no plugin command.
 */
function pluginCommand(client: SkillPluginClient): string | null {
  switch (client) {
    case "claude-code":
      return claudeCodeCommand()
    case "codex":
      return "codex"
    case "copilot":
    case "vscode":
      return "copilot"
    case "antigravity":
      return "agy"
    case "devin":
      return "devin"
    case "pi":
      return "pi"
    case "droid":
      return "droid"
    case "kiro":
      return "kiro-cli"
    case "junie":
    case "zed":
    case "cline":
    case "warp":
    case "amp":
      return null
  }
}

const TARGET_FOLDERS: Record<SkillProjectionTargetId, string> = {
  claude: "~/.claude/skills",
  agents: "~/.agents/skills",
}

const RESTART_HINTS: Record<SkillPluginClient, string> = {
  "claude-code":
    "Start a new Claude Code session, or run /reload-plugins, to load Worktable.",
  codex: "Start a new Codex session to load Worktable.",
  copilot: "Start a new Copilot CLI session to load Worktable.",
  vscode: "Reload VS Code windows to load Worktable.",
  antigravity: "Start a new Antigravity conversation to load Worktable.",
  devin: "Start a new Devin session to load Worktable.",
  junie: "Start a new Junie session to load Worktable.",
  zed: "Start a new Zed agent thread to load Worktable.",
  cline: "Start a new Cline task to load Worktable.",
  warp: "Start a new Warp agent conversation to load Worktable.",
  pi: "Start a new Pi session, or run /reload, to load Worktable.",
  droid: "Start a new Droid session to load Worktable.",
  amp: "Start a new Amp thread to load Worktable.",
  kiro: "Start a new Kiro chat to load Worktable.",
}

function runCommand(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, {
    // Never wait on a prompt: a plugin that asks for confirmation fails here
    // and falls back to copying the skills.
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env },
    timeout: 120_000,
  })
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? "",
    stderr: result.error ? result.error.message : (result.stderr ?? ""),
  }
}

function parseJson(text: string): unknown {
  // Some commands print a human line after the JSON one.
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue
    try {
      return JSON.parse(trimmed)
    } catch {
      // Multi-line JSON: try the whole output below.
      break
    }
  }
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function firstLine(result: CommandResult, command?: string): string {
  if (result.status === null && /\bENOENT\b/.test(result.stderr))
    return command ? `no ${command} command found` : "command not found"
  const parsed = parseJson(result.stdout) as { message?: unknown } | undefined
  const message =
    typeof parsed?.message === "string"
      ? parsed.message
      : `${result.stderr}\n${result.stdout}`
  const line =
    message
      .split("\n")
      .map((part) => part.replace(/^\s*(?:Error:|✘)\s*/, "").trim())
      .find(Boolean) ?? "unknown error"
  // The first sentence says what went wrong; the rest is the client's advice.
  const sentence = line.split(/(?<=\.)\s/)[0]!.replace(/\.$/, "")
  return sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence
}

/**
 * Devin lists a plugin's skills as `/<plugin>:<skill>` in `devin skills
 * list`, which works signed out too; `devin plugins` needs a Devin sign-in.
 */
function devinPlugins(dependencies: SkillPluginDependencies): { names: string[] } | { error: string } {
  const result = dependencies.run("devin", ["skills", "list"])
  if (result.status !== 0) return { error: firstLine(result, "devin") }
  const names = new Set<string>()
  for (const match of result.stdout.matchAll(/^\s*\/?([\w.-]+):worktable-library\b/gm)) names.add(match[1]!)
  return { names: [...names] }
}

/**
 * Pi lists each package's source in `pi list`. Pi takes the plugin's
 * repository as a package of its skills, so that is Worktable Skills there.
 */
function piPackages(dependencies: SkillPluginDependencies): { names: string[] } | { error: string } {
  const result = dependencies.run("pi", ["list"])
  if (result.status !== 0) return { error: firstLine(result, "pi") }
  return { names: /^\s+\S*worktable-plugin\S*\s*$/m.test(result.stdout) ? [SKILLS_PLUGIN] : [] }
}

/** `droid plugin list` prints a table of `<plugin>@<marketplace>` rows. */
function droidPlugins(dependencies: SkillPluginDependencies): { names: string[] } | { error: string } {
  const result = dependencies.run("droid", ["plugin", "list", "--scope", "user"])
  if (result.status !== 0) return { error: firstLine(result, "droid") }
  return { names: [...result.stdout.matchAll(/^([\w.-]+)@[\w.-]+\s/gm)].map((match) => match[1]!) }
}

/** Kiro lists the Powers it installed in ~/.kiro/powers/installed.json. */
function kiroPowers(env: NodeJS.ProcessEnv): { names: string[] } | { error: string } {
  const path = join(env["WORKTABLE_SKILL_HOME"]?.trim() || homedir(), ".kiro", "powers", "installed.json")
  if (!existsSync(path)) return { names: [] }
  const parsed = parseJson(readFileSync(path, "utf8")) as { installedPowers?: unknown } | undefined
  if (!Array.isArray(parsed?.installedPowers)) return { error: "couldn't read its installed Powers" }
  return {
    names: parsed.installedPowers.map((power) => String((power as { name?: unknown }).name ?? "")),
  }
}

/** Installed plugin names, or an error. */
function installedPlugins(
  client: SkillPluginClient,
  dependencies: SkillPluginDependencies
): { names: string[] } | { error: string } {
  if (client === "devin") return devinPlugins(dependencies)
  if (client === "pi") return piPackages(dependencies)
  if (client === "droid") return droidPlugins(dependencies)
  if (client === "kiro") return kiroPowers(dependencies.env)
  const command = pluginCommand(client)
  if (!command) return { names: [] }
  const result = dependencies.run(command, ["plugin", "list", "--json"])
  if (result.status !== 0) return { error: firstLine(result, command) }
  const parsed = parseJson(result.stdout)
  // Antigravity lists `[{ name }]`. Copilot lists the same, plus built-in
  // plugins and, from a marketplace in a local folder, each plugin it offers,
  // which counts only once turned on.
  if ((client === "antigravity" || client === "copilot" || client === "vscode") && Array.isArray(parsed)) {
    return {
      names: parsed
        .filter((entry: { source?: unknown; enabled?: unknown }) =>
          entry.source === "builtin" ? false : entry.source !== "live" || entry.enabled === true
        )
        .map((entry: { name?: unknown }) => String(entry.name ?? "")),
    }
  }
  // Claude lists installed plugins as an array of `name@marketplace` ids;
  // Codex as `{ installed: [{ name }] }`. A turned-off plugin still counts,
  // so the two are never installed side by side.
  if (client === "claude-code" && Array.isArray(parsed)) {
    return {
      names: parsed
        .map((entry) => String((entry as { id?: unknown }).id ?? ""))
        .map((id) => id.split("@")[0]!),
    }
  }
  const installed = (parsed as { installed?: unknown } | undefined)?.installed
  if (client === "codex" && Array.isArray(installed)) {
    return {
      names: installed.map((entry) =>
        String((entry as { name?: unknown }).name ?? "")
      ),
    }
  }
  return { error: "couldn't read its plugin list" }
}

/**
 * Antigravity installs from a folder or a GitHub folder address, not from a
 * marketplace: the plugin's folder in the marketplace's repository.
 */
export function antigravitySource(marketplace: string): string | null {
  if (isAbsolute(marketplace) || marketplace.startsWith(".") || existsSync(marketplace))
    return join(resolve(marketplace), SKILLS_PLUGIN_PATH)
  const repository = /^[\w.-]+\/[\w.-]+$/.test(marketplace)
    ? `https://github.com/${marketplace}`
    : /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(?:\.git)?\/?$/.test(marketplace)
      ? marketplace.replace(/(?:\.git)?\/?$/, "")
      : null
  return repository ? `${repository}/tree/main/${SKILLS_PLUGIN_PATH}` : null
}

/**
 * Devin installs a plugin from a folder, a GitHub `owner/repo`, or a Git
 * address, with `#<folder>` for one below the repository's root.
 */
export function devinSource(marketplace: string): string {
  if (isAbsolute(marketplace) || marketplace.startsWith(".") || existsSync(marketplace))
    return join(resolve(marketplace), SKILLS_PLUGIN_PATH)
  return `${marketplace.replace(/\/+$/, "")}#${SKILLS_PLUGIN_PATH}`
}

/**
 * Pi installs a package from a folder, which it reads in place, or from a
 * Git repository: `git:github.com/<owner>/<repo>` for GitHub's.
 */
export function piSource(marketplace: string): string {
  if (isAbsolute(marketplace) || marketplace.startsWith(".") || existsSync(marketplace)) return resolve(marketplace)
  if (/^[\w.-]+\/[\w.-]+$/.test(marketplace)) return `git:github.com/${marketplace}`
  return marketplace
}

/** Droid names a marketplace after its repository, and says so either way. */
function droidMarketplaceName(result: CommandResult): string | null {
  const text = `${result.stdout}\n${result.stderr}`
  return (
    /added marketplace:\s*([\w.-]+)/i.exec(text)?.[1] ??
    /Marketplace "([\w.-]+)" already exists/i.exec(text)?.[1] ??
    null
  )
}

function installSkillsPlugin(
  client: SkillPluginClient,
  marketplace: string,
  dependencies: SkillPluginDependencies
): string | null {
  if (client === "pi") {
    const result = dependencies.run("pi", ["install", piSource(marketplace)])
    return result.status === 0 ? null : firstLine(result, "pi")
  }
  if (client === "droid") {
    // Droid reads Claude Code's marketplace and translates its plugins.
    const added = dependencies.run("droid", ["plugin", "marketplace", "add", marketplace])
    const name = droidMarketplaceName(added)
    if (!name) return firstLine(added, "droid")
    const install = () =>
      dependencies.run("droid", ["plugin", "install", `${SKILLS_PLUGIN}@${name}`, "--scope", "user"])
    let result = install()
    if (result.status !== 0 && /not found/i.test(`${result.stderr}\n${result.stdout}`)) {
      // A copy of the marketplace taken before it listed the plugin: refresh it once.
      dependencies.run("droid", ["plugin", "marketplace", "update", name])
      result = install()
    }
    return result.status === 0 ? null : firstLine(result, "droid")
  }
  if (client === "devin") {
    // On this computer only, like the connection, not in the Devin account's plugins.
    const result = dependencies.run("devin", ["plugins", "install", "--local", "--yes", devinSource(marketplace)])
    return result.status === 0 ? null : firstLine(result, "devin")
  }
  if (client === "antigravity") {
    const source = antigravitySource(marketplace)
    if (!source) return `it can't install from ${marketplace}`
    const result = dependencies.run("agy", ["plugin", "install", source])
    return result.status === 0 ? null : firstLine(result, "agy")
  }
  if (client === "copilot" || client === "vscode") {
    // An already registered marketplace named worktable is used as it is.
    const added = dependencies.run("copilot", ["plugin", "marketplace", "add", marketplace])
    const install = () =>
      dependencies.run("copilot", ["plugin", "install", `${SKILLS_PLUGIN}@${MARKETPLACE_NAME}`])
    let result = install()
    if (result.status !== 0 && /not found/i.test(`${result.stderr}\n${result.stdout}`)) {
      // A copy of the marketplace taken before it listed the plugin: refresh it once.
      dependencies.run("copilot", ["plugin", "marketplace", "update", MARKETPLACE_NAME])
      result = install()
    }
    if (result.status === 0) return null
    const registered = added.status === 0 || /already registered/i.test(`${added.stderr}\n${added.stdout}`)
    return firstLine(registered ? result : added, "copilot")
  }
  if (client === "claude-code") {
    const command = claudeCodeCommand()
    const install = (args: string[]) => {
      const result = dependencies.run(command, ["plugin", "install", ...args, "--json"])
      const failure = (parseJson(result.stdout) as { failureCode?: unknown } | undefined)
        ?.failureCode
      return { result, failure }
    }
    let attempt = install([SKILLS_PLUGIN, "--marketplace", marketplace])
    // A marketplace named worktable from another spelling of the same source
    // (or a mirror) may list the plugin too.
    if (attempt.failure === "name_taken")
      attempt = install([`${SKILLS_PLUGIN}@${MARKETPLACE_NAME}`])
    // A copy of the marketplace added before it listed the plugin: refresh it once.
    if (attempt.failure === "not_found") {
      dependencies.run(command, ["plugin", "marketplace", "update", MARKETPLACE_NAME, "--json"])
      attempt = install([`${SKILLS_PLUGIN}@${MARKETPLACE_NAME}`])
    }
    return attempt.result.status === 0 ? null : firstLine(attempt.result)
  }
  const added = dependencies.run("codex", [
    "plugin",
    "marketplace",
    "add",
    marketplace,
    "--json",
  ])
  const reported = (parseJson(added.stdout) as { marketplaceName?: unknown } | undefined)
    ?.marketplaceName
  const name = typeof reported === "string" && reported ? reported : MARKETPLACE_NAME
  const add = () =>
    dependencies.run("codex", ["plugin", "add", `${SKILLS_PLUGIN}@${name}`, "--json"])
  let result = add()
  if (result.status !== 0 && /not found/i.test(result.stderr)) {
    // A Git copy taken before the marketplace listed the plugin: refresh it once.
    dependencies.run("codex", ["plugin", "marketplace", "upgrade", name])
    result = add()
  }
  if (result.status === 0) return null
  return firstLine(added.status === 0 ? result : added)
}

/**
 * Give a connected Claude Code or Codex Worktable's skills: keep the full
 * plugin's, else install Worktable Skills, else copy them.
 */
export async function setUpSkills(
  client: SkillPluginClient,
  overrides: Partial<SkillPluginDependencies> = {},
  /** The connected Worktable, which serves its skills. */
  origin?: string
): Promise<SkillsReport> {
  const dependencies: SkillPluginDependencies = {
    run: runCommand,
    projectSkills,
    removeProjectedSkills,
    installFromWorktable,
    env: process.env,
    ...overrides,
  }
  const label = LABELS[client]
  // What each app calls the plugin.
  const noun = client === "pi" ? "package" : client === "kiro" ? "Power" : "plugin"
  const target = TARGETS[client]
  const folder = target ? TARGET_FOLDERS[target] : null
  const marketplace =
    dependencies.env["WORKTABLE_PLUGIN_MARKETPLACE"]?.trim() ||
    DEFAULT_PLUGIN_MARKETPLACE
  const lines: string[] = []
  const report = (outcome: SkillsOutcome): SkillsReport => ({
    outcome,
    lines,
    restartHint: RESTART_HINTS[client],
  })
  const removeCopies = () => {
    // The plugin brings the skills, so an earlier copy would show each twice.
    if (!target || !REMOVES_COPIES[client]) return
    const removal = dependencies.removeProjectedSkills(target)
    if (removal.error)
      lines.push(
        `  Worktable's earlier skill copies in ${folder} couldn't be removed (${removal.error}), so ${label} may show them twice.`
      )
    else if (removal.removed)
      lines.push(`  Removed Worktable's earlier skill copies from ${folder}`)
  }

  if (!pluginCommand(client) && target) {
    const copyError = await dependencies.projectSkills(target)
    lines.push(
      copyError
        ? `  Couldn't add Worktable's skills to ${label} (${copyError}). See ${SKILLS_GUIDE}`
        : `  ${label}: skills copied to ${folder}`
    )
    return report(
      copyError
        ? { via: "copy", reason: "no plugin command", copied: false, copyError }
        : { via: "copy", reason: "no plugin command", copied: true }
    )
  }

  let reason: string
  const before = installedPlugins(client, dependencies)
  if (client === "kiro" && "names" in before && !before.names.includes(FULL_PLUGIN) && !before.names.includes(SKILLS_PLUGIN)) {
    // Kiro installs Powers from a folder: Worktable Skills, built from the skills this Worktable serves.
    const failed = origin ? await dependencies.installFromWorktable(origin, "kiro") : "no Worktable to install from"
    const after = failed ? null : installedPlugins(client, dependencies)
    if (after && "names" in after && after.names.includes(SKILLS_PLUGIN)) {
      lines.push(`  ${label}: Worktable skills ${noun} installed`)
      return report({ via: "worktable", reason: "Kiro installs Powers from a folder" })
    }
    const why = failed ?? "it didn't show up after installing"
    lines.push(`  Couldn't add Worktable's skills to ${label} (${why}). See ${SKILLS_GUIDE}`)
    return report({ via: "copy", reason: why, copied: false, copyError: why })
  }
  if ("names" in before && before.names.includes(FULL_PLUGIN)) {
    lines.push(`  ${label}: skills come with its Worktable plugin`)
    // Copilot CLI takes a plugin's server over the user's one of the same name.
    if (client === "copilot")
      lines.push(
        "  Its Worktable plugin connects Copilot CLI to Worktable Cloud in place of this connection. To use this Worktable instead, run copilot plugin uninstall worktable, then this command again with --replace."
      )
    removeCopies()
    return report({ via: "full-plugin" })
  }
  if ("names" in before && before.names.includes(SKILLS_PLUGIN)) {
    lines.push(`  ${label}: Worktable skills ${noun} already installed`)
    removeCopies()
    return report({ via: "plugin", alreadyInstalled: true })
  }
  if ("error" in before) {
    reason = before.error
  } else {
    const failed = installSkillsPlugin(client, marketplace, dependencies)
    const after = failed ? null : installedPlugins(client, dependencies)
    if (after && "names" in after && after.names.includes(SKILLS_PLUGIN)) {
      lines.push(`  ${label}: Worktable skills ${noun} installed`)
      removeCopies()
      return report({ via: "plugin", alreadyInstalled: false })
    }
    reason = failed ?? "the plugin didn't show up after installing"
  }

  if (!target) {
    // Antigravity: the same plugin, built from the skills this Worktable serves.
    const failed =
      origin && !/^no agy command/.test(reason)
        ? await dependencies.installFromWorktable(origin, "antigravity")
        : "no copy to install"
    const after = failed ? null : installedPlugins(client, dependencies)
    if (after && "names" in after && after.names.includes(SKILLS_PLUGIN)) {
      lines.push(
        `  Couldn't install the Worktable plugin in ${label} (${reason}), so it was installed from this Worktable's skills instead.`
      )
      return report({ via: "worktable", reason })
    }
    lines.push(`  Couldn't add Worktable's skills to ${label} (${reason}). See ${SKILLS_GUIDE}`)
    return report({ via: "copy", reason, copied: false, copyError: failed ?? "it didn't show up after installing" })
  }
  const copyError = await dependencies.projectSkills(target)
  lines.push(
    copyError
      ? `  Couldn't add Worktable's skills to ${label} (${reason}; ${copyError}). See ${SKILLS_GUIDE}`
      : `  Couldn't install the Worktable plugin in ${label} (${reason}), so its skills were copied to ${folder} instead.`
  )
  return report({
    via: "copy",
    reason,
    copied: copyError === null,
    ...(copyError ? { copyError } : {}),
  })
}

// ---- Antigravity's plugin from the skills a Worktable serves --------------------

interface CatalogIndex {
  skills: { name: string; version: string; files: string[] }[]
}

const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/
const SKILLS_DOWNLOAD_MS = 30_000
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Clients that install Worktable Skills built from the skills a Worktable serves. */
export type WorktableBuiltClient = "antigravity" | "kiro"

/**
 * Builds Worktable Skills from the catalog at `<origin>/.well-known/skills/`
 * (packages/server/src/skill-catalog.ts) and installs it with `agy`, or with
 * `kiro-cli` as a Power, which each keep their own copy. Null when it worked.
 */
export async function installFromWorktable(
  origin: string,
  client: WorktableBuiltClient,
  run: (command: string, args: string[]) => CommandResult = runCommand
): Promise<string | null> {
  const base = `${new URL(origin).origin}/.well-known/skills/`
  const directory = mkdtempSync(join(tmpdir(), "worktable-skills-plugin-"))
  // One deadline for the whole download, body reads included, so a stalled
  // server can't keep the connect command from finishing.
  const signal = AbortSignal.timeout(SKILLS_DOWNLOAD_MS)
  try {
    const response = await fetch(new URL("index.json", base), { signal })
    if (!response.ok) return `its skills address returned HTTP ${response.status}`
    const index = (await response.json()) as CatalogIndex
    const skills = Array.isArray(index.skills) ? index.skills : []
    if (skills.length === 0) return "its skills address lists no skills"
    for (const skill of skills) {
      if (!SAFE_NAME.test(skill.name) || !skill.files.every((file) => SAFE_FILE.test(file)))
        return `its skills address lists an unexpected skill`
      mkdirSync(join(directory, "skills", skill.name), { recursive: true })
      for (const file of skill.files) {
        const fileResponse = await fetch(new URL(`${skill.name}/${file}`, base), { signal })
        if (!fileResponse.ok) return `its skills address returned HTTP ${fileResponse.status}`
        writeFileSync(
          join(directory, "skills", skill.name, file),
          Buffer.from(await fileResponse.arrayBuffer())
        )
      }
    }
    const version = createHash("sha256")
      .update(skills.map((skill) => `${skill.name}@${skill.version}`).join("\n"))
      .digest("hex")
      .slice(0, 12)
    const manifest = {
      name: SKILLS_PLUGIN,
      displayName: "Worktable",
      description: "Worktable's skills, from the Worktable this agent connects to.",
      version: `0.0.0-${version}`,
    }
    if (client === "kiro") {
      // A Power in the Agent Plugins format: plugin.json at its root.
      writeFileSync(
        join(directory, "plugin.json"),
        `${JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", ...manifest }, null, 2)}\n`
      )
      const installed = run("kiro-cli", ["powers", "install", directory])
      return installed.status === 0 ? null : firstLine(installed, "kiro-cli")
    }
    mkdirSync(join(directory, ".antigravity-plugin"))
    writeFileSync(join(directory, ".antigravity-plugin", "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`)
    const installed = run("agy", ["plugin", "install", directory])
    return installed.status === 0 ? null : firstLine(installed, "agy")
  } catch (error) {
    if (signal.aborted) return "its skills address took too long to answer"
    return `couldn't read its skills address: ${(error as Error).message}`
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

// ---- The skill copies install-skills makes ------------------------------------

/**
 * Worktable's app-data folder, where install-skills keeps its records of the
 * folders it copied. Mirrors getAppDir in packages/server/src/app-storage.ts,
 * which this Node-only bundle can't import.
 */
function appDataDir(env: NodeJS.ProcessEnv): string {
  const explicit = env["WORKTABLE_APP_DIR"]?.trim()
  if (explicit) return resolve(explicit)
  if (process.platform === "darwin")
    return join(homedir(), "Library", "Application Support", "Worktable")
  const xdg = env["XDG_CONFIG_HOME"]?.trim()
  return join(xdg ? resolve(xdg) : join(homedir(), ".config"), "worktable")
}

function projectionEnvironment(env: NodeJS.ProcessEnv): SkillProjectionEnvironment {
  return {
    homeDir: env["WORKTABLE_SKILL_HOME"]?.trim() || homedir(),
    appDataDir: appDataDir(env),
    // Removing needs only the record of what was copied, not the skills.
    sourceDir: join(appDataDir(env), "agent-skills", "no-source"),
    sourceVersion: "",
  }
}

/** Removes unchanged skill folders install-skills copied; keeps edited ones. */
export function removeProjectedSkills(
  target: SkillProjectionTargetId,
  env: NodeJS.ProcessEnv = process.env
): { removed: boolean; error?: string } {
  try {
    const projection = projectionEnvironment(env)
    const status = getSkillProjectionStatus({ targetId: target }, projection)
    if (!status.allowedOperations.includes("remove")) return { removed: false }
    const request = { targetId: target, operation: "remove" as const }
    const preview = previewSkillProjection(request, projection)
    applySkillProjection(request, preview.planId, projection)
    return { removed: true }
  } catch (error) {
    return {
      removed: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** Runs the same installer as `curl https://worktable.dev/install-skills | sh`. */
export async function projectSkills(
  target: SkillProjectionTargetId,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const url = env["WORKTABLE_SKILLS_INSTALLER"]?.trim() || SKILLS_INSTALLER
  let script: string
  try {
    const response = await fetch(url)
    if (!response.ok) return `the skill installer returned HTTP ${response.status}`
    script = await response.text()
  } catch (error) {
    return `couldn't download the skill installer: ${(error as Error).message}`
  }
  const directory = mkdtempSync(join(tmpdir(), "worktable-skills-"))
  try {
    const path = join(directory, "install-skills.sh")
    writeFileSync(path, script, { mode: 0o700 })
    const installed = runCommand("sh", [path, "--target", target])
    if (installed.status === 0) return null
    // Install refuses an older copy; update replaces it if it is unchanged.
    const updated = runCommand("sh", [path, "update", "--target", target])
    return updated.status === 0 ? null : firstLine(installed)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
