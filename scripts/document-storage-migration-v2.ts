import { resolve } from "node:path"
import { setAppDirOverride } from "../packages/server/src/app-storage.ts"
import {
  planDocumentStorageV2Migration,
  rehearseDocumentStorageV2Migration,
} from "../packages/server/src/document-storage-migration-v2.ts"
import { setWorkspaceRootOverride } from "../packages/server/src/workspace.ts"

type Command = "census" | "rehearse"

interface Options {
  command: Command
  workspace: string
  sourceWorkspace?: string
  expectedWorkspaceId?: string
  expectedSourceCheckpoint?: string
  expectedCopyCheckpoint?: string
  appDir?: string
  runtimeCacheKey?: string
  json: boolean
  confirmOffline: boolean
}

function usage(): string {
  return [
    "usage:",
    "  document-storage-v2 census --workspace <copy> [--app-dir <path>] [--runtime-cache-key <key>] [--json]",
    "  document-storage-v2 rehearse --workspace <copy> --source-workspace <original> --expected-workspace-id <id> --expected-source-workspace-checkpoint <sha256> --expected-copy-workspace-checkpoint <sha256> --confirm-offline [--app-dir <path>] [--runtime-cache-key <key>] [--json]",
    "",
    "The rehearsal refuses to mutate the source workspace. --confirm-offline attests that no Worktable process has the copy open. It atomically migrates only that separate copy and retains its verified V1 rollback tree.",
    "When app data is inspected, --app-dir and a 16-character hexadecimal --runtime-cache-key are both required.",
  ].join("\n")
}

function parseOptions(argv: string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`)
    process.exit(0)
  }
  const command = argv[0]
  if (command !== "census" && command !== "rehearse") {
    throw new Error(usage())
  }
  const values = new Map<string, string>()
  let json = false
  let confirmOffline = false
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === "--json") {
      json = true
      continue
    }
    if (argument === "--confirm-offline") {
      confirmOffline = true
      continue
    }
    if (!argument.startsWith("--")) {
      throw new Error(`unexpected argument: ${argument}\n\n${usage()}`)
    }
    const value = argv[index + 1]
    if (!value || value.startsWith("--")) {
      throw new Error(`missing value for ${argument}\n\n${usage()}`)
    }
    values.set(argument, value)
    index += 1
  }
  const allowed = new Set([
    "--workspace",
    "--source-workspace",
    "--expected-workspace-id",
    "--expected-source-workspace-checkpoint",
    "--expected-copy-workspace-checkpoint",
    "--app-dir",
    "--runtime-cache-key",
  ])
  for (const key of values.keys()) {
    if (!allowed.has(key)) {
      throw new Error(`unknown option: ${key}\n\n${usage()}`)
    }
  }
  const workspace = values.get("--workspace")
  if (!workspace) throw new Error(`--workspace is required\n\n${usage()}`)
  const options: Options = {
    command,
    workspace: resolve(workspace),
    json,
    confirmOffline,
    ...(values.get("--source-workspace")
      ? { sourceWorkspace: resolve(values.get("--source-workspace")!) }
      : {}),
    ...(values.get("--expected-workspace-id")
      ? { expectedWorkspaceId: values.get("--expected-workspace-id") }
      : {}),
    ...(values.get("--expected-source-workspace-checkpoint")
      ? {
          expectedSourceCheckpoint: values.get(
            "--expected-source-workspace-checkpoint"
          ),
        }
      : {}),
    ...(values.get("--expected-copy-workspace-checkpoint")
      ? {
          expectedCopyCheckpoint: values.get(
            "--expected-copy-workspace-checkpoint"
          ),
        }
      : {}),
    ...(values.get("--app-dir")
      ? { appDir: resolve(values.get("--app-dir")!) }
      : {}),
    ...(values.get("--runtime-cache-key")
      ? { runtimeCacheKey: values.get("--runtime-cache-key") }
      : {}),
  }
  if (
    command === "rehearse" &&
    (!options.sourceWorkspace ||
      !options.expectedWorkspaceId ||
      !options.expectedSourceCheckpoint ||
      !options.expectedCopyCheckpoint ||
      !options.confirmOffline)
  ) {
    throw new Error(
      `rehearse requires --source-workspace, --expected-workspace-id, --expected-source-workspace-checkpoint, --expected-copy-workspace-checkpoint, and --confirm-offline\n\n${usage()}`
    )
  }
  if (Boolean(options.appDir) !== Boolean(options.runtimeCacheKey)) {
    throw new Error(
      `--app-dir and --runtime-cache-key must be provided together\n\n${usage()}`
    )
  }
  return options
}

const options = parseOptions(process.argv.slice(2))
setWorkspaceRootOverride(options.workspace)
if (options.appDir) setAppDirOverride(options.appDir)
const inspectionOptions = {
  ...(options.appDir ? { appDir: options.appDir } : {}),
  ...(options.runtimeCacheKey
    ? { runtimeCacheKey: options.runtimeCacheKey }
    : {}),
}

if (options.command === "census") {
  const plan = await planDocumentStorageV2Migration(
    options.workspace,
    inspectionOptions
  )
  if (options.json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  } else {
    process.stdout.write(
      [
        `Workspace: ${plan.workspaceRoot}`,
        `Workspace ID: ${plan.workspaceId}`,
        `Workspace checkpoint: ${plan.workspaceContentCheckpoint}`,
        `Documents: ${plan.documentCount} total, ${plan.durableCount} durable, ${plan.materializeCount} to materialize`,
        `Conflicts: ${plan.conflictCount}`,
        `Dependencies: ${plan.dependencyCount} entries, ${plan.dependencyBytes} bytes`,
        `Status: ${plan.clean ? "ready" : "blocked"}`,
        ...plan.diagnostics.map(
          (diagnostic) => `ERROR ${diagnostic.path}: ${diagnostic.message}`
        ),
        "",
      ].join("\n")
    )
  }
  process.exitCode = plan.clean ? 0 : 1
} else {
  const result = await rehearseDocumentStorageV2Migration({
    offlineConfirmed: true,
    sourceWorkspace: options.sourceWorkspace!,
    copiedWorkspace: options.workspace,
    expectedWorkspaceId: options.expectedWorkspaceId!,
    expectedSourceWorkspaceContentCheckpoint: options.expectedSourceCheckpoint!,
    expectedCopyWorkspaceContentCheckpoint: options.expectedCopyCheckpoint!,
    ...inspectionOptions,
  })
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(
      [
        `Migrated copied workspace: ${result.copiedWorkspace}`,
        `Source workspace unchanged: ${result.sourceWorkspace}`,
        `Documents: ${result.documentCount} (${result.materializedCount} IDs materialized)`,
        `Annotations: ${result.annotationsMigrated} across ${result.annotationFilesMigrated} files`,
        `Copied bytes: ${result.copiedBytes}`,
        `Elapsed: ${result.elapsedMs} ms`,
        `Retained V1 backup: ${result.backupPath}`,
        "Rollback procedure:",
        ...result.rollbackProcedure.map(
          (instruction, index) => `  ${index + 1}. ${instruction}`
        ),
        "",
      ].join("\n")
    )
  }
}
