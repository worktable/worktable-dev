#!/usr/bin/env bun
/**
 * perf-smoke: structural speed budgets for pull requests (Plan 17 Speed).
 *
 *   bun scripts/perf/smoke.ts [--checkout <dir>] [--out <dir>] [--update]
 *   bun scripts/perf/smoke.ts --clicks <result.json> --io <result.json> [--update]
 *
 * Runs the click lane once, untimed, on the 100-document fixture, and
 * io-count's counting run, then checks what they record against
 * smoke-budgets.json. Everything checked is a count that does not depend on
 * the machine's speed:
 *
 * - requests per click (API, HTML frame and page loads, not cached assets);
 * - the request chain a click's content waited for;
 * - document content requests on revisits;
 * - requests from an untouched tab at Home over a fixed window;
 * - HTTP redirects;
 * - JavaScript files a cold page load fetches before its content;
 * - elements in the page once a screen settles;
 * - file stats, file reads and SQL statements per hot server request.
 *
 * Needs what click-trace.ts and io-count.ts need: a web build of the checkout
 * (`WORKTABLE_BUILD_ID=smoke bun run --cwd apps/web build`), Playwright's
 * Chromium and strace. It generates the fixture if missing. With `--clicks`
 * and `--io` it only checks existing results. `--update` rewrites the budgets
 * to the measured values, keeping each unchanged budget's `why`; a budget
 * that rises needs a new `why`, which `bun run perf:guards` checks.
 */
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ClickRecord, ClickTraceResult, Pass } from "./click-trace.ts"
import { PERF_ROOT, REPO_ROOT, markdownTable, parseArgs } from "./lib.ts"

export const SMOKE_BUDGETS_FILE = "scripts/perf/smoke-budgets.json"
const PROFILE = "100"
export const SMOKE_PASSES: Pass[] = ["cold", "first", "warm", "revisit", "reopen"]
const IDLE_WINDOW_SECONDS = 60

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
    const chain = click.chain.filter((step) => API_KINDS.has(step.kind))
    measurements.push({
      key: `chain, ${name}`,
      metric: "chain",
      value: chain.length,
      detail: chain.map((step) => shortLabel(step.label)),
    })
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
        detail: paths(row, ["stat", "lstat", "fstat", "newfstatat", "statx", "access", "faccessat"]),
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
  value: number
  max: number | null
  status: "over" | "new" | "under" | "ok"
  detail?: string[]
}

/**
 * Over budget when the value exceeds the budget's max plus the metric's
 * slack. io-count figures are means over several requests, so they carry
 * half a call of slack: a whole extra call per request still fails.
 */
export function check(
  measurements: Measurement[],
  budgets: SmokeBudgets
): Verdict[] {
  return measurements.map((measurement) => {
    const budget = budgets.budgets[measurement.key]
    const slack = budgets.metrics[measurement.metric]?.slack ?? 0
    const base = {
      key: measurement.key,
      value: measurement.value,
      ...(measurement.detail ? { detail: measurement.detail } : {}),
    }
    if (!budget) return { ...base, max: null, status: "new" }
    if (measurement.value > budget.max + slack)
      return { ...base, max: budget.max, status: "over" }
    return {
      ...base,
      max: budget.max,
      status: measurement.value < budget.max - slack ? "under" : "ok",
    }
  })
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
  const under = verdicts.filter((verdict) => verdict.status === "under")
  const lines = ["## perf-smoke", ""]
  if (failures.length === 0 && over.length === 0 && fresh.length === 0)
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
        "local",
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
  const failed =
    failures.length > 0 ||
    verdicts.some(
      (verdict) => verdict.status === "over" || verdict.status === "new"
    )
  if (failed) process.exit(1)
}

if (import.meta.main) {
  await main()
  process.exit(0)
}
