import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { aggregateCi, stamp } from "./aggregate-ci.ts"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
})
const identity = {
  sourceSha: "a".repeat(40),
  executionTree: "b".repeat(40),
  runId: "42",
  runAttempt: "2",
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ci-fragments-"))
  roots.push(root)
  const input = join(root, "fragments")
  const expected = ["bun-standard", "bun-server"]
  for (const [index, suite] of expected.entries()) {
    const dir = join(input, suite, "full-targeted")
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, "portfolio.json"),
      JSON.stringify({
        revision: "fixture",
        status: "passed",
        selectedSuites: [suite],
      })
    )
    await writeFile(
      join(dir, `${suite}.lane.json`),
      JSON.stringify({
        suite,
        title: suite,
        profile: "full",
        classification: "integration",
        status: "passed",
        durationMs: 1000,
        startedAt: new Date(10000 + index * 500).toISOString(),
        files: 1,
        command: "bun test",
      })
    )
    await writeFile(
      join(dir, `${suite}.junit.xml`),
      '<testsuites tests="1" failures="0" errors="0"><testsuite tests="1"><testcase name="contract" /></testsuite></testsuites>'
    )
    await stamp(join(input, suite), identity, [suite])
  }
  return {
    root: input,
    output: join(root, "output"),
    identity,
    expected,
    profile: "changed" as "changed" | "full",
  }
}

test("same-run fragments produce one complete selected portfolio with overlapping wall time", async () => {
  const options = await fixture()
  await aggregateCi(options)
  const portfolio = JSON.parse(
    await readFile(join(options.output, "portfolio.json"), "utf8")
  )
  expect(portfolio).toMatchObject({
    ...identity,
    revision: "fixture-distributed",
    status: "passed",
    targeted: true,
    durationMs: 1500,
    selectedSuites: options.expected,
  })
  expect(
    JSON.parse(await readFile(join(options.output, "summary.json"), "utf8"))
      .junit
  ).toHaveLength(2)
})

test("aggregation rejects missing ownership and evidence from another source or attempt", async () => {
  const incompleteFull = await fixture()
  incompleteFull.profile = "full"
  await expect(aggregateCi(incompleteFull)).rejects.toThrow(
    "Incomplete canonical full manifest"
  )
  for (const mutation of [
    "missing",
    "source",
    "tree",
    "run",
    "attempt",
    "duplicate",
    "unstamped",
  ] as const) {
    const options = await fixture()
    const dir = join(options.root, "bun-server", "full-targeted")
    const manifest = join(dir, "ci-identity.json")
    if (mutation === "missing")
      await rm(join(options.root, "bun-server"), { recursive: true })
    else if (mutation === "unstamped") await rm(manifest)
    else if (mutation === "duplicate") options.expected = ["bun-standard"]
    else {
      const data = JSON.parse(await readFile(manifest, "utf8"))
      const key = {
        source: "sourceSha",
        tree: "executionTree",
        run: "runId",
        attempt: "runAttempt",
      }[mutation]
      data[key] =
        mutation === "source" || mutation === "tree" ? "c".repeat(40) : "3"
      await writeFile(manifest, JSON.stringify(data))
    }
    await expect(aggregateCi(options)).rejects.toThrow()
    expect(
      JSON.parse(await readFile(join(options.output, "portfolio.json"), "utf8"))
    ).toMatchObject({
      status: "failed",
      targeted: true,
      schedule: "distributed-ci",
    })
  }
})

test("a passing lane cannot hide absent or failing runtime reports", async () => {
  for (const failure of [
    "missing",
    "failed",
    "malformed",
    "lane",
    "portfolio",
  ] as const) {
    const options = await fixture()
    const dir = join(options.root, "bun-server", "full-targeted")
    const report = join(dir, "bun-server.junit.xml")
    if (failure === "missing") await rm(report)
    else if (failure === "failed")
      await writeFile(
        report,
        '<testsuites tests="1" failures="1"><failure /></testsuites>'
      )
    else if (failure === "malformed") await writeFile(report, "not a report")
    else {
      const path = join(
        dir,
        failure === "lane" ? "bun-server.lane.json" : "portfolio.json"
      )
      const data = JSON.parse(await readFile(path, "utf8"))
      data.status = "failed"
      await writeFile(path, JSON.stringify(data))
    }
    await expect(aggregateCi(options)).rejects.toThrow()
    expect(
      JSON.parse(await readFile(join(options.output, "portfolio.json"), "utf8"))
    ).toMatchObject({
      status: "failed",
      targeted: true,
      schedule: "distributed-ci",
    })
  }
})
