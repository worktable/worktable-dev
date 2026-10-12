#!/usr/bin/env bun
/**
 * Summary of a click-trace run: `bun scripts/perf/click-trace-report.ts
 * <result.json>` rewrites summary.md and waterfalls.md beside it.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ClickRecord, ClickTraceResult, Pass } from "./click-trace.ts"
import { markdownTable, median } from "./lib.ts"

const PASSES: { pass: Pass; label: string }[] = [
  { pass: "cold", label: "cold load" },
  { pass: "first", label: "first in tab" },
  { pass: "warm", label: "warm, new target" },
  { pass: "revisit", label: "revisit" },
  { pass: "idle", label: "revisit after idle" },
  { pass: "reopen", label: "reopen app" },
]

const JOURNEYS = [
  "open the app at Home",
  "open Space",
  "open Markdown doc",
  "open rich doc",
  "open rich doc (2,000 blocks)",
  "open HTML doc",
  "back to Home",
  "open Threads",
  "open a thread",
  "search",
]

function med(values: (number | null | undefined)[]): number | null {
  const present = values.filter(
    (value): value is number => typeof value === "number"
  )
  const value = median(present)
  return value === null ? null : Math.round(value)
}

function kb(bytes: number): number {
  return Math.round(bytes / 102.4) / 10
}

function group(clicks: ClickRecord[]) {
  const groups = new Map<string, ClickRecord[]>()
  for (const click of clicks) {
    const key = `${click.network}|${click.pass}|${click.journey}`
    groups.set(key, [...(groups.get(key) ?? []), click])
  }
  return (network: string, pass: Pass, journey: string) =>
    groups.get(`${network}|${pass}|${journey}`) ?? []
}

function apiCount(click: ClickRecord, from = -Infinity) {
  return click.requests.filter(
    (request) => request.kind === "api" && request.start >= from
  ).length
}

function chunks(click: ClickRecord) {
  const fetched = click.requests.filter(
    (request) =>
      (request.kind === "script" || request.kind === "style") &&
      !request.cached &&
      request.start >= 0
  )
  return {
    count: fetched.length,
    bytes: fetched.reduce((sum, request) => sum + request.transfer, 0),
  }
}

/** Network time on the chain, split into its parts, plus the gaps. */
function parts(click: ClickRecord, latencyMs: number) {
  const content = click.contentMs ?? click.settledMs
  const gapMs = click.mainThread?.chainGaps.gapMs ?? null
  const network = gapMs === null ? null : content - gapMs
  const steps = click.chain.filter((step) => step.end > 0)
  // Chrome's emulated latency lands in the response phases, so split each
  // step's duration: connection queue, server time, one round trip, rest.
  let rtt = 0
  let server = 0
  let transfer = 0
  let queue = 0
  for (const step of steps) {
    const duration = step.end - Math.max(0, step.start)
    const ownServer = step.server ?? 0
    const ownQueue = Math.min(step.queue, duration)
    const ownRtt = Math.min(
      latencyMs,
      Math.max(0, duration - ownQueue - ownServer)
    )
    queue += ownQueue
    server += ownServer
    rtt += ownRtt
    transfer += Math.max(0, duration - ownQueue - ownServer - ownRtt)
  }
  const gaps = click.mainThread?.chainGaps
  return {
    content,
    depth: steps.length,
    network,
    rtt,
    server,
    transfer,
    queue,
    parse: gaps?.parseCompile ?? null,
    script: gaps?.script ?? null,
    style: gaps?.styleLayout ?? null,
    paint: gaps?.paint ?? null,
    other: gaps ? gaps.other + gaps.gc + gaps.parseHTML : null,
    idle: gaps ? Math.max(0, gaps.gapMs - gaps.busy) : null,
  }
}

export function summary(result: ClickTraceResult): string {
  const find = group(result.clicks)
  const lines: string[] = []
  lines.push(
    `# Click trace: ${result.profile} fixture, ${result.setup.spaces} Spaces, ${result.setup.documents} documents`,
    "",
    `Commit ${result.commit}, ${result.startedAt}. ${result.machine.cpus} × ${result.machine.model}, ${result.machine.memoryGb} GB, load ${result.machine.load1.toFixed(2)} at start, Bun ${result.machine.bun}, Chromium ${result.machine.chromium}. ${result.options.rounds} rounds; idle ${result.options.idleSeconds} s; desktop hovers ${result.options.hoverMs} ms before clicking; tracing ${result.options.trace ? "on" : "off"}.`,
    "",
    "Times are medians over rounds, in ms from the click (or navigation start). **Content** is the per-screen predicate in `click-trace-page.ts`; **settled** is the last request, DOM change or long task before 1 s of quiet.",
    ""
  )
  for (const network of result.options.networks) {
    const name = network.name
    lines.push(
      `## ${name}: ${network.via === "proxy" ? "HTTP/2 proxy" : "HTTP/1.1 direct"}, ${network.latencyMs} ms RTT${network.downKbps ? `, ${network.downKbps / 1000}/${network.upKbps / 1000} Mbps` : ""}${network.cpu > 1 ? `, ${network.cpu}x CPU` : ""}`,
      "",
      "### Time to content (settled)",
      ""
    )
    lines.push(
      markdownTable(
        ["Journey", ...PASSES.map((pass) => pass.label)],
        JOURNEYS.map((journey) => [
          journey,
          ...PASSES.map(({ pass }) => {
            const clicks = find(name, pass, journey)
            if (clicks.length === 0) return ""
            const content = med(clicks.map((click) => click.contentMs))
            const settled = med(clicks.map((click) => click.settledMs))
            const missing = clicks.filter(
              (click) => click.contentMs === null
            ).length
            return `${content ?? "n/a"} (${settled})${missing ? ` [${missing} missed]` : ""}`
          }),
        ])
      ),
      "",
      "### Requests: API requests / chain depth to content / JS+CSS fetched (KB)",
      ""
    )
    lines.push(
      markdownTable(
        ["Journey", ...PASSES.map((pass) => pass.label)],
        JOURNEYS.map((journey) => [
          journey,
          ...PASSES.map(({ pass }) => {
            const clicks = find(name, pass, journey)
            if (clicks.length === 0) return ""
            const api = med(clicks.map((click) => apiCount(click)))
            const depth = med(clicks.map((click) => click.chain.length))
            const fetched = clicks.map(chunks)
            const count = med(fetched.map((item) => item.count))
            const bytes = med(fetched.map((item) => item.bytes)) ?? 0
            return `${api} / ${depth} / ${count} (${kb(bytes)})`
          }),
        ])
      ),
      ""
    )
    lines.push(
      "### Where the time to content goes (cold, first in tab, warm and revisit)",
      "",
      "Network is the union of the chain's requests; the chain's parts overlap, so they need not add up. Main-thread columns are self time inside the chain's gaps (from the trace); idle is gap time with the main thread free (timers, IndexedDB, sockets, the search debounce).",
      ""
    )
    const rows: (string | number | null)[][] = []
    for (const pass of ["cold", "first", "warm", "revisit"] as Pass[]) {
      for (const journey of JOURNEYS) {
        const clicks = find(name, pass, journey)
        if (clicks.length === 0) continue
        const split = clicks.map((click) => parts(click, network.latencyMs))
        const pick = (key: keyof ReturnType<typeof parts>) =>
          med(split.map((item) => item[key]))
        rows.push([
          `${pass}: ${journey}`,
          pick("content"),
          pick("depth"),
          pick("network"),
          pick("rtt"),
          pick("server"),
          pick("transfer"),
          pick("queue"),
          pick("parse"),
          pick("script"),
          pick("style"),
          pick("paint"),
          pick("other"),
          pick("idle"),
        ])
      }
    }
    lines.push(
      markdownTable(
        [
          "Click",
          "Content",
          "Chain",
          "Network",
          "Round trips",
          "Server",
          "Transfer",
          "Queue",
          "Parse/compile",
          "Script",
          "Style/layout",
          "Paint",
          "Other",
          "Idle",
        ],
        rows
      ),
      ""
    )
    const rich = ["open rich doc", "open rich doc (2,000 blocks)"]
    const richRows: (string | number | null)[][] = []
    for (const { pass, label } of PASSES)
      for (const journey of rich) {
        const clicks = find(name, pass, journey)
        if (clicks.length === 0) continue
        const yjs = (click: ClickRecord) =>
          click.ws.find((socket) => socket.url.startsWith("/yjs"))
        richRows.push([
          `${label}: ${journey}`,
          med(clicks.map((click) => click.milestones["opening"])),
          med(clicks.map((click) => click.contentMs)),
          med(clicks.map((click) => click.editableMs)),
          med(clicks.map((click) => yjs(click)?.created)),
          med(clicks.map((click) => yjs(click)?.open)),
          med(clicks.map((click) => yjs(click)?.syncStep2)),
          med(clicks.map((click) => kb(yjs(click)?.bytesIn ?? 0))),
        ])
      }
    lines.push(
      "### Rich documents: preview, editable and the collaboration room",
      "",
      markdownTable(
        [
          "Click",
          "Snapshot in HTML",
          "Readable",
          "Editable",
          "Yjs socket created",
          "Open",
          "Synced",
          "KB in",
        ],
        richRows
      ),
      "",
      "### Main thread to settled (first in tab): long tasks and busy time",
      ""
    )
    lines.push(
      markdownTable(
        [
          "Journey",
          "Long tasks",
          "Total",
          "Longest",
          "Busy",
          "Script",
          "Parse/compile",
          "Style/layout",
        ],
        JOURNEYS.map((journey) => {
          const clicks = find(name, "first", journey)
          return [
            journey,
            med(clicks.map((click) => click.longTasks.count)),
            med(clicks.map((click) => click.longTasks.totalMs)),
            med(clicks.map((click) => click.longTasks.maxMs)),
            med(clicks.map((click) => click.mainThread?.toSettled.busy)),
            med(clicks.map((click) => click.mainThread?.toSettled.script)),
            med(
              clicks.map((click) => click.mainThread?.toSettled.parseCompile)
            ),
            med(clicks.map((click) => click.mainThread?.toSettled.styleLayout)),
          ]
        })
      ),
      ""
    )
  }
  return lines.join("\n")
}

export function waterfalls(result: ClickTraceResult): string {
  const lines: string[] = [
    "# Waterfalls (round 1)",
    "",
    "Times in ms from the click. `*` marks the chain to content. Phases: queue / wait (request to first byte) / download. Server is Server-Timing total.",
    "",
  ]
  for (const click of result.clicks.filter((item) => item.round === 1)) {
    lines.push(
      `## ${click.network} · ${click.pass} · ${click.journey} (${click.target})`,
      "",
      `content ${click.contentMs ?? "n/a"} ms, settled ${click.settledMs} ms${click.settleCapped ? " (capped)" : ""}${click.editableMs !== null ? `, editable ${click.editableMs} ms` : ""}${click.hoverLeadMs ? `, hover ${click.hoverLeadMs} ms before click` : ""}; milestones ${JSON.stringify(click.milestones)}; long tasks ${click.longTasks.count} (${click.longTasks.totalMs} ms)${click.loafScripts?.length ? `; long-frame scripts ${click.loafScripts.map((script) => `${script.source} ${script.ms}`).join(", ")}` : ""}`,
      "",
      "```"
    )
    const chain = new Set(
      click.chain.map((step) => `${step.label}@${step.start}`)
    )
    for (const request of click.requests) {
      const mark = chain.has(`${request.label}@${request.start}`) ? "*" : " "
      lines.push(
        `${mark} ${String(request.start).padStart(7)} → ${String(request.end).padStart(7)}  ${request.kind.padEnd(8)} ${request.queue}/${request.wait}/${request.download}${request.server !== null ? ` srv ${request.server}` : ""} ${kb(request.transfer)}KB${request.cached ? " cached" : ""} ${request.status ?? ""} ${request.label.slice(0, 140)}${request.initiator ? `  ← ${request.initiator.slice(0, 80)}` : ""}${request.failed ? ` FAILED ${request.failed}` : ""}`
      )
    }
    for (const socket of click.ws)
      lines.push(
        `  ws ${socket.url.slice(0, 100)} created ${socket.created} open ${socket.open} first ${socket.firstMessage} sync2 ${socket.syncStep2} msgs ${socket.messages} ${kb(socket.bytesIn)}KB`
      )
    lines.push("```", "")
  }
  return lines.join("\n")
}

export function writeReport(result: ClickTraceResult, outDir: string): void {
  writeFileSync(join(outDir, "summary.md"), summary(result))
  writeFileSync(join(outDir, "waterfalls.md"), waterfalls(result))
}

if (import.meta.main) {
  const file = process.argv[2]
  if (!file) throw new Error("usage: click-trace-report.ts <result.json>")
  const result = JSON.parse(readFileSync(file, "utf8")) as ClickTraceResult
  writeReport(result, dirname(file))
  console.log(`wrote ${join(dirname(file), "summary.md")}`)
}
