#!/usr/bin/env bun
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { aggregateResults, type LaneResult } from "./report.ts"
import { testSuites } from "./suites.ts"
import { CANONICAL_PORTFOLIO_REVISION } from "./health-policy.ts"

export interface Identity {
  sourceSha: string
  executionTree: string
  runId: string
  runAttempt: string
}
interface Fragment extends Identity {
  expectedSuites: string[]
}
async function find(root: string, name: string): Promise<string[]> {
  const matches: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) matches.push(...(await find(path, name)))
    else if (entry.isFile() && entry.name === name) matches.push(path)
  }
  return matches
}
function suiteSet(suites: string[]): string {
  if (
    !suites.length ||
    suites.some((s) => !/^[a-z][a-z0-9-]+$/.test(s)) ||
    new Set(suites).size !== suites.length
  )
    throw new Error("Expected nonempty unique suite IDs")
  return [...suites].sort().join(",")
}
function validateIdentity(identity: Identity): void {
  if (
    ![identity.sourceSha, identity.executionTree].every((s) =>
      /^[a-f0-9]{40}$/.test(s)
    ) ||
    !/^\d+$/.test(identity.runId) ||
    !/^[1-9]\d*$/.test(identity.runAttempt)
  )
    throw new Error("Invalid immutable CI identity")
}
async function validateReports(
  directory: string,
  suiteId: string
): Promise<void> {
  const suite = testSuites.find((candidate) => candidate.id === suiteId)
  if (!suite) throw new Error(`Unknown canonical suite: ${suiteId}`)
  if (suite.runner === "go" || suite.runner === "host-go") {
    const events = (
      await readFile(join(directory, `${suiteId}.go.json`), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
    if (
      !events.some((event) => event.Action === "pass") ||
      events.some((event) => event.Action === "fail")
    )
      throw new Error(`Missing or failed Go evidence: ${suiteId}`)
  } else {
    const xml = await readFile(join(directory, `${suiteId}.junit.xml`), "utf8")
    const roots = [...xml.matchAll(/<testsuites?\b([^>]*)>/g)]
    if (
      !roots.length ||
      !roots.some((match) => /\btests="[1-9]\d*"/.test(match[1]!)) ||
      roots.some((match) =>
        /\b(?:failures|errors)="(?!0")[^"]+"/.test(match[1]!)
      ) ||
      /<(?:failure|error)\b/.test(xml)
    )
      throw new Error(`Missing or failed JUnit evidence: ${suiteId}`)
  }
  if (suite.runner === "desktop") {
    const { phases } = JSON.parse(
      await readFile(join(directory, `${suiteId}.rust.json`), "utf8")
    )
    const expected = [
      "desktop-bun-contracts",
      "rustfmt",
      "rust-test",
      "rust-clippy",
    ]
    if (
      !Array.isArray(phases) ||
      phases.length !== expected.length ||
      expected.some(
        (name) =>
          !phases.some((phase) => phase.phase === name && phase.exitCode === 0)
      )
    )
      throw new Error("Incomplete native phase evidence")
  }
}
export async function stamp(
  root: string,
  identity: Identity,
  expected: string[]
): Promise<void> {
  validateIdentity(identity)
  const portfolios = await find(root, "portfolio.json")
  if (portfolios.length !== 1)
    throw new Error("A fragment must contain exactly one portfolio")
  const path = portfolios[0]!
  const portfolio = JSON.parse(await readFile(path, "utf8"))
  if (suiteSet(portfolio.selectedSuites ?? []) !== suiteSet(expected))
    throw new Error("Fragment portfolio does not own its expected suites")
  await writeFile(
    join(dirname(path), "ci-identity.json"),
    JSON.stringify({ ...identity, expectedSuites: expected }, null, 2) + "\n"
  )
}
interface AggregateOptions {
  root: string
  output: string
  identity: Identity
  expected: string[]
  profile: "full" | "changed" | "required"
}
export async function aggregateCi(options: AggregateOptions): Promise<void> {
  await mkdir(options.output, { recursive: true })
  if ((await readdir(options.output)).length)
    throw new Error("Aggregation output must be empty")
  try {
    await aggregatePassing(options)
  } catch (error) {
    await recordFailedPortfolio(options)
    throw error
  }
}
async function aggregatePassing(options: AggregateOptions): Promise<void> {
  const { root, output, identity, expected, profile } = options
  validateIdentity(identity)
  suiteSet(expected)
  if (
    profile !== "changed" &&
    suiteSet(expected) !==
      suiteSet(
        testSuites
          .filter((suite) => suite.profiles.includes(profile))
          .map((suite) => suite.id)
      )
  )
    throw new Error(`Incomplete canonical ${profile} manifest`)
  const identities = await find(root, "ci-identity.json")
  if (!identities.length) throw new Error("Missing CI fragments")
  const allPortfolios = await find(root, "portfolio.json")
  if (allPortfolios.length !== identities.length)
    throw new Error("Unstamped CI portfolio")
  const lanes: LaneResult[] = []
  const directories: string[] = []
  let revision: string | undefined
  for (const file of identities) {
    const fragment: Fragment = JSON.parse(await readFile(file, "utf8"))
    if (
      Object.entries(identity).some(
        ([key, value]) => fragment[key as keyof Identity] !== value
      )
    )
      throw new Error("CI fragment source/tree/run/attempt mismatch")
    const directory = dirname(file)
    const portfolio = JSON.parse(
      await readFile(join(directory, "portfolio.json"), "utf8")
    )
    if (portfolio.status !== "passed")
      throw new Error("Failed or incomplete CI portfolio")
    if (!portfolio.revision || (revision && revision !== portfolio.revision))
      throw new Error("Portfolio revision mismatch")
    revision = portfolio.revision
    if (
      suiteSet(portfolio.selectedSuites ?? []) !==
      suiteSet(fragment.expectedSuites)
    )
      throw new Error("Fragment ownership mismatch")
    const entries = await readdir(directory)
    const actual = entries.filter((f) => f.endsWith(".lane.json"))
    if (actual.length !== fragment.expectedSuites.length)
      throw new Error("Missing or extra lane result")
    for (const path of actual) {
      const lane: LaneResult = JSON.parse(
        await readFile(join(directory, path), "utf8")
      )
      if (
        !fragment.expectedSuites.includes(lane.suite) ||
        path !== `${lane.suite}.lane.json` ||
        lane.status !== "passed" ||
        !Number.isFinite(lane.durationMs) ||
        lane.durationMs < 0 ||
        !Number.isFinite(Date.parse(lane.startedAt))
      )
        throw new Error("Invalid, failed or unexpected lane")
      if (lanes.some((l) => l.suite === lane.suite))
        throw new Error("Duplicate lane ownership")
      await validateReports(directory, lane.suite)
      lanes.push(lane)
    }
    directories.push(directory)
  }
  if (suiteSet(lanes.map((l) => l.suite)) !== suiteSet(expected))
    throw new Error("Incomplete selected portfolio")
  // Do not merge over stale evidence from a previous invocation.
  await mkdir(output, { recursive: true })
  if ((await readdir(output)).length)
    throw new Error("Aggregation output must be empty")
  const copied = new Set<string>()
  for (const directory of directories) {
    for (const file of await readdir(directory)) {
      if (
        [
          "portfolio.json",
          "summary.json",
          "summary.md",
          "ci-identity.json",
        ].includes(file)
      )
        continue
      if (copied.has(file))
        throw new Error(`Conflicting evidence file: ${file}`)
      copied.add(file)
      await cp(join(directory, file), join(output, file), { recursive: true })
    }
  }
  const starts = lanes.map((l) => Date.parse(l.startedAt))
  const start = Math.min(...starts)
  const end = Math.max(...lanes.map((l, i) => starts[i]! + l.durationMs))
  const portfolio = {
    revision: `${revision}-distributed`,
    profile,
    schedule: "distributed-ci",
    status: "passed",
    durationMs: end - start,
    peakRssMb: Math.max(...lanes.map((l) => l.peakRssMb ?? 0)),
    targeted: profile === "changed",
    selectedSuites: expected,
    startedAt: new Date(start).toISOString(),
    ...identity,
  }
  await writeFile(
    join(output, "portfolio.json"),
    JSON.stringify(portfolio, null, 2) + "\n"
  )
  await aggregateResults(output)
  const summary = JSON.parse(
    await readFile(join(output, "summary.json"), "utf8")
  )
  if (
    summary.junit.some(
      (j: { failures: number; errors: number }) => j.failures || j.errors
    ) ||
    summary.go.some((g: { failed: number }) => g.failed) ||
    summary.rust.some((r: { phases: { exitCode: number }[] }) =>
      r.phases.some((p) => p.exitCode !== 0)
    )
  ) {
    portfolio.status = "failed"
    await writeFile(
      join(output, "portfolio.json"),
      JSON.stringify(portfolio, null, 2) + "\n"
    )
    await aggregateResults(output)
    throw new Error("Runtime reports contradict passing lane evidence")
  }
}
// A failed full run must reset the observation streak even if a selected job
// never produced a portfolio. Raw fragments remain separate artifacts for diagnosis.
async function recordFailedPortfolio(options: AggregateOptions): Promise<void> {
  const lanes: LaneResult[] = []
  for (const file of await find(options.root, "ci-identity.json").catch(
    () => []
  )) {
    try {
      const fragment: Fragment = JSON.parse(await readFile(file, "utf8"))
      if (
        Object.entries(options.identity).some(
          ([key, value]) => fragment[key as keyof Identity] !== value
        )
      )
        continue
      for (const suite of fragment.expectedSuites) {
        if (
          !options.expected.includes(suite) ||
          lanes.some((lane) => lane.suite === suite)
        )
          continue
        const lane: LaneResult = JSON.parse(
          await readFile(join(dirname(file), `${suite}.lane.json`), "utf8")
        )
        if (
          lane.suite !== suite ||
          !Number.isFinite(Date.parse(lane.startedAt)) ||
          !Number.isFinite(lane.durationMs)
        )
          continue
        lanes.push(lane)
        await writeFile(
          join(options.output, `${suite}.lane.json`),
          JSON.stringify(lane)
        )
      }
    } catch {
      /* A damaged fragment cannot supply evidence. */
    }
  }
  const start = lanes.length
    ? Math.min(...lanes.map((lane) => Date.parse(lane.startedAt)))
    : Date.now()
  const end = Math.max(
    start,
    ...lanes.map((lane) => Date.parse(lane.startedAt) + lane.durationMs)
  )
  await writeFile(
    join(options.output, "portfolio.json"),
    JSON.stringify(
      {
        revision: `${CANONICAL_PORTFOLIO_REVISION}-distributed`,
        profile: options.profile,
        schedule: "distributed-ci",
        status: "failed",
        targeted: options.profile === "changed",
        selectedSuites: options.expected,
        durationMs: end - start,
        startedAt: new Date(start).toISOString(),
        ...options.identity,
      },
      null,
      2
    ) + "\n"
  )
  await aggregateResults(options.output)
}
if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || !args[i + 1])
      throw new Error("Expected --key value arguments")
    values.set(args[i]!.slice(2), args[i + 1]!)
  }
  const get = (key: string) => {
    const value = values.get(key)
    if (!value) throw new Error(`Missing --${key}`)
    return value
  }
  const identity = {
    sourceSha: get("source"),
    executionTree: get("tree"),
    runId: get("run"),
    runAttempt: get("attempt"),
  }
  const root = resolve(get("root"))
  const expected = get("expected").split(",")
  if (command === "stamp") await stamp(root, identity, expected)
  else if (command === "aggregate") {
    const profile = get("profile")
    if (!["full", "changed", "required"].includes(profile))
      throw new Error("Invalid aggregate profile")
    await aggregateCi({
      root,
      output: resolve(get("output")),
      identity,
      expected,
      profile: profile as "full" | "changed" | "required",
    })
  } else throw new Error("Use stamp or aggregate")
}
