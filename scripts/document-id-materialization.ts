import { resolve } from "node:path"
import {
  planDocumentIdMaterialization,
  rehearseDocumentIdMaterialization,
} from "../packages/server/src/document-id-materialization.ts"

type Command = "census" | "apply"

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
}

function usage(): string {
  return [
    "usage:",
    "  document-id-materialization census --workspace <copy> [--app-dir <path>] [--runtime-cache-key <key>] [--json]",
    "  document-id-materialization apply --workspace <copy> --source-workspace <original> --expected-workspace-id <id> --expected-source-workspace-checkpoint <sha256> --expected-copy-workspace-checkpoint <sha256> [--app-dir <path>] [--runtime-cache-key <key>] [--json]",
    "",
    "When app data is inspected, --app-dir and a 16-character hexadecimal --runtime-cache-key are both required.",
    "The apply command refuses to target the source workspace and verifies that the separate copy still matches the read-only census checkpoint.",
  ].join("\n")
}

function parseOptions(argv: string[]): Options {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`)
    process.exit(0)
  }
  const command = argv[0]
  if (command !== "census" && command !== "apply") {
    throw new Error(usage())
  }
  const values = new Map<string, string>()
  let json = false
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (argument === "--json") {
      json = true
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
    if (!allowed.has(key))
      throw new Error(`unknown option: ${key}\n\n${usage()}`)
  }
  const workspace = values.get("--workspace")
  if (!workspace) throw new Error(`--workspace is required\n\n${usage()}`)
  const options: Options = {
    command,
    workspace: resolve(workspace),
    json,
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
    command === "apply" &&
    (!options.sourceWorkspace ||
      !options.expectedWorkspaceId ||
      !options.expectedSourceCheckpoint ||
      !options.expectedCopyCheckpoint)
  ) {
    throw new Error(
      `apply requires --source-workspace, --expected-workspace-id, --expected-source-workspace-checkpoint, and --expected-copy-workspace-checkpoint\n\n${usage()}`
    )
  }
  if (Boolean(options.appDir) !== Boolean(options.runtimeCacheKey)) {
    throw new Error(
      `--app-dir and --runtime-cache-key must be provided together\n\n${usage()}`
    )
  }
  return options
}

function dependencyCounts(
  dependencies: Awaited<
    ReturnType<typeof planDocumentIdMaterialization>
  >["census"]["dependencies"]
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const dependency of dependencies) {
    counts[dependency.kind] = (counts[dependency.kind] ?? 0) + 1
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0
    )
  )
}

function printPlan(
  plan: Awaited<ReturnType<typeof planDocumentIdMaterialization>>,
  json: boolean
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    return
  }
  process.stdout.write(
    [
      `Workspace: ${plan.workspaceRoot}`,
      `Workspace ID: ${plan.workspaceId}`,
      `Workspace checkpoint: ${plan.workspaceContentCheckpoint}`,
      `Documents: ${plan.documentCount} total, ${plan.durableCount} durable, ${plan.materializeCount} to materialize`,
      `Dependencies: ${JSON.stringify(dependencyCounts(plan.census.dependencies))}`,
      `App data: ${plan.census.appDataInspection}`,
      `Status: ${plan.clean ? "ready" : "blocked"}`,
      ...plan.preflight.diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map(
          (diagnostic) =>
            `ERROR ${diagnostic.path ?? "."}: ${diagnostic.message}`
        ),
      ...plan.census.diagnostics.map(
        (diagnostic) => `ERROR ${diagnostic.path}: ${diagnostic.message}`
      ),
      ...plan.diagnostics.map(
        (diagnostic) => `ERROR ${diagnostic.path}: ${diagnostic.message}`
      ),
      "",
    ].join("\n")
  )
}

const options = parseOptions(process.argv.slice(2))
const inspectionOptions = {
  ...(options.appDir ? { appDir: options.appDir } : {}),
  ...(options.runtimeCacheKey
    ? { runtimeCacheKey: options.runtimeCacheKey }
    : {}),
}

if (options.command === "census") {
  const plan = await planDocumentIdMaterialization(
    options.workspace,
    inspectionOptions
  )
  printPlan(plan, options.json)
  process.exitCode = plan.clean ? 0 : 1
} else {
  const result = await rehearseDocumentIdMaterialization({
    sourceWorkspace: options.sourceWorkspace!,
    copyWorkspace: options.workspace,
    expectedWorkspaceId: options.expectedWorkspaceId!,
    expectedSourceWorkspaceContentCheckpoint: options.expectedSourceCheckpoint!,
    expectedCopyWorkspaceContentCheckpoint: options.expectedCopyCheckpoint!,
    ...inspectionOptions,
  })
  const output = {
    ...result,
    workspace: result.copyWorkspace,
    rollbackWorkspace: result.sourceWorkspace,
  }
  process.stdout.write(
    options.json
      ? `${JSON.stringify(output, null, 2)}\n`
      : [
          `Materialized ${result.materializedCount} document IDs in ${result.copyWorkspace}.`,
          `The source workspace remains unchanged at ${result.sourceWorkspace}.`,
          `New workspace checkpoint: ${result.afterWorkspaceContentCheckpoint}`,
          "",
        ].join("\n")
  )
}
