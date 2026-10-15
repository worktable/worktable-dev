#!/usr/bin/env bun
/**
 * Static speed guards (Plan 17, item 8). See docs/performance.md.
 *
 *   bun run perf:guards [--base <git ref>]
 *
 * Fails when the source adds polling, broad query invalidation or a catalog
 * build on the request path that is not registered in scripts/perf/guards/,
 * when a registered site no longer exists, or when a bundle budget rises
 * without a `why`. With `--base`, the catalog list may only shrink against
 * that commit and budget increases are measured against it; without a base,
 * those two comparisons use the merge base with origin/main when available.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { REPO_ROOT, parseArgs } from "./lib.ts"

export interface Site {
  /** `<file>#<function>[.<variable>]`: stable across edits that move lines. */
  site: string
  kind: string
  file: string
  line: number
  text: string
}

export interface Entry {
  site: string
  kind?: string
  why?: string
}

export interface Allowlist {
  $comment?: string
  sites: Entry[]
}

export interface Problem {
  guard: string
  message: string
}

export interface Source {
  file: string
  text: string
}

const POLLING_FILE = "scripts/perf/guards/polling.json"
const INVALIDATION_FILE = "scripts/perf/guards/invalidation.json"
const CATALOG_FILE = "scripts/perf/guards/catalog-builders.json"
const BUDGETS_FILE = "scripts/perf/bundle-budgets.json"

// ── Parsing ─────────────────────────────────────────────────

const parsed = new WeakMap<Source, ts.SourceFile>()

function parse(source: Source): ts.SourceFile {
  let file = parsed.get(source)
  if (!file) {
    file = parseSource(source)
    parsed.set(source, file)
  }
  return file
}

function parseSource(source: Source): ts.SourceFile {
  return ts.createSourceFile(
    source.file,
    source.text,
    ts.ScriptTarget.Latest,
    true,
    source.file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "all"])

/** A route handler, as in `router.post("/", handler)`, is named `POST /`. */
function routeName(node: ts.Node): string | null {
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return null
  const call = node.parent
  if (
    !ts.isCallExpression(call) ||
    !ts.isPropertyAccessExpression(call.expression) ||
    !HTTP_METHODS.has(call.expression.name.text)
  )
    return null
  const [path] = call.arguments
  return path && ts.isStringLiteral(path)
    ? `${call.expression.name.text.toUpperCase()} ${path.text}`
    : null
}

/**
 * Where a node sits: the nearest named function, method or class, then the
 * variable inside it that holds the node, as in `ConnectStep.tokens`.
 */
function ownerName(node: ts.Node): string {
  let variable: string | null = null
  const named = (name: string) => (variable ? `${name}.${variable}` : name)
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      (ts.isFunctionDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isClassDeclaration(parent)) &&
      parent.name
    )
      return named(parent.name.getText())
    const route = routeName(parent)
    if (route) return named(route)
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      const value = parent.initializer
      if (
        value &&
        (ts.isArrowFunction(value) || ts.isFunctionExpression(value))
      )
        return named(parent.name.text)
      variable ??= parent.name.text
    }
  }
  return variable ?? "(module)"
}

function siteOf(source: Source, node: ts.Node, kind: string): Site {
  const file = node.getSourceFile()
  return {
    site: `${source.file}#${ownerName(node)}`,
    kind,
    file: source.file,
    line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    text: node.getText().replace(/\s+/g, " ").slice(0, 120),
  }
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

function property(
  object: ts.ObjectLiteralExpression,
  name: string
): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find(
    (element) =>
      (ts.isPropertyAssignment(element) ||
        ts.isShorthandPropertyAssignment(element) ||
        ts.isMethodDeclaration(element)) &&
      element.name.getText() === name
  )
}

// ── Polling ─────────────────────────────────────────────────

/** `refetchInterval` options and `setInterval` timers in the web app. */
export function findPolling(sources: Source[]): Site[] {
  const sites: Site[] = []
  for (const source of sources) {
    if (
      !source.text.includes("refetchInterval") &&
      !source.text.includes("setInterval")
    )
      continue
    walk(parse(source), (node) => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText() === "refetchInterval"
      )
        sites.push(siteOf(source, node, "refetchInterval"))
      if (
        ts.isCallExpression(node) &&
        /(?:^|\.)setInterval$/.test(node.expression.getText())
      )
        sites.push(siteOf(source, node, "setInterval"))
    })
  }
  return sites
}

// ── Invalidation ────────────────────────────────────────────

const INVALIDATING = /^(?:invalidate|reset|refetch|remove)Queries$/

/**
 * Keys that cover every query of a Space, or of every Space: since Plan 15 a
 * document's page and content have their own keys under ["spaces", id], so a
 * prefix this short refetches open documents too.
 */
function isSpaceWideKey(expression: ts.Expression): boolean {
  const text = expression.getText().replace(/\s+/g, "")
  if (/^queryKeys\.spaces$/.test(text)) return true
  if (/^queryKeys\.space\([^()]*\)$/.test(text)) return true
  if (/^spaceQueryOptions\([^()]*\)\.queryKey$/.test(text)) return true
  if (ts.isArrayLiteralExpression(expression)) {
    const [first, ...rest] = expression.elements
    if (
      first &&
      ts.isStringLiteral(first) &&
      (first.text === "spaces" || first.text === "annotations") &&
      rest.length <= 1 &&
      rest.every((element) => !ts.isSpreadElement(element))
    )
      return true
  }
  return false
}

/** What a key identifier holds: its declaration, or the array a loop walks. */
function resolveKey(expression: ts.Expression): ts.Expression[] {
  if (!ts.isIdentifier(expression)) return [expression]
  const name = expression.text
  for (let scope = expression.parent; scope; scope = scope.parent) {
    if (ts.isForOfStatement(scope)) {
      const declaration = scope.initializer
      if (
        ts.isVariableDeclarationList(declaration) &&
        declaration.declarations[0]?.name.getText() === name
      )
        return ts.isArrayLiteralExpression(scope.expression)
          ? scope.expression.elements.filter(
              (element): element is ts.Expression =>
                !ts.isSpreadElement(element)
            )
          : []
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const statement of scope.statements) {
        if (!ts.isVariableStatement(statement)) continue
        for (const declaration of statement.declarationList.declarations) {
          if (declaration.name.getText() === name && declaration.initializer)
            return [declaration.initializer]
        }
      }
    }
  }
  return []
}

function filterKind(object: ts.ObjectLiteralExpression): string | null {
  if (property(object, "queryFn")) return null
  const exact = property(object, "exact")
  if (
    exact &&
    ts.isPropertyAssignment(exact) &&
    exact.initializer.kind === ts.SyntaxKind.TrueKeyword
  )
    return null
  const key = property(object, "queryKey")
  if (!key) return property(object, "predicate") ? "predicate" : null
  const expression = ts.isPropertyAssignment(key)
    ? key.initializer
    : ts.isShorthandPropertyAssignment(key)
      ? key.name
      : null
  if (!expression) return null
  return resolveKey(expression).some(isSpaceWideKey) ? "space-wide" : null
}

function calleeName(call: ts.CallExpression): string {
  return ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : call.expression.getText()
}

function isInvalidationArgument(object: ts.ObjectLiteralExpression): boolean {
  const call = object.parent
  return ts.isCallExpression(call) && INVALIDATING.test(calleeName(call))
}

/** A filter handed straight to a read such as `findAll` changes nothing. */
function isReadOnlyFilter(object: ts.ObjectLiteralExpression): boolean {
  const call = object.parent
  return (
    ts.isCallExpression(call) &&
    call.arguments.includes(object) &&
    !INVALIDATING.test(calleeName(call)) &&
    !["refreshLive", "push"].includes(calleeName(call))
  )
}

/**
 * Query invalidation that is not narrowed to the data a change touched: a
 * call with no filter, a filter that is only a predicate (it visits every
 * cached query), or a Space-wide key prefix without `exact: true`. Filters
 * are found wherever they are written, so ones built for `refreshLive` count.
 */
export function findInvalidation(sources: Source[]): Site[] {
  const sites: Site[] = []
  for (const source of sources) {
    if (!/Queries\(|refreshLive|InvalidateQueryFilters/.test(source.text))
      continue
    walk(parse(source), (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        INVALIDATING.test(node.expression.name.text)
      ) {
        const [filter] = node.arguments
        if (
          !filter ||
          (ts.isObjectLiteralExpression(filter) &&
            !property(filter, "queryKey") &&
            !property(filter, "predicate"))
        )
          sites.push(siteOf(source, node, "unkeyed"))
        return
      }
      if (ts.isObjectLiteralExpression(node) && !isReadOnlyFilter(node)) {
        const kind = filterKind(node)
        if (kind && (kind !== "predicate" || isInvalidationArgument(node)))
          sites.push(siteOf(source, node, kind))
      }
    })
  }
  return sites
}

// ── Catalog builders on the request path ────────────────────

/**
 * Functions that rebuild a Space's document catalog from files, or list or
 * stat every document or thread file. The catalog snapshot, thread digests
 * and other derived data wrap them; code that answers a request should read
 * through those instead.
 */
export const CATALOG_BUILDERS = [
  "buildDocumentCatalog",
  "documentQueryContext",
  "listDocs",
  "listDocsByPrefix",
  "scanThreadDigests",
  "scanAllThreadDigests",
] as const

/**
 * Functions that never run while a request waits. Add one here only with its
 * reason; every other call is registered in catalog-builders.json.
 */
export const BACKGROUND_FUNCTIONS = [
  // Boot: finishes interrupted document lifecycle work before serving.
  "packages/server/src/document-data-lifecycle-v2.ts#reconcileDocumentDataV2LifecycleRecovery",
  // CLI preflight and storage migration.
  "packages/server/src/document-preflight.ts#preflightDocumentWorkspace",
  // Starter content check run by local supervisors at start.
  "packages/server/src/seed.ts#starterWorkspaceReady",
]

const inBackground = (site: string) =>
  BACKGROUND_FUNCTIONS.some(
    (owner) => site === owner || site.startsWith(`${owner}.`)
  )

/** Every call to a catalog builder in server code, outside the background. */
export function findCatalogBuilders(
  sources: Source[],
  builders: readonly string[] = CATALOG_BUILDERS
): Site[] {
  const pattern = new RegExp(`\\b(?:${builders.join("|")})\\(`)
  const sites: Site[] = []
  for (const source of sources) {
    if (!pattern.test(source.text)) continue
    walk(parse(source), (node) => {
      if (!ts.isCallExpression(node)) return
      const callee = calleeName(node)
      if (!builders.includes(callee)) return
      const site = siteOf(source, node, callee)
      if (!inBackground(site.site)) sites.push(site)
    })
  }
  return sites
}

// ── Allowlists ──────────────────────────────────────────────

const keyOf = (entry: { site: string; kind?: string }) =>
  entry.kind ? `${entry.site} [${entry.kind}]` : entry.site

/** Each entry admits one site; duplicate entries admit duplicate sites. */
export function compareAllowlist(
  guard: string,
  file: string,
  sites: Site[],
  list: Allowlist,
  options: { withKind: boolean; register: string }
): Problem[] {
  const problems: Problem[] = []
  const allowed = new Map<string, number>()
  for (const entry of list.sites) {
    const key = keyOf(options.withKind ? entry : { site: entry.site })
    allowed.set(key, (allowed.get(key) ?? 0) + 1)
    if (!entry.why?.trim())
      problems.push({
        guard,
        message: `${file}: the entry for ${key} needs a one-line "why".`,
      })
  }
  const found = new Map<string, Site[]>()
  for (const site of sites) {
    const key = keyOf(options.withKind ? site : { site: site.site })
    found.set(key, [...(found.get(key) ?? []), site])
  }
  for (const [key, matches] of found) {
    const extra = matches.length - (allowed.get(key) ?? 0)
    if (extra <= 0) continue
    const where = matches
      .map((site) => `    ${site.file}:${site.line}  ${site.text}`)
      .join("\n")
    const entry = JSON.stringify(
      options.withKind
        ? { site: matches[0]!.site, kind: matches[0]!.kind, why: "..." }
        : { site: matches[0]!.site, why: "..." }
    )
    problems.push({
      guard,
      message:
        `${key}: ${matches.length} found, ${allowed.get(key) ?? 0} registered.\n${where}\n` +
        `  ${options.register}\n  To register it, add ${entry} to ${file}.`,
    })
  }
  for (const [key, count] of allowed) {
    const missing = count - (found.get(key)?.length ?? 0)
    if (missing > 0)
      problems.push({
        guard,
        message: `${key}: registered ${count} times in ${file} but found ${count - missing} times. Remove ${missing} entr${missing === 1 ? "y" : "ies"}.`,
      })
  }
  return problems
}

/**
 * The catalog list may lose entries but never gain them: per builder, it
 * holds no more calls than at the base. A renamed function moves its entry.
 */
export function compareShrinkOnly(
  guard: string,
  file: string,
  head: Allowlist,
  base: Allowlist
): Problem[] {
  const count = (list: Allowlist, kind: string) =>
    list.sites.filter((entry) => entry.kind === kind).length
  const known = new Set(base.sites.map(keyOf))
  const problems: Problem[] = []
  for (const kind of new Set(head.sites.map((entry) => entry.kind ?? ""))) {
    const after = count(head, kind)
    const before = count(base, kind)
    if (after <= before) continue
    const added = head.sites
      .filter((entry) => entry.kind === kind && !known.has(keyOf(entry)))
      .map((entry) => entry.site)
    problems.push({
      guard,
      message: `${file} lists ${after} calls to ${kind}, ${before} at the base, and can only shrink${added.length ? ` (new: ${added.join(", ")})` : ""}. Read through the catalog snapshot, thread digests or other derived data instead (docs/performance.md).`,
    })
  }
  return problems
}

// ── Bundle budgets ──────────────────────────────────────────

export interface Budgets {
  budgets: Record<string, { gzip: number; why?: string }>
}

/** A budget that rises, or a new one, carries a new `why`. */
export function compareBudgets(head: Budgets, base: Budgets | null): Problem[] {
  if (!base) return []
  const problems: Problem[] = []
  for (const [name, budget] of Object.entries(head.budgets)) {
    const before = base.budgets[name]
    if (before && budget.gzip <= before.gzip) continue
    const why = budget.why?.trim()
    if (why && why !== before?.why?.trim()) continue
    problems.push({
      guard: "Bundle budgets",
      message: before
        ? `"${name}" rises from ${before.gzip} to ${budget.gzip} bytes without a new "why". Add "why": "<what grew and why it is worth it>" to its entry in ${BUDGETS_FILE}, or shrink the bundle.`
        : `"${name}" is a new budget without a "why". Add "why": "<what it covers>" to its entry in ${BUDGETS_FILE}.`,
    })
  }
  return problems
}

// ── Running ─────────────────────────────────────────────────

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })
}

function trackedSources(prefix: string): Source[] {
  return git(["ls-files", "-z", "--", prefix])
    .split("\0")
    .filter(
      (file) =>
        /\.[cm]?tsx?$/.test(file) &&
        !/\.(?:test|spec|browser)\.[cm]?tsx?$/.test(file) &&
        !file.endsWith(".d.ts") &&
        !/(?:^|\/)(?:e2e|fixtures)\//.test(file)
    )
    .map((file) => ({
      file,
      text: readFileSync(join(REPO_ROOT, file), "utf8"),
    }))
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, file), "utf8")) as T
}

/**
 * A commit to compare against, fetched when CI checked out only the head. An
 * empty or all-zero `--base` (a manual run, or a new branch) means none.
 */
function resolveBase(requested: string | undefined): string | null {
  const candidate = requested && !/^0+$/.test(requested) ? requested : undefined
  if (candidate) {
    try {
      git(["cat-file", "-e", `${candidate}^{commit}`])
    } catch {
      try {
        git(["fetch", "--no-tags", "--depth=1", "origin", candidate])
      } catch {
        throw new Error(
          `perf:guards: cannot read the base commit ${candidate}; fetch it or omit --base.`
        )
      }
    }
    return candidate
  }
  try {
    return git(["merge-base", "HEAD", "origin/main"]).trim() || null
  } catch {
    return null
  }
}

function readAtBase<T>(base: string, file: string): T | null {
  try {
    return JSON.parse(git(["show", `${base}:${file}`])) as T
  } catch {
    return null
  }
}

export function runGuards(base: string | null): {
  problems: Problem[]
  counts: Record<string, number>
} {
  const web = trackedSources("apps/web/src")
  const server = trackedSources("packages/server/src")
  const polling = readJson<Allowlist>(POLLING_FILE)
  const invalidation = readJson<Allowlist>(INVALIDATION_FILE)
  const catalog = readJson<Allowlist>(CATALOG_FILE)
  const budgets = readJson<Budgets>(BUDGETS_FILE)

  const problems = [
    ...compareAllowlist("Polling", POLLING_FILE, findPolling(web), polling, {
      withKind: false,
      register:
        "New polling. Prefer a socket event or a refetch when the user acts; poll only when nothing tells the client about the change.",
    }),
    ...compareAllowlist(
      "Query invalidation",
      INVALIDATION_FILE,
      findInvalidation(web),
      invalidation,
      {
        withKind: true,
        register:
          "Broad invalidation. Invalidate the exact keys the change touched, with exact: true where the key is a prefix.",
      }
    ),
    ...compareAllowlist(
      "Catalog builders on the request path",
      CATALOG_FILE,
      findCatalogBuilders(server),
      catalog,
      {
        withKind: true,
        register:
          "A request handler builds the catalog or scans files. Read through the catalog snapshot or the read model instead; this list can only shrink.",
      }
    ),
  ]
  if (base) {
    const baseCatalog = readAtBase<Allowlist>(base, CATALOG_FILE)
    if (baseCatalog)
      problems.push(
        ...compareShrinkOnly(
          "Catalog builders on the request path",
          CATALOG_FILE,
          catalog,
          baseCatalog
        )
      )
    problems.push(
      ...compareBudgets(budgets, readAtBase<Budgets>(base, BUDGETS_FILE))
    )
  }
  return {
    problems,
    counts: {
      polling: polling.sites.length,
      invalidation: invalidation.sites.length,
      catalog: catalog.sites.length,
    },
  }
}

if (import.meta.main) {
  const started = performance.now()
  const args = parseArgs(process.argv.slice(2))
  const base = resolveBase(args.get("base"))
  const { problems, counts } = runGuards(base)
  const elapsed = Math.round(performance.now() - started)
  const summary = `polling ${counts.polling}, invalidation ${counts.invalidation}, catalog builders ${counts.catalog} registered; ${base ? `compared with ${base.slice(0, 12)}` : "no base commit, so budget and shrink checks were skipped"}; ${elapsed} ms`
  if (problems.length === 0) {
    console.log(`perf:guards passed (${summary}).`)
  } else {
    for (const guard of new Set(problems.map((problem) => problem.guard))) {
      console.error(`\n${guard}`)
      for (const problem of problems)
        if (problem.guard === guard) console.error(`- ${problem.message}`)
    }
    console.error(
      `\nperf:guards found ${problems.length} problem${problems.length === 1 ? "" : "s"} (${summary}). See docs/performance.md.`
    )
    process.exit(1)
  }
}
