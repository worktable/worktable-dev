#!/usr/bin/env bun
/**
 * Paired timing gate (Plan 17 Speed): the rules of Plan 16's D1 and D4 gates
 * over paired click-trace and io-count timing runs of a base and a head.
 *
 *   bun scripts/perf/gate.ts --results <dir> --base <commit> --head <commit>
 *     [--confirm <verdict.json>] [--out <verdict.json>] [--check]
 *
 * Reads every result.json under `--results` (any depth) and sorts it by its
 * `commit` (PERF_COMMIT in the runs) into the base or the head. Each side
 * should have the same number of runs, made on the same machine in
 * alternating order, as perf-gates.sh does.
 *
 * - **Clicks (D1):** per network, pass and journey, the median time to
 *   content over the side's runs. A regression is a head median more than
 *   max(10%, 30 ms) above the base's, or content the head never showed.
 * - **Server (D4):** per endpoint, the median over runs of the solo p95 from
 *   io-count's timing run. A regression is a head p95 more than 10% above
 *   the base's, and more than 1 ms above it for routes under 1 ms.
 *
 * `--confirm` takes an earlier verdict and keeps only regressions it also
 * found: timings vary 15 to 17% between rounds, so a regression must repeat
 * in a second paired run before anyone is alerted. Writes the verdict as JSON
 * (`--out`) and a Markdown report to stdout and the GitHub step summary.
 * `--check` exits 1 when a regression remains.
 */
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import type { ClickTraceResult } from "./click-trace.ts"
import { markdownTable, median, parseArgs, round } from "./lib.ts"

export const CLICK_RATIO = 0.1
export const CLICK_FLOOR_MS = 30
export const SERVER_RATIO = 0.1
export const SERVER_FLOOR_MS = 1

export interface Comparison {
  /** Opaque, stable id: letters, digits, `_`, `:` and `-` only. */
  id: string
  kind: "click" | "server"
  label: string
  base: number | null
  head: number | null
  runs: { base: number; head: number }
  limit: number | null
  regressed: boolean
}

export interface Verdict {
  base: string
  head: string
  runs: {
    base: { clicks: number; io: number }
    head: { clicks: number; io: number }
  }
  comparisons: Comparison[]
  regressions: Comparison[]
  /** Set when a --confirm verdict filtered the regressions. */
  confirmedFrom?: string[]
}

interface IoResult {
  commit: string
  timing?: { timings: { role: string; endpoint: string; p95: number }[] }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
}

function results(dir: string): unknown[] {
  const found: unknown[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) found.push(...results(path))
    else if (name === "result.json")
      found.push(JSON.parse(readFileSync(path, "utf8")))
  }
  return found
}

function sameCommit(left: string, right: string): boolean {
  return (
    left.length > 0 &&
    right.length > 0 &&
    (left.startsWith(right) || right.startsWith(left))
  )
}

export function clickLimit(base: number): number {
  return Math.max(base * CLICK_RATIO, CLICK_FLOOR_MS)
}

export function serverLimit(base: number): number {
  return base < 1
    ? Math.max(base * SERVER_RATIO, SERVER_FLOOR_MS)
    : base * SERVER_RATIO
}

export function compare(all: unknown[], base: string, head: string): Verdict {
  const clicks = all.filter(
    (item): item is ClickTraceResult =>
      typeof item === "object" && item !== null && "clicks" in item
  )
  const io = all.filter(
    (item): item is IoResult =>
      typeof item === "object" &&
      item !== null &&
      "timing" in item &&
      Boolean((item as IoResult).timing)
  )
  const side = <T extends { commit: string }>(items: T[], commit: string) =>
    items.filter((item) => sameCommit(item.commit, commit))
  const sides = {
    base: { clicks: side(clicks, base), io: side(io, base) },
    head: { clicks: side(clicks, head), io: side(io, head) },
  }
  const comparisons: Comparison[] = []

  // Clicks: one content time per run and key; a run is one round.
  const clickValues = (runs: ClickTraceResult[]) => {
    const values = new Map<
      string,
      { label: string; times: (number | null)[] }
    >()
    for (const run of runs)
      for (const click of run.clicks) {
        const key = `${click.network}:${click.pass}:${slug(click.journey)}`
        const entry = values.get(key) ?? {
          label: `${click.network}, ${click.pass}, ${click.journey}`,
          times: [],
        }
        entry.times.push(click.contentMs)
        values.set(key, entry)
      }
    return values
  }
  const baseClicks = clickValues(sides.base.clicks)
  const headClicks = clickValues(sides.head.clicks)
  for (const [key, headEntry] of headClicks) {
    const baseEntry = baseClicks.get(key)
    if (!baseEntry) continue
    const present = (times: (number | null)[]) =>
      times.filter((time): time is number => time !== null)
    const baseMedian = median(present(baseEntry.times))
    const headMissing = headEntry.times.some((time) => time === null)
    const headMedian = median(present(headEntry.times))
    const limit = baseMedian === null ? null : round(clickLimit(baseMedian), 1)
    const regressed =
      baseMedian !== null &&
      (headMissing ||
        (headMedian !== null &&
          headMedian - baseMedian > clickLimit(baseMedian)))
    comparisons.push({
      id: `click:${key}`,
      kind: "click",
      label: headEntry.label,
      base: baseMedian === null ? null : round(baseMedian, 1),
      head: headMissing
        ? null
        : headMedian === null
          ? null
          : round(headMedian, 1),
      runs: { base: baseEntry.times.length, head: headEntry.times.length },
      limit,
      regressed,
    })
  }

  // Server: the solo p95 per endpoint, median over runs.
  const serverValues = (runs: IoResult[]) => {
    const values = new Map<string, number[]>()
    for (const run of runs)
      for (const row of run.timing?.timings ?? []) {
        if (row.role !== "solo") continue
        values.set(row.endpoint, [...(values.get(row.endpoint) ?? []), row.p95])
      }
    return values
  }
  const baseServer = serverValues(sides.base.io)
  const headServer = serverValues(sides.head.io)
  for (const [endpoint, headTimes] of headServer) {
    const baseTimes = baseServer.get(endpoint)
    if (!baseTimes) continue
    const baseMedian = median(baseTimes)!
    const headMedian = median(headTimes)!
    comparisons.push({
      id: `server:p95:${slug(endpoint)}`,
      kind: "server",
      label: `server p95, ${endpoint}`,
      base: round(baseMedian, 2),
      head: round(headMedian, 2),
      runs: { base: baseTimes.length, head: headTimes.length },
      limit: round(serverLimit(baseMedian), 2),
      regressed: headMedian - baseMedian > serverLimit(baseMedian),
    })
  }
  return {
    base,
    head,
    runs: {
      base: { clicks: sides.base.clicks.length, io: sides.base.io.length },
      head: { clicks: sides.head.clicks.length, io: sides.head.io.length },
    },
    comparisons,
    regressions: comparisons.filter((item) => item.regressed),
  }
}

/** Keep the regressions an earlier paired run also found. */
export function confirm(verdict: Verdict, earlier: Verdict): Verdict {
  const before = new Set(earlier.regressions.map((item) => item.id))
  return {
    ...verdict,
    regressions: verdict.regressions.filter((item) => before.has(item.id)),
    confirmedFrom: [...before],
  }
}

export function report(verdict: Verdict): string {
  const lines = [
    "## Paired speed gate",
    "",
    `Base \`${verdict.base.slice(0, 12)}\` (${verdict.runs.base.clicks} click runs, ${verdict.runs.base.io} server runs) against head \`${verdict.head.slice(0, 12)}\` (${verdict.runs.head.clicks}, ${verdict.runs.head.io}). Clicks: median time to content, limit max(10%, 30 ms). Server: median solo p95, limit 10%, at least 1 ms under 1 ms.`,
    "",
  ]
  if (verdict.confirmedFrom)
    lines.push(
      `Confirmation run: a regression counts only if the first run found it too (${verdict.confirmedFrom.length} did).`,
      ""
    )
  if (verdict.comparisons.length === 0)
    lines.push("**Nothing to compare:** no runs matched both commits.", "")
  else if (verdict.regressions.length === 0)
    lines.push(
      `No regressions in ${verdict.comparisons.length} comparisons.`,
      ""
    )
  else
    lines.push(
      `### ${verdict.regressions.length} regressions`,
      "",
      markdownTable(
        ["Measure", "Base ms", "Head ms", "Change", "Limit"],
        verdict.regressions.map((item) => [
          item.label,
          item.base,
          item.head ?? "no content",
          item.head === null || item.base === null
            ? null
            : `+${round(item.head - item.base, 1)}`,
          `+${item.limit}`,
        ])
      ),
      ""
    )
  lines.push(
    "<details><summary>All comparisons</summary>",
    "",
    markdownTable(
      ["Measure", "Base ms", "Head ms", "Change", "Limit", "Runs"],
      verdict.comparisons.map((item) => [
        `${item.regressed ? "**" : ""}${item.label}${item.regressed ? "**" : ""}`,
        item.base,
        item.head ?? "no content",
        item.head === null || item.base === null
          ? null
          : round(item.head - item.base, 1),
        item.limit,
        `${item.runs.base}/${item.runs.head}`,
      ])
    ),
    "",
    "</details>",
    ""
  )
  return lines.join("\n")
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dir = args.get("results")
  const base = args.get("base")
  const head = args.get("head")
  if (!dir || !base || !head)
    throw new Error(
      "usage: gate.ts --results <dir> --base <commit> --head <commit>"
    )
  let verdict = compare(results(dir), base, head)
  const earlier = args.get("confirm")
  if (earlier)
    verdict = confirm(
      verdict,
      JSON.parse(readFileSync(earlier, "utf8")) as Verdict
    )
  const out = args.get("out")
  if (out) writeFileSync(out, JSON.stringify(verdict, null, 2))
  const text = report(verdict)
  console.log(text)
  const summary = process.env["GITHUB_STEP_SUMMARY"]
  if (summary) appendFileSync(summary, `${text}\n`)
  if (verdict.comparisons.length === 0) {
    console.error("[gate] no comparable runs")
    process.exit(2)
  }
  if (args.has("check") && verdict.regressions.length > 0) process.exit(1)
}

if (import.meta.main) {
  await main()
  process.exit(0)
}
