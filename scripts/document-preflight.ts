import { resolve } from "node:path"
import {
  formatDocumentPreflightReport,
  preflightDocumentWorkspace,
} from "../packages/server/src/document-preflight.ts"

function workspaceArgument(argv: string[]): string | null {
  const at = argv.indexOf("--workspace")
  if (at === -1) return null
  return argv[at + 1] ?? null
}

const workspace =
  workspaceArgument(process.argv.slice(2)) ??
  process.env["WORKTABLE_WORKSPACE"]?.trim()

if (!workspace) {
  throw new Error(
    "provide --workspace <path> or set WORKTABLE_WORKSPACE for read-only preflight"
  )
}

const report = await preflightDocumentWorkspace(resolve(workspace))
if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  process.stdout.write(formatDocumentPreflightReport(report))
}
process.exitCode = report.clean ? 0 : 1
