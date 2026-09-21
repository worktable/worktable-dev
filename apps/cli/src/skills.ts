import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  applySkillProjection,
  getSkillProjectionStatus,
  previewSkillProjection,
  removeOwnedSkillProjectionsForUninstall,
  SkillProjectionError,
  withPreparedSkillProjectionUninstall,
  type PreparedSkillProjectionUninstallLifecycle,
  type SkillProjectionEnvironment,
  type SkillProjectionOperation,
  type SkillProjectionPreview,
  type SkillProjectionResult,
  type SkillProjectionUninstallLifecycle,
  type SkillProjectionUninstallResult,
} from "@worktable/mcp-connect"
import {
  isSkillProjectionTargetId,
  SKILL_PROJECTION_TARGET_IDS,
  type SkillProjectionTargetId,
} from "@worktable/types"
import { getAppDir } from "@worktable/server/runtime"
import { getReleaseDir, VERSION } from "./paths.ts"
import { style, UsageError } from "./style.ts"

export interface SkillCommandOptions {
  json?: boolean
  preview?: boolean
  planId?: string
  yes?: boolean
}

function packagedSkillCandidates(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const explicitReleaseDir = process.env.WORKTABLE_RELEASE_DIR?.trim()
  if (explicitReleaseDir) {
    return [
      join(resolve(explicitReleaseDir), "integrations", "worktable-skills"),
    ]
  }
  const releaseDir = getReleaseDir()
  const releaseSource = releaseDir
    ? join(releaseDir, "integrations", "worktable-skills")
    : null
  const developmentSource = resolve(
    moduleDir,
    "..",
    "..",
    "..",
    "plugins",
    "worktable",
    "skills"
  )
  return releaseSource
    ? [releaseSource, developmentSource]
    : [developmentSource]
}

export function resolvePackagedSkillSource(): string {
  const source = packagedSkillCandidates().find((candidate) =>
    existsSync(candidate)
  )
  if (!source) {
    throw new UsageError(
      "The Worktable skill package is missing. Reinstall or update Worktable, then run this command again."
    )
  }
  return source
}

function expectedPackagedSkillSource(): string {
  const candidates = packagedSkillCandidates()
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!
}

export function skillProjectionEnvironment(): SkillProjectionEnvironment {
  return {
    homeDir: homedir(),
    appDataDir: getAppDir(),
    sourceDir: expectedPackagedSkillSource(),
    sourceVersion: VERSION,
  }
}

export function removeSkillProjectionsDuringUninstall<T>(
  continueWhileLocked: (
    result: SkillProjectionUninstallResult,
    lifecycle: SkillProjectionUninstallLifecycle
  ) => T
): T {
  try {
    return removeOwnedSkillProjectionsForUninstall(
      skillProjectionEnvironment(),
      continueWhileLocked
    )
  } catch (error) {
    translateProjectionError(error)
  }
}

export function withPreparedSkillProjectionsDuringUninstall<T>(
  continueWhileLocked: (
    lifecycle: PreparedSkillProjectionUninstallLifecycle
  ) => T
): T {
  try {
    return withPreparedSkillProjectionUninstall(
      skillProjectionEnvironment(),
      continueWhileLocked
    )
  } catch (error) {
    translateProjectionError(error)
  }
}

export function parseSkillTargetSelection(
  values: string[]
): SkillProjectionTargetId[] {
  const flattened = values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean)
  for (const value of flattened) {
    if (value !== "all" && !isSkillProjectionTargetId(value)) {
      throw new UsageError(
        `Unknown skill target "${value}". Choose from: ${SKILL_PROJECTION_TARGET_IDS.join(", ")}.`
      )
    }
  }
  const expanded = flattened.includes("all")
    ? [...SKILL_PROJECTION_TARGET_IDS]
    : flattened
  const unique = [...new Set(expanded)]
  return unique as SkillProjectionTargetId[]
}

function printPreview(preview: SkillProjectionPreview): void {
  console.log(
    style.bold(`${preview.request.operation} ${preview.status.label}`)
  )
  console.log(`Status: ${preview.status.state}`)
  console.log(`Target: ${preview.status.targetRoot}`)
  console.log(`Plan:   ${preview.planId}`)
  console.log()
  for (const change of preview.changes) console.log(`- ${change}`)
}

function printResult(result: SkillProjectionResult): void {
  console.log(
    result.applied
      ? `${result.statusAfter.label}: ${result.statusAfter.state}`
      : `${result.statusAfter.label}: already ${result.statusAfter.state}`
  )
  console.log(result.statusAfter.detail)
}

async function confirmPreview(
  preview: SkillProjectionPreview
): Promise<boolean> {
  const prompts = await import("@clack/prompts")
  const answer = await prompts.confirm({
    message: `Apply this ${preview.request.operation} plan?`,
    initialValue: false,
  })
  if (prompts.isCancel(answer)) return false
  return answer === true
}

function translateProjectionError(error: unknown): never {
  if (error instanceof SkillProjectionError) {
    throw new UsageError(error.message)
  }
  throw error
}

export function commandSkillStatus(
  targets: string[],
  options: SkillCommandOptions
): void {
  try {
    const targetIds =
      targets.length > 0
        ? parseSkillTargetSelection(targets)
        : [...SKILL_PROJECTION_TARGET_IDS]
    const env = skillProjectionEnvironment()
    const statuses = targetIds.map((targetId) =>
      getSkillProjectionStatus({ targetId }, env)
    )
    if (options.json) {
      console.log(JSON.stringify({ schemaVersion: 2, statuses }, null, 2))
      return
    }
    for (const status of statuses) {
      console.log(`${status.label}: ${status.state} (${status.targetRoot})`)
      console.log(`  ${status.detail}`)
    }
  } catch (error) {
    translateProjectionError(error)
  }
}

export async function commandSkillOperation(
  operation: SkillProjectionOperation,
  target: string,
  options: SkillCommandOptions
): Promise<void> {
  const targetIds = parseSkillTargetSelection([target])
  if (targetIds.length !== 1) {
    throw new UsageError("Choose exactly one skill target: claude or agents.")
  }
  const [targetId] = targetIds
  try {
    const env = skillProjectionEnvironment()
    const request = { targetId, operation }
    const preview = previewSkillProjection(request, env)
    if (options.preview) {
      if (options.json) {
        console.log(JSON.stringify({ schemaVersion: 2, preview }, null, 2))
      } else {
        printPreview(preview)
      }
      if (!preview.allowed) process.exitCode = 1
      return
    }
    if (!preview.allowed) throw new UsageError(preview.status.detail)

    const planId = options.planId ?? preview.planId
    if (!options.planId) {
      if (options.json && !options.yes) {
        throw new UsageError(
          "JSON output cannot use an interactive confirmation. Review with --preview --json, then apply with --plan-id <id> --yes --json."
        )
      }
      if (!options.yes) {
        if (!process.stdin.isTTY || !process.stdout.isTTY) {
          throw new UsageError(
            "Review the plan with --preview, then pass --plan-id <id> --yes to apply it non-interactively."
          )
        }
        printPreview(preview)
        if (!(await confirmPreview(preview))) return
      }
    } else if (!options.yes) {
      throw new UsageError("Applying an approved --plan-id requires --yes.")
    }
    const result = applySkillProjection(request, planId, env)
    if (options.json) {
      console.log(JSON.stringify({ schemaVersion: 2, result }, null, 2))
    } else {
      printResult(result)
    }
  } catch (error) {
    translateProjectionError(error)
  }
}
