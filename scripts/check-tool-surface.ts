// Holds the MCP tool surface still while the directory reviews are pending.
// Compares the surface tools/list serves now with mcp-tools.json at a base
// revision: a pull request's base, or the last release in release preflight.
//
//   bun run check:tool-surface --base <git-ref> [--approved]
//
// In a pull_request run, the `tool-surface-change` label in the event payload
// approves a change, and --approved is ignored. Elsewhere, --approved does.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"
import { generateToolCatalog } from "./generate-mcp-tools.ts"

export const approvalLabel = "tool-surface-change"

type Tool = { name: string } & Record<string, unknown>

/** One line per added, removed or changed tool, naming the changed fields. */
export function toolSurfaceChanges(base: Tool[], head: Tool[]): string[] {
  const before = new Map(base.map((tool) => [tool.name, tool]))
  const after = new Map(head.map((tool) => [tool.name, tool]))
  const changes: string[] = []
  for (const [name, tool] of after) {
    const previous = before.get(name)
    if (!previous) {
      changes.push(`added ${name}`)
      continue
    }
    const fields = [
      ...new Set([...Object.keys(previous), ...Object.keys(tool)]),
    ]
      .filter((field) => !isDeepStrictEqual(previous[field], tool[field]))
      .sort()
    if (fields.length > 0) changes.push(`changed ${name}: ${fields.join(", ")}`)
  }
  for (const name of before.keys())
    if (!after.has(name)) changes.push(`removed ${name}`)
  const order = (tools: Tool[]) => tools.map((tool) => tool.name).join("\n")
  if (changes.length === 0 && order(base) !== order(head))
    changes.push("changed the order of tools")
  return changes
}

/** Labels come from the event payload, so a label event's own run sees them. */
export function labelledForChange(event: unknown): boolean {
  const labels = (event as { pull_request?: { labels?: unknown } })
    ?.pull_request?.labels
  return (
    Array.isArray(labels) &&
    labels.some(
      (label) => (label as { name?: unknown })?.name === approvalLabel
    )
  )
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const baseIndex = args.indexOf("--base")
  const base = baseIndex === -1 ? undefined : args[baseIndex + 1]
  if (!base) {
    console.error(
      "Usage: bun run check:tool-surface --base <git-ref> [--approved]"
    )
    process.exit(2)
  }
  const eventPath = process.env.GITHUB_EVENT_PATH
  const pullRequest = process.env.GITHUB_EVENT_NAME?.startsWith("pull_request")
  // In a pull request only the label approves, so the decision is visible
  // on the pull request rather than in its own workflow edits.
  const approved = pullRequest
    ? !!eventPath &&
      labelledForChange(JSON.parse(readFileSync(eventPath, "utf8")))
    : args.includes("--approved")

  const snapshot = JSON.parse(
    execFileSync("git", ["show", `${base}:mcp-tools.json`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
  ) as Tool[]
  const current = (await generateToolCatalog()) as Tool[]
  const changes = toolSurfaceChanges(snapshot, current)

  if (changes.length === 0) {
    console.log(`MCP tool surface matches ${base} (${current.length} tools).`)
    process.exit(0)
  }
  console.log(`MCP tool surface differs from ${base}:`)
  for (const change of changes) console.log(`  ${change}`)
  if (approved) {
    console.log(
      pullRequest
        ? `Accepted by the ${approvalLabel} label.`
        : "Accepted by --approved."
    )
    process.exit(0)
  }
  console.error(
    `::error::The MCP tool surface is frozen while the directory reviews are pending. Revert the change, or ${
      pullRequest ? `add the ${approvalLabel} label` : "rerun with --approved"
    } to accept it.`
  )
  process.exit(1)
}
