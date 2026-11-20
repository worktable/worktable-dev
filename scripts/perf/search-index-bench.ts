// The search index as built (search-store.ts) against the one before it
// (MiniSearch, WORKTABLE_SEARCH_INDEX=minisearch), through the real search
// function, on the same synthetic Worktable, each in a fresh process.
//
//   bun scripts/perf/search-index-bench.ts --profiles 1k,5k --out <dir>
//
// Not part of CI: a one-off measurement for the search rework.

import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fixtureDir, readFixture, type ProfileName } from "./fixtures.ts"
import { parseArgs, REPO_ROOT } from "./lib.ts"

const QUERIES = [
  "ledger reconciliation",
  "incident runbook",
  "pricing experiment",
  "quarterly roadmap",
  "customer",
  "onboarding",
  "migration plan",
  "ledg",
  "runb",
  "design review notes",
  "budget",
  "release",
  "r",
  "re",
]
const TYPO_QUERIES = ["ledgr reconcilation", "incidnt runbook", "pricng experimnt", "quartely roadmap"]
const REPEATS = 7

interface Result {
  engine: string
  buildMs: number
  heapMb: number
  rssMb: number
  diskMb: number
  queryP50Ms: number
  queryP95Ms: number
  perQuery: Record<string, number>
  typoMs: number
  typoHits: Record<string, number>
  editVisibleMs: number
  restartFirstSearchMs: number
  restartReread: number
  /** A fresh process on the same data, with the server's own wait. */
  coldFirstSearchMs?: number
  coldResults?: number
  coldComplete?: boolean
}

async function cold(workspace: string, app: string) {
  const { setWorkspaceRootOverride } = await import("../../packages/server/src/workspace.ts")
  const { setAppDirOverride } = await import("../../packages/server/src/app-storage.ts")
  setWorkspaceRootOverride(workspace)
  setAppDirOverride(app)
  const search = await import("../../packages/server/src/search-index.ts")
  const store = await import("../../packages/server/src/search-store.ts")
  store.keepSearchIndexOnDisk(true)
  const started = performance.now()
  const answer = await search.searchWithStatus("budget", {
    documentAccess: "common", maxResults: 50, includeArchived: true, archivedLast: true,
  })
  return { coldFirstSearchMs: performance.now() - started, coldResults: answer.results.length, coldComplete: answer.complete }
}

const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor((p / 100) * values.length))]!

function memory() {
  Bun.gc(true)
  const usage = process.memoryUsage()
  return { rssMb: usage.rss / 2 ** 20, heapMb: usage.heapUsed / 2 ** 20 }
}

function dirMb(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) total += statSync(join(entry.parentPath, entry.name)).size
  }
  return total / 2 ** 20
}

async function child(workspace: string, app: string): Promise<Result> {
  const { setWorkspaceRootOverride } = await import("../../packages/server/src/workspace.ts")
  const { setAppDirOverride } = await import("../../packages/server/src/app-storage.ts")
  setWorkspaceRootOverride(workspace)
  setAppDirOverride(app)
  const search = await import("../../packages/server/src/search-index.ts")
  const store = await import("../../packages/server/src/search-store.ts")
  const { listSpaces } = await import("../../packages/server/src/store.ts")
  store.keepSearchIndexOnDisk(true)
  search.setSearchWaitForTests(600_000)
  const ask = (query: string, maxResults = 50) =>
    search.searchWithStatus(query, { documentAccess: "common", maxResults, includeArchived: true, archivedLast: true })

  const before = memory()
  const started = performance.now()
  await ask("warmup")
  const buildMs = performance.now() - started
  const after = memory()

  const latencies: number[] = []
  const perQuery: Record<string, number> = {}
  for (const query of QUERIES) {
    const own: number[] = []
    for (let repeat = 0; repeat < REPEATS; repeat += 1) {
      const t = performance.now()
      await ask(query)
      own.push(performance.now() - t)
    }
    latencies.push(...own)
    perQuery[query] = percentile(own, 50)
  }
  const typoHits: Record<string, number> = {}
  const typoStarted = performance.now()
  for (const query of TYPO_QUERIES) typoHits[query] = (await ask(query)).results.length
  const typoMs = (performance.now() - typoStarted) / TYPO_QUERIES.length

  const space = (await listSpaces())[0]!
  const docsDir = join(workspace, "spaces", space.id, "docs")
  const target = readdirSync(docsDir).find((name) => name.endsWith(".md"))!
  writeFileSync(join(docsDir, target), `${readFileSync(join(docsDir, target), "utf8")}\n\nzanzibarqux appears here.\n`)
  search.invalidateSearchIndex({ spaceId: space.id, path: target.replace(/\.md$/, "") })
  const editStarted = performance.now()
  if ((await ask("zanzibarqux", 5)).results.length === 0) throw new Error("missed the edit")
  const editVisibleMs = performance.now() - editStarted

  // A restart: the store closes and opens again; MiniSearch starts empty.
  store.keepSearchIndexOnDisk(false)
  store.keepSearchIndexOnDisk(true)
  search.invalidateSearchIndex()
  let reread = 0
  search.setSearchIndexRebuildHookForTests(async ({ documents }) => {
    reread += documents
  })
  const restarted = performance.now()
  await ask("budget")
  const restartFirstSearchMs = performance.now() - restarted

  return {
    engine: process.env["WORKTABLE_SEARCH_INDEX"] === "minisearch" ? "minisearch" : "fts5",
    buildMs,
    heapMb: after.heapMb - before.heapMb,
    rssMb: after.rssMb - before.rssMb,
    diskMb: dirMb(join(app, "derived")),
    queryP50Ms: percentile(latencies, 50),
    queryP95Ms: percentile(latencies, 95),
    perQuery,
    typoMs,
    typoHits,
    editVisibleMs,
    restartFirstSearchMs,
    restartReread: reread,
  }
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  if (args.get("cold")) {
    console.log(`RESULT ${JSON.stringify(await cold(args.get("workspace")!, args.get("app")!))}`)
    process.exit(0)
  }
  if (args.get("child")) {
    console.log(`RESULT ${JSON.stringify(await child(args.get("workspace")!, args.get("app")!))}`)
    process.exit(0)
  }
  const profiles = (args.get("profiles") ?? "1k").split(",") as ProfileName[]
  const out = args.get("out") ?? join(REPO_ROOT, "test-results")
  mkdirSync(out, { recursive: true })
  const report: Record<string, unknown> = { bun: Bun.version, cpus: navigator.hardwareConcurrency }
  for (const profile of profiles) {
    const dir = fixtureDir(profile, 1)
    if (!readFixture(dir)) {
      const made = spawnSync("bun", ["scripts/perf/fixtures.ts", "--profile", profile, "--seed", "1"], {
        cwd: REPO_ROOT,
        stdio: "inherit",
      })
      if (made.status !== 0) throw new Error(`fixture ${profile} failed`)
    }
    const results: Result[] = []
    for (const engine of ["minisearch", "fts5"]) {
      const work = mkdtempSync(join(tmpdir(), `search-index-bench-${profile}-`))
      cpSync(join(dir, "workspace"), join(work, "workspace"), { recursive: true })
      cpSync(join(dir, "app"), join(work, "app"), { recursive: true })
      // Settled files, as a Worktable's are: ones changed moments before a
      // read are read again until their timestamps settle.
      const hourAgo = new Date(Date.now() - 3_600_000)
      for (const entry of readdirSync(join(work, "workspace"), { withFileTypes: true, recursive: true })) {
        utimesSync(join(entry.parentPath, entry.name), hourAgo, hourAgo)
      }
      const runChild = (flag: string) => {
        const run = spawnSync(
          "bun",
          ["scripts/perf/search-index-bench.ts", flag, "1", "--workspace", join(work, "workspace"), "--app", join(work, "app")],
          {
            cwd: REPO_ROOT,
            encoding: "utf8",
            maxBuffer: 64 * 2 ** 20,
            env: { ...process.env, ...(engine === "minisearch" ? { WORKTABLE_SEARCH_INDEX: "minisearch" } : {}) },
          }
        )
        const line = run.stdout.split("\n").find((entry) => entry.startsWith("RESULT "))
        if (!line) throw new Error(`${engine} on ${profile} failed:\n${run.stdout.slice(-2000)}\n${run.stderr.slice(-4000)}`)
        return JSON.parse(line.slice(7))
      }
      const result = runChild("--child") as Result
      Object.assign(result, runChild("--cold"))
      rmSync(work, { recursive: true, force: true })
      results.push(result)
    }
    report[profile] = results
    console.log(profile, JSON.stringify(results, null, 1))
  }
  writeFileSync(join(out, "search-index-bench.json"), JSON.stringify(report, null, 2))
}
