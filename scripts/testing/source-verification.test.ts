import { expect, test } from "bun:test"
import { assertPublicJobs, sourceReceipt } from "./source-verification.ts"
import { publicTestSuites } from "./public-suites.ts"

const jobs = () => ({
  plan: {
    result: "success",
    outputs: {
      scope: "full",
      suites: publicTestSuites.map((s) => s.id).join(","),
    },
  },
  checks: { result: "success" },
  build: { result: "success" },
  required: { result: "success" },
  native: { result: "success" },
  browsers: { result: "success" },
  docs: { result: "skipped" },
})

test("required result accounts for each selected branch and intentionally omitted docs branches", () => {
  expect(assertPublicJobs(jobs()).scope).toBe("full")
  for (const status of ["failure", "cancelled", "skipped", "pending"])
    expect(() =>
      assertPublicJobs({ ...jobs(), browsers: { result: status } })
    ).toThrow()
  const missing: Partial<ReturnType<typeof jobs>> = jobs()
  delete missing.native
  expect(() => assertPublicJobs(missing)).toThrow()
  const docs = jobs()
  docs.plan.outputs = { scope: "product-docs", suites: "" }
  for (const name of [
    "checks",
    "build",
    "required",
    "native",
    "browsers",
  ] as const)
    docs[name].result = "skipped"
  docs.docs.result = "success"
  expect(assertPublicJobs(docs).scope).toBe("product-docs")
  expect(() =>
    assertPublicJobs({ ...docs, required: { result: "success" } })
  ).toThrow()
})

test("reusable source proof requires the complete main execution and actual toolchain", () => {
  const input = {
    repository: "worktable/worktable-dev",
    sha: "a".repeat(40),
    tree: "b".repeat(40),
    runId: 123,
    runAttempt: 1,
    event: "push",
    ref: "refs/heads/main",
    bun: "1.3.14",
    node: "24.15.0",
    lockfileSha256: "c".repeat(64),
    jobs: jobs(),
  }
  expect(sourceReceipt(input)).toMatchObject({
    sha: input.sha,
    status: "success",
    scope: "full",
  })
  for (const change of [
    { event: "pull_request" },
    { ref: "refs/heads/topic" },
    { bun: "1.3.12" },
    { runAttempt: 0 },
  ])
    expect(() => sourceReceipt({ ...input, ...change })).toThrow()
  const partial = jobs()
  partial.plan.outputs.suites = "bun-standard"
  expect(() => sourceReceipt({ ...input, jobs: partial })).toThrow()
})
