import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { publicTestSuites } from "./public-suites.ts"

type Job = { result: string; outputs?: Record<string, string> }
type Jobs = Record<string, Job>
const names = [
  "plan",
  "checks",
  "build",
  "required",
  "native",
  "browsers",
  "docs",
]
const all = publicTestSuites.map((suite) => suite.id)
const required = publicTestSuites
  .filter((suite) => suite.profiles.includes("required"))
  .map((suite) => suite.id)

/** A skipped branch is acceptable only when the immutable plan omitted it. */
export function assertPublicJobs(value: unknown): {
  scope: string
  suites: string[]
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Missing CI job results")
  const jobs = value as Jobs
  if (
    Object.keys(jobs).length !== names.length ||
    names.some((name) => !jobs[name])
  )
    throw new Error("Incomplete CI job graph")
  if (jobs.plan!.result !== "success")
    throw new Error("The evidence plan did not succeed")
  const scope = jobs.plan!.outputs?.scope
  if (
    !["documentation", "product-docs", "selected", "full"].includes(scope ?? "")
  )
    throw new Error("Unknown evidence scope")
  const suites = (jobs.plan!.outputs?.suites ?? "").split(",").filter(Boolean)
  if (
    new Set(suites).size !== suites.length ||
    suites.some((id) => !all.includes(id))
  )
    throw new Error("Invalid selected lanes")
  const product = scope === "full" || scope === "selected"
  if (
    product ? required.some((id) => !suites.includes(id)) : suites.length !== 0
  )
    throw new Error("The plan lost required evidence ownership")
  if (scope === "full" && suites.length !== all.length)
    throw new Error("Full proof needs every lane")
  const expected: Record<string, boolean> = {
    checks: product,
    build: product,
    required: product,
    native: suites.includes("desktop-contracts"),
    browsers: suites.some((id) => id.endsWith("-browser")),
    docs: !product,
  }
  for (const [name, selected] of Object.entries(expected)) {
    if (jobs[name]!.result !== (selected ? "success" : "skipped"))
      throw new Error(
        `${name}: expected ${selected ? "success" : "skipped"}, received ${jobs[name]!.result}`
      )
  }
  return { scope: scope!, suites }
}

export function sourceReceipt(input: {
  repository: string
  sha: string
  tree: string
  runId: number
  runAttempt: number
  event: string
  ref: string
  bun: string
  node: string
  lockfileSha256: string
  jobs: unknown
}) {
  const { scope } = assertPublicJobs(input.jobs)
  if (
    scope !== "full" ||
    input.event !== "push" ||
    input.ref !== "refs/heads/main"
  )
    throw new Error(
      "Release source proof requires complete public main push verification"
    )
  if (
    !/^[\w.-]+\/[\w.-]+$/.test(input.repository) ||
    !/^[a-f0-9]{40}$/.test(input.sha) ||
    !/^[a-f0-9]{40}$/.test(input.tree) ||
    !/^[a-f0-9]{64}$/.test(input.lockfileSha256) ||
    !Number.isSafeInteger(input.runId) ||
    input.runId <= 0 ||
    !Number.isSafeInteger(input.runAttempt) ||
    input.runAttempt <= 0 ||
    input.bun !== "1.3.14" ||
    input.node !== "24.15.0"
  )
    throw new Error("Invalid source or toolchain identity")
  return {
    schemaVersion: 1,
    repository: input.repository,
    sha: input.sha,
    tree: input.tree,
    runId: input.runId,
    runAttempt: input.runAttempt,
    workflow: ".github/workflows/ci.yml",
    event: input.event,
    ref: input.ref,
    toolchain: { bun: input.bun, node: input.node },
    lockfileSha256: input.lockfileSha256,
    scope,
    checks: ["typecheck", "required", "generated", "release-lab"],
    status: "success",
  }
}

if (import.meta.main) {
  const jobs: unknown = JSON.parse(process.env.NEEDS_JSON ?? "null")
  const plan = assertPublicJobs(jobs)
  console.log(
    `Verified ${plan.scope} job graph (${plan.suites.length} selected lanes)`
  )
  const output = process.argv[2]
  if (output) {
    const git = (...args: string[]) =>
      execFileSync("git", args, { encoding: "utf8" }).trim()
    if (
      git("rev-parse", "HEAD") !== process.env.GITHUB_SHA ||
      git("status", "--porcelain") !== ""
    )
      throw new Error("Receipt must describe the clean actual checkout")
    const receipt = sourceReceipt({
      repository: process.env.GITHUB_REPOSITORY ?? "",
      sha: process.env.GITHUB_SHA ?? "",
      tree: git("rev-parse", "HEAD^{tree}"),
      runId: Number(process.env.GITHUB_RUN_ID),
      runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      event: process.env.GITHUB_EVENT_NAME ?? "",
      ref: process.env.GITHUB_REF ?? "",
      bun: Bun.version,
      node: execFileSync("node", ["--version"], { encoding: "utf8" })
        .trim()
        .replace(/^v/, ""),
      lockfileSha256: createHash("sha256")
        .update(await readFile("bun.lock"))
        .digest("hex"),
      jobs,
    })
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`)
  }
}
