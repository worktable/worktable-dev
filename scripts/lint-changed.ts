// Lints the files a change touches and fails only on lint errors it adds.
// Existing lint debt elsewhere, or already in a touched file, does not fail.
//
//   bun run lint:changed [--base <git-ref>]   (default HEAD^1)
//
// Each workspace keeps its own ESLint config and `lint` scope. A touched file
// is linted at both revisions with the current config; it fails when any rule
// reports more errors than it did at the base.
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const lintable = /\.(?:[cm]?[jt]sx?)$/

export interface LintMessage {
  ruleId: string | null
  severity: number
  line?: number
  column?: number
  message: string
}

export interface AddedLintErrors {
  rule: string
  before: number
  after: number
  messages: LintMessage[]
}

/** Rules that report more errors at head than at base, with their head errors. */
export function addedLintErrors(
  base: LintMessage[] | null,
  head: LintMessage[]
): AddedLintErrors[] {
  const byRule = (messages: LintMessage[]) => {
    const rules = new Map<string, LintMessage[]>()
    for (const message of messages) {
      if (message.severity !== 2) continue
      const rule = message.ruleId ?? "parse"
      rules.set(rule, [...(rules.get(rule) ?? []), message])
    }
    return rules
  }
  const before = byRule(base ?? [])
  return [...byRule(head)].flatMap(([rule, messages]) => {
    const previous = before.get(rule)?.length ?? 0
    return messages.length > previous
      ? [{ rule, before: previous, after: messages.length, messages }]
      : []
  })
}

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })

/** Workspaces with a `lint` script, and the directories that script lints. */
function lintWorkspaces(): { dir: string; scopes: string[] }[] {
  const manifest = JSON.parse(git("show", "HEAD:package.json")) as {
    workspaces: string[]
  }
  return manifest.workspaces.flatMap((dir) => {
    let script: string | undefined
    try {
      script = (
        JSON.parse(git("show", `HEAD:${dir}/package.json`)) as {
          scripts?: Record<string, string>
        }
      ).scripts?.lint
    } catch {
      return []
    }
    if (script === undefined) return []
    const match = script.match(/^eslint((?:\s+(?!-)[\w./-]+)*)\s*$/)
    // Fail closed rather than silently skipping a workspace that lints.
    if (!match)
      throw new Error(
        `${dir}: lint:changed reads only "eslint [paths]" lint scripts, not "${script}"`
      )
    const scopes = match[1]!.trim().split(/\s+/).filter(Boolean)
    return [{ dir, scopes: scopes.length > 0 ? scopes : ["."] }]
  })
}

type ESLintClass = new (options: { cwd: string }) => {
  isPathIgnored(path: string): Promise<boolean>
  lintFiles(paths: string[]): Promise<{ messages: LintMessage[] }[]>
  lintText(
    text: string,
    options: { filePath: string }
  ): Promise<{ messages: LintMessage[] }[]>
}

type WorkspaceResult = {
  checked: number
  files: [path: string, rules: AddedLintErrors[]][]
}

async function lintWorkspace(
  dir: string,
  base: string,
  files: [path: string, from: string | null][],
  configProbe: string | null
): Promise<WorkspaceResult> {
  const require = createRequire(join(root, dir, "package.json"))
  const { ESLint } = (await import(require.resolve("eslint"))) as {
    ESLint: ESLintClass
  }
  const eslint = new ESLint({ cwd: join(root, dir) })
  const result: WorkspaceResult = { checked: 0, files: [] }
  if (configProbe) {
    // A changed config must still load and name real rules, even when no
    // source file in scope changed. A config that fails to load throws.
    const [probe] = await eslint.lintText("export {}\n", {
      filePath: join(root, configProbe),
    })
    const added = addedLintErrors(null, probe!.messages)
    if (added.length > 0) result.files.push([configProbe, added])
  }
  for (const [path, from] of files) {
    const absolute = join(root, path)
    if (await eslint.isPathIgnored(absolute)) continue
    result.checked++
    const [head] = await eslint.lintFiles([absolute])
    // A renamed file is judged at its old path, under that path's rules, so
    // moving a file into a stricter override cannot hide what it breaks.
    // From outside this workspace's lint scope, or an ignored path, it is new.
    const basePath = from ? join(root, from) : null
    const before =
      basePath && !(await eslint.isPathIgnored(basePath))
        ? (
            await eslint.lintText(git("show", `${base}:${from}`), {
              filePath: basePath,
            })
          )[0]!.messages
        : null
    const added = addedLintErrors(before, head!.messages)
    if (added.length > 0) result.files.push([path, added])
  }
  return result
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args[0] === "--workspace") {
    const { files, configProbe } = JSON.parse(await Bun.stdin.text())
    console.log(
      JSON.stringify(
        await lintWorkspace(args[1]!, args[2]!, files, configProbe)
      )
    )
    process.exit(0)
  }
  const baseIndex = args.indexOf("--base")
  const base = baseIndex === -1 ? "HEAD^1" : args[baseIndex + 1]
  if (!base) throw new Error("--base requires a git revision")

  // Path now, and its path at base when it already existed there. Comparing
  // with the working tree also covers uncommitted edits to tracked files.
  const changed = new Map<string, string | null>()
  const fields = git(
    "diff",
    "--name-status",
    "-z",
    "-M",
    "--diff-filter=AMR",
    base
  ).split("\0")
  for (let index = 0; index < fields.length - 1; ) {
    const status = fields[index++]!
    if (status.startsWith("R")) {
      const from = fields[index++]!
      changed.set(fields[index++]!, from)
    } else {
      const path = fields[index++]!
      changed.set(path, status === "A" ? null : path)
    }
  }

  // typescript-eslint caches project roots per process, so each workspace
  // lints in its own process.
  const workspaces = lintWorkspaces().flatMap(({ dir, scopes }) => {
    const inScope = (path: string) =>
      lintable.test(path) &&
      scopes.some((scope) =>
        path.startsWith(scope === "." ? `${dir}/` : `${dir}/${scope}/`)
      )
    const files = [...changed]
      .filter(([path]) => inScope(path))
      .map(([path, from]) => [path, from && inScope(from) ? from : null])
    const configChanged = [...changed.keys()].some(
      (path) =>
        path.startsWith(`${dir}/`) &&
        /^eslint\.config\.[cm]?[jt]s$/.test(path.slice(dir.length + 1))
    )
    const configProbe = configChanged
      ? join(dir, scopes[0] === "." ? "" : scopes[0]!, "lint-config-probe.ts")
      : null
    if (files.length === 0 && !configProbe) return []
    const child = Bun.spawn(
      [process.execPath, import.meta.path, "--workspace", dir, base],
      { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "inherit" }
    )
    child.stdin.write(JSON.stringify({ files, configProbe }))
    child.stdin.end()
    return [
      (async () => {
        const output = await new Response(child.stdout).text()
        if ((await child.exited) !== 0) throw new Error(`Linting ${dir} failed`)
        return JSON.parse(output) as WorkspaceResult
      })(),
    ]
  })

  let added = 0
  let checked = 0
  for (const result of await Promise.all(workspaces)) {
    checked += result.checked
    for (const [path, rules] of result.files) {
      for (const rule of rules) {
        added += rule.after - rule.before
        // Errors can't be matched across edits, so list every error of the rule.
        console.log(
          `${path}: ${rule.rule}, ${rule.before} error${rule.before === 1 ? "" : "s"} before, ${rule.after} now`
        )
        for (const { line = 1, column = 1, message } of rule.messages) {
          console.log(`  ${line}:${column}  ${message}`)
          if (process.env.GITHUB_ACTIONS)
            console.log(
              `::error file=${path},line=${line},col=${column}::${message.replace(/\r?\n/g, " ")} (${rule.rule})`
            )
        }
      }
    }
  }

  if (added > 0) {
    console.error(
      `\n${added} lint error${added === 1 ? "" : "s"} added in changed files.`
    )
    process.exit(1)
  }
  console.log(
    `No lint errors added in ${checked} changed file${checked === 1 ? "" : "s"}.`
  )
}
