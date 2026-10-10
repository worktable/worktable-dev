#!/usr/bin/env bun
/**
 * Server timings on a perf fixture (Plan 15, W0-04).
 *
 *   bun scripts/perf/server.ts [--profile 100|1k|5k] [--seed 1] [--checkout <dir>]
 *     [--samples 20] [--typing-minutes 2] [--out <dir>]
 *
 * Boots the server from a checkout on a fresh copy of the fixture and records
 * cold boot (to listening and to the first spaces list), the first response of
 * each endpoint, p50/p95 at concurrency 1 and 4 (with /health sampled alongside
 * to show request-loop blocking), and the typing load. Writes result.json and
 * summary.md.
 */
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { cpus, loadavg, totalmem } from "node:os"
import { join, resolve } from "node:path"
import {
  fixtureDir,
  readFixture,
  type FixtureManifest,
  type ProfileName,
} from "./fixtures.ts"
import {
  PERF_ROOT,
  REPO_ROOT,
  copyFixture,
  markdownTable,
  numberArg,
  parseArgs,
  percentile,
  round,
  startServer,
} from "./lib.ts"
import { runTyping, type TypingResult } from "./typing.ts"

interface Sample {
  ms: number
  bytes: number
  ok: boolean
}

export interface RequestStats {
  name: string
  concurrency: number
  samples: number
  errors: number
  p50Ms: number | null
  p95Ms: number | null
  maxMs: number | null
  bytes: number
  /** /health latency sampled every 100 ms while this endpoint ran (concurrency 4 only). */
  healthP95Ms: number | null
}

export interface ServerResult {
  label: string
  checkout: string
  commit: string
  profile: ProfileName
  seed: number
  startedAt: string
  machine: {
    cpus: number
    model: string
    memoryGb: number
    load1: number
    platform: string
    bun: string
  }
  boot: { listenMs: number; firstListMs: number }
  firstResponseMs: Record<string, number>
  requests: RequestStats[]
  typing: TypingResult | null
  /** GET /api/diagnostics/perf at the end of the run, when the server has it. */
  diagnostics: unknown
}

type Endpoint = { name: string; paths: (round: number) => string[] }

/**
 * What the web client requests for these screens today. Opening a document is
 * the route's page request followed by the renderer's content requests.
 */
function endpoints(fixture: FixtureManifest): Endpoint[] {
  const { rich2000, markdown, html } = fixture.probes
  const space = fixture.spaces[0]!
  const docContent = ({ spaceId, path }: { spaceId: string; path: string }) => [
    `/api/spaces/${spaceId}/docs/${path}?conversionCheck=skip`,
  ]
  const htmlDocument = `/api/spaces/${html.spaceId}/widgets/__document/${Buffer.from(html.path).toString("base64url")}`
  const open =
    ({ spaceId, path }: { spaceId: string; path: string }, content: string[]) =>
    () => [
      `/api/spaces/${spaceId}/documents/page?path=${encodeURIComponent(path)}`,
      ...content,
    ]
  return [
    { name: "spaces", paths: () => ["/api/spaces"] },
    {
      name: "documents",
      paths: () => [`/api/spaces/${space}/documents?includeArchived=false`],
    },
    {
      name: "recent",
      paths: () => ["/api/recent?sort=updated&includeTemporary=false&limit=30"],
    },
    {
      name: "activity",
      paths: () => ["/api/activity?limit=30&timezoneOffset=0"],
    },
    { name: "threads", paths: () => ["/api/threads"] },
    { name: "pending", paths: () => ["/api/pending"] },
    {
      name: "search",
      paths: (index) => [
        `/api/search?${new URLSearchParams({
          query: fixture.searchTerms[index % fixture.searchTerms.length]!,
          documentMode: "common",
          maxResults: "20",
        })}`,
      ],
    },
    { name: "open markdown", paths: open(markdown, docContent(markdown)) },
    { name: "open rich 2,000", paths: open(rich2000, docContent(rich2000)) },
    {
      name: "open html",
      paths: open(html, [htmlDocument, `${htmlDocument}/content?theme=light`]),
    },
  ]
}

/** One sample: the endpoint's requests in order, as the client makes them. */
async function sample(url: string, paths: string[]): Promise<Sample> {
  const started = performance.now()
  let bytes = 0
  let ok = true
  for (const path of paths) {
    const response = await fetch(url + path)
    bytes += (await response.arrayBuffer()).byteLength
    ok &&= response.ok
  }
  return { ms: performance.now() - started, bytes, ok }
}

async function measure(
  url: string,
  endpoint: Endpoint,
  concurrency: number,
  samples: number
): Promise<RequestStats> {
  const results: Sample[] = []
  const health: number[] = []
  let done = concurrency === 1
  const sampler = (async () => {
    while (!done) {
      const started = performance.now()
      await fetch(`${url}/health`).then((response) => response.arrayBuffer())
      health.push(performance.now() - started)
      await Bun.sleep(Math.max(0, 100 - (performance.now() - started)))
    }
  })()
  // Stop early on very slow endpoints, keeping at least three samples each.
  const deadline = performance.now() + 60_000
  let next = 0
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (
        next < samples &&
        (next < concurrency * 3 || performance.now() < deadline)
      ) {
        const index = next++
        results.push(await sample(url, endpoint.paths(index)))
      }
    })
  )
  done = true
  await sampler
  const times = results.filter((result) => result.ok).map((result) => result.ms)
  return {
    name: endpoint.name,
    concurrency,
    samples: results.length,
    errors: results.filter((result) => !result.ok).length,
    p50Ms: round(percentile(times, 0.5)),
    p95Ms: round(percentile(times, 0.95)),
    maxMs: round(percentile(times, 1)),
    bytes: results[0]?.bytes ?? 0,
    healthP95Ms: concurrency > 1 ? round(percentile(health, 0.95)) : null,
  }
}

function commitOf(checkout: string): string {
  try {
    const commit = execFileSync(
      "git",
      ["-C", checkout, "rev-parse", "--short=12", "HEAD"],
      { encoding: "utf8" }
    ).trim()
    const dirty = execFileSync(
      "git",
      ["-C", checkout, "status", "--porcelain", "--untracked-files=no"],
      { encoding: "utf8" }
    ).trim()
    return dirty ? `${commit}+changes` : commit
  } catch {
    return "unknown"
  }
}

/** Generate the fixture if it is missing or stale (in a separate process). */
export function ensureFixture(
  profile: ProfileName,
  seed: number
): { dir: string; fixture: FixtureManifest } {
  const dir = fixtureDir(profile, seed)
  let fixture = readFixture(dir)
  if (!fixture) {
    const generated = spawnSync(
      "bun",
      [
        join(import.meta.dirname, "fixtures.ts"),
        "--profile",
        profile,
        "--seed",
        String(seed),
      ],
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
      }
    )
    if (generated.status !== 0)
      throw new Error(`fixture generation failed (${generated.status})`)
    fixture = readFixture(dir)
    if (!fixture)
      throw new Error(`fixture generation wrote no manifest at ${dir}`)
  }
  return { dir, fixture }
}

export async function runServerScenario(options: {
  label: string
  checkout: string
  commit?: string
  profile: ProfileName
  seed: number
  samples: number
  typingMinutes: number
  runDir: string
}): Promise<ServerResult> {
  const { dir, fixture } = ensureFixture(options.profile, options.seed)
  const startedAt = new Date().toISOString()
  const load1 = round(loadavg()[0]!, 2)!
  const run = copyFixture(dir, options.runDir)
  const server = await startServer({ checkout: options.checkout, ...run })
  try {
    const list = await fetch(`${server.url}/api/spaces`)
    await list.arrayBuffer()
    if (!list.ok) throw new Error(`first /api/spaces returned ${list.status}`)
    const boot = {
      listenMs: round(server.listenMs, 0)!,
      firstListMs: round(performance.now() - server.startedAt, 0)!,
    }

    const all = endpoints(fixture)
    const firstResponseMs: Record<string, number> = {}
    for (const endpoint of all.slice(1)) {
      const first = await sample(server.url, endpoint.paths(0))
      if (!first.ok)
        throw new Error(
          `${endpoint.name} failed: ${endpoint.paths(0).join(", ")}`
        )
      firstResponseMs[endpoint.name] = round(first.ms, 0)!
    }
    const requests: RequestStats[] = []
    for (const concurrency of [1, 4]) {
      for (const endpoint of all)
        requests.push(
          await measure(server.url, endpoint, concurrency, options.samples)
        )
    }
    const typing =
      options.typingMinutes > 0
        ? await runTyping({
            url: server.url,
            pid: server.pid,
            workspace: run.workspace,
            spaceId: fixture.probes.rich2000.spaceId,
            path: fixture.probes.rich2000.path,
            minutes: options.typingMinutes,
          })
        : null
    const diagnosticsResponse = await fetch(
      `${server.url}/api/diagnostics/perf`
    )
    const diagnostics = diagnosticsResponse.ok
      ? await diagnosticsResponse.json()
      : null
    return {
      label: options.label,
      checkout: options.checkout,
      commit: options.commit ?? commitOf(options.checkout),
      profile: options.profile,
      seed: options.seed,
      startedAt,
      machine: {
        cpus: cpus().length,
        model: cpus()[0]?.model ?? "unknown",
        memoryGb: Math.round(totalmem() / 2 ** 30),
        load1,
        platform: `${process.platform}-${process.arch}`,
        bun: Bun.version,
      },
      boot,
      firstResponseMs,
      requests,
      typing,
      diagnostics,
    }
  } finally {
    await server.stop()
    writeFileSync(join(options.runDir, "server.log"), server.output())
  }
}

/** Flat metric names for summaries and comparisons; lower is better. */
export function metrics(result: ServerResult): Record<string, number | null> {
  const flat: Record<string, number | null> = {
    "boot to listening (ms)": result.boot.listenMs,
    "boot to first spaces list (ms)": result.boot.firstListMs,
  }
  for (const [name, ms] of Object.entries(result.firstResponseMs))
    flat[`first ${name} (ms)`] = ms
  for (const stats of result.requests) {
    flat[`${stats.name} c${stats.concurrency} p50 (ms)`] = stats.p50Ms
    flat[`${stats.name} c${stats.concurrency} p95 (ms)`] = stats.p95Ms
    if (stats.healthP95Ms !== null)
      flat[`/health p95 during ${stats.name} c${stats.concurrency} (ms)`] =
        stats.healthP95Ms
  }
  const typing = result.typing
  if (typing) {
    flat["typing echo p50 (ms)"] = typing.echoMs.p50
    flat["typing echo p95 (ms)"] = typing.echoMs.p95
    flat["typing /health p95 (ms)"] = typing.healthMs.p95
    flat["typing /health max (ms)"] = typing.healthMs.max
    flat["typing longest unsaved (ms)"] = typing.longestUnsavedMs
    flat["typing server CPU (ms)"] = typing.serverCpuMs
    flat["typing server bytes written (KB)"] =
      typing.serverWriteBytes === null
        ? null
        : Math.round(typing.serverWriteBytes / 1024)
  }
  return flat
}

export function summary(result: ServerResult): string {
  const requestRows = result.requests.map((stats) => [
    stats.name,
    stats.concurrency,
    stats.samples,
    stats.p50Ms,
    stats.p95Ms,
    stats.maxMs,
    stats.healthP95Ms,
    Math.round(stats.bytes / 1024),
  ])
  const lines = [
    `# Server perf: ${result.label} (${result.commit})`,
    "",
    `Fixture ${result.profile}, seed ${result.seed}. ${result.machine.cpus} CPUs (${result.machine.model}), ${result.machine.memoryGb} GB, load ${result.machine.load1}, Bun ${result.machine.bun}.`,
    "",
    `Boot: listening after ${result.boot.listenMs} ms, first spaces list after ${result.boot.firstListMs} ms.`,
    "",
    markdownTable(
      ["First response after boot", "ms"],
      Object.entries(result.firstResponseMs).map(([name, ms]) => [name, ms])
    ),
    "",
    markdownTable(
      [
        "Endpoint",
        "Concurrency",
        "Samples",
        "p50 ms",
        "p95 ms",
        "max ms",
        "/health p95 ms",
        "KB",
      ],
      requestRows
    ),
  ]
  const typing = result.typing
  if (typing) {
    lines.push(
      "",
      `Typing: ${typing.typed} characters over ${typing.minutes} min at ${typing.charactersPerSecond}/s into the 2,000-block document.`,
      "",
      markdownTable(
        ["Measure", "Value"],
        [
          [
            "Echo to second client p50 / p95 / max (ms)",
            `${typing.echoMs.p50} / ${typing.echoMs.p95} / ${typing.echoMs.max}`,
          ],
          ["Characters echoed", `${typing.echoed} of ${typing.typed}`],
          [
            "/health p50 / p95 / max (ms)",
            `${typing.healthMs.p50} / ${typing.healthMs.p95} / ${typing.healthMs.max}`,
          ],
          ["Saves while typing", typing.persists],
          ["Longest stretch without a save (ms)", typing.longestUnsavedMs],
          ["Save after the last keystroke (ms)", typing.saveAfterStopMs],
          ["Saved file has the typed text", typing.savedAllText ? "yes" : "no"],
          ["Server CPU (ms)", typing.serverCpuMs],
          [
            "Server write calls (KB)",
            typing.serverWriteBytes === null
              ? null
              : Math.round(typing.serverWriteBytes / 1024),
          ],
          [
            "Server storage writes (KB)",
            typing.serverDiskBytes === null
              ? null
              : Math.round(typing.serverDiskBytes / 1024),
          ],
        ]
      )
    )
  }
  return `${lines.join("\n")}\n`
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2))
  const profile = (args.get("profile") ?? "100") as ProfileName
  const seed = numberArg(args, "seed", 1)
  const checkout = resolve(args.get("checkout") ?? REPO_ROOT)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const out = resolve(
    args.get("out") ?? join(PERF_ROOT, "results", `${stamp}-server-${profile}`)
  )
  mkdirSync(out, { recursive: true })
  const result = await runServerScenario({
    label: args.get("label") ?? "server",
    checkout,
    profile,
    seed,
    samples: numberArg(args, "samples", 20),
    typingMinutes: args.has("typing-minutes")
      ? Number(args.get("typing-minutes"))
      : 2,
    runDir: join(PERF_ROOT, "runs", "server"),
  })
  writeFileSync(
    join(out, "result.json"),
    `${JSON.stringify(result, null, 2)}\n`
  )
  writeFileSync(join(out, "summary.md"), summary(result))
  console.log(summary(result))
  console.log(`Wrote ${out}`)
  process.exit(0)
}
