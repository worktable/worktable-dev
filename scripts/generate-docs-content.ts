// Generates the docs-site pages that mirror product sources, so they can
// never drift: the MCP tool catalog (from mcp-tools.json), the CLI command
// reference (from the commander program), What's New (from CHANGELOG.md), and
// the HTML runtime reference (from the server authoring contract). Output is
// gitignored and rebuilt by `bun run build:docs`.
//
// Run directly: bun run generate:docs-content
import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { buildProgram } from "../apps/cli/src/index.ts"
import { getHtmlAuthoringGuide } from "../packages/server/src/widget-authoring.ts"

type AnyCommand = {
  name(): string
  description(): string
  usage(): string
  aliases(): string[]
  commands: readonly AnyCommand[]
  options: readonly {
    flags: string
    description: string
    defaultValue?: unknown
    hidden?: boolean
  }[]
  registeredArguments: readonly {
    name(): string
    description: string
    required: boolean
    variadic: boolean
  }[]
  _hidden?: boolean
  _defaultCommandName?: string
}

interface ToolEntry {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: Record<string, unknown>
}

// Markdown swallows bare HTML-ish tokens like <spaceId>; escape `<` outside
// inline code spans so placeholders survive rendering.
export function escapeMdText(text: string): string {
  return text
    .split(/(`[^`]*`)/)
    .map((segment, i) => (i % 2 === 1 ? segment : segment.replace(/</g, "\\<")))
    .join("")
}

function tableCell(text: string): string {
  return escapeMdText(text)
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ")
}

// Invisible to readers; tells anyone opening the generated file where edits belong.
function generatedNote(source: string): string {
  return `<!-- Generated at build time from ${source}. Edits belong in the source. -->`
}

// ── MCP tool catalog ────────────────────────────────────────────

const TOOL_GROUPS: Array<{
  title: string
  matches: (name: string) => boolean
}> = [
  {
    title: "Guidance & validation",
    matches: (n) => n === "worktable_guidance" || n === "worktable_mermaid",
  },
  {
    title: "Workspace & discovery",
    matches: (n) => n === "worktable_discover" || n === "worktable_spaces",
  },
  { title: "Docs", matches: (n) => n.includes("_docs_") },
  { title: "HTML docs", matches: (n) => n.includes("_html_") },
  { title: "Records", matches: (n) => n.includes("record") },
  { title: "Annotations", matches: (n) => n.includes("annotation") },
  { title: "Threads & delivery", matches: (n) => n.includes("thread") },
  { title: "Destructive actions", matches: (n) => n === "worktable_delete" },
]

const TOOL_GROUP_ORDER = [
  "Workspace & discovery",
  "Docs",
  "HTML docs",
  "Records",
  "Annotations",
  "Threads & delivery",
  "Destructive actions",
  "Guidance & validation",
]

function collectActions(
  value: unknown,
  actions = new Set<string>()
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectActions(item, actions)
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const properties = record.properties as Record<string, unknown> | undefined
    const action = properties?.action as Record<string, unknown> | undefined
    if (typeof action?.const === "string") actions.add(action.const)
    for (const nested of Object.values(record)) collectActions(nested, actions)
  }
  return actions
}

export function renderMcpToolsPage(tools: ToolEntry[]): string {
  const grouped = new Map<string, ToolEntry[]>()
  for (const tool of tools) {
    const group =
      TOOL_GROUPS.find((g) => g.matches(tool.name))?.title ?? "Other"
    grouped.set(group, [...(grouped.get(group) ?? []), tool])
  }
  const order = [
    ...TOOL_GROUP_ORDER,
    ...[...grouped.keys()].filter((g) => !TOOL_GROUP_ORDER.includes(g)),
  ]
  const sections = order
    .filter((group) => grouped.has(group))
    .map((group) => {
      const entries = grouped
        .get(group)!
        .map((tool) => {
          const actions = [...collectActions(tool.inputSchema)]
          const hints = Object.entries(tool.annotations ?? {})
            .filter(([, enabled]) => enabled === true)
            .map(([name]) => `\`${name}\``)
            .join(", ")
          return [
            `### ${tool.name}`,
            escapeMdText(tool.description),
            actions.length > 0
              ? `**Actions:** ${actions.map((action) => `\`${action}\``).join(", ")}`
              : "",
            hints ? `**MCP hints:** ${hints}` : "",
            "<details>",
            "<summary>Input schema</summary>",
            "",
            "```json",
            JSON.stringify(tool.inputSchema, null, 2),
            "```",
            "",
            "</details>",
          ]
            .filter(Boolean)
            .join("\n\n")
        })
        .join("\n\n")
      return `## ${group}\n\n${entries}`
    })
    .join("\n\n")
  return [
    "---",
    "title: MCP tool catalog",
    "description: Every MCP tool the Worktable server exposes to connected agents.",
    "---",
    "",
    generatedNote("the MCP tool registry (`mcp-tools.json`)"),
    "",
    `Worktable exposes ${tools.length} MCP tools over HTTP and stdio. Connection details live in the [MCP reference](/reference/mcp/).`,
    "",
    sections,
    "",
  ].join("\n")
}

// ── CLI command reference ───────────────────────────────────────

function renderArguments(cmd: AnyCommand): string {
  const args = cmd.registeredArguments.filter((a) => a.description)
  if (args.length === 0) return ""
  const rows = args.map((a) => {
    const shape = a.variadic ? `${a.name()}...` : a.name()
    const wrapped = a.required ? `\`<${shape}>\`` : `\`[${shape}]\``
    return `| ${wrapped} | ${tableCell(a.description)} |`
  })
  return ["| Argument | Description |", "| --- | --- |", ...rows].join("\n")
}

function renderOptions(cmd: AnyCommand): string {
  const options = cmd.options.filter((o) => !o.hidden)
  if (options.length === 0) return ""
  const hasDefaults = options.some(
    (o) => o.defaultValue !== undefined && typeof o.defaultValue !== "boolean"
  )
  const header = hasDefaults
    ? ["| Option | Description | Default |", "| --- | --- | --- |"]
    : ["| Option | Description |", "| --- | --- |"]
  const rows = options.map((o) => {
    const cells = [`\`${o.flags}\``, tableCell(o.description)]
    if (hasDefaults) {
      cells.push(
        o.defaultValue !== undefined && typeof o.defaultValue !== "boolean"
          ? `\`${String(o.defaultValue)}\``
          : "—"
      )
    }
    return `| ${cells.join(" | ")} |`
  })
  return [...header, ...rows].join("\n")
}

function renderCommand(
  cmd: AnyCommand,
  path: string[],
  depth: number
): string[] {
  const fullName = [...path, cmd.name()].join(" ")
  const heading = "#".repeat(Math.min(depth + 2, 4))
  const parts = [`${heading} ${fullName}`]
  const isDefault =
    (cmd as { parent?: AnyCommand }).parent !== undefined &&
    (cmd as unknown as { parent: AnyCommand }).parent._defaultCommandName ===
      cmd.name()
  const description = escapeMdText(cmd.description())
  parts.push(isDefault ? `${description} *(default subcommand)*` : description)
  const argUsage = cmd.registeredArguments
    .map((a) =>
      a.required
        ? `<${a.variadic ? `${a.name()}...` : a.name()}>`
        : `[${a.variadic ? `${a.name()}...` : a.name()}]`
    )
    .join(" ")
  const visibleSubs = cmd.commands.filter((c) => !c._hidden)
  const usageBits = [
    fullName,
    visibleSubs.length > 0 ? "[command]" : "",
    argUsage,
    cmd.options.some((o) => !o.hidden) ? "[options]" : "",
  ].filter(Boolean)
  parts.push(["```sh", usageBits.join(" "), "```"].join("\n"))
  const args = renderArguments(cmd)
  if (args) parts.push(args)
  const options = renderOptions(cmd)
  if (options) parts.push(options)
  for (const sub of visibleSubs) {
    parts.push(...renderCommand(sub, [...path, cmd.name()], depth + 1))
  }
  return parts
}

export function renderCliCommandsPage(program: AnyCommand): string {
  const commands = program.commands.filter((c) => !c._hidden)
  const body = commands
    .flatMap((cmd) => renderCommand(cmd, [program.name()], 0))
    .join("\n\n")
  return [
    "---",
    "title: CLI command reference",
    "description: Every worktable CLI command and flag, generated from the CLI itself.",
    "---",
    "",
    generatedNote("the `worktable` CLI source"),
    "",
    `${escapeMdText(program.description())} Usage guidance and examples live in the [CLI overview](/reference/cli/).`,
    "",
    body,
    "",
  ].join("\n")
}

// ── What's New ──────────────────────────────────────────────────

export function renderWhatsNewPage(changelog: string): string {
  const stripped = changelog.replace(/<!--[\s\S]*?-->/g, "")
  const lines = stripped.split("\n")
  const sections: Array<{ heading: string; body: string[] }> = []
  let current: { heading: string; body: string[] } | null = null
  for (const line of lines) {
    if (line.startsWith("## ")) {
      current = { heading: line.slice(3).trim(), body: [] }
      sections.push(current)
    } else if (current) {
      current.body.push(line)
    }
  }
  const releases = sections
    .map((s) => {
      const match = s.heading.match(/^\[(\d+\.\d+\.\d+)\]\s*-\s*(\S+)/)
      return match
        ? { version: match[1], date: match[2], body: s.body.join("\n").trim() }
        : null
    })
    .filter(
      (s): s is { version: string; date: string; body: string } =>
        s !== null && s.body.length > 0
    )
  const body = releases
    .map((r) => `## ${r.version} — ${r.date}\n\n${r.body}`)
    .join("\n\n")
  return [
    "---",
    "title: What's new",
    "description: User-facing changes in each Worktable release.",
    "---",
    "",
    generatedNote("`CHANGELOG.md`"),
    "",
    "Desktop updates from Help → Check for Updates. Local and self-hosted installs update from Settings → System or with `worktable update`. Worktable Cloud updates automatically.",
    "",
    body,
    "",
  ].join("\n")
}

// ── HTML doc runtime ───────────────────────────────────────────

export function renderHtmlRuntimePage(): string {
  const content = getHtmlAuthoringGuide("runtime")
    .replace(/^# .*\n+/, "")
    .trim()
  return [
    "---",
    "title: HTML doc runtime",
    "description: The sandbox, data, state, theme, diagnostics, and network contract for interactive HTML docs.",
    "---",
    "",
    generatedNote("the HTML authoring contract shipped with the server"),
    "",
    "This contract is returned by `worktable_html_read` with action `guide`. It matches the server runtime that handles the HTML Doc.",
    "",
    escapeMdText(content),
    "",
  ].join("\n")
}

// ── Main ────────────────────────────────────────────────────────

export const GENERATED_PAGES = [
  "apps/docs/src/content/docs/reference/mcp-tools.md",
  "apps/docs/src/content/docs/reference/cli-commands.md",
  "apps/docs/src/content/docs/whats-new.md",
  "apps/docs/src/content/docs/reference/html-doc-runtime.md",
] as const

export const RETIRED_GENERATED_PAGES = [
  "apps/docs/src/content/docs/agents/orientation.md",
] as const

export function removeRetiredGeneratedPages(rootDir: string): void {
  for (const relPath of RETIRED_GENERATED_PAGES) {
    rmSync(join(rootDir, relPath), { force: true })
  }
}

export async function generateAll(rootDir: string): Promise<void> {
  removeRetiredGeneratedPages(rootDir)
  const tools = JSON.parse(
    readFileSync(join(rootDir, "mcp-tools.json"), "utf8")
  ) as ToolEntry[]
  const changelog = readFileSync(join(rootDir, "CHANGELOG.md"), "utf8")
  const program = buildProgram() as unknown as AnyCommand
  const outputs: Record<(typeof GENERATED_PAGES)[number], string> = {
    "apps/docs/src/content/docs/reference/mcp-tools.md":
      renderMcpToolsPage(tools),
    "apps/docs/src/content/docs/reference/cli-commands.md":
      renderCliCommandsPage(program),
    "apps/docs/src/content/docs/whats-new.md": renderWhatsNewPage(changelog),
    "apps/docs/src/content/docs/reference/html-doc-runtime.md":
      renderHtmlRuntimePage(),
  }
  for (const [relPath, content] of Object.entries(outputs)) {
    await Bun.write(join(rootDir, relPath), content)
  }
  console.log(`Generated ${Object.keys(outputs).length} docs pages`)
}

if (import.meta.main) {
  await generateAll(join(import.meta.dir, ".."))
}
