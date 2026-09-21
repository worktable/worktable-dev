#!/usr/bin/env bun
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import budgets from "./budgets.json"
import {
  processTreeIsAlive,
  signalProcessTree,
  waitForProcessTreeExit,
} from "./process-tree.ts"
import { aggregateResults, writeLaneResult, type LaneResult } from "./report.ts"
import { CANONICAL_PORTFOLIO_REVISION } from "./health-policy.ts"
import {
  bunTestArguments,
  canonicalResultDirectory,
  isTargetedSelection,
  selectedTestFiles,
  unmatchedTestFilters,
  vitestArguments,
} from "./run-policy.ts"
import {
  ownedTestFiles,
  pathFromSuiteCwd,
  repositoryRoot,
  suitesForProfile,
  type TestProfile,
  type TestSuite,
} from "./suites.ts"

interface Options {
  profile: TestProfile
  base?: string
  files: string[]
  testFiles: string[]
  testPathPrefixes: string[]
  suites: string[]
  repeat: number
}

interface Command {
  executable: string
  args: string[]
  cwd: string
  env?: Record<string, string>
  captureStdout?: string
}

function parseArgs(argv: string[]): Options {
  const profile = (argv.shift() ?? "required") as TestProfile
  if (!["required", "changed", "full", "stability", "host"].includes(profile)) {
    throw new Error(`Unknown test profile: ${profile}`)
  }
  const options: Options = {
    profile,
    files: [],
    testFiles: [],
    testPathPrefixes: [],
    suites: [],
    repeat: profile === "stability" ? 10 : 1,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    const value = argv[index + 1]
    if (arg === "--base" && value) {
      options.base = value
      index += 1
    } else if (arg === "--file" && value) {
      options.files.push(value)
      index += 1
    } else if (arg === "--suite" && value) {
      options.suites.push(value)
      index += 1
    } else if (arg === "--test-file" && value) {
      options.testFiles.push(value)
      index += 1
    } else if (arg === "--test-path-prefix" && value) {
      options.testPathPrefixes.push(value)
      index += 1
    } else if (arg === "--repeat" && value) {
      options.repeat = Number(value)
      index += 1
    } else {
      throw new Error(`Unknown or incomplete option: ${arg}`)
    }
  }
  return options
}

function gitValue(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return undefined
  }
}

function gitLines(args: string[]): string[] {
  const output = execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  })
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

function changedFiles(options: Options): string[] {
  if (options.files.length > 0) return [...new Set(options.files)].sort()
  const files = new Set<string>()
  const candidates = [
    options.base,
    process.env["GITHUB_BASE_REF"]
      ? `origin/${process.env["GITHUB_BASE_REF"]}`
      : undefined,
    gitValue([
      "symbolic-ref",
      "--quiet",
      "--short",
      "refs/remotes/origin/HEAD",
    ]),
    "origin/main",
    "main",
  ].filter((value): value is string => Boolean(value))
  let base: string | undefined
  for (const candidate of candidates) {
    if (!gitValue(["rev-parse", "--verify", "--quiet", candidate])) continue
    base = gitValue(["merge-base", candidate, "HEAD"])
    if (base) break
  }
  if (base) {
    for (const path of gitLines([
      "diff",
      "--name-only",
      "--no-renames",
      `${base}...HEAD`,
    ])) {
      files.add(path)
    }
  }
  for (const path of gitLines(["diff", "--name-only", "--no-renames", "HEAD"]))
    files.add(path)
  for (const path of gitLines(["ls-files", "--others", "--exclude-standard"])) {
    files.add(path)
  }
  return [...files].sort()
}

function commandForSuite(
  suite: TestSuite,
  files: string[],
  resultDirectory: string,
  options: Options
): Command {
  const cwd = resolve(repositoryRoot, suite.cwd ?? ".")
  const junit = join(resultDirectory, `${suite.id}.junit.xml`)
  const owned = files.map((path) => pathFromSuiteCwd(suite, path))
  if (suite.runner === "bun") {
    const config =
      suite.cwd === "packages/server"
        ? "bunfig.toml"
        : resolve(repositoryRoot, "scripts/testing/bunfig.standard.toml")
    const args = bunTestArguments({
      config,
      files: owned,
      junit,
      stabilityRepeat:
        options.profile === "stability" ? options.repeat : undefined,
    })
    return { executable: "bun", args, cwd }
  }
  if (suite.runner === "vitest") {
    const args = vitestArguments({
      files: owned,
      junit,
      config: suite.id === "gateway-worker" ? "vitest.config.ts" : undefined,
    })
    return { executable: "bun", args, cwd }
  }
  if (suite.runner === "playwright") {
    const config =
      suite.id === "web-browser"
        ? ["--config", "playwright.doc-links.config.ts"]
        : []
    return {
      executable: "bun",
      args: [
        "run",
        "playwright",
        "test",
        ...owned,
        ...config,
        "--workers=1",
        "--retries=0",
        "--reporter=line,junit",
        "--trace=retain-on-failure",
      ],
      cwd,
      env: {
        PLAYWRIGHT_JUNIT_OUTPUT_NAME: junit,
        WORKTABLE_PLAYWRIGHT_OUTPUT_DIR: join(
          resultDirectory,
          `${suite.id}.playwright`
        ),
      },
    }
  }
  if (suite.runner === "go") {
    return {
      executable: "go",
      args: ["test", "-race", "-json", "./..."],
      cwd,
      captureStdout: join(resultDirectory, `${suite.id}.go.json`),
    }
  }
  if (suite.runner === "desktop") {
    return {
      executable: "bun",
      args: [
        "run",
        resolve(repositoryRoot, "scripts/testing/desktop.ts"),
        resultDirectory,
      ],
      cwd: repositoryRoot,
    }
  }
  return {
    executable: "go",
    args: [
      "test",
      "-race",
      "-tags=worktable_host_integration",
      "-run",
      "^TestMicrosandboxProviderWithRealBackend$",
      "./...",
    ],
    cwd,
  }
}

async function runCommand(
  command: Command,
  timeoutMs: number,
  rssPath: string
): Promise<{ exitCode: number; timedOut: boolean; peakRssMb?: number }> {
  const useTime = process.platform === "linux" && existsSync("/usr/bin/time")
  const executable = useTime ? "/usr/bin/time" : command.executable
  const args = useTime
    ? ["-v", "-o", rssPath, "--", command.executable, ...command.args]
    : command.args
  const stdout = command.captureStdout ? "pipe" : "inherit"
  const processHandle = Bun.spawn([executable, ...args], {
    cwd: command.cwd,
    env: { ...process.env, ...command.env },
    detached: true,
    stdin: "inherit",
    stdout,
    stderr: "inherit",
  })
  let sampledPeakRssMb = 0
  const sampleRss = () => {
    sampledPeakRssMb = Math.max(
      sampledPeakRssMb,
      processTreeRssMb(processHandle.pid) ?? 0
    )
  }
  sampleRss()
  const rssTimer = setInterval(sampleRss, 500)
  let timedOut = false
  const trackedProcessGroups = new Set<number>()
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined
  let forceKillSent = false
  let resolveForceKill: (() => void) | undefined
  const forceKillComplete = new Promise<void>((resolveForce) => {
    resolveForceKill = resolveForce
  })
  const timer = setTimeout(
    () => {
      timedOut = true
      signalProcessTree(processHandle, "SIGTERM", trackedProcessGroups)
      forceKillTimer = setTimeout(() => {
        forceKillSent = true
        signalProcessTree(processHandle, "SIGKILL", trackedProcessGroups)
        resolveForceKill?.()
      }, 5_000)
    },
    Math.max(1, timeoutMs)
  )
  let captured = ""
  if (command.captureStdout && processHandle.stdout) {
    captured = await new Response(processHandle.stdout).text()
    process.stdout.write(captured)
  }
  const exitCode = await processHandle.exited
  clearTimeout(timer)
  if (forceKillTimer !== undefined) {
    if (processTreeIsAlive(processHandle.pid, trackedProcessGroups)) {
      await forceKillComplete
    } else {
      clearTimeout(forceKillTimer)
      resolveForceKill?.()
    }
  }
  const processTreeExited =
    !timedOut ||
    (!forceKillSent &&
      !processTreeIsAlive(processHandle.pid, trackedProcessGroups)) ||
    (await waitForProcessTreeExit(
      processHandle.pid,
      2_000,
      trackedProcessGroups
    ))
  clearInterval(rssTimer)
  if (timedOut && !processTreeExited) {
    throw new Error(
      `Timed-out suite process group ${processHandle.pid} survived SIGKILL`
    )
  }
  if (command.captureStdout) await writeFile(command.captureStdout, captured)
  let peakRssMb: number | undefined
  if (useTime && existsSync(rssPath)) {
    const text = await Bun.file(rssPath).text()
    const kib = Number(
      text.match(/Maximum resident set size \(kbytes\):\s*(\d+)/)?.[1]
    )
    if (Number.isFinite(kib)) peakRssMb = kib / 1024
  }
  peakRssMb = Math.max(peakRssMb ?? 0, sampledPeakRssMb) || undefined
  return { exitCode, timedOut, peakRssMb }
}

function printable(command: Command): string {
  return [command.executable, ...command.args]
    .map((part) => (/[\s"]/u.test(part) ? JSON.stringify(part) : part))
    .join(" ")
}

function processTreeRssMb(rootPid: number): number | undefined {
  if (process.platform !== "linux") return undefined
  try {
    const rows = execFileSync("ps", ["-eo", "pid=,ppid=,rss="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(
        (row): row is [number, number, number] =>
          row.length === 3 && row.every(Number.isFinite)
      )
    const tree = new Set([rootPid])
    let added = true
    while (added) {
      added = false
      for (const [pid, parentPid] of rows) {
        if (!tree.has(pid) && tree.has(parentPid)) {
          tree.add(pid)
          added = true
        }
      }
    }
    return (
      rows.reduce(
        (sum, [pid, , rssKib]) => sum + (tree.has(pid) ? rssKib : 0),
        0
      ) / 1024
    )
  } catch {
    return undefined
  }
}

const options = parseArgs(process.argv.slice(2))
const changes = options.profile === "changed" ? changedFiles(options) : []
let suites = suitesForProfile(options.profile, changes)
if (options.suites.length > 0) {
  const requested = new Set(options.suites)
  suites = suites.filter((suite) => requested.has(suite.id))
  const missing = [...requested].filter(
    (id) => !suites.some((suite) => suite.id === id)
  )
  if (missing.length > 0) {
    throw new Error(
      `Suites do not belong to this profile: ${missing.join(", ")}`
    )
  }
}
const selectedOwnedFiles = [
  ...new Set(suites.flatMap((suite) => ownedTestFiles(suite))),
]
const unmatchedFilters = unmatchedTestFilters(
  selectedOwnedFiles,
  options.testFiles,
  options.testPathPrefixes
)
if (unmatchedFilters.length > 0) {
  throw new Error(
    `Explicit test filters matched no selected suite: ${unmatchedFilters.join(", ")}`
  )
}
const indivisibleFilteredSuites = suites.filter(
  (suite) =>
    ["go", "host-go", "desktop"].includes(suite.runner) &&
    selectedTestFiles(
      ownedTestFiles(suite),
      options.testFiles,
      options.testPathPrefixes
    ).length > 0 &&
    (options.testFiles.length > 0 || options.testPathPrefixes.length > 0)
)
if (indivisibleFilteredSuites.length > 0) {
  throw new Error(
    `These suites do not support file filters: ${indivisibleFilteredSuites
      .map((suite) => suite.id)
      .join(", ")}. Select the suite without --test-file/--test-path-prefix.`
  )
}
const targeted = isTargetedSelection(options)
const resultDirectory = canonicalResultDirectory(
  resolve(repositoryRoot, "test-results/canonical"),
  options
)
await rm(resultDirectory, { recursive: true, force: true })
await mkdir(resultDirectory, { recursive: true })

console.log(
  `Canonical ${options.profile} tests: ${suites.map((suite) => suite.id).join(", ") || "no affected test lanes"}`
)
if (options.profile === "changed") {
  console.log(`Changed files considered: ${changes.length}`)
}

let failed = false
const requiredStarted = performance.now()
let portfolioPeakRssMb = processTreeRssMb(process.pid) ?? 0
const portfolioRssTimer = setInterval(() => {
  portfolioPeakRssMb = Math.max(
    portfolioPeakRssMb,
    processTreeRssMb(process.pid) ?? 0
  )
}, 500)

async function executeSuite(suite: TestSuite): Promise<boolean> {
  const owned = ownedTestFiles(suite)
  const files = selectedTestFiles(
    owned,
    options.testFiles,
    options.testPathPrefixes
  )
  if (
    files.length === 0 &&
    (options.testFiles.length > 0 || options.testPathPrefixes.length > 0)
  ) {
    return false
  }
  const command = commandForSuite(suite, files, resultDirectory, options)
  const commandText = printable(command)
  console.log(`\n[${suite.id}] ${suite.title}\n${commandText}`)
  const laneStartedAt = new Date().toISOString()
  const laneStarted = performance.now()
  const isRequiredSuite = suite.profiles.includes("required")
  const requiredElapsedMs = performance.now() - requiredStarted
  const ceilingMs =
    options.profile === "required" ||
    (options.profile === "changed" && isRequiredSuite)
      ? budgets.requiredCeilingSeconds * 1000 - requiredElapsedMs
      : 60 * 60 * 1000
  const outcome = await runCommand(
    command,
    ceilingMs,
    join(resultDirectory, `${suite.id}.resource.txt`)
  )
  const result: LaneResult = {
    suite: suite.id,
    title: suite.title,
    profile: options.profile,
    classification: suite.classification,
    status: outcome.timedOut
      ? "timed-out"
      : outcome.exitCode === 0
        ? "passed"
        : "failed",
    durationMs: performance.now() - laneStarted,
    peakRssMb: outcome.peakRssMb,
    files: files.length,
    command: commandText,
    startedAt: laneStartedAt,
  }
  await writeLaneResult(resultDirectory, result)
  if (result.status !== "passed") {
    return true
  }
  return false
}

function scheduledGroups(selected: TestSuite[]): TestSuite[][] {
  const pair = new Set(["cli-boundary", "bun-server"])
  const groups: TestSuite[][] = []
  let paired = false
  for (const suite of selected) {
    if (pair.has(suite.id)) {
      if (!paired) {
        groups.push(selected.filter((candidate) => pair.has(candidate.id)))
        paired = true
      }
      continue
    }
    groups.push([suite])
  }
  return groups
}

const executionSchedule = "cli-server-parallel"
console.log(`Execution schedule: ${executionSchedule}`)
for (const group of scheduledGroups(suites)) {
  const outcomes = await Promise.all(group.map(executeSuite))
  if (outcomes.some(Boolean)) {
    failed = true
    break
  }
}
clearInterval(portfolioRssTimer)
await writeFile(
  join(resultDirectory, "portfolio.json"),
  `${JSON.stringify(
    {
      revision: CANONICAL_PORTFOLIO_REVISION,
      profile: options.profile,
      schedule: executionSchedule,
      status: failed ? "failed" : "passed",
      durationMs: performance.now() - requiredStarted,
      peakRssMb: portfolioPeakRssMb || undefined,
      targeted,
      selectedSuites: suites.map((suite) => suite.id),
      startedAt: new Date(
        Date.now() - (performance.now() - requiredStarted)
      ).toISOString(),
    },
    null,
    2
  )}\n`
)
const summary = await aggregateResults(resultDirectory)
console.log(`\n${summary}`)
if (failed) process.exit(1)
