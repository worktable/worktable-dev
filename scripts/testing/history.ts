#!/usr/bin/env bun
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import budgets from "./budgets.json"
import {
  CANONICAL_PORTFOLIO_REVISION,
  comparableRequiredDuration,
  completeBrowserCleanStreak,
  isBroadRequiredHealthPortfolio,
  isCompleteBrowserSample,
  isPassingCompleteBrowserSample,
  isPeakRssWithinBudget,
  partitionPortfolioRevisionSamples,
  type HealthPortfolio,
} from "./health-policy.ts"
import type { LaneResult } from "./report.ts"
import { repositoryRoot, testSuites } from "./suites.ts"

interface Sample {
  directory: string
  revision?: string
  durationMs: number
  peakRssMb: number
  passed: boolean
  complete: boolean
  startedAt: string
}

interface BrowserSample {
  directory: string
  revision?: string
  passed: boolean
  complete: boolean
  startedAt: string
}

async function laneFilesBelow(root: string): Promise<string[]> {
  if (!existsSync(root)) return []
  const files: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...(await laneFilesBelow(path)))
    else if (entry.name.endsWith(".lane.json")) files.push(path)
  }
  return files
}

async function portfoliosBelow(
  root: string
): Promise<Map<string, HealthPortfolio>> {
  if (!existsSync(root)) return new Map()
  const portfolios = new Map<string, HealthPortfolio>()
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.name === "portfolio.json") {
        portfolios.set(
          directory,
          JSON.parse(await readFile(path, "utf8")) as HealthPortfolio
        )
      }
    }
  }
  await visit(root)
  return portfolios
}

function percentile(values: number[], quantile: number): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)]
}

const requested = process.argv[2] ?? "test-results/canonical"
const inputRoot = resolve(repositoryRoot, requested)
const requiredSuiteIds = new Set(
  testSuites
    .filter((suite) => suite.profiles.includes("required"))
    .map((suite) => suite.id)
)
const browserSuiteIds = new Set([
  "web-browser",
  "desktop-browser",
  "cloud-browser",
])
const byDirectory = new Map<string, LaneResult[]>()
const portfolios = await portfoliosBelow(inputRoot)
for (const file of await laneFilesBelow(inputRoot)) {
  if (file.split(/[\\/]/).includes("benchmark")) continue
  const result = JSON.parse(await readFile(file, "utf8")) as LaneResult
  const directory = dirname(file)
  byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), result])
}

const samples: Sample[] = [...byDirectory.entries()]
  .filter(([directory]) =>
    isBroadRequiredHealthPortfolio(portfolios.get(directory))
  )
  .map(([directory, lanes]) => {
    const required = lanes.filter((lane) => requiredSuiteIds.has(lane.suite))
    const portfolio = portfolios.get(directory)
    const starts = required.map((lane) => Date.parse(lane.startedAt))
    const wallStart = starts.length > 0 ? Math.min(...starts) : 0
    const wallEnd =
      required.length > 0
        ? Math.max(
            ...required.map((lane, index) => starts[index]! + lane.durationMs)
          )
        : 0
    return {
      directory,
      revision: portfolio?.revision,
      // A weekly `full` portfolio continues into browser/Desktop work after the
      // required lanes finish. Its portfolio wall time therefore is not a
      // comparable required-CI sample; use the required lane interval instead.
      durationMs: comparableRequiredDuration(
        portfolio,
        Math.max(0, wallEnd - wallStart)
      ),
      peakRssMb: Math.max(
        portfolio?.profile === "required" ? (portfolio.peakRssMb ?? 0) : 0,
        ...required.map((lane) => lane.peakRssMb ?? 0)
      ),
      passed:
        required.length > 0 &&
        required.every((lane) => lane.status === "passed"),
      complete:
        required.length === requiredSuiteIds.size &&
        portfolio?.targeted !== true,
      startedAt:
        required
          .map((lane) => lane.startedAt)
          .sort()
          .at(0) ?? "",
    }
  })
  .filter((sample) => sample.durationMs > 0)
  .sort((left, right) => left.startedAt.localeCompare(right.startedAt))

const browserSamples: BrowserSample[] = [...byDirectory.entries()]
  .map(([directory, lanes]) => {
    const browser = lanes.filter((lane) => browserSuiteIds.has(lane.suite))
    const portfolio = portfolios.get(directory)
    return {
      directory,
      revision: portfolio?.revision,
      passed: isPassingCompleteBrowserSample(
        browser.length,
        browserSuiteIds.size,
        browser.every((lane) => lane.status === "passed")
      ),
      complete: isCompleteBrowserSample(
        browser.length,
        browserSuiteIds.size,
        portfolio
      ),
      startedAt:
        browser
          .map((lane) => lane.startedAt)
          .sort()
          .at(0) ?? "",
    }
  })
  .filter((sample) => sample.startedAt !== "")
  .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
// Selected runs often contain only one browser lane. They are useful flake
// evidence, but are not a "full-browser run" and must not reset or advance the
// observation streak. Count consecutive complete portfolios only.
const currentBrowserSamples = partitionPortfolioRevisionSamples(
  browserSamples,
  CANONICAL_PORTFOLIO_REVISION
).current
const browserCleanStreak = completeBrowserCleanStreak(currentBrowserSamples)
const fullBrowserObservationGateMet =
  browserCleanStreak >= budgets.fullBrowserObservationRunThreshold

const { current: currentSamples, excluded: excludedRevisionSamples } =
  partitionPortfolioRevisionSamples(samples, CANONICAL_PORTFOLIO_REVISION)
const comparable = currentSamples.filter(
  (sample) => sample.complete && sample.passed
)
const durations = comparable.map((sample) => sample.durationMs)
const p50Ms = percentile(durations, 0.5)
const p95Ms = percentile(durations, 0.95)
const failures = currentSamples.filter((sample) => !sample.passed).length
const incomplete = currentSamples.filter((sample) => !sample.complete).length
const peakRssMb = Math.max(0, ...comparable.map((sample) => sample.peakRssMb))
const enoughSamples = comparable.length >= budgets.minimumComparableRuns
const sloPassing =
  !enoughSamples ||
  (p95Ms !== undefined && p95Ms <= budgets.requiredP95SloSeconds * 1000)
const resourcePassing = isPeakRssWithinBudget(
  peakRssMb,
  budgets.maximumPeakRssMb
)

const markdown = `# Required-test health history

- Portfolio revision: ${CANONICAL_PORTFOLIO_REVISION}
- Comparable passing runs: ${comparable.length}/${budgets.minimumComparableRuns} required before enforcement
- Legacy or other revision samples retained but excluded: ${excludedRevisionSamples}
- p50: ${p50Ms === undefined ? "n/a" : `${(p50Ms / 1000).toFixed(1)}s`}
- p95: ${p95Ms === undefined ? "n/a" : `${(p95Ms / 1000).toFixed(1)}s`} (${enoughSamples ? (sloPassing ? "within" : "over") : "advisory against"} ${budgets.requiredP95SloSeconds}s)
- Failed samples with artifacts: ${failures}
- Incomplete samples: ${incomplete}
- Peak measured process-tree RSS: ${peakRssMb === 0 ? "n/a" : `${peakRssMb.toFixed(0)} MB`} (${resourcePassing ? "within" : "over"} ${budgets.maximumPeakRssMb} MB)
- Scheduled full-browser observation gate: ${browserCleanStreak}/${budgets.fullBrowserObservationRunThreshold} consecutive clean complete runs (${fullBrowserObservationGateMet ? "met" : "collecting"})

No retries are inferred as passes. Failed and incomplete portfolios are excluded from timing percentiles and reported separately.
`

const outputRoot = resolve(repositoryRoot, "test-results/canonical")
await mkdir(outputRoot, { recursive: true })
await writeFile(join(outputRoot, "health-history.md"), markdown)
await writeFile(
  join(outputRoot, "health-history.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      portfolioRevision: CANONICAL_PORTFOLIO_REVISION,
      comparableRuns: comparable.length,
      excludedRevisionSamples,
      p50Ms,
      p95Ms,
      failures,
      incomplete,
      peakRssMb,
      enoughSamples,
      sloPassing,
      resourcePassing,
      browserCleanStreak,
      fullBrowserObservationGateMet,
      browserSamples,
      samples,
    },
    null,
    2
  )}\n`
)
console.log(markdown)
if (!sloPassing || !resourcePassing) process.exit(1)
