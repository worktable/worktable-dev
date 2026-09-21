import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  applySkillProjection,
  getSkillProjectionStatus,
  previewSkillProjection,
  SkillProjectionError,
  type SkillProjectionEnvironment,
  type SkillProjectionOperation,
} from "@worktable/mcp-connect"
import {
  isSkillProjectionTargetId,
  type SkillProjectionTargetId,
} from "@worktable/types"
import { getAppDir } from "../../../packages/server/src/app-storage.ts"

const OPERATIONS = ["status", "install", "update", "repair", "remove"] as const

const OPERATION_LABELS: Record<SkillProjectionOperation, string> = {
  install: "Install",
  update: "Update",
  repair: "Repair",
  remove: "Remove",
}

const RESULT_MESSAGES: Record<SkillProjectionOperation, string> = {
  install: "installed for",
  update: "updated for",
  repair: "repaired for",
  remove: "removed for",
}

type InstallerOperation = (typeof OPERATIONS)[number]

interface InstallerOptions {
  operation: InstallerOperation
  targetId: SkillProjectionTargetId
  preview: boolean
  json: boolean
}

interface InstallerManifest {
  type: "worktable.skill-installer"
  version: string
}

class UsageError extends Error {}

function usage(): string {
  return `Install Worktable skills without installing Worktable itself.

Usage:
  worktable-skill-installer [status|install|update|repair|remove] --target <claude|agents> [--preview] [--json]

Targets:
  claude  ~/.claude/skills
  agents  ~/.agents/skills

The operation defaults to install.`
}

function releaseRoot(): string {
  const explicit = process.env["WORKTABLE_SKILL_INSTALLER_ROOT"]?.trim()
  return explicit ? resolve(explicit) : dirname(dirname(process.execPath))
}

function readManifest(root: string): InstallerManifest {
  const path = join(root, "manifest.json")
  if (!existsSync(path)) {
    throw new UsageError(
      "The skill installer manifest is missing. Download the installer again."
    )
  }
  let value: Partial<InstallerManifest>
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as Partial<InstallerManifest>
  } catch {
    throw new UsageError(
      "The skill installer manifest is invalid. Download the installer again."
    )
  }
  if (
    value.type !== "worktable.skill-installer" ||
    typeof value.version !== "string" ||
    value.version.length === 0
  ) {
    throw new UsageError(
      "The skill installer manifest is invalid. Download the installer again."
    )
  }
  return value as InstallerManifest
}

function environment(
  root: string,
  version: string
): SkillProjectionEnvironment {
  return {
    homeDir: process.env["WORKTABLE_SKILL_HOME"]?.trim() || homedir(),
    appDataDir: getAppDir(),
    sourceDir: join(root, "skills"),
    sourceVersion: version,
  }
}

function isOperation(value: string): value is InstallerOperation {
  return (OPERATIONS as readonly string[]).includes(value)
}

export function parseInstallerArgs(
  args: string[]
):
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "run"; options: InstallerOptions } {
  let operation: InstallerOperation = "install"
  let operationSet = false
  let target: string | undefined
  let preview = false
  let json = false

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!
    if (value === "--help" || value === "-h") return { kind: "help" }
    if (value === "--version" || value === "-V") return { kind: "version" }
    if (value === "--preview") {
      preview = true
      continue
    }
    if (value === "--json") {
      json = true
      continue
    }
    if (value === "--target") {
      const next = args[index + 1]
      if (!next) throw new UsageError("--target requires claude or agents.")
      target = next
      index += 1
      continue
    }
    if (value.startsWith("--target=")) {
      target = value.slice("--target=".length)
      continue
    }
    if (!value.startsWith("-") && isOperation(value) && !operationSet) {
      operation = value
      operationSet = true
      continue
    }
    throw new UsageError(`Unknown option or operation: ${value}`)
  }

  if (!target || !isSkillProjectionTargetId(target)) {
    throw new UsageError(
      "Choose one target with --target claude or --target agents."
    )
  }
  if (operation === "status" && preview) {
    throw new UsageError(
      "--preview applies to install, update, repair, or remove."
    )
  }
  return {
    kind: "run",
    options: { operation, targetId: target, preview, json },
  }
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

export function runInstaller(options: InstallerOptions): void {
  const root = releaseRoot()
  const manifest = readManifest(root)
  const env = environment(root, manifest.version)
  if (options.operation === "status") {
    const status = getSkillProjectionStatus({ targetId: options.targetId }, env)
    if (options.json) printJson({ schemaVersion: 2, status })
    else {
      console.log(`${status.label}: ${status.state}`)
      console.log(status.targetRoot)
      if (!["not-installed", "current", "outdated"].includes(status.state)) {
        console.log(status.detail)
      }
    }
    return
  }

  const request = {
    targetId: options.targetId,
    operation: options.operation as SkillProjectionOperation,
  }
  const preview = previewSkillProjection(request, env)
  if (options.preview) {
    if (options.json) printJson({ schemaVersion: 2, preview })
    else {
      console.log(
        `${OPERATION_LABELS[preview.request.operation]} Worktable skills for ${preview.status.label}`
      )
      console.log(`Target: ${preview.status.targetRoot}`)
      for (const change of preview.changes) console.log(`- ${change}`)
    }
    if (!preview.allowed) process.exitCode = 1
    return
  }

  // Re-running the public install command against an already-current target is
  // a successful no-op. Other state transitions remain explicit operations.
  if (options.operation === "install" && preview.status.state === "current") {
    if (options.json) printJson({ schemaVersion: 2, status: preview.status })
    else console.log(`${preview.status.label}: current`)
    return
  }
  if (!preview.allowed) throw new UsageError(preview.status.detail)

  const result = applySkillProjection(request, preview.planId, env)
  if (options.json) printJson({ schemaVersion: 2, result })
  else {
    console.log(
      `Worktable skills ${RESULT_MESSAGES[options.operation]} ${result.statusAfter.label}.`
    )
    console.log(result.statusAfter.targetRoot)
  }
}

export function main(args = process.argv.slice(2)): void {
  try {
    const parsed = parseInstallerArgs(args)
    if (parsed.kind === "help") {
      console.log(usage())
      return
    }
    const root = releaseRoot()
    if (parsed.kind === "version") {
      console.log(readManifest(root).version)
      return
    }
    runInstaller(parsed.options)
  } catch (error) {
    if (error instanceof UsageError || error instanceof SkillProjectionError) {
      console.error(error.message)
      process.exitCode = 1
      return
    }
    throw error
  }
}

if (import.meta.main) main()
