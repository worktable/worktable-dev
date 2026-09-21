#!/usr/bin/env bun
import { existsSync } from "node:fs"
import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import budgets from "./budgets.json"
import { repositoryRoot } from "./suites.ts"

export interface LaneResult {
  suite: string
  title: string
  profile: string
  classification: string
  status: "passed" | "failed" | "timed-out" | "cancelled"
  durationMs: number
  peakRssMb?: number
  files: number
  command: string
  startedAt: string
}

interface JunitTotals {
  tests: number
  failures: number
  errors: number
  skipped: number
  timeSeconds: number
}

interface RustTiming {
  file: string
  phases: Array<{
    phase: string
    durationMs: number
    exitCode: number
  }>
}

interface PortfolioResult {
  revision?: string
  profile: string
  schedule: string
  status: "passed" | "failed"
  durationMs: number
  peakRssMb?: number
  targeted?: boolean
  selectedSuites?: string[]
  startedAt: string
}

function attribute(source: string, name: string): number {
  const value = source.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1]
  return value === undefined ? 0 : Number(value)
}

function textAttribute(source: string, name: string): string | undefined {
  return source.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1]
}

function junitFileTimes(xml: string): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const match of xml.matchAll(/<testcase\b([^>]*)>/g)) {
    const attributes = match[1] ?? ""
    const file =
      textAttribute(attributes, "file") ??
      textAttribute(attributes, "classname") ??
      "unknown"
    totals[file] = (totals[file] ?? 0) + attribute(attributes, "time")
  }
  return totals
}

function junitTotals(xml: string): JunitTotals {
  const root =
    xml.match(/<testsuites\b([^>]*)>/)?.[1] ??
    xml.match(/<testsuite\b([^>]*)>/)?.[1] ??
    ""
  return {
    tests: attribute(root, "tests"),
    failures: attribute(root, "failures"),
    errors: attribute(root, "errors"),
    skipped: attribute(root, "skipped"),
    timeSeconds: attribute(root, "time"),
  }
}

export async function writeLaneResult(
  directory: string,
  result: LaneResult
): Promise<void> {
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, `${result.suite}.lane.json`),
    `${JSON.stringify(result, null, 2)}\n`
  )
}

export async function aggregateResults(
  directory: string,
  options: { githubSummary?: boolean } = {}
): Promise<string> {
  await mkdir(directory, { recursive: true })
  const entries = await readdir(directory)
  const laneFiles = entries.filter((entry) => entry.endsWith(".lane.json"))
  const junitFiles = entries.filter((entry) => entry.endsWith(".junit.xml"))
  const goFiles = entries.filter((entry) => entry.endsWith(".go.json"))
  const rustFiles = entries.filter((entry) => entry.endsWith(".rust.json"))
  const portfolio = existsSync(join(directory, "portfolio.json"))
    ? (JSON.parse(
        await readFile(join(directory, "portfolio.json"), "utf8")
      ) as PortfolioResult)
    : undefined
  const lanes = (await Promise.all(
    laneFiles.map(async (entry) =>
      JSON.parse(await readFile(join(directory, entry), "utf8"))
    )
  )) as LaneResult[]
  const junit = await Promise.all(
    junitFiles.map(async (entry) => {
      const xml = await readFile(join(directory, entry), "utf8")
      return {
        file: entry,
        ...junitTotals(xml),
        fileTimes: junitFileTimes(xml),
      }
    })
  )
  const go = await Promise.all(
    goFiles.map(async (entry) => {
      const events = (await readFile(join(directory, entry), "utf8"))
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as { Action?: string; Test?: string }]
          } catch {
            return []
          }
        })
      return {
        file: entry,
        passed: events.filter((event) => event.Test && event.Action === "pass")
          .length,
        failed: events.filter((event) => event.Test && event.Action === "fail")
          .length,
        skipped: events.filter((event) => event.Test && event.Action === "skip")
          .length,
      }
    })
  )
  const rust = (await Promise.all(
    rustFiles.map(async (entry) => ({
      file: entry,
      ...JSON.parse(await readFile(join(directory, entry), "utf8")),
    }))
  )) as RustTiming[]
  const totalDurationMs = lanes.reduce((sum, lane) => sum + lane.durationMs, 0)
  const summary = [
    "## Canonical test health",
    "",
    "| Lane | Result | Duration | Peak RSS | Files |",
    "| --- | --- | ---: | ---: | ---: |",
    ...lanes
      .sort((left, right) => right.durationMs - left.durationMs)
      .map(
        (lane) =>
          `| ${lane.title} | ${lane.status} | ${(lane.durationMs / 1000).toFixed(1)}s | ${
            lane.peakRssMb === undefined
              ? "n/a"
              : `${lane.peakRssMb.toFixed(0)} MB`
          } | ${lane.files} |`
      ),
    "",
    `Total lane time: ${(totalDurationMs / 1000).toFixed(1)}s.`,
    ...(portfolio
      ? [
          `Portfolio wall time: ${(portfolio.durationMs / 1000).toFixed(1)}s (${portfolio.schedule}).`,
        ]
      : []),
    "",
  ]
  if (junit.length > 0) {
    const totals = junit.reduce<JunitTotals>(
      (sum, item) => ({
        tests: sum.tests + item.tests,
        failures: sum.failures + item.failures,
        errors: sum.errors + item.errors,
        skipped: sum.skipped + item.skipped,
        timeSeconds: sum.timeSeconds + item.timeSeconds,
      }),
      { tests: 0, failures: 0, errors: 0, skipped: 0, timeSeconds: 0 }
    )
    summary.push(
      `JUnit: ${totals.tests} tests, ${totals.failures + totals.errors} failures/errors, ${totals.skipped} skipped.`,
      ""
    )
    const requiredSuiteIds = new Set(
      lanes
        .filter((lane) => lane.profile === "required")
        .map((lane) => lane.suite)
    )
    const fileTimes = junit
      .flatMap((item) =>
        Object.entries(item.fileTimes).map(([file, timeSeconds]) => ({
          suite: item.file.replace(".junit.xml", ""),
          file,
          timeSeconds,
        }))
      )
      .filter(
        (item) =>
          requiredSuiteIds.size === 0 || requiredSuiteIds.has(item.suite)
      )
    const measuredSeconds = fileTimes.reduce(
      (sum, item) => sum + item.timeSeconds,
      0
    )
    const slowest = fileTimes.sort(
      (left, right) => right.timeSeconds - left.timeSeconds
    )[0]
    if (
      portfolio?.targeted !== true &&
      requiredSuiteIds.size > 0 &&
      slowest &&
      measuredSeconds > 0 &&
      fileTimes.length > 1
    ) {
      const concentration = slowest.timeSeconds / measuredSeconds
      summary.push(
        `Slowest measured file: \`${slowest.file}\` at ${slowest.timeSeconds.toFixed(1)}s (${(concentration * 100).toFixed(1)}% of JUnit case time).`,
        concentration > budgets.maximumLaneConcentration
          ? `Advisory: file concentration exceeds ${(budgets.maximumLaneConcentration * 100).toFixed(0)}%.`
          : "File concentration is within the advisory budget.",
        ""
      )
    }
    const durationWarnings = fileTimes.filter((item) => {
      const lane = lanes.find((candidate) => candidate.suite === item.suite)
      if (!lane) return false
      return (
        item.timeSeconds >
        budgets.durationWarningsSeconds[
          lane.classification as keyof typeof budgets.durationWarningsSeconds
        ]
      )
    })
    if (durationWarnings.length > 0) {
      summary.push(
        `Advisory duration warnings: ${durationWarnings
          .slice(0, 10)
          .map((item) => `\`${item.file}\` ${item.timeSeconds.toFixed(1)}s`)
          .join(", ")}.`,
        ""
      )
    }
  }
  if (go.length > 0) {
    summary.push(
      `Go: ${go.reduce((sum, result) => sum + result.passed, 0)} passed, ${go.reduce((sum, result) => sum + result.failed, 0)} failed, ${go.reduce((sum, result) => sum + result.skipped, 0)} skipped.`,
      ""
    )
  }
  if (rust.length > 0) {
    summary.push(
      "Rust/Desktop phase timing:",
      ...rust.flatMap((result) =>
        result.phases.map(
          (phase) =>
            `- ${phase.phase}: ${(phase.durationMs / 1000).toFixed(1)}s (${phase.exitCode === 0 ? "passed" : `exit ${phase.exitCode}`})`
        )
      ),
      ""
    )
  }
  const peakRssMb = Math.max(
    portfolio?.peakRssMb ?? 0,
    ...lanes.map((lane) => lane.peakRssMb ?? 0)
  )
  if (peakRssMb > 0) {
    summary.push(
      `Peak measured process-tree RSS: ${peakRssMb.toFixed(0)} MB (${peakRssMb <= budgets.maximumPeakRssMb ? "within" : "over"} the ${budgets.maximumPeakRssMb} MB budget).`,
      ""
    )
  }
  if (lanes.some((lane) => lane.profile === "required")) {
    summary.push(
      `Required-lane p95 SLO remains advisory until ${budgets.minimumComparableRuns} comparable CI runs are collected; this artifact is one sample.`,
      ""
    )
  }
  const markdown = `${summary.join("\n")}\n`
  await writeFile(join(directory, "summary.md"), markdown)
  await writeFile(
    join(directory, "summary.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        portfolio,
        lanes,
        junit,
        go,
        rust,
      },
      null,
      2
    )}\n`
  )
  const githubSummary = process.env["GITHUB_STEP_SUMMARY"]
  if (
    options.githubSummary !== false &&
    githubSummary &&
    existsSync(resolve(githubSummary))
  ) {
    await appendFile(githubSummary, markdown)
  }
  return markdown
}

if (import.meta.main) {
  const requested = process.argv[2] ?? "test-results/canonical"
  const directory = resolve(repositoryRoot, requested)
  const markdown = await aggregateResults(directory)
  console.log(
    `${basename(directory)}: ${markdown.split("\n")[2] ?? "no results"}`
  )
}
