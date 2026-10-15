#!/usr/bin/env bun
/**
 * perf-smoke: structural speed budgets for pull requests (Plan 17 Speed).
 *
 *   bun scripts/perf/smoke.ts [--checkout <dir>] [--network desktop]
 *     [--out <dir>] [--update]
 *   bun scripts/perf/smoke.ts --clicks <result.json> --io <result.json> [--update]
 *     [--prune]
 *
 * Runs the click lane once, untimed, on the 100-document fixture (the
 * desktop profile by default: 40 ms round trips through the HTTP/2 proxy, so
 * requests that wait on each other show as a chain), and io-count's counting
 * run, then checks what they record against
 * smoke-budgets.json. Everything checked is a count that does not depend on
 * the machine's speed:
 *
 * - requests per click (API, HTML frame and page loads, not cached assets);
 * - the requests a click's content waited for one after another, after the
 *   click (in-tab clicks and reopening the app);
 * - document content requests on revisits;
 * - requests from an untouched tab at Home over a fixed window;
 * - HTTP redirects;
 * - JavaScript files a cold page load fetches before its content;
 * - elements in the page once a screen settles;
 * - file stats, file reads and SQL statements per hot server request.
 *
 * Needs what click-trace.ts and io-count.ts need: a web build of the checkout
 * (`WORKTABLE_BUILD_ID=smoke bun run --cwd apps/web build`), Playwright's
 * Chromium, Caddy and strace. It generates the fixture if missing. With `--clicks`
 * and `--io` it only checks existing results. `--update` rewrites the budgets
 * to the measured values, keeping each unchanged budget's `why`; a budget
 * that rises needs a new `why`, which `bun run perf:guards` checks. A budget
 * the run did not measure fails the check, and `--update` keeps refusing
 * until `--prune` says it went away on purpose.
 */
import { spawnSync } from "node:child_process"
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"
import type { ClickRecord, ClickTraceResult, Pass } from "./click-trace.ts"
import { PERF_ROOT, REPO_ROOT, markdownTable, parseArgs } from "./lib.ts"

export const SMOKE_BUDGETS_FILE = "scripts/perf/smoke-budgets.json"
const PROFILE = "100"
export const SMOKE_PASSES: Pass[] = [
  "cold",
  "first",
  "warm",
  "revisit",
  "reopen",
]
/**
 * Home's 60 s checks (Pending, Recent, Activity) start when the reopened app
 * fetches them; the window opens once it settles and ends 15 s after their
 * first tick, so each fires exactly once in it.
 */
const IDLE_WINDOW_SECONDS = 75

export type Metric =
  | "requests"
  | "chain"
  | "revisit content"
  | "idle requests"
  | "redirects"
  | "cold js"
  | "dom"
  | "io stat"
  | "io read"
  | "io sql"

export interface SmokeBudgets {
  $comment?: string
  /** What each metric guards; individual budgets carry a `why` when they rise. */
  metrics: Record<Metric, { why: string; slack?: number; headroom?: number }>
  budgets: Record<string, { max: number; why?: string }>
}

export interface Measurement {
  key: string
  metric: Metric
  value: number
  /** Evidence: the requests or paths behind the value. */
  detail?: string[]
}

const API_KINDS = new Set(["api", "frame", "document"])

function apiRequests(click: ClickRecord) {
  return click.requests.filter(
    (request) => API_KINDS.has(request.kind) && !request.cached
  )
}

/** Document content read on a revisit: a cache miss (click-trace-report.ts). */
function contentRequests(click: ClickRecord): string[] {
  return click.requests
    .filter(
      (request) =>
        !request.cached &&
        (request.label.includes("/documents/content?") ||
          /\/api\/spaces\/[^/]+\/docs\//.test(request.label))
    )
    .map((request) => request.label)
}

/** Ids and revisions vary between fixtures; evidence reads better without. */
function shortLabel(label: string): string {
  return label.length > 120 ? `${label.slice(0, 117)}...` : label
}

export function measureClicks(result: ClickTraceResult): {
  measurements: Measurement[]
  failures: string[]
} {
  const measurements: Measurement[] = []
  const failures: string[] = []
  const clicks = result.clicks.filter((click) =>
    SMOKE_PASSES.includes(click.pass)
  )
  for (const click of clicks) {
    const name = `${click.pass}, ${click.journey}`
    if (click.contentMs === null) {
      failures.push(`${name}: the screen's content never appeared`)
      continue
    }
    const requests = apiRequests(click)
    measurements.push({
      key: `requests, ${name}`,
      metric: "requests",
      value: requests.length,
      detail: requests.map((request) => shortLabel(request.label)),
    })
    // What the click waited on after it happened: requests a hover started
    // early, and a cold load's page and script chain (see cold js), vary
    // with timing and are left out.
    if (click.pass !== "cold") {
      const chain = click.chain.filter(
        (step) =>
          (step.kind === "api" || step.kind === "frame") && step.start >= 0
      )
      measurements.push({
        key: `chain, ${name}`,
        metric: "chain",
        value: chain.length,
        detail: chain.map((step) => shortLabel(step.label)),
      })
    }
    if (click.pass === "cold") {
      const scripts = click.requests.filter(
        (request) =>
          request.kind === "script" &&
          !request.cached &&
          request.start <= click.contentMs!
      )
      measurements.push({
        key: `cold js, ${click.journey}`,
        metric: "cold js",
        value: scripts.length,
      })
    }
    if (
      typeof click.domNodes === "number" &&
      (click.pass === "first" ||
        (click.pass === "cold" && click.journey === "open the app at Home"))
    )
      measurements.push({
        key: `dom, ${name}`,
        metric: "dom",
        value: click.domNodes,
      })
  }
  const revisitContent = clicks
    .filter((click) => click.pass === "revisit")
    .flatMap((click) =>
      contentRequests(click).map((label) => `${click.journey}: ${label}`)
    )
  measurements.push({
    key: "revisit content",
    metric: "revisit content",
    value: revisitContent.length,
    detail: revisitContent,
  })
  const redirects = result.clicks.flatMap((click) =>
    click.requests
      .filter(
        (request) =>
          (request.redirects ?? 0) > 0 ||
          (request.status !== null &&
            request.status >= 300 &&
            request.status < 400 &&
            request.status !== 304)
      )
      .map((request) => `${click.pass}, ${click.journey}: ${request.label}`)
  )
  measurements.push({
    key: "redirects",
    metric: "redirects",
    value: redirects.length,
    detail: redirects,
  })
  for (const window of result.idleWindows ?? [])
    measurements.push({
      key: `idle requests, Home, ${window.seconds} s`,
      metric: "idle requests",
      value: window.requests.length,
      detail: window.requests.map(shortLabel),
    })
  if (!result.idleWindows?.length)
    failures.push("the click run recorded no idle window (--idle-window)")
  return { measurements, failures }
}

interface IoEndpoint {
  role: string
  endpoint: string
  counts: {
    stat: number
    open: number
    read: number
    readdir: number
    sql: number
    authSql: number
  }
  evidence: {
    paths: { call: string; path: string; perRequest: number }[]
    statements: { sql: string; site: string; perRequest: number }[]
  }
}

export function measureIo(result: {
  counting?: { calibration: { ok: boolean }; endpoints: IoEndpoint[] }
}): { measurements: Measurement[]; failures: string[] } {
  const counting = result.counting
  if (!counting)
    return { measurements: [], failures: ["io-count made no counting run"] }
  const failures = counting.calibration.ok
    ? []
    : ["io-count: strace did not show the calibration read"]
  const measurements: Measurement[] = []
  const paths = (row: IoEndpoint, calls: string[]) =>
    row.evidence.paths
      .filter((item) => calls.some((call) => item.call.startsWith(call)))
      .slice(0, 8)
      .map((item) => `${item.perRequest} × ${item.call} ${item.path}`)
  for (const row of counting.endpoints.filter((item) => item.role === "solo")) {
    const { counts } = row
    measurements.push(
      {
        key: `io stat, ${row.endpoint}`,
        metric: "io stat",
        value: counts.stat,
        detail: paths(row, [
          "stat",
          "lstat",
          "fstat",
          "newfstatat",
          "statx",
          "access",
          "faccessat",
        ]),
      },
      {
        key: `io read, ${row.endpoint}`,
        metric: "io read",
        value: round1(counts.open + counts.read + counts.readdir),
        detail: paths(row, ["open", "read", "pread", "getdents"]),
      },
      {
        key: `io sql, ${row.endpoint}`,
        metric: "io sql",
        value: round1(counts.sql + counts.authSql),
        detail: row.evidence.statements
          .slice(0, 8)
          .map((item) => `${item.perRequest} × ${item.sql} (${item.site})`),
      }
    )
  }
  return { measurements, failures }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

export interface Verdict {
  key: string
  value: number | null
  max: number | null
  status: "over" | "new" | "missing" | "under" | "ok" | "moved"
  detail?: string[]
}

/** Budgets the run did not measure: a journey, pass or endpoint went missing. */
export function unmeasured(
  measurements: Measurement[],
  budgets: SmokeBudgets
): string[] {
  const measured = new Set(measurements.map((measurement) => measurement.key))
  return Object.keys(budgets.budgets).filter((key) => !measured.has(key))
}

/** A verdict that fails the check. */
export function failing(verdict: Verdict): boolean {
  return (
    verdict.status === "over" ||
    verdict.status === "new" ||
    verdict.status === "missing"
  )
}

/** "requests, <pass>, <journey>" -> "<pass>" */
function passOf(key: string): string {
  return key.split(", ")[1] ?? ""
}

/**
 * Over budget when the value exceeds the budget's max plus the metric's
 * slack. io-count figures are means over several requests, so they carry
 * half a call of slack: a whole extra call per request still fails.
 *
 * A request that starts late (such as the deployment check after a
 * revisit) can land in the next click's window. So a click over its
 * request budget fails only when its pass made more requests in total than
 * the pass's budgets allow; otherwise it is reported as moved.
 */
export function check(
  measurements: Measurement[],
  budgets: SmokeBudgets
): Verdict[] {
  const passTotals = new Map<string, { value: number; max: number }>()
  for (const measurement of measurements) {
    if (measurement.metric !== "requests") continue
    const total = passTotals.get(passOf(measurement.key)) ?? {
      value: 0,
      max: 0,
    }
    total.value += measurement.value
    total.max += budgets.budgets[measurement.key]?.max ?? 0
    passTotals.set(passOf(measurement.key), total)
  }
  const missing = unmeasured(measurements, budgets).map(
    (key): Verdict => ({
      key,
      value: null,
      max: budgets.budgets[key]!.max,
      status: "missing",
    })
  )
  const measured = measurements.map((measurement): Verdict => {
    const budget = budgets.budgets[measurement.key]
    const slack = budgets.metrics[measurement.metric]?.slack ?? 0
    const base = {
      key: measurement.key,
      value: measurement.value,
      ...(measurement.detail ? { detail: measurement.detail } : {}),
    }
    if (!budget) return { ...base, max: null, status: "new" }
    if (measurement.value > budget.max + slack) {
      const total = passTotals.get(passOf(measurement.key))
      if (
        measurement.metric === "requests" &&
        total &&
        total.value <= total.max
      )
        return { ...base, max: budget.max, status: "moved" }
      return { ...base, max: budget.max, status: "over" }
    }
    const total = passTotals.get(passOf(measurement.key))
    const lower =
      budgetFor(measurement, budgets) < budget.max - slack &&
      (measurement.metric !== "requests" || !total || total.value < total.max)
    return { ...base, max: budget.max, status: lower ? "under" : "ok" }
  })
  return [...measured, ...missing]
}

/** The budget `--update` writes for a measured value. */
export function budgetFor(measurement: Measurement, budgets: SmokeBudgets) {
  const headroom = budgets.metrics[measurement.metric]?.headroom ?? 0
  return headroom > 0
    ? Math.ceil(measurement.value * (1 + headroom))
    : measurement.value
}

export function updateBudgets(
  measurements: Measurement[],
  budgets: SmokeBudgets
): SmokeBudgets {
  const next: SmokeBudgets["budgets"] = {}
  for (const measurement of measurements) {
    const max = budgetFor(measurement, budgets)
    const before = budgets.budgets[measurement.key]
    // An unchanged budget keeps its why; a raised one needs a new why.
    next[measurement.key] =
      before?.why && before.max === max ? { max, why: before.why } : { max }
  }
  return { ...budgets, budgets: next }
}

function report(verdicts: Verdict[], failures: string[]): string {
  const over = verdicts.filter((verdict) => verdict.status === "over")
  const fresh = verdicts.filter((verdict) => verdict.status === "new")
  const missing = verdicts.filter((verdict) => verdict.status === "missing")
  const under = verdicts.filter((verdict) => verdict.status === "under")
  const moved = verdicts.filter((verdict) => verdict.status === "moved")
  const lines = ["## perf-smoke", ""]
  if (
    failures.length === 0 &&
    over.length === 0 &&
    fresh.length === 0 &&
    missing.length === 0
  )
    lines.push(`All ${verdicts.length} structural budgets hold.`, "")
  for (const failure of failures) lines.push(`- **Failed:** ${failure}`)
  if (failures.length) lines.push("")
  const table = (rows: Verdict[]) =>
    markdownTable(
      ["Budget", "Measured", "Max", "Evidence"],
      rows.map((verdict) => [
        verdict.key,
        verdict.value,
        verdict.max,
        (verdict.detail ?? []).slice(0, 6).join("<br>") || "",
      ])
    )
  if (over.length)
    lines.push(
      "### Over budget",
      "",
      "Fix the regression, or raise the budget with `bun scripts/perf/smoke.ts --update` and add a `why` to each raised entry in `scripts/perf/smoke-budgets.json` (see docs/performance.md).",
      "",
      table(over),
      ""
    )
  if (fresh.length)
    lines.push(
      "### Without a budget",
      "",
      "A new journey, pass or endpoint: add budgets with `bun scripts/perf/smoke.ts --update`.",
      "",
      table(fresh),
      ""
    )
  if (missing.length)
    lines.push(
      "### Not measured",
      "",
      "The run recorded nothing for these budgets: a click never reached its content, or a journey, pass or endpoint went away. If it went away on purpose, drop them with `bun scripts/perf/smoke.ts --update --prune`.",
      "",
      table(missing),
      ""
    )
  if (moved.length)
    lines.push(
      "### Requests in a neighbouring click's window",
      "",
      "Over the click's budget while its pass stays within its total: a late request landed in the next click's window. Not a failure.",
      "",
      table(moved),
      ""
    )
  if (under.length)
    lines.push(
      "### Below budget",
      "",
      "Lower these with `--update` so the improvement stays.",
      "",
      table(under),
      ""
    )
  return lines.join("\n")
}

function run(command: string[], label: string): void {
  console.log(`[smoke] ${label}: ${command.join(" ")}`)
  const started = performance.now()
  const result = spawnSync(command[0]!, command.slice(1), {
    cwd: REPO_ROOT,
    stdio: "inherit",
  })
  console.log(
    `[smoke] ${label} took ${Math.round((performance.now() - started) / 1000)} s`
  )
  if (result.status !== 0)
    throw new Error(`${label} failed with exit code ${result.status}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const network = args.get("network") ?? "desktop"
  const budgetsPath = join(REPO_ROOT, SMOKE_BUDGETS_FILE)
  const budgets = JSON.parse(readFileSync(budgetsPath, "utf8")) as SmokeBudgets
  let clicksPath = args.get("clicks")
  let ioPath = args.get("io")
  if (!clicksPath !== !ioPath)
    throw new Error("pass both --clicks and --io, or neither")
  if (!clicksPath || !ioPath) {
    const checkout = resolve(args.get("checkout") ?? REPO_ROOT)
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const out = resolve(
      args.get("out") ?? join(PERF_ROOT, "results", `${stamp}-smoke`)
    )
    run(["bun", "scripts/perf/fixtures.ts", "--profile", PROFILE], "fixture")
    run(
      [
        "bun",
        "scripts/perf/click-trace.ts",
        "--profile",
        PROFILE,
        "--checkout",
        checkout,
        "--rounds",
        "1",
        "--networks",
        network,
        "--passes",
        SMOKE_PASSES.join(","),
        "--idle-window",
        String(IDLE_WINDOW_SECONDS),
        "--content-timeout",
        "60",
        "--no-trace",
        "--out",
        join(out, "clicks"),
      ],
      "clicks"
    )
    run(
      [
        "bun",
        "scripts/perf/io-count.ts",
        "--profile",
        PROFILE,
        "--checkout",
        checkout,
        "--requests",
        "10",
        "--attempts",
        "3",
        "--idle-seconds",
        "3",
        "--sockets",
        "2",
        "--no-timing",
        "--out",
        join(out, "io"),
      ],
      "io-count"
    )
    clicksPath = join(out, "clicks", "result.json")
    ioPath = join(out, "io", "result.json")
  }
  const clicks = measureClicks(
    JSON.parse(readFileSync(clicksPath, "utf8")) as ClickTraceResult
  )
  const io = measureIo(JSON.parse(readFileSync(ioPath, "utf8")))
  const measurements = [...clicks.measurements, ...io.measurements]
  const failures = [...clicks.failures, ...io.failures]
  const resultsDir = resolve(clicksPath, "..", "..")
  writeFileSync(
    join(resultsDir, "smoke.json"),
    JSON.stringify({ measurements, failures }, null, 2)
  )
  if (args.has("update")) {
    if (failures.length)
      throw new Error(`not updating budgets:\n${failures.join("\n")}`)
    const missing = unmeasured(measurements, budgets)
    if (missing.length && !args.has("prune"))
      throw new Error(
        `not updating budgets: this run did not measure ${missing.join("; ")}. Pass --prune to drop them.`
      )
    const next = updateBudgets(measurements, budgets)
    writeFileSync(budgetsPath, `${JSON.stringify(next, null, 2)}\n`)
    console.log(
      `[smoke] wrote ${Object.keys(next.budgets).length} budgets to ${SMOKE_BUDGETS_FILE}`
    )
    return
  }
  const verdicts = check(measurements, budgets)
  const text = report(verdicts, failures)
  writeFileSync(join(resultsDir, "smoke.md"), text)
  console.log(text)
  const summary = process.env["GITHUB_STEP_SUMMARY"]
  if (summary && existsSync(summary)) appendFileSync(summary, `${text}\n`)
  const failed = failures.length > 0 || verdicts.some(failing)
  if (failed) process.exit(1)
}

if (import.meta.main) {
  await main()
  process.exit(0)
}
