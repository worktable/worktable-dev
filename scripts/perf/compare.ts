#!/usr/bin/env bun
/**
 * Paired base-versus-candidate server runs (Plan 15, W0-04).
 *
 *   bun scripts/perf/compare.ts --base origin/main [--candidate <ref>]
 *     [--profile 1k] [--rounds 5] [--samples 10] [--typing-minutes 2] [--out <dir>]
 *
 * Exports each ref into .local-dev/perf/checkouts and installs its
 * dependencies; without --candidate, the candidate is this working tree. The
 * fixture is generated once by this checkout. Runs alternate on the same
 * machine (base first in even rounds, candidate first in odd rounds). The
 * report gives each side's median, the change, and how many rounds the
 * candidate was faster. Treat it as advisory: a change smaller than the
 * round-to-round spread is noise.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import type { ProfileName } from "./fixtures.ts"
import {
  PERF_ROOT,
  REPO_ROOT,
  markdownTable,
  median,
  numberArg,
  parseArgs,
  round,
} from "./lib.ts"
import {
  ensureFixture,
  metrics,
  runServerScenario,
  type ServerResult,
} from "./server.ts"

interface Side {
  label: "base" | "candidate"
  ref: string
  commit: string
  checkout: string
}

function git(...args: string[]): string {
  return execFileSync("git", ["-C", REPO_ROOT, ...args], {
    encoding: "utf8",
  }).trim()
}

/** A clean export of a commit with its locked dependencies, reused across runs. */
function checkoutOf(label: Side["label"], ref: string): Side {
  const commit = git("rev-parse", "--short=12", `${ref}^{commit}`)
  const checkout = join(PERF_ROOT, "checkouts", commit)
  if (!existsSync(join(checkout, ".perf-ready"))) {
    rmSync(checkout, { recursive: true, force: true })
    mkdirSync(checkout, { recursive: true })
    console.log(`[perf-compare] exporting ${ref} (${commit})`)
    execFileSync(
      "sh",
      [
        "-c",
        `git -C "${REPO_ROOT}" archive ${commit} | tar -x -C "${checkout}"`,
      ],
      { stdio: "inherit" }
    )
    execFileSync("bun", ["install", "--frozen-lockfile"], {
      cwd: checkout,
      stdio: "inherit",
    })
    writeFileSync(join(checkout, ".perf-ready"), `${commit}\n`)
  }
  return { label, ref, commit, checkout }
}

function workingTree(): Side {
  const commit = git("rev-parse", "--short=12", "HEAD")
  const dirty = git("status", "--porcelain", "--untracked-files=no") !== ""
  return {
    label: "candidate",
    ref: "working tree",
    commit: dirty ? `${commit}+changes` : commit,
    checkout: REPO_ROOT,
  }
}

export function compareSummary(
  base: ServerResult[],
  candidate: ServerResult[]
) {
  const baseMetrics = base.map(metrics)
  const candidateMetrics = candidate.map(metrics)
  return Object.keys(baseMetrics[0] ?? {}).map((metric) => {
    const values = (all: Record<string, number | null>[]) =>
      all
        .map((entry) => entry[metric])
        .filter((value): value is number => typeof value === "number")
    const baseMedian = median(values(baseMetrics))
    const candidateMedian = median(values(candidateMetrics))
    const wins = baseMetrics.filter((entry, index) => {
      const left = entry[metric]
      const right = candidateMetrics[index]?.[metric]
      return (
        typeof left === "number" && typeof right === "number" && right < left
      )
    }).length
    return {
      metric,
      base: round(baseMedian),
      candidate: round(candidateMedian),
      changePercent:
        baseMedian && candidateMedian !== null
          ? round(((candidateMedian - baseMedian) / baseMedian) * 100, 0)
          : null,
      candidateFaster: `${wins}/${Math.min(baseMetrics.length, candidateMetrics.length)}`,
    }
  })
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  const baseRef = args.get("base")
  if (!baseRef)
    throw new Error("--base <ref> is required, for example --base origin/main")
  const profile = (args.get("profile") ?? "1k") as ProfileName
  const seed = numberArg(args, "seed", 1)
  const rounds = numberArg(args, "rounds", 5)
  const samples = numberArg(args, "samples", 10)
  const typingMinutes = args.has("typing-minutes")
    ? Number(args.get("typing-minutes"))
    : 2
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const out = resolve(
    args.get("out") ?? join(PERF_ROOT, "results", `${stamp}-compare-${profile}`)
  )
  mkdirSync(out, { recursive: true })

  const base = checkoutOf("base", baseRef)
  const candidateRef = args.get("candidate")
  const candidate = candidateRef
    ? checkoutOf("candidate", candidateRef)
    : workingTree()
  ensureFixture(profile, seed)

  const results: Record<Side["label"], ServerResult[]> = {
    base: [],
    candidate: [],
  }
  for (let index = 0; index < rounds; index += 1) {
    for (const side of index % 2 === 0
      ? [base, candidate]
      : [candidate, base]) {
      console.log(
        `[perf-compare] round ${index + 1}/${rounds}: ${side.label} ${side.commit}`
      )
      const result = await runServerScenario({
        label: side.label,
        checkout: side.checkout,
        commit: side.commit,
        profile,
        seed,
        samples,
        typingMinutes,
        runDir: join(PERF_ROOT, "runs", side.label),
      })
      results[side.label].push(result)
      writeFileSync(
        join(out, "rounds.json"),
        `${JSON.stringify(results, null, 2)}\n`
      )
    }
  }

  const rows = compareSummary(results.base, results.candidate)
  const machine = results.base[0]!.machine
  const report = [
    `# Server perf: ${base.commit} (base) against ${candidate.commit} (candidate)`,
    "",
    `Fixture ${profile}, seed ${seed}, ${rounds} alternating rounds, ${samples} samples per endpoint, typing ${typingMinutes} min. ${machine.cpus} CPUs (${machine.model}), Bun ${machine.bun}.`,
    "",
    "Medians across rounds; lower is better. Advisory: changes within the round-to-round spread are noise.",
    "",
    markdownTable(
      ["Metric", "Base", "Candidate", "Change %", "Candidate faster"],
      rows.map((row) => [
        row.metric,
        row.base,
        row.candidate,
        row.changePercent,
        row.candidateFaster,
      ])
    ),
    "",
  ].join("\n")
  writeFileSync(
    join(out, "compare.json"),
    `${JSON.stringify({ base, candidate, profile, seed, rounds, samples, typingMinutes, summary: rows }, null, 2)}\n`
  )
  writeFileSync(join(out, "compare.md"), report)
  console.log(report)
  console.log(`Wrote ${out}`)
  process.exit(0)
}
