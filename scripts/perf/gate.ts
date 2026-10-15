#!/usr/bin/env bun
/**
 * Paired timing gate (Plan 17 Speed): the rules of Plan 16's D1 and D4 gates
 * over paired click-trace and io-count timing runs of a base and a head.
 *
 *   bun scripts/perf/gate.ts --results <dir> --base <commit> --head <commit>
 *     [--k 3] [--require clicks:desktop,server] [--confirm <verdict.json>]
 *     [--out <verdict.json>] [--plan <confirm.json>] [--check]
 *
 * Reads every result.json under `--results` (any depth) and sorts it by its
 * `commit` (PERF_COMMIT in the runs) into the base or the head. Each side
 * should have the same number of runs, made on the same machine in
 * alternating order, as perf-gates.sh does.
 *
 * Every change is judged as a ratio and fails only when it exceeds both a
 * floor and `--k` (default 3) standard errors of the change. The standard
 * error comes from the run-to-run spread in these runs, pooled per network
 * and pass (or per server route): phone timings move 15 to 20% between runs,
 * so with few rounds a 10% limit alone flags noise. More rounds shrink it.
 *
 * - **Journeys (D1):** per network, pass and journey, the median time to
 *   content; floor max(10%, 30 ms). Content the head never showed in most
 *   runs is a regression.
 * - **Passes:** per network and pass, the typical journey's change (the
 *   median over journeys); floor 5%. Its noise has a part every journey of a
 *   run shares and a part that averages out, so a slowdown that touches
 *   every screen shows here first.
 * - **Server (D4):** per route, the median over runs of the solo p95 from
 *   io-count's timing run; floor 10%, at least 1 ms under 1 ms.
 *
 * Nightly use is two independent stages: a screen with `--k 2` lists
 * suspects and, with `--plan`, the passes to re-time; a confirmation run
 * re-times only those with more rounds, is judged with `--k 3` on its own
 * data, and `--confirm <first verdict>` keeps only ids both stages found
 * slower. Writes the verdict as JSON (`--out`) and a Markdown report to
 * stdout and the GitHub step summary. `--check` exits 1 when a regression
 * remains. It exits 2 when it cannot judge: no comparable runs, a measure
 * with more runs on one side than the other, or a measure named by
 * `--require` without results. Keys only the head measured (a base too old
 * for them) are listed and not judged.
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
/** A pass's typical journey may slow by this much before its noise counts. */
export const PASS_RATIO = 0.05
/** How many standard errors a change must exceed. */
export const NOISE_K = 3

export interface Comparison {
  /** Opaque, stable id: letters, digits, `_`, `:` and `-` only. */
  id: string
  /** A journey, a whole pass (its typical journey), or a server route. */
  kind: "click" | "pass" | "server"
  label: string
  /** Medians in ms; for a pass, the typical change in percent (head only). */
  base: number | null
  head: number | null
  runs: { base: number; head: number }
  /** The change's standard error, in percent. */
  noise: number
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
  /**
   * Measures one side has more runs of than the other (a run that failed or
   * an artifact that is missing): the verdict does not count.
   */
  incomplete: string[]
  /** Keys only the head measured (a base too old for them); not judged. */
  headOnly: string[]
  /** How many standard errors a change had to exceed. */
  k: number
  /** Set when a --confirm verdict filtered the regressions. */
  confirmedFrom?: string[]
}

/** The measures a run covers: `clicks:<network>` per network, or `server`. */
function measuresOf(item: ClickTraceResult | IoResult): string[] {
  if ("clicks" in item)
    return [...new Set(item.clicks.map((click) => `clicks:${click.network}`))]
  return ["server"]
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

/** One run's values by key (a journey's time to content, a route's p95). */
type Run = Map<string, number | null>

function median0(values: number[]): number {
  return median(values) ?? Number.NaN
}

/** Robust spread (MAD scaled to a normal standard deviation). */
function robustSd(values: number[]): number {
  if (values.length < 2) return Number.NaN
  const center = median0(values)
  return 1.4826 * median0(values.map((value) => Math.abs(value - center)))
}

/**
 * The run-to-run spread of log values, from the differences between every
 * two runs of the same key and side (a difference of two runs has √2 times
 * the spread of one). Pooled over `groups`, each one key's values on one
 * side, so a dozen journeys give a usable estimate from three runs each.
 */
function pooledSpread(groups: number[][]): number {
  const differences: number[] = []
  for (const values of groups)
    for (let i = 0; i < values.length; i += 1)
      for (let j = i + 1; j < values.length; j += 1)
        differences.push(Math.abs(values[i]! - values[j]!))
  if (differences.length < 3) return Number.NaN
  // Absolute differences: their median is 0.6745 √2 sigma for normal noise.
  return median0(differences) / (0.6745 * Math.SQRT2)
}

/** Standard error of a median of n draws with spread sigma (log scale). */
function medianError(sigma: number, n: number): number {
  return 1.2533 * sigma * Math.sqrt(1 / n)
}

/**
 * Compare paired runs. Every change is judged in log space (a ratio), and
 * counts as a regression only when it exceeds both its floor (Plan 16's
 * rules) and `k` standard errors of the change. The standard error comes
 * from the run-to-run spread measured in these runs, pooled per network and
 * pass (or per server route), so a lane that moves 15% between runs needs a
 * proportionally larger change, and more rounds make it more sensitive.
 *
 * Per network and pass, the typical journey (the median over journeys of
 * head/base) is judged as well, against a 5% floor. Its noise has a part
 * every journey of a run shares (the machine's state during that run) and a
 * part that averages out over journeys, so a slowdown that touches every
 * screen shows there well before any single noisy journey can prove it.
 */
export function compare(
  all: unknown[],
  base: string,
  head: string,
  k = NOISE_K
): Verdict {
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
  const tally = (items: (ClickTraceResult | IoResult)[]) => {
    const counts = new Map<string, number>()
    for (const item of items)
      for (const measure of measuresOf(item))
        counts.set(measure, (counts.get(measure) ?? 0) + 1)
    return counts
  }
  const baseRuns = tally([...sides.base.clicks, ...sides.base.io])
  const headRuns = tally([...sides.head.clicks, ...sides.head.io])
  const incomplete = [...new Set([...baseRuns.keys(), ...headRuns.keys()])]
    .filter((measure) => baseRuns.get(measure) !== headRuns.get(measure))
    .map(
      (measure) =>
        `${measure}: ${baseRuns.get(measure) ?? 0} base runs, ${headRuns.get(measure) ?? 0} head runs`
    )
  const headOnly: string[] = []

  const labels = new Map<string, string>()
  // One run per result and round (a result can hold several rounds). The
  // churn and backup passes measure other things and are not timed here.
  const clickRuns = (runs: ClickTraceResult[]): Run[] =>
    runs.flatMap((run) => {
      const rounds = new Map<number, Run>()
      for (const click of run.clicks) {
        if (click.pass === "churn" || click.pass === "backup") continue
        const key = `${click.network}:${click.pass}:${slug(click.journey)}`
        labels.set(key, `${click.network}, ${click.pass}, ${click.journey}`)
        const values = rounds.get(click.round) ?? new Map()
        values.set(key, click.contentMs)
        rounds.set(click.round, values)
      }
      return [...rounds.values()]
    })
  const serverRuns = (runs: IoResult[]): Run[] =>
    runs.map(
      (run) =>
        new Map(
          (run.timing?.timings ?? [])
            .filter((row) => row.role === "solo")
            .map((row) => [row.endpoint, row.p95] as const)
        )
    )

  // Every key measured on one side must be on the other, in as many runs;
  // a key only the head has is noted (the base predates it), not judged.
  const pairKeys = (kind: string, left: Run[], right: Run[]) => {
    const coverage = (runs: Run[]) => {
      const counts = new Map<string, number>()
      for (const run of runs)
        for (const key of run.keys())
          counts.set(key, (counts.get(key) ?? 0) + 1)
      return counts
    }
    const leftKeys = coverage(left)
    const rightKeys = coverage(right)
    const keys: string[] = []
    for (const key of new Set([...leftKeys.keys(), ...rightKeys.keys()])) {
      const l = leftKeys.get(key) ?? 0
      const r = rightKeys.get(key) ?? 0
      if (l === 0 && r === right.length) headOnly.push(`${kind} ${key}`)
      else if (l !== r)
        incomplete.push(`${kind} ${key}: ${l} base runs, ${r} head runs`)
      else keys.push(key)
    }
    return keys
  }
  // Log values of a key's runs. A click whose content never appeared counts
  // as slower than any that did (Infinity), so it ranks in the median; the
  // spread is estimated from finite values only.
  const logs = (runs: Run[], key: string) =>
    runs
      .filter((run) => run.has(key))
      .map((run) => run.get(key))
      .map((value) =>
        typeof value === "number" && value > 0 ? Math.log(value) : Infinity
      )
  const finite = (values: number[]) => values.filter(Number.isFinite)

  // Clicks, grouped by network and pass for their noise.
  const baseClicks = clickRuns(sides.base.clicks)
  const headClicks = clickRuns(sides.head.clicks)
  const groups = new Map<string, string[]>()
  for (const key of pairKeys("click", baseClicks, headClicks)) {
    const group = key.split(":").slice(0, 2).join(":")
    groups.set(group, [...(groups.get(group) ?? []), key])
  }
  for (const [group, groupKeys] of groups) {
    const keys: string[] = []
    for (const key of groupKeys) {
      if (finite(logs(baseClicks, key)).length === 0)
        incomplete.push(`click ${key}: the base never showed its content`)
      else keys.push(key)
    }
    if (keys.length === 0) continue
    const sigma = pooledSpread(
      keys.flatMap((key) => [
        finite(logs(baseClicks, key)),
        finite(logs(headClicks, key)),
      ])
    )
    // The shared part: each run's median residual over its journeys.
    const runEffects = (runs: Run[]) =>
      runs
        .filter((run) => keys.some((key) => run.has(key)))
        .map((run) =>
          median0(
            keys.flatMap((key) => {
              const value = run.get(key)
              if (typeof value !== "number" || value <= 0) return []
              const others = finite(logs(runs, key))
              return [Math.log(value) - median0(others)]
            })
          )
        )
        .filter(Number.isFinite)
    // A run effect still carries each journey's own noise (a median of J
    // journeys keeps about pi/2 sigma^2/J of it); take that out.
    const effectSpread =
      pooledSpread([runEffects(baseClicks), runEffects(headClicks)]) || 0
    const sigmaRun = Math.sqrt(
      Math.min(
        sigma ** 2,
        Math.max(
          0,
          effectSpread ** 2 - ((Math.PI / 2) * sigma ** 2) / keys.length
        )
      )
    )
    const changes: number[] = []
    let nBase = 0
    let nHead = 0
    for (const key of keys) {
      const baseLogs = logs(baseClicks, key)
      const headLogs = logs(headClicks, key)
      if (!Number.isFinite(median0(baseLogs))) {
        incomplete.push(
          `click ${key}: the base mostly never showed its content`
        )
        continue
      }
      nBase = baseLogs.length
      nHead = headLogs.length
      // A timeout ranks as the slowest run; if it reaches the median (the
      // head mostly never showed content) that alone is a regression.
      const baseMedian = Math.exp(median0(finite(baseLogs)))
      const headCenter = median0(headLogs)
      const headLost = !Number.isFinite(headCenter)
      const change = headCenter - median0(baseLogs)
      const error =
        Math.sqrt(
          medianError(sigma, baseLogs.length) ** 2 +
            medianError(sigma, headLogs.length) ** 2
        ) || 0
      const floor = Math.log(1 + clickLimit(baseMedian) / baseMedian)
      const limit = Math.max(floor, k * error)
      if (!headLost) changes.push(change)
      comparisons.push({
        id: `click:${key}`,
        kind: "click",
        label: labels.get(key) ?? key,
        base: round(baseMedian, 1),
        head: headLost ? null : round(Math.exp(headCenter), 1),
        runs: { base: baseLogs.length, head: headLogs.length },
        noise: round(error * 100, 1)!,
        limit: round(baseMedian * (Math.exp(limit) - 1), 1),
        regressed: headLost || change > limit,
      })
    }
    if (changes.length < 3) continue
    const [network, pass] = group.split(":")
    const typical = median0(changes)
    const scale = Math.sqrt(1 / Math.max(1, nBase) + 1 / Math.max(1, nHead))
    const shared = sigmaRun ** 2
    const own = Math.max(0, sigma ** 2 - shared) / changes.length
    const error = 1.2533 * scale * Math.sqrt(shared + own) || 0
    const limit = Math.max(Math.log(1 + PASS_RATIO), k * error)
    const percent = (value: number) => round((Math.exp(value) - 1) * 100, 1)
    comparisons.push({
      id: `pass:${group}`,
      kind: "pass",
      label: `${network}, ${pass}, typical journey (%)`,
      base: 0,
      head: percent(typical),
      runs: { base: nBase, head: nHead },
      noise: round(error * 100, 1)!,
      limit: percent(limit),
      regressed: typical > limit,
    })
  }

  // Server: the solo p95 per route, median over runs; each route's own
  // spread, since a 1 ms route and a 30 ms one move differently.
  const baseServer = serverRuns(sides.base.io)
  const headServer = serverRuns(sides.head.io)
  for (const endpoint of pairKeys("server", baseServer, headServer)) {
    const baseLogs = logs(baseServer, endpoint)
    const headLogs = logs(headServer, endpoint)
    if (baseLogs.length === 0 || headLogs.length === 0) continue
    const sigma = pooledSpread([baseLogs, headLogs])
    const error =
      Math.sqrt(
        medianError(sigma, baseLogs.length) ** 2 +
          medianError(sigma, headLogs.length) ** 2
      ) || 0
    const baseMedian = Math.exp(median0(baseLogs))
    const headMedian = Math.exp(median0(headLogs))
    const floor = Math.log(1 + serverLimit(baseMedian) / baseMedian)
    const limit = Math.max(floor, k * error)
    comparisons.push({
      id: `server:p95:${slug(endpoint)}`,
      kind: "server",
      label: `server p95, ${endpoint}`,
      base: round(baseMedian, 2),
      head: round(headMedian, 2),
      runs: { base: baseLogs.length, head: headLogs.length },
      noise: round(error * 100, 1)!,
      limit: round(baseMedian * (Math.exp(limit) - 1), 2),
      regressed: Math.log(headMedian / baseMedian) > limit,
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
    incomplete,
    headOnly,
    k,
  }
}

/**
 * What a confirmation run should re-time: per network, the passes with
 * suspects (and the first visits that warm, revisit and reopen build on),
 * and the server routes as one measure.
 */
export function confirmationPlan(
  verdict: Verdict
): { network: string; passes: string }[] {
  const passes = new Map<string, Set<string>>()
  for (const item of verdict.regressions) {
    const [kind, network, pass] = item.id.split(":")
    if (kind === "server") passes.set("server", new Set())
    else {
      const set = passes.get(network!) ?? new Set<string>()
      set.add(pass!)
      if (pass !== "cold" && pass !== "first") set.add("first")
      passes.set(network!, set)
    }
  }
  // Churn and backup passes are never timed by compare().
  const order = ["cold", "first", "warm", "revisit", "reopen", "idle"]
  return [...passes].map(([network, set]) => ({
    network,
    passes: order.filter((pass) => set.has(pass)).join(","),
  }))
}

/**
 * Two independent tests of the same thing: a confirmation run re-times only
 * the measures (network and pass, or the server) where the first run found
 * suspects, with more rounds, and is judged on its own data. A regression
 * counts only for a journey, pass or route that both runs found slower.
 */
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
    `Base \`${verdict.base.slice(0, 12)}\` (${verdict.runs.base.clicks} click runs, ${verdict.runs.base.io} server runs) against head \`${verdict.head.slice(0, 12)}\` (${verdict.runs.head.clicks}, ${verdict.runs.head.io}). A change fails when it exceeds both its floor and ${verdict.k} times its noise (the standard error of the change, from the run-to-run spread in these runs). Floors: a journey's median time to content max(10%, 30 ms); a pass's typical journey ${PASS_RATIO * 100}%; a route's median p95 10%, at least 1 ms under 1 ms.`,
    "",
  ]
  if (verdict.confirmedFrom)
    lines.push(
      `Confirmation run: it re-timed only the measures with suspects in the first run (${verdict.confirmedFrom.length} suspects), judged its own data, and counts a regression only where both runs found one.`,
      ""
    )
  if (verdict.incomplete.length)
    lines.push(
      `**Incomplete:** the sides do not pair (${verdict.incomplete.join("; ")}). This verdict does not count.`,
      ""
    )
  if (verdict.headOnly.length)
    lines.push(
      `Only the head measured ${verdict.headOnly.join("; ")}; the base predates them, so they are not judged.`,
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
        ["Measure", "Base", "Head", "Change", "Noise", "Limit"],
        verdict.regressions.map((item) => [
          item.label,
          item.base,
          item.head ?? "no content",
          item.head === null || item.base === null
            ? null
            : `+${round(item.head - item.base, 1)}`,
          item.noise,
          `+${item.limit}`,
        ])
      ),
      ""
    )
  lines.push(
    "<details><summary>All comparisons</summary>",
    "",
    markdownTable(
      ["Measure", "Base", "Head", "Change", "Noise", "Limit", "Runs"],
      verdict.comparisons.map((item) => [
        `${item.regressed ? "**" : ""}${item.label}${item.regressed ? "**" : ""}`,
        item.base,
        item.head ?? "no content",
        item.head === null || item.base === null
          ? null
          : round(item.head - item.base, 1),
        item.noise,
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
  const k = args.has("k") ? Number(args.get("k")) : NOISE_K
  if (!(k > 0)) throw new Error("--k must be a positive number")
  let verdict = compare(results(dir), base, head, k)
  const earlier = args.get("confirm")
  if (earlier)
    verdict = confirm(
      verdict,
      JSON.parse(readFileSync(earlier, "utf8")) as Verdict
    )
  const out = args.get("out")
  if (out) writeFileSync(out, JSON.stringify(verdict, null, 2))
  const plan = args.get("plan")
  if (plan) writeFileSync(plan, JSON.stringify(confirmationPlan(verdict)))
  const text = report(verdict)
  console.log(text)
  const summary = process.env["GITHUB_STEP_SUMMARY"]
  if (summary) appendFileSync(summary, `${text}\n`)
  const required = args.get("require")?.split(",") ?? []
  const present = new Set(
    verdict.comparisons.map((item) =>
      item.kind === "server" ? "server" : `clicks:${item.id.split(":")[1]}`
    )
  )
  const absent = required.filter((measure) => !present.has(measure))
  if (
    verdict.comparisons.length === 0 ||
    verdict.incomplete.length > 0 ||
    absent.length > 0
  ) {
    console.error(
      `[gate] cannot judge: ${[
        ...(verdict.comparisons.length ? [] : ["no comparable runs"]),
        ...verdict.incomplete,
        ...absent.map((measure) => `no ${measure} results`),
      ].join("; ")}`
    )
    process.exit(2)
  }
  if (args.has("check") && verdict.regressions.length > 0) process.exit(1)
}

if (import.meta.main) {
  await main()
  process.exit(0)
}
