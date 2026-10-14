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
  { pass: "churn", label: "revisit, team churn" },
  { pass: "backup", label: "revisit, during backup" },
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

/** Time the chain's requests cover between the action and content. */
function networkMs(steps: ClickRecord["chain"], content: number): number {
  const spans = steps
    .map((step) => [Math.max(0, step.start), Math.min(step.end, content)])
    .filter(([start, end]) => end! > start!)
    .sort((left, right) => left[0]! - right[0]!)
  let covered = 0
  let cursor = 0
  for (const [start, end] of spans) {
    covered += Math.max(0, end! - Math.max(start!, cursor))
    cursor = Math.max(cursor, end!)
  }
  return covered
}

/**
 * Network time on the chain, the parts of the requests that started after
 * the click (a hover-started request's server time cannot be split at the
 * click), and the main thread in the chain's gaps (with a trace). Null when
 * the click never reached its content.
 */
function parts(click: ClickRecord, latencyMs: number) {
  const content = click.contentMs
  if (content === null) return null
  const steps = click.chain.filter((step) => step.end > 0)
  const network = networkMs(steps, content)
  // Chrome's emulated latency lands in the response phases, so split each
  // step's duration: connection queue, server time, one round trip, rest.
  let rtt = 0
  let server = 0
  let transfer = 0
  let queue = 0
  for (const step of steps.filter((item) => item.start >= 0)) {
    const duration = step.end - Math.max(0, step.start)
    const ownQueue = Math.min(step.queue, duration)
    const ownServer = Math.min(step.server ?? 0, duration - ownQueue)
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

/** Document content read on a revisit: the page check aside, a cache miss. */
function contentRequests(click: ClickRecord): string[] {
  return click.requests
    .filter(
      (request) =>
        !request.cached &&
        (request.label.includes("/documents/content?") ||
          /\/api\/spaces\/[^/]+\/docs\//.test(request.label))
    )
    .map((request) => request.label)
}

export function summary(result: ClickTraceResult): string {
  const find = group(result.clicks)
  const lines: string[] = []
  // Older results have no team fields; the churn and backup passes are optional.
  const passes = PASSES.filter(({ pass }) =>
    result.clicks.some((click) => click.pass === pass)
  )
  lines.push(
    `# Click trace: ${result.profile} fixture, ${result.setup.spaces} Spaces, ${result.setup.documents} documents`,
    "",
    `Commit ${result.commit}, ${result.startedAt}. Clicked by ${result.as === "member" ? `a team member who can open ${result.team?.memberSpaces} of ${result.setup.spaces + (result.team?.hiddenSpaces ?? 0)} Spaces` : result.as === "owner" ? "the team owner" : "the solo owner"}. ${result.machine.cpus} × ${result.machine.model}, ${result.machine.memoryGb} GB, load ${result.machine.load1.toFixed(2)} at start, Bun ${result.machine.bun}, Chromium ${result.machine.chromium}. ${result.options.rounds} rounds; idle ${result.options.idleSeconds} s; desktop hovers ${result.options.hoverMs} ms before clicking; tracing ${result.options.trace ? "on" : "off"}.`,
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
        ["Journey", ...passes.map((pass) => pass.label)],
        JOURNEYS.map((journey) => [
          journey,
          ...passes.map(({ pass }) => {
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
        ["Journey", ...passes.map((pass) => pass.label)],
        JOURNEYS.map((journey) => [
          journey,
          ...passes.map(({ pass }) => {
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
        const split = clicks
          .map((click) => parts(click, network.latencyMs))
          .filter((item) => item !== null)
        if (split.length === 0) continue
        const pick = (key: keyof NonNullable<ReturnType<typeof parts>>) =>
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
    for (const { pass, label } of passes)
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
  lines.push(
    ...revisitContent(result),
    ...churnSection(result),
    ...backupSection(result)
  )
  return lines.join("\n")
}

function revisitContent(result: ClickTraceResult): string[] {
  const revisits = result.clicks.filter((click) =>
    ["revisit", "idle", "churn", "backup"].includes(click.pass)
  )
  if (revisits.length === 0) return []
  const lines = [
    "## Document content requests on revisits",
    "",
    "Requests for a document's content (`/documents/content`, `/docs/…`) that the browser did not serve from its cache, on clicks to documents already opened in the tab.",
    "",
  ]
  const rows: (string | number)[][] = []
  for (const network of result.options.networks)
    for (const pass of ["revisit", "idle", "churn", "backup"] as Pass[]) {
      const clicks = revisits.filter(
        (click) =>
          click.network === network.name &&
          click.pass === pass &&
          click.journey.startsWith("open ") &&
          click.journey.includes(" doc")
      )
      if (clicks.length === 0) continue
      const found = clicks.flatMap(contentRequests)
      rows.push([
        network.name,
        pass,
        clicks.length,
        found.length,
        found.slice(0, 3).join(", "),
      ])
    }
  lines.push(
    markdownTable(
      ["Network", "Pass", "Document clicks", "Content requests", "Examples"],
      rows
    ),
    ""
  )
  return lines
}

function churnSection(result: ClickTraceResult): string[] {
  if (!result.churn?.length) return []
  const lines = [
    "## Team churn",
    "",
    "The owner makes one change before each click of the churn pass; the window is the 3 s after it, until the tab is quiet. A change that does not alter the member's own access should cause no reload, no navigation and no request.",
    "",
  ]
  const kinds = [...new Set(result.churn.map((item) => item.kind))]
  lines.push(
    markdownTable(
      [
        "Change",
        "Affects member",
        "Changes",
        "Reloads",
        "Navigations",
        "Requests (max per change)",
        "Requested",
      ],
      kinds.map((kind) => {
        const items = result.churn.filter((item) => item.kind === kind)
        return [
          kind,
          items[0]!.affectsMember ? "yes" : "no",
          items.length,
          items.reduce((sum, item) => sum + item.reloads, 0),
          items.reduce((sum, item) => sum + item.navigations.length, 0),
          `${items.reduce((sum, item) => sum + item.requests.length, 0)} (${Math.max(...items.map((item) => item.requests.length))})`,
          [
            ...new Set(
              items.flatMap((item) =>
                item.requests.map((label) => label.split("?")[0]!)
              )
            ),
          ]
            .slice(0, 4)
            .join(", "),
        ]
      })
    ),
    ""
  )
  return lines
}

function backupSection(result: ClickTraceResult): string[] {
  if (!result.backup?.length) return []
  const revisitMax = (network: string) => {
    const values = result.clicks
      .filter((click) => click.network === network && click.pass === "revisit")
      .map((click) => click.contentMs ?? 0)
    return values.length ? Math.max(...values) : null
  }
  return [
    "## Backup during load",
    "",
    "Live operator snapshots back to back while the tab clicks through revisits and a second client reads every 100 ms and writes every second. Reads and writes count when they overlap a snapshot.",
    "",
    markdownTable(
      [
        "Network",
        "Round",
        "Snapshots (ok)",
        "Snapshot ms (max)",
        "Reads",
        "Failed reads",
        "Writes",
        "Refused writes",
        "Write wait p50 / max ms",
        "Tab failures",
        "Slowest click (revisit max)",
      ],
      result.backup.map((item) => [
        item.network,
        item.round,
        `${item.snapshots.length} (${item.snapshots.filter((snapshot) => snapshot.status === 200).length})`,
        Math.round(
          Math.max(0, ...item.snapshots.map((snapshot) => snapshot.ms))
        ),
        item.reads.total,
        item.reads.failed,
        item.writes.total,
        item.writes.refused,
        `${item.writes.p50Ms} / ${item.writes.maxMs}`,
        item.tabFailures.length,
        `${item.maxClickMs ?? "n/a"} ${item.maxClickJourney ?? ""} (${revisitMax(item.network) ?? "n/a"})`,
      ])
    ),
    "",
    ...result.backup.flatMap((item) =>
      [
        ...item.reads.failures,
        ...item.tabFailures,
        ...item.snapshots
          .filter((snapshot) => snapshot.error)
          .map((snapshot) => `snapshot ${snapshot.status}: ${snapshot.error}`),
      ]
        .slice(0, 10)
        .map((line) => `- ${item.network} round ${item.round}: ${line}`)
    ),
    "",
  ]
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
