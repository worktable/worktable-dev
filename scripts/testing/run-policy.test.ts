import { describe, expect, test } from "bun:test"
import { isBareSleepLine } from "./policy-rules.ts"
import {
  bunTestArguments,
  hasExecutedGoTests,
  canonicalResultDirectory,
  selectedTestFiles,
  unmatchedTestFilters,
  vitestArguments,
  type TestSelection,
} from "./run-policy.ts"

const complete: TestSelection = {
  profile: "required",
  suites: [],
  testFiles: [],
  testPathPrefixes: [],
}

describe("canonical runner policy", () => {
  test("passes Bun's global config before the test subcommand", () => {
    expect(
      bunTestArguments({
        config: "scripts/testing/bunfig.standard.toml",
        files: ["scripts/example.test.ts"],
        junit: "results.xml",
      })
    ).toEqual([
      "--config=scripts/testing/bunfig.standard.toml",
      "test",
      "scripts/example.test.ts",
      "--reporter=junit",
      "--reporter-outfile=results.xml",
    ])
  })

  test("keeps complete and targeted evidence in separate directories", () => {
    expect(canonicalResultDirectory("/results", complete)).toBe(
      "/results/required"
    )
    const targeted = canonicalResultDirectory("/results", {
      ...complete,
      testFiles: ["scripts/example.test.ts"],
    })
    expect(targeted).toStartWith("/results/targeted/required/")
    expect(targeted).toBe(
      canonicalResultDirectory("/results", {
        ...complete,
        testFiles: ["scripts/example.test.ts"],
      })
    )
  })

  test("reports every explicit filter that selects no owned test", () => {
    expect(
      unmatchedTestFilters(
        ["scripts/one.test.ts", "scripts/group/two.test.ts"],
        ["scripts/missing.test.ts"],
        ["scripts/group/", "apps/missing/"]
      )
    ).toEqual([
      "test file scripts/missing.test.ts",
      "test path prefix apps/missing/",
    ])
  })

  test("selects exact files and prefixes without widening the request", () => {
    expect(
      selectedTestFiles(
        ["a/one.test.ts", "a/group/two.test.ts", "b/three.test.ts"],
        ["a/one.test.ts"],
        ["a/group/"]
      )
    ).toEqual(["a/one.test.ts", "a/group/two.test.ts"])
  })

  test("passes focused files to both Vitest command variants", () => {
    expect(
      vitestArguments({
        files: ["tests/focused.vitest.ts"],
        junit: "control-plane.xml",
      })
    ).toContain("tests/focused.vitest.ts")
    expect(
      vitestArguments({
        files: ["src/focused.worker.vitest.ts"],
        junit: "gateway.xml",
        config: "vitest.config.ts",
      })
    ).toEqual([
      "run",
      "vitest",
      "run",
      "--config",
      "vitest.config.ts",
      "src/focused.worker.vitest.ts",
      "--reporter=default",
      "--reporter=junit",
      "--outputFile.junit=gateway.xml",
    ])
  })

  test("treats Playwright timeouts as bare sleeps", () => {
    const timeoutCall = ["await page", "waitForTimeout(250)"].join(".")
    expect(isBareSleepLine([timeoutCall], 0)).toBe(true)
  })
})

test("host evidence requires a completed test, not a successful empty Go invocation", () => {
  for (const events of [
    [],
    [{ Action: "pass", Package: "runner" }],
    [{ Action: "skip", Test: "TestHost" }],
  ]) {
    expect(
      hasExecutedGoTests(
        events.map((event) => JSON.stringify(event)).join("\n")
      )
    ).toBe(false)
  }
  expect(
    hasExecutedGoTests(JSON.stringify({ Action: "pass", Test: "TestHost" }))
  ).toBe(true)
  expect(hasExecutedGoTests("invalid JSON")).toBe(false)
})
