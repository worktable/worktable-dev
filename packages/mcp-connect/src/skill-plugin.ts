import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
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
// After the connect command sets up Claude Code or Codex, it installs
// Worktable Skills (the skills-only build of the Worktable plugin) with the
// agent's own plugin command, so the skills update with the agent. The full
// Worktable plugin already carries the skills, so it is left alone. When the
// plugin can't be installed, the skills are copied as before, by the same
// installer `curl https://worktable.dev/install-skills | sh` runs. Nothing
// here can fail the connection: every outcome is a line to show.
//
// Must stay runnable under plain Node 18+, like the rest of the connector.

export type SkillPluginClient = "claude-code" | "codex"

export const SKILL_PLUGIN_CLIENTS: readonly SkillPluginClient[] = [
  "claude-code",
  "codex",
]

/** Where the plugins are listed. Self-hosted mirrors and tests point elsewhere. */
export const DEFAULT_PLUGIN_MARKETPLACE = "worktable/worktable-plugin"
export const SKILLS_PLUGIN = "worktable-skills"
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
  env: NodeJS.ProcessEnv
}

export type SkillsOutcome =
  | { via: "full-plugin" }
  | { via: "plugin"; alreadyInstalled: boolean }
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
}

const TARGETS: Record<SkillPluginClient, SkillProjectionTargetId> = {
  "claude-code": "claude",
  codex: "agents",
}

const TARGET_FOLDERS: Record<SkillProjectionTargetId, string> = {
  claude: "~/.claude/skills",
  agents: "~/.agents/skills",
}

const RESTART_HINTS: Record<SkillPluginClient, string> = {
  "claude-code":
    "Start a new Claude Code session, or run /reload-plugins, to load Worktable.",
  codex: "Start a new Codex session to load Worktable.",
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

/** Installed plugin names, or an error. */
function installedPlugins(
  client: SkillPluginClient,
  dependencies: SkillPluginDependencies
): { names: string[] } | { error: string } {
  const command = client === "claude-code" ? claudeCodeCommand() : "codex"
  const result = dependencies.run(command, ["plugin", "list", "--json"])
  if (result.status !== 0) return { error: firstLine(result, command) }
  const parsed = parseJson(result.stdout)
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

function installSkillsPlugin(
  client: SkillPluginClient,
  marketplace: string,
  dependencies: SkillPluginDependencies
): string | null {
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
  overrides: Partial<SkillPluginDependencies> = {}
): Promise<SkillsReport> {
  const dependencies: SkillPluginDependencies = {
    run: runCommand,
    projectSkills,
    removeProjectedSkills,
    env: process.env,
    ...overrides,
  }
  const label = LABELS[client]
  const target = TARGETS[client]
  const folder = TARGET_FOLDERS[target]
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
    const removal = dependencies.removeProjectedSkills(target)
    if (removal.error)
      lines.push(
        `  Worktable's earlier skill copies in ${folder} couldn't be removed (${removal.error}), so ${label} may show them twice.`
      )
    else if (removal.removed)
      lines.push(`  Removed Worktable's earlier skill copies from ${folder}`)
  }

  let reason: string
  const before = installedPlugins(client, dependencies)
  if ("names" in before && before.names.includes(FULL_PLUGIN)) {
    lines.push(`  ${label}: skills come with its Worktable plugin`)
    removeCopies()
    return report({ via: "full-plugin" })
  }
  if ("names" in before && before.names.includes(SKILLS_PLUGIN)) {
    lines.push(`  ${label}: Worktable skills plugin already installed`)
    removeCopies()
    return report({ via: "plugin", alreadyInstalled: true })
  }
  if ("error" in before) {
    reason = before.error
  } else {
    const failed = installSkillsPlugin(client, marketplace, dependencies)
    const after = failed ? null : installedPlugins(client, dependencies)
    if (after && "names" in after && after.names.includes(SKILLS_PLUGIN)) {
      lines.push(`  ${label}: Worktable skills plugin installed`)
      removeCopies()
      return report({ via: "plugin", alreadyInstalled: false })
    }
    reason = failed ?? "the plugin didn't show up after installing"
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
