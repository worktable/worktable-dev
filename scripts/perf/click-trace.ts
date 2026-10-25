#!/usr/bin/env bun
/**
 * Click timings in a real browser (Plan 15, client side).
 *
 *   bun scripts/perf/click-trace.ts [--profile 1k] [--seed 1] [--rounds 3]
 *     [--networks local,desktop,phone,phone-h1] [--idle-seconds 20]
 *     [--spaces 28] [--content-timeout 45] [--caddy caddy] [--no-trace]
 *     [--raw-traces]
 *     [--checkout <dir>] [--as solo|owner|member] [--churn] [--backup]
 *     [--passes cold,first,warm,revisit,reopen,idle] [--idle-window <s>]
 *     [--out <dir>]
 *
 * Needs a perf fixture (`bun run perf:fixtures --profile 1k`), a production
 * web build (`bun run --cwd apps/web build`), Playwright's Chromium
 * (`bunx playwright@1.61.1 install --with-deps chromium`) and, for the
 * desktop and phone profiles, Caddy on PATH (or `--caddy <path>`).
 *
 * Boots the server from a checkout (`--checkout`, default this one, with its
 * own web build) on a fresh copy of the fixture, serving the web build with
 * WORKTABLE_REQUIRE_AUTH=1, as an instance behind a tunnel runs. Adds Spaces
 * up to `--spaces`. `--as` picks who clicks: the solo owner (default), or,
 * with Worktable Teams turned on in the copy (team.ts), the team's owner or a
 * member who can open about half the Spaces. Then drives headless Chromium
 * through the journeys below under each network profile (Chrome DevTools
 * Protocol network and CPU emulation):
 *
 * - local: no emulation, HTTP/1.1 straight to the server;
 * - desktop: 40 ms round trip, through a local HTTP/2 proxy (as Cloudflare);
 * - phone: 150 ms round trip, 10 Mbps down, 3 Mbps up, 4x CPU slowdown,
 *   Pixel 7 viewport and touch, through the HTTP/2 proxy;
 * - phone-h1: the phone over HTTP/1.1 straight to the server (as Tailscale
 *   to the server's port), where Chromium opens at most six connections.
 *
 * Each round runs, per profile: cold page loads of every screen (new browser
 * context, empty cache); then one tab that clicks through the journeys four
 * times: first visit in the tab, warm with new targets, revisit, and revisit
 * after `--idle-seconds` of idle before each click; and reopening the app with
 * a warm HTTP cache. Desktop clicks hover 150 ms first, as a mouse does; the
 * phone taps.
 *
 * Per click it records the time to meaningful content (a per-screen DOM
 * predicate, see click-trace-page.ts) and to settled (no requests, DOM
 * changes or long tasks for 1 s), every request with its phases, bytes,
 * Server-Timing and initiator, JS and CSS chunks, long tasks and long
 * animation frames, WebSockets (for rich documents, the Yjs connect and sync),
 * and with tracing a main-thread breakdown from a Chrome trace.
 *
 * Two optional passes follow, in the same tab, as revisits:
 *
 * - `--churn` (member only): before each click the owner makes an admin
 *   change, every 5 to 10 s in turn: an invitation, an agent rename, a new
 *   Space the member cannot see, a grant change for another member, and, as
 *   the control, a grant change for the member on a Space no journey opens.
 *   Per change it records the measured tab's full reloads, navigations and
 *   API requests in the following 3 s.
 * - `--backup`: live operator snapshots run back to back (the entry point a
 *   hosted backup uses) while the tab clicks and a second client reads and
 *   writes; it records failed reads, write waits and the slowest click.
 *
 * `--passes` limits the passes (all by default). `--idle-window <s>` leaves
 * the tab at Home after reopening it and records every request it makes
 * over that many seconds. perf-smoke (smoke.ts) uses both.
 *
 * `--raw-traces` adds JS sampling (a V8 CPU profile) and JS stacks on trace
 * events to every Chrome trace, and saves each measured action's trace, every
 * round and profile, to traces/, to name the functions behind a long task.
 *
 * Writes result.json, summary.md and waterfalls.md to
 * .local-dev/perf/results/<time>-clicks-<profile>/ (or --out), with
 * screenshots of round 1.
 */
import { gzipSync } from "node:zlib"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createHash, X509Certificate } from "node:crypto"
import { cpus, loadavg, totalmem } from "node:os"
import { join, resolve } from "node:path"
import { execFileSync, spawn } from "node:child_process"
import {
  chromium,
  devices,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Locator,
  type Page,
} from "playwright-core"
import {
  fixtureDir,
  readFixture,
  type FixtureManifest,
  type ProfileName,
} from "./fixtures.ts"
import {
  PERF_ROOT,
  REPO_ROOT,
  freePort,
  numberArg,
  parseArgs,
  restoreFixture,
  startServer,
  waitForIdle,
  type ServerProcess,
} from "./lib.ts"
import {
  installInstrumentation,
  type ArmedResult,
  type Expectation,
} from "./click-trace-page.ts"
import {
  RAW_TRACE_CATEGORIES,
  TRACE_CATEGORIES,
  breakdown,
  readMainThread,
  type Breakdown,
} from "./trace-breakdown.ts"
import { writeReport } from "./click-trace-report.ts"
import {
  api,
  enableTeam,
  setGrant,
  signInSoloOwner,
  signInTeam,
  type Cookie,
  type Identity,
  type TeamRoles,
} from "./team.ts"

// ── Profiles ──────────────────────────────────────────────────────────

export interface Network {
  name: "local" | "desktop" | "phone" | "phone-h1"
  latencyMs: number
  downKbps: number
  upKbps: number
  cpu: number
  phone: boolean
  /**
   * "proxy": through a local HTTP/2 TLS proxy (Caddy), as through Cloudflare,
   * so requests are not limited to six connections. "direct": plain HTTP/1.1
   * to the server, as over Tailscale to the server's port.
   */
  via: "direct" | "proxy"
}

const NETWORKS: Record<Network["name"], Network> = {
  local: {
    name: "local",
    latencyMs: 0,
    downKbps: 0,
    upKbps: 0,
    cpu: 1,
    phone: false,
    via: "direct",
  },
  desktop: {
    name: "desktop",
    latencyMs: 40,
    downKbps: 0,
    upKbps: 0,
    cpu: 1,
    phone: false,
    via: "proxy",
  },
  phone: {
    name: "phone",
    latencyMs: 150,
    downKbps: 10_000,
    upKbps: 3_000,
    cpu: 4,
    phone: true,
    via: "proxy",
  },
  "phone-h1": {
    name: "phone-h1",
    latencyMs: 150,
    downKbps: 10_000,
    upKbps: 3_000,
    cpu: 4,
    phone: true,
    via: "direct",
  },
}

const HOVER_MS = 150
let CONTENT_TIMEOUT_MS = 45_000
const QUIET_MS = 1_000
const SETTLE_MAX_MS = 20_000

// ── Records ───────────────────────────────────────────────────────────

export interface Req {
  url: string
  /** Path and query, shortened for reading. */
  label: string
  kind:
    | "document"
    | "api"
    | "script"
    | "style"
    | "font"
    | "frame"
    | "image"
    | "other"
  /** ms relative to the action's start (t0); negative when hover started it. */
  start: number
  end: number
  /** Waiting for a connection (queueing, stalled, connect). */
  queue: number
  /** Request sent to first byte: round trip plus server time. */
  wait: number
  download: number
  /** Server-Timing `total`, when the response has one. */
  server: number | null
  transfer: number
  encoded: number
  decoded: number
  cached: boolean
  status: number | null
  protocol: string | null
  initiator: string | null
  failed?: string
  /** HTTP redirects followed before the final response. */
  redirects?: number
}

export interface WsRec {
  url: string
  created: number
  open: number | null
  firstMessage: number | null
  syncStep2: number | null
  messages: number
  bytesIn: number
  closed: number | null
}

export interface ChainStep {
  label: string
  kind: Req["kind"]
  start: number
  end: number
  queue: number
  wait: number
  server: number | null
  download: number
}

export interface ClickRecord {
  network: Network["name"]
  round: number
  pass: Pass
  journey: string
  target: string
  /** Page time of the action (0 for page loads). */
  t0: number
  /** ms from t0. */
  contentMs: number | null
  paintMs: number | null
  editableMs: number | null
  /** Every armed predicate, ms from t0 (for example `opening`, the server's snapshot). */
  milestones: Record<string, number | null>
  settledMs: number
  settleCapped: boolean
  hoverLeadMs: number | null
  requests: Req[]
  ws: WsRec[]
  longTasks: { count: number; totalMs: number; maxMs: number }
  loaf: {
    count: number
    totalMs: number
    blockingMs: number
    scriptMs: number
    styleLayoutMs: number
  }
  chain: ChainStep[]
  /** Script time in long animation frames by source file and entry point, top 6. */
  loafScripts: { source: string; ms: number }[]
  /** Main-thread time from the trace: to content, to settled, and in the gaps of the chain before content. */
  mainThread: {
    toContent: Breakdown
    toSettled: Breakdown
    chainGaps: Breakdown & { gapMs: number }
  } | null
  navigation: Record<string, number> | null
  /** Elements in the app's document once settled (frames not included). */
  domNodes?: number
  screenshot?: string
}

/**
 * Requests an open tab made while nobody touched it, over a fixed window
 * after reopening the app at Home (`--idle-window`).
 */
export interface IdleWindowRecord {
  network: Network["name"]
  round: number
  seconds: number
  requests: string[]
}

export type Pass =
  | "cold"
  | "first"
  | "warm"
  | "revisit"
  | "idle"
  | "reopen"
  | "churn"
  | "backup"

/** One admin change by the owner while the member's tab is open. */
export interface ChurnRecord {
  network: Network["name"]
  round: number
  kind: ChurnKind
  /** Whether the change alters what the measured member can open. */
  affectsMember: boolean
  /** ms the owner's API calls took. */
  changeMs: number
  /** Full page loads of the measured tab in the window after the change. */
  reloads: number
  /** Route changes of the measured tab in that window (none were clicked). */
  navigations: string[]
  /** API requests the tab made in that window. */
  requests: string[]
}

export type ChurnKind =
  | "invite"
  | "agent rename"
  | "hidden Space"
  | "other's grant"
  | "own grant"

/** A pass of clicks with live operator snapshots running back to back. */
export interface BackupRecord {
  network: Network["name"]
  round: number
  snapshots: { startMs: number; ms: number; status: number; error?: string }[]
  /** The second client's reads and writes while a snapshot ran. */
  reads: { total: number; failed: number; failures: string[] }
  writes: { total: number; refused: number; maxMs: number; p50Ms: number }
  /** Requests of the measured tab that failed or got a 5xx during the pass. */
  tabFailures: string[]
  /** Slowest content time of the pass's clicks, and its journey. */
  maxClickMs: number | null
  maxClickJourney: string | null
}

export interface ClickTraceResult {
  commit: string
  profile: ProfileName
  seed: number
  /** Who clicked: the solo owner, or the team's owner or member. */
  as: Identity
  team: {
    memberSpaces: number
    hiddenSpaces: number
    agents: number
  } | null
  churn: ChurnRecord[]
  backup: BackupRecord[]
  idleWindows?: IdleWindowRecord[]
  startedAt: string
  machine: {
    cpus: number
    model: string
    memoryGb: number
    load1: number
    platform: string
    bun: string
    chromium: string
  }
  setup: {
    spaces: number
    documents: number
    bootMs: number
    idleMs: number | null
    targets: Targets
  }
  options: {
    rounds: number
    networks: Network[]
    idleSeconds: number
    trace: boolean
    /** JS sampling was on, which slows the page: not timing evidence. */
    rawTraces?: boolean
    hoverMs: number
    churn: boolean
    backup: boolean
    passes?: Pass[]
    idleWindowSeconds?: number
  }
  clicks: ClickRecord[]
}

// ── Targets ───────────────────────────────────────────────────────────

interface SpaceTarget {
  id: string
  name: string
}

interface DocTarget {
  spaceId: string
  spaceName: string
  path: string
  kind: "md" | "rich" | "html" | "file"
  /** First heading (Markdown and rich text). */
  heading: string
  /** Files the document embeds, which its content waits for. */
  images?: string[]
}

interface ThreadTarget {
  href: string
  id: string
}

export interface Targets {
  spaceA: SpaceTarget
  spaceB: SpaceTarget
  mdA: DocTarget
  mdB: DocTarget
  richA: DocTarget
  richB: DocTarget
  richLarge: DocTarget
  htmlA: DocTarget
  htmlB: DocTarget
  file: DocTarget
  withImages: DocTarget
  threadsHref: string
  threadA: ThreadTarget
  threadB: ThreadTarget
  searchA: string
  searchB: string
}

// ── Browser session ───────────────────────────────────────────────────

interface CdpRequest {
  id: string
  url: string
  type: string
  wallMs: number
  ts: number
  endTs: number | null
  initiator: string | null
  status: number | null
  protocol: string | null
  cached: boolean
  encoded: number
  failed: string | null
  redirects: number
}

interface Session {
  network: Network
  context: BrowserContext
  page: Page
  cdp: CDPSession
  requests: Map<string, CdpRequest>
  inflight: Set<string>
  lastNet: number
  base: string
  /** Main-frame document loads and same-document route changes. */
  loads: { at: number; url: string }[]
  routes: { at: number; url: string }[]
}

function contextOptions(network: Network) {
  if (network.phone) {
    const { defaultBrowserType: _ignored, ...pixel } = devices["Pixel 7"]!
    return pixel
  }
  return { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }
}

function initiatorOf(initiator: unknown): string | null {
  const value = initiator as {
    type?: string
    url?: string
    stack?: {
      callFrames?: { url?: string; functionName?: string }[]
      parent?: unknown
    }
  }
  let stack = value?.stack
  while (stack) {
    const frame = stack.callFrames?.find((candidate) => candidate.url)
    if (frame?.url)
      return `${value.type}:${shortUrl(frame.url)}${frame.functionName ? `#${frame.functionName}` : ""}`
    stack = stack.parent as typeof stack
  }
  return value?.type
    ? `${value.type}${value.url ? `:${shortUrl(value.url)}` : ""}`
    : null
}

function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

/**
 * The measured person's session cookies per origin (the server directly, and
 * the HTTP/2 proxy). The server runs with WORKTABLE_REQUIRE_AUTH=1, as an
 * instance reached through a tunnel does: it then compresses responses to
 * loopback peers too, and writes the boot facts for the signed-in person.
 * The solo owner's cookie serves both origins; a team session is signed in
 * per origin, because its cookie name depends on the scheme.
 */
const sessionCookies = new Map<string, Cookie[]>()

async function newContext(
  browser: Browser,
  base: string,
  options: Parameters<Browser["newContext"]>[0] = {}
): Promise<BrowserContext> {
  const context = await browser.newContext({
    ...options,
    baseURL: base,
  })
  const cookies = sessionCookies.get(base) ?? []
  if (cookies.length > 0)
    await context.addCookies(
      cookies.map((cookie) => ({ ...cookie, url: base }))
    )
  return context
}

async function openSession(
  browser: Browser,
  network: Network,
  base: string,
  expect?: { expectations: Expectation[] }
): Promise<Session> {
  const context = await newContext(browser, base, contextOptions(network))
  await context.addInitScript(installInstrumentation)
  if (expect)
    await context.addInitScript({
      content: `window.__wtExpect = ${JSON.stringify({ ...expect, timeoutMs: CONTENT_TIMEOUT_MS })}`,
    })
  const page = await context.newPage()
  const cdp = await context.newCDPSession(page)
  const session: Session = {
    network,
    context,
    page,
    cdp,
    requests: new Map(),
    inflight: new Set(),
    lastNet: performance.now(),
    base,
    loads: [],
    routes: [],
  }
  const touch = () => {
    session.lastNet = performance.now()
  }
  let mainFrame: string | null = null
  cdp.on("Page.frameNavigated", (event) => {
    if (event.frame.parentId) return
    mainFrame = event.frame.id
    session.loads.push({ at: performance.now(), url: event.frame.url })
  })
  cdp.on("Page.navigatedWithinDocument", (event) => {
    if (event.frameId === mainFrame)
      session.routes.push({ at: performance.now(), url: event.url })
  })
  await cdp.send("Page.enable")
  cdp.on("Network.requestWillBeSent", (event) => {
    touch()
    const existing = session.requests.get(event.requestId)
    // A redirect reuses the id; keep the first start.
    session.requests.set(event.requestId, {
      id: event.requestId,
      url: event.request.url,
      type: event.type ?? "Other",
      wallMs: existing?.wallMs ?? event.wallTime * 1000,
      ts: existing?.ts ?? event.timestamp,
      endTs: null,
      initiator: existing?.initiator ?? initiatorOf(event.initiator),
      status: null,
      protocol: null,
      cached: false,
      encoded: 0,
      failed: null,
      redirects: (existing?.redirects ?? 0) + (event.redirectResponse ? 1 : 0),
    })
    if (!event.request.url.startsWith("data:"))
      session.inflight.add(event.requestId)
  })
  cdp.on("Network.requestServedFromCache", (event) => {
    const request = session.requests.get(event.requestId)
    if (request) request.cached = true
  })
  cdp.on("Network.responseReceived", (event) => {
    touch()
    const request = session.requests.get(event.requestId)
    if (!request) return
    request.status = event.response.status
    request.protocol = event.response.protocol ?? null
    if (event.response.fromDiskCache || event.response.fromServiceWorker)
      request.cached = true
  })
  cdp.on("Network.loadingFinished", (event) => {
    touch()
    const request = session.requests.get(event.requestId)
    if (request) {
      request.endTs = event.timestamp
      request.encoded = event.encodedDataLength
    }
    session.inflight.delete(event.requestId)
  })
  cdp.on("Network.loadingFailed", (event) => {
    touch()
    const request = session.requests.get(event.requestId)
    if (request) {
      request.endTs = event.timestamp
      request.failed = event.errorText
    }
    session.inflight.delete(event.requestId)
  })
  await cdp.send("Network.enable")
  if (network.latencyMs > 0 || network.downKbps > 0)
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: network.latencyMs,
      downloadThroughput:
        network.downKbps > 0 ? (network.downKbps * 1000) / 8 : -1,
      uploadThroughput: network.upKbps > 0 ? (network.upKbps * 1000) / 8 : -1,
    })
  if (network.cpu > 1)
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: network.cpu })
  return session
}

/**
 * Wait until nothing happens for QUIET_MS: no request in flight or finishing,
 * no DOM mutation and no long task. Returns whether the cap was hit.
 */
async function waitSettled(session: Session, maxMs = SETTLE_MAX_MS) {
  const started = performance.now()
  for (;;) {
    await Bun.sleep(200)
    // Requests that never finish (none expected) stop counting after 15 s.
    for (const id of session.inflight) {
      const request = session.requests.get(id)
      if (request && Date.now() - request.wallMs > 15_000)
        session.inflight.delete(id)
    }
    let quietPage = false
    try {
      quietPage = await session.page.evaluate((quiet) => {
        const wt = (window as unknown as Record<string, any>)["__wt"]
        if (!wt) return false
        const now = performance.now()
        const lastLong = wt.long.reduce(
          (last: number, task: { start: number; dur: number }) =>
            Math.max(last, task.start + task.dur),
          0
        )
        return now - Math.max(wt.lastMutation, lastLong) >= quiet
      }, QUIET_MS)
    } catch {
      quietPage = false // navigating
    }
    const quietNet =
      session.inflight.size === 0 &&
      performance.now() - session.lastNet >= QUIET_MS
    if (quietPage && quietNet) return false
    if (performance.now() - started > maxMs) return true
  }
}

// ── Measuring one action ──────────────────────────────────────────────

interface PageData {
  timeOrigin: number
  now: number
  armedAt: number
  resources: {
    url: string
    type: string
    start: number
    requestStart: number
    responseStart: number
    responseEnd: number
    transfer: number
    encoded: number
    decoded: number
    protocol: string
    status: number
    serverTiming: { name: string; dur: number }[]
  }[]
  long: { start: number; dur: number }[]
  loaf: {
    start: number
    dur: number
    blocking: number
    renderStart: number
    styleStart: number
    scripts: { src: string; type: string; dur: number; forced: number }[]
  }[]
  ws: WsRec[]
  clicks: number[]
  inputs: number[]
  hovers: number[]
  lastMutation: number
  marks: { name: string; at: number }[]
  navigation: Record<string, number> | null
  domNodes: number
}

async function readPage(session: Session, from: number): Promise<PageData> {
  return session.page.evaluate((from) => {
    const wt = (window as unknown as Record<string, any>)["__wt"]
    const navigation = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined
    const fcp = performance
      .getEntriesByName("first-contentful-paint")
      .at(0)?.startTime
    return {
      timeOrigin: performance.timeOrigin,
      now: performance.now(),
      armedAt: wt.armedAt,
      resources: (
        performance.getEntriesByType("resource") as PerformanceResourceTiming[]
      )
        .filter((entry) => entry.startTime >= from - 1)
        .map((entry) => ({
          url: entry.name,
          type: entry.initiatorType,
          start: entry.startTime,
          requestStart: entry.requestStart,
          responseStart: entry.responseStart,
          responseEnd: entry.responseEnd,
          transfer: entry.transferSize,
          encoded: entry.encodedBodySize,
          decoded: entry.decodedBodySize,
          protocol: entry.nextHopProtocol,
          status:
            (entry as unknown as { responseStatus?: number }).responseStatus ??
            0,
          serverTiming: entry.serverTiming.map((timing) => ({
            name: timing.name,
            dur: timing.duration,
          })),
        })),
      long: wt.long,
      loaf: wt.loaf,
      ws: wt.ws,
      clicks: wt.clicks,
      inputs: wt.inputs,
      hovers: wt.hovers,
      lastMutation: wt.lastMutation,
      marks: wt.marks,
      domNodes: document.getElementsByTagName("*").length,
      navigation:
        from <= 0 && navigation
          ? {
              responseStart: navigation.responseStart,
              responseEnd: navigation.responseEnd,
              domInteractive: navigation.domInteractive,
              domContentLoaded: navigation.domContentLoadedEventEnd,
              load: navigation.loadEventEnd,
              transfer: navigation.transferSize,
              fcp: fcp ?? -1,
            }
          : null,
    }
  }, from)
}

function kindOf(url: string, type: string): Req["kind"] {
  const path = shortUrl(url)
  if (path.startsWith("/api/") && path.includes("/content")) return "frame"
  if (path.startsWith("/api/") || path.startsWith("/gateway/")) return "api"
  if (/\.m?js(\?|$)/.test(path)) return "script"
  if (/\.css(\?|$)/.test(path)) return "style"
  if (/\.(woff2?|ttf|otf)(\?|$)/.test(path)) return "font"
  if (/\.(png|svg|jpe?g|webp|ico|gif)(\?|$)/.test(path)) return "image"
  if (type === "Document" || type === "navigation") return "document"
  return "other"
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/**
 * Requests of the action: CDP sees every request (including the HTML frame's);
 * Resource Timing adds precise phases and Server-Timing where it has the entry.
 */
function buildRequests(
  session: Session,
  data: PageData,
  from: number,
  t0: number
): Req[] {
  const origin = data.timeOrigin
  const timings = [...data.resources]
  const requests: Req[] = []
  for (const request of session.requests.values()) {
    if (request.url.startsWith("data:")) continue
    const start = request.wallMs - origin
    if (start < from - 5 || start > data.now) continue
    const end =
      request.endTs === null
        ? data.now
        : start + (request.endTs - request.ts) * 1000
    // Match the Resource Timing entry for the same URL nearest in time.
    let best = -1
    let bestDistance = 50
    timings.forEach((timing, index) => {
      if (timing.url !== request.url) return
      const distance = Math.abs(timing.start - start)
      if (distance < bestDistance) {
        best = index
        bestDistance = distance
      }
    })
    const timing = best >= 0 ? timings.splice(best, 1)[0]! : null
    const total = timing?.serverTiming.find((entry) => entry.name === "total")
    const startAt = timing?.start ?? start
    const endAt = timing && timing.responseEnd > 0 ? timing.responseEnd : end
    requests.push({
      url: request.url,
      label: shortUrl(request.url),
      kind: kindOf(request.url, request.type),
      start: round1(startAt - t0),
      end: round1(endAt - t0),
      queue:
        timing && timing.requestStart > 0
          ? round1(timing.requestStart - timing.start)
          : 0,
      wait:
        timing && timing.responseStart > 0 && timing.requestStart > 0
          ? round1(timing.responseStart - timing.requestStart)
          : round1(endAt - startAt),
      download:
        timing && timing.responseStart > 0
          ? round1(timing.responseEnd - timing.responseStart)
          : 0,
      server: total ? round1(total.dur) : null,
      transfer: timing?.transfer ?? request.encoded,
      encoded: timing?.encoded ?? request.encoded,
      decoded: timing?.decoded ?? 0,
      cached:
        request.cached ||
        (timing ? timing.transfer === 0 && timing.decoded > 0 : false),
      status: request.status ?? timing?.status ?? null,
      protocol: request.protocol ?? timing?.protocol ?? null,
      initiator: request.initiator,
      ...(request.failed ? { failed: request.failed } : {}),
      ...(request.redirects ? { redirects: request.redirects } : {}),
    })
  }
  return requests.sort((left, right) => left.start - right.start)
}

/**
 * The request chain that content waited for: from the latest request matching
 * `gate` (or the latest request when no gate is specified) that finished before
 * content, walk back to the request that finished last before it started,
 * within `maxGap` ms.
 * With cached content, no matching request may finish before it appears.
 * An unrelated background read does not become the gate in that case.
 * A heuristic: the waterfalls show the evidence.
 */
export function criticalChain(
  requests: Req[],
  contentMs: number,
  gate: RegExp | null,
  maxGap: number
): ChainStep[] {
  const eligible = requests.filter(
    (request) =>
      request.end <= contentMs + 1 &&
      request.kind !== "font" &&
      request.kind !== "image" &&
      !request.cached &&
      !request.failed
  )
  const gated = gate
    ? eligible.filter((request) => gate.test(request.label))
    : eligible
  let current = gated.reduce<Req | null>(
    (latest, request) =>
      !latest || request.end > latest.end ? request : latest,
    null
  )
  const chain: Req[] = []
  while (current) {
    chain.unshift(current)
    const start: number = current.start
    current = eligible.reduce<Req | null>(
      (latest, request) =>
        request.end <= start + 1 &&
        request.end >= start - maxGap &&
        !chain.includes(request) &&
        (!latest || request.end > latest.end)
          ? request
          : latest,
      null
    )
  }
  return chain.map((request) => ({
    label: request.label,
    kind: request.kind,
    start: request.start,
    end: request.end,
    queue: request.queue,
    wait: request.wait,
    server: request.server,
    download: request.download,
  }))
}

/** Parts of [from, to] not covered by the intervals. */
function gaps(
  intervals: [number, number][],
  from: number,
  to: number
): [number, number][] {
  const sorted = intervals
    .map(([start, end]) => [Math.max(start, from), Math.min(end, to)] as const)
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0])
  const result: [number, number][] = []
  let cursor = from
  for (const [start, end] of sorted) {
    if (start > cursor) result.push([cursor, start])
    cursor = Math.max(cursor, end)
  }
  if (cursor < to) result.push([cursor, to])
  return result
}

interface Action {
  pass: Pass
  journey: string
  target: string
  expect: Expectation[]
  /** Which predicate is "content"; "editable" is reported separately. */
  contentKey: string
  editableKey?: string
  gate: RegExp | null
  /** Unmeasured preparation, such as revealing a link in the sidebar. */
  prepare?: (session: Session) => Promise<void>
  /** The measured action. Returns nothing; t0 comes from the page's events. */
  act: (session: Session) => Promise<void>
  t0: "click" | "input" | "navigation"
  /** Unmeasured cleanup, such as clearing the search box. */
  cleanup?: (session: Session) => Promise<void>
}

interface RunContext {
  browser: Browser
  trace: boolean
  /** Profile JS in the trace and save every action's trace. */
  rawTraces: boolean
  round: number
  outDir: string
  screenshots: boolean
}

async function measure(
  run: RunContext,
  session: Session,
  action: Action,
  page: Page = session.page
): Promise<ClickRecord> {
  if (action.prepare) {
    await action.prepare(session)
    await waitSettled(session, 10_000)
  }
  if (action.t0 !== "navigation")
    await page.evaluate(
      ({ expect, timeoutMs }) =>
        (window as unknown as Record<string, any>)["__wt"].arm(
          expect,
          timeoutMs
        ),
      { expect: action.expect, timeoutMs: CONTENT_TIMEOUT_MS }
    )
  if (run.trace)
    await run.browser.startTracing(page, {
      categories: run.rawTraces ? RAW_TRACE_CATEGORIES : TRACE_CATEGORIES,
    })
  await action.act(session)
  let results: ArmedResult["results"]
  try {
    results =
      ((await page.evaluate(
        () => (window as unknown as Record<string, any>)["__wt"].armed
      )) as ArmedResult["results"] | null) ?? {}
  } catch (error) {
    if (run.trace) await run.browser.stopTracing().catch(() => {})
    throw new Error(`${action.journey} (${action.target}): ${error}`)
  }
  const capped = await waitSettled(session)
  const traceBuffer = run.trace ? await run.browser.stopTracing() : null
  const from =
    action.t0 === "navigation"
      ? 0
      : await page.evaluate(
          () =>
            (window as unknown as Record<string, any>)["__wt"].armedAt as number
        )
  const data = await readPage(session, from)
  const t0 =
    action.t0 === "navigation"
      ? 0
      : ((action.t0 === "click" ? data.clicks : data.inputs).find(
          (time) => time >= data.armedAt
        ) ?? data.armedAt)
  const hover = data.hovers.find((time) => time >= data.armedAt)
  const requests = buildRequests(session, data, from, t0)
  const content = results[action.contentKey]
  const editable = action.editableKey ? results[action.editableKey] : null
  // An HTML document's frame fires load for an error page too: content
  // needs the expected frame request to have succeeded.
  const frame = action.expect.find((item) => item.name === "html")?.args[
    "srcPart"
  ] as string | undefined
  const frameFailed =
    frame !== undefined &&
    requests.some(
      (request) =>
        request.label.includes(frame) &&
        (Boolean(request.failed) || (request.status ?? 0) >= 400)
    )
  const contentMs = content && !frameFailed ? round1(content.at - t0) : null
  const lastEnd = Math.max(
    0,
    ...requests
      .filter((request) => request.end >= 0)
      .map((request) => request.end),
    data.lastMutation - t0,
    ...data.long.map((task) => task.start + task.dur - t0)
  )
  const settledMs = round1(Math.min(lastEnd, data.now - t0))
  const inWindow = <T extends { start: number }>(items: T[]) =>
    items.filter((item) => item.start >= t0 - 1 && item.start <= t0 + settledMs)
  const long = inWindow(data.long)
  const loaf = inWindow(data.loaf)
  const chain =
    contentMs === null
      ? []
      : criticalChain(
          requests,
          contentMs,
          action.gate,
          100 * session.network.cpu
        )

  let mainThread: ClickRecord["mainThread"] = null
  if (traceBuffer) {
    // Marks of this action only: the document keeps every earlier one.
    const thread = readMainThread(
      traceBuffer,
      data.marks.filter(
        (mark) => action.t0 === "navigation" || mark.at > data.armedAt
      )
    )
    if (thread) {
      const end = contentMs ?? settledMs
      const chainGaps = gaps(
        chain.map((step) => [step.start, step.end]),
        0,
        end
      )
      const gapMs = chainGaps.reduce((sum, [from, to]) => sum + to - from, 0)
      mainThread = {
        toContent: breakdown(thread, [[t0, t0 + end]]),
        toSettled: breakdown(thread, [[t0, t0 + settledMs]]),
        chainGaps: {
          ...breakdown(
            thread,
            chainGaps.map(([from, to]) => [t0 + from, t0 + to])
          ),
          gapMs: round1(gapMs),
        },
      }
    }
    if (
      run.rawTraces ||
      (run.round === 1 &&
        session.network.name === "phone" &&
        (action.pass === "cold" || action.pass === "first"))
    ) {
      const name = `trace-${session.network.name}-${action.pass}-${action.journey.replace(/\W+/g, "-")}${run.rawTraces ? `-r${run.round}` : ""}.json.gz`
      writeFileSync(join(run.outDir, "traces", name), gzipSync(traceBuffer))
    }
  }

  const record: ClickRecord = {
    network: session.network.name,
    round: run.round,
    pass: action.pass,
    journey: action.journey,
    target: action.target,
    t0: round1(t0),
    contentMs,
    paintMs: content && contentMs !== null ? round1(content.paint - t0) : null,
    editableMs: editable ? round1(editable.at - t0) : null,
    milestones: Object.fromEntries(
      Object.entries(results).map(([key, value]) => [
        key,
        value ? round1(value.at - t0) : null,
      ])
    ),
    settledMs,
    settleCapped: capped,
    hoverLeadMs: hover !== undefined && hover < t0 ? round1(t0 - hover) : null,
    requests,
    ws: data.ws
      .filter((socket) => socket.created >= from - 1)
      .map((socket) => ({
        ...socket,
        created: round1(socket.created - t0),
        open: socket.open === null ? null : round1(socket.open - t0),
        firstMessage:
          socket.firstMessage === null
            ? null
            : round1(socket.firstMessage - t0),
        syncStep2:
          socket.syncStep2 === null ? null : round1(socket.syncStep2 - t0),
        closed: socket.closed === null ? null : round1(socket.closed - t0),
        url: shortUrl(socket.url),
      })),
    longTasks: {
      count: long.length,
      totalMs: round1(long.reduce((sum, task) => sum + task.dur, 0)),
      maxMs: round1(Math.max(0, ...long.map((task) => task.dur))),
    },
    loaf: {
      count: loaf.length,
      totalMs: round1(loaf.reduce((sum, frame) => sum + frame.dur, 0)),
      blockingMs: round1(
        loaf.reduce((sum, frame) => sum + (frame.blocking ?? 0), 0)
      ),
      scriptMs: round1(
        loaf.reduce(
          (sum, frame) =>
            sum +
            frame.scripts.reduce((total, script) => total + script.dur, 0),
          0
        )
      ),
      styleLayoutMs: round1(
        loaf.reduce(
          (sum, frame) =>
            sum +
            (frame.styleStart > 0
              ? frame.start + frame.dur - frame.styleStart
              : 0),
          0
        )
      ),
    },
    chain,
    loafScripts: Object.entries(
      loaf
        .flatMap((frame) => frame.scripts)
        .reduce<Record<string, number>>((sum, script) => {
          const key = `${script.src ? shortUrl(script.src).replace(/-[\w-]{8}\.js$/, ".js") : "(none)"} ${script.type}`
          sum[key] = (sum[key] ?? 0) + script.dur
          return sum
        }, {})
    )
      .sort((left, right) => right[1] - left[1])
      .slice(0, 6)
      .map(([source, ms]) => ({ source, ms: round1(ms) })),
    mainThread,
    navigation: data.navigation,
    domNodes: data.domNodes,
  }
  if (run.screenshots) {
    const name = `${session.network.name}-${action.pass}-${action.journey.replace(/\W+/g, "-")}.jpg`
    await page.screenshot({
      path: join(run.outDir, "screenshots", name),
      type: "jpeg",
      quality: 50,
      scale: "css",
    })
    record.screenshot = name
  }
  const status = contentMs === null ? "NO CONTENT" : `${contentMs} ms`
  console.log(
    `[clicks] r${run.round} ${session.network.name} ${action.pass} ${action.journey}: ${status}, settled ${settledMs} ms, ${requests.filter((request) => request.kind === "api").length} API, ${requests.filter((request) => request.kind === "script" && !request.cached).length} JS`
  )
  if (action.cleanup) {
    await action.cleanup(session)
    await waitSettled(session, 10_000)
  }
  // Leave the pointer somewhere neutral so it hovers no link.
  if (!session.network.phone) {
    const viewport = page.viewportSize()
    if (viewport) await page.mouse.move(viewport.width - 4, viewport.height - 4)
  }
  return record
}

// ── UI helpers ────────────────────────────────────────────────────────

const sidebar = (session: Session) =>
  session.page.locator("[data-worktable-sidebar-root]").first()

async function showSidebar(session: Session): Promise<void> {
  if (!session.network.phone) return
  const shell = session.page.locator("[data-worktable-app-shell]")
  if ((await shell.getAttribute("data-worktable-sidebar-open")) === "true")
    return
  await session.page
    .locator('header button[aria-label^="Toggle sidebar"]')
    .tap()
  await session.page.waitForSelector(
    '[data-worktable-app-shell][data-worktable-sidebar-open="true"]'
  )
  await session.page.waitForTimeout(350) // drawer transition
}

async function hideSidebar(session: Session): Promise<void> {
  if (!session.network.phone) return
  const shell = session.page.locator("[data-worktable-app-shell]")
  if ((await shell.getAttribute("data-worktable-sidebar-open")) !== "true")
    return
  await session.page.touchscreen.tap(12, 400)
  await session.page.waitForSelector(
    '[data-worktable-app-shell][data-worktable-sidebar-open="false"]'
  )
  await session.page.waitForTimeout(350)
}

/** The measured gesture: hover then click on desktop, tap on the phone. */
async function press(
  session: Session,
  selector: string | Locator
): Promise<void> {
  const link =
    typeof selector === "string"
      ? session.page.locator(selector).first()
      : selector
  if (session.network.phone) {
    await link.tap()
    return
  }
  await link.hover()
  await session.page.waitForTimeout(HOVER_MS)
  await session.page.mouse.down()
  await session.page.mouse.up()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Opens a Space in the sidebar: its whole row folds and unfolds it. */
/**
 * What opens and closes a Space in the sidebar: its whole row, or in
 * releases before rows opened Spaces, the chevron beside its name. The
 * release gate runs this script against the previous release too.
 */
function spaceToggle(session: Session, name: string) {
  const spaces = sidebar(session).locator(".group\\/space")
  return spaces
    .getByRole("button", { name, exact: true })
    .or(
      spaces.getByRole("button", {
        name: new RegExp(`^(Expand|Collapse) ${escapeRegExp(name)}$`),
      })
    )
    .first()
}

/** Opens a Space in the sidebar. */
async function expandSpace(session: Session, name: string) {
  const row = spaceToggle(session, name)
  await row.waitFor()
  if ((await row.getAttribute("aria-expanded")) === "false") await row.click()
}

async function revealDocument(session: Session, doc: DocTarget) {
  await showSidebar(session)
  const root = sidebar(session)
  await expandSpace(session, doc.spaceName)
  for (const segment of doc.path.split("/").slice(0, -1)) {
    const folder = root
      .getByRole("button", {
        name: new RegExp(`^${escapeRegExp(segment)}$`, "i"),
      })
      .first()
    await folder.waitFor()
    if ((await folder.getAttribute("aria-expanded")) === "false")
      await folder.click()
  }
  const link = root.locator(`a[href="${documentHref(doc)}"]`).first()
  await link.waitFor({ state: "visible" })
  await link.scrollIntoViewIfNeeded()
}

function documentHref(doc: DocTarget): string {
  return `/spaces/${doc.spaceId}/documents/${doc.path}`
}

function htmlSrcPart(doc: DocTarget): string {
  return `/widgets/__document/${Buffer.from(doc.path).toString("base64url")}/content`
}

/** What an image of a file in a Space loads from (fileSourceUrl). */
function fileSrcPart(path: string): string {
  return `/documents/file?path=${encodeURIComponent(path)}`
}

function docExpectations(
  doc: DocTarget,
  pageLoad = false
): {
  expect: Expectation[]
  contentKey: string
  editableKey?: string
  gate: RegExp
} {
  const encodedPath = doc.path.split("/").map(encodeURIComponent).join("/")
  // A deep link's page HTML can carry a display-only snapshot.
  const opening: Expectation[] =
    pageLoad && (doc.kind === "md" || doc.kind === "rich")
      ? [{ name: "opening", key: "opening", args: { heading: doc.heading } }]
      : []
  // Content waits for its images to load, so their requests are its gate.
  const fileGate = /\/documents\/file\?/
  if (doc.kind === "file")
    return {
      expect: [
        {
          name: "images",
          key: "content",
          args: { srcParts: [fileSrcPart(doc.path)] },
        },
      ],
      contentKey: "content",
      gate: fileGate,
    }
  if (doc.kind === "md" && doc.images?.length)
    return {
      expect: [
        ...opening,
        { name: "markdown", key: "text", args: { heading: doc.heading } },
        {
          name: "images",
          key: "content",
          args: {
            heading: doc.heading,
            srcParts: doc.images.map(fileSrcPart),
          },
        },
      ],
      contentKey: "content",
      gate: fileGate,
    }
  if (doc.kind === "md")
    return {
      expect: [
        ...opening,
        { name: "markdown", key: "content", args: { heading: doc.heading } },
      ],
      contentKey: "content",
      gate: new RegExp(`/docs/${escapeRegExp(encodedPath)}`),
    }
  if (doc.kind === "rich")
    return {
      expect: [
        ...opening,
        { name: "rich", key: "content", args: { heading: doc.heading } },
        {
          name: "richEditable",
          key: "editable",
          args: { heading: doc.heading },
        },
      ],
      contentKey: "content",
      editableKey: "editable",
      gate: new RegExp(`/docs/${escapeRegExp(encodedPath)}`),
    }
  return {
    expect: [
      { name: "html", key: "content", args: { srcPart: htmlSrcPart(doc) } },
    ],
    contentKey: "content",
    gate: /\/content\?/,
  }
}

// ── Journeys ──────────────────────────────────────────────────────────

function openSpaceInSidebar(pass: Pass, space: SpaceTarget): Action {
  return {
    pass,
    journey: "open a Space in the sidebar",
    target: space.id,
    expect: [
      { name: "sidebarSpace", key: "content", args: { spaceId: space.id } },
    ],
    contentKey: "content",
    gate: new RegExp(`/api/spaces/${space.id}/(documents|docs)\\b`),
    // Starts from the Space closed, as a person meets it in the list.
    prepare: async (session) => {
      await showSidebar(session)
      const row = spaceToggle(session, space.name)
      await row.waitFor()
      if ((await row.getAttribute("aria-expanded")) === "true") {
        await row.click()
        await row.and(session.page.locator('[aria-expanded="false"]')).waitFor()
      }
    },
    act: (session) => press(session, spaceToggle(session, space.name)),
    t0: "click",
  }
}

function openSpace(pass: Pass, space: SpaceTarget): Action {
  return {
    pass,
    journey: "open Space",
    target: space.id,
    expect: [
      {
        name: "space",
        key: "content",
        args: { spaceId: space.id, name: space.name },
      },
    ],
    contentKey: "content",
    gate: new RegExp(`/api/spaces/${space.id}/(documents|docs)\\b`),
    // Space Home is the first row inside the opened Space.
    prepare: async (session) => {
      await showSidebar(session)
      await expandSpace(session, space.name)
    },
    act: (session) =>
      press(
        session,
        `[data-worktable-sidebar-root] a[href="/spaces/${space.id}"]`
      ),
    t0: "click",
  }
}

function openDocument(pass: Pass, journey: string, doc: DocTarget): Action {
  return {
    pass,
    journey,
    target: `${doc.spaceId}/${doc.path}`,
    ...(() => {
      const expectations = docExpectations(doc)
      // Does the Space overview render on the way to the document?
      return {
        ...expectations,
        expect: [
          ...expectations.expect,
          {
            name: "overview",
            key: "overviewFlash",
            args: { name: doc.spaceName },
            optional: true,
            edge: true,
          },
        ],
      }
    })(),
    prepare: (session) => revealDocument(session, doc),
    act: (session) =>
      press(
        session,
        `[data-worktable-sidebar-root] a[href="${documentHref(doc)}"]`
      ),
    t0: "click",
  }
}

function goHome(pass: Pass): Action {
  return {
    pass,
    journey: "back to Home",
    target: "/",
    expect: [{ name: "home", key: "content", args: {} }],
    contentKey: "content",
    gate: /\/api\/recent/,
    prepare: showSidebar,
    act: (session) =>
      press(
        session,
        '[data-worktable-sidebar-root] a[href="/"]:has-text("Home")'
      ),
    t0: "click",
  }
}

function openThreads(pass: Pass, targets: Targets): Action {
  return {
    pass,
    journey: "open Threads",
    target: targets.threadsHref,
    expect: [{ name: "threads", key: "content", args: {} }],
    contentKey: "content",
    gate: /\/api\/threads(\?|$)/,
    prepare: showSidebar,
    act: (session) =>
      press(
        session,
        `[data-worktable-sidebar-root] a[href="${targets.threadsHref}"]`
      ),
    t0: "click",
  }
}

function openThread(pass: Pass, thread: ThreadTarget): Action {
  return {
    pass,
    journey: "open a thread",
    target: thread.id,
    expect: [{ name: "thread", key: "content", args: { threadId: thread.id } }],
    contentKey: "content",
    gate: new RegExp(`/threads/${thread.id}`),
    prepare: hideSidebar,
    act: (session) =>
      press(session, `nav[aria-label="Threads"] a[href="${thread.href}"]`),
    t0: "click",
  }
}

function search(pass: Pass, query: string): Action {
  return {
    pass,
    journey: "search",
    target: query,
    expect: [
      {
        name: "search",
        key: "content",
        args: { tokens: query.toLowerCase().split(/\s+/) },
      },
    ],
    contentKey: "content",
    gate: /\/api\/search/,
    prepare: async (session) => {
      await showSidebar(session)
      await sidebar(session)
        .locator('input[aria-label="Search workspace"]')
        .click()
    },
    act: (session) =>
      sidebar(session)
        .locator('input[aria-label="Search workspace"]')
        .fill(query),
    t0: "input",
    cleanup: async (session) => {
      await sidebar(session)
        .locator('button[aria-label="Clear search"]')
        .click()
    },
  }
}

function clickJourney(pass: Pass, targets: Targets, second: boolean): Action[] {
  const pick = <T>(a: T, b: T) => (second ? b : a)
  return [
    openSpaceInSidebar(pass, pick(targets.spaceA, targets.spaceB)),
    openSpace(pass, pick(targets.spaceA, targets.spaceB)),
    openDocument(pass, "open Markdown doc", pick(targets.mdA, targets.mdB)),
    openDocument(pass, "open rich doc", pick(targets.richA, targets.richB)),
    ...(second
      ? []
      : [
          openDocument(pass, "open rich doc (2,000 blocks)", targets.richLarge),
        ]),
    openDocument(pass, "open HTML doc", pick(targets.htmlA, targets.htmlB)),
    ...(second
      ? []
      : [
          openDocument(pass, "open a file page", targets.file),
          openDocument(pass, "open a Doc with images", targets.withImages),
        ]),
    goHome(pass),
    openThreads(pass, targets),
    openThread(pass, pick(targets.threadA, targets.threadB)),
    search(pass, pick(targets.searchA, targets.searchB)),
  ]
}

interface ColdLoad {
  journey: string
  target: string
  path: string
  expect: Expectation[]
  contentKey: string
  editableKey?: string
  gate: RegExp | null
}

function coldLoads(targets: Targets): ColdLoad[] {
  const doc = (journey: string, target: DocTarget): ColdLoad => ({
    journey,
    target: `${target.spaceId}/${target.path}`,
    path: documentHref(target),
    ...docExpectations(target, true),
  })
  return [
    {
      journey: "open the app at Home",
      target: "/",
      path: "/",
      expect: [{ name: "home", key: "content", args: {} }],
      contentKey: "content",
      gate: /\/api\/recent/,
    },
    {
      journey: "open Space",
      target: targets.spaceA.id,
      path: `/spaces/${targets.spaceA.id}`,
      expect: [
        {
          name: "space",
          key: "content",
          args: { spaceId: targets.spaceA.id, name: targets.spaceA.name },
        },
      ],
      contentKey: "content",
      gate: new RegExp(`/api/spaces/${targets.spaceA.id}/(documents|docs)\\b`),
    },
    doc("open Markdown doc", targets.mdA),
    doc("open rich doc", targets.richA),
    doc("open rich doc (2,000 blocks)", targets.richLarge),
    doc("open HTML doc", targets.htmlA),
    doc("open a file page", targets.file),
    doc("open a Doc with images", targets.withImages),
    {
      journey: "open Threads",
      target: targets.threadsHref,
      path: targets.threadsHref,
      expect: [{ name: "threads", key: "content", args: {} }],
      contentKey: "content",
      gate: /\/api\/threads(\?|$)/,
    },
    {
      journey: "open a thread",
      target: targets.threadA.id,
      path: targets.threadA.href,
      expect: [
        {
          name: "thread",
          key: "content",
          args: { threadId: targets.threadA.id },
        },
      ],
      contentKey: "content",
      gate: new RegExp(`/threads/${targets.threadA.id}`),
    },
  ]
}

async function measureLoad(
  run: RunContext,
  network: Network,
  base: string,
  pass: Pass,
  load: ColdLoad,
  session?: Session
): Promise<ClickRecord> {
  const own = !session
  const active =
    session ??
    (await openSession(run.browser, network, base, {
      expectations: load.expect,
    }))
  if (!own)
    await active.context.addInitScript({
      content: `window.__wtExpect = ${JSON.stringify({ expectations: load.expect, timeoutMs: CONTENT_TIMEOUT_MS })}`,
    })
  try {
    return await measure(run, active, {
      pass,
      journey: load.journey,
      target: load.target,
      expect: load.expect,
      contentKey: load.contentKey,
      ...(load.editableKey ? { editableKey: load.editableKey } : {}),
      gate: load.gate,
      act: async (current) => {
        current.requests.clear()
        current.inflight.clear()
        await current.page.goto(base + load.path, { waitUntil: "commit" })
      },
      t0: "navigation",
    })
  } finally {
    if (own) await active.context.close()
  }
}

async function runNetwork(
  run: RunContext,
  network: Network,
  base: string,
  targets: Targets,
  idleSeconds: number,
  extras: Extras
): Promise<ClickRecord[]> {
  const records: ClickRecord[] = []
  const passes = extras.passes
  if (passes.has("cold"))
    for (const load of coldLoads(targets))
      records.push(await measureLoad(run, network, base, "cold", load))

  const session = await openSession(run.browser, network, base)
  try {
    const home = coldLoads(targets)[0]!
    // The tab always opens at Home; "first" decides whether that is measured.
    if (passes.has("first"))
      records.push(
        await measureLoad(run, network, base, "first", home, session)
      )
    else {
      await session.page.goto(base + home.path, { waitUntil: "commit" })
      await waitSettled(session)
    }
    if (passes.has("first"))
      for (const action of clickJourney("first", targets, false))
        records.push(await measure(run, session, action))
    if (passes.has("warm"))
      for (const action of clickJourney("warm", targets, true))
        records.push(await measure(run, session, action))
    if (passes.has("revisit"))
      for (const action of clickJourney("revisit", targets, false))
        records.push(await measure(run, session, action))
    if (passes.has("reopen"))
      records.push(
        await measureLoad(run, network, base, "reopen", home, session)
      )
    if (extras.idleWindowSeconds > 0)
      extras.idleWindowRecords.push(
        await idleWindow(run, session, home, extras.idleWindowSeconds)
      )
    for (const action of passes.has("idle")
      ? clickJourney("idle", targets, false)
      : []) {
      const prepare = action.prepare
      records.push(
        await measure(run, session, {
          ...action,
          prepare: async (current) => {
            if (prepare) await prepare(current)
            await waitSettled(current, 10_000)
            await Bun.sleep(idleSeconds * 1000)
          },
        })
      )
    }
    if (extras.churn) {
      const churn = extras.churn
      let turn = 0
      for (const action of clickJourney("churn", targets, false)) {
        const prepare = action.prepare
        const kind = CHURN_KINDS[turn++ % CHURN_KINDS.length]!
        records.push(
          await measure(run, session, {
            ...action,
            prepare: async (current) => {
              if (prepare) await prepare(current)
              extras.churnRecords.push(
                await churnChange(run, current, churn, kind)
              )
              // Changes land every 5 to 10 s: the 3 s window, this and a click.
              await Bun.sleep(1000 + Math.round(Math.random() * 3000))
            },
          })
        )
      }
    }
    if (extras.backup) {
      const load = startBackupLoad(extras.backup)
      const first = records.length
      try {
        for (const action of clickJourney("backup", targets, false))
          records.push(await measure(run, session, action))
      } finally {
        const result = await load.stop()
        const clicks = records.slice(first)
        // A click that never reached content is the slowest of all.
        const time = (click: ClickRecord) => click.contentMs ?? Infinity
        const slowest = clicks.reduce<ClickRecord | null>(
          (worst, click) =>
            !worst || time(click) > time(worst) ? click : worst,
          null
        )
        extras.backupRecords.push({
          network: network.name,
          round: run.round,
          ...result,
          tabFailures: clicks.flatMap((click) =>
            click.requests
              .filter(
                (request) =>
                  Boolean(request.failed) || (request.status ?? 0) >= 500
              )
              .map(
                (request) =>
                  `${click.journey}: ${request.status ?? request.failed} ${request.label}`
              )
          ),
          maxClickMs: slowest?.contentMs ?? null,
          maxClickJourney: slowest?.journey ?? null,
        })
      }
    }
  } finally {
    await session.context.close()
  }
  return records
}

/**
 * Leave the tab at Home, settled, for `seconds` and list the requests it
 * makes meanwhile. A tab nobody touches should make none: polling and timers
 * belong to the change stream (docs/performance.md).
 */
async function idleWindow(
  run: RunContext,
  session: Session,
  home: ColdLoad,
  seconds: number
): Promise<IdleWindowRecord> {
  if (!session.page.url().endsWith(home.path)) {
    await session.page.goto(session.base + home.path, { waitUntil: "commit" })
  }
  await waitSettled(session)
  const from = Date.now()
  await Bun.sleep(seconds * 1000)
  const to = Date.now()
  const requests = [...session.requests.values()]
    .filter(
      (request) =>
        !request.url.startsWith("data:") &&
        request.wallMs >= from &&
        request.wallMs <= to
    )
    .map((request) => shortUrl(request.url))
  console.log(
    `[clicks] r${run.round} ${session.network.name} idle ${seconds} s at Home: ${requests.length} requests`
  )
  return {
    network: session.network.name,
    round: run.round,
    seconds,
    requests,
  }
}

// ── Churn and backup passes ───────────────────────────────────────────

interface Extras {
  passes: Set<Pass>
  idleWindowSeconds: number
  idleWindowRecords: IdleWindowRecord[]
  churn: ChurnContext | null
  backup: BackupContext | null
  churnRecords: ChurnRecord[]
  backupRecords: BackupRecord[]
}

interface ChurnContext {
  /** The server, directly. */
  base: string
  owner: Cookie[]
  roles: TeamRoles
  /** A member-visible Space where "other" holds a grant. */
  otherSpace: string
  /** A Space no journey opens, for the member's own grant (the control). */
  spare: string
  turn: number
}

const CHURN_KINDS: ChurnKind[] = [
  "invite",
  "agent rename",
  "hidden Space",
  "other's grant",
  "own grant",
]

const CHURN_WINDOW_MS = 3000

async function churnChange(
  run: RunContext,
  session: Session,
  churn: ChurnContext,
  kind: ChurnKind
): Promise<ChurnRecord> {
  await waitSettled(session, 10_000)
  const turn = (churn.turn += 1)
  const { base, owner, roles } = churn
  const wallFrom = Date.now()
  const from = performance.now()
  const loads = session.loads.length
  const routes = session.routes.length
  let affectsMember = false
  if (kind === "invite") {
    await api(base, owner, "/api/team/invitations", {
      method: "POST",
      body: { email: `perf-churn-${run.round}-${turn}@example.test` },
    })
  } else if (kind === "agent rename") {
    const agent = roles.agents[turn % roles.agents.length]!
    await api(base, owner, `/api/team/agents/${agent.id}`, {
      method: "PATCH",
      body: { name: `${agent.name} ${turn}` },
    })
  } else if (kind === "hidden Space") {
    // A new Space starts shared; there is no way to create it restricted, so
    // the member can see it until the second call.
    affectsMember = true
    const { spaceId } = await api<{ spaceId: string }>(
      base,
      owner,
      "/api/spaces",
      { method: "POST", body: { name: `Churn ${run.round} ${turn}` } }
    )
    await setGrant(
      base,
      owner,
      spaceId,
      { subjectType: "member", subjectId: roles.member.memberId },
      null,
      "restricted"
    )
  } else if (kind === "other's grant") {
    await setGrant(
      base,
      owner,
      churn.otherSpace,
      { subjectType: "member", subjectId: roles.other.memberId },
      turn % 2 === 0 ? "edit" : "read"
    )
  } else {
    affectsMember = true
    const granted = (
      await api<{ grants: { subjectId: string }[] }>(
        base,
        owner,
        `/api/team/spaces/${encodeURIComponent(churn.spare)}`
      )
    ).grants.some((grant) => grant.subjectId === roles.member.memberId)
    await setGrant(
      base,
      owner,
      churn.spare,
      { subjectType: "member", subjectId: roles.member.memberId },
      granted ? null : "read"
    )
  }
  const changeMs = performance.now() - from
  await Bun.sleep(CHURN_WINDOW_MS)
  await waitSettled(session, 10_000)
  const requests = [...session.requests.values()]
    .filter(
      (request) =>
        request.wallMs >= wallFrom &&
        !request.url.startsWith("data:") &&
        ["api", "document", "frame"].includes(kindOf(request.url, request.type))
    )
    .map((request) => shortUrl(request.url))
  const record: ChurnRecord = {
    network: session.network.name,
    round: run.round,
    kind,
    affectsMember,
    changeMs: round1(changeMs),
    reloads: session.loads.length - loads,
    navigations: session.routes
      .slice(routes)
      .map((route) => shortUrl(route.url)),
    requests,
  }
  console.log(
    `[clicks] r${run.round} ${session.network.name} churn ${kind}: ${record.reloads} reloads, ${record.navigations.length} navigations, ${requests.length} requests ${JSON.stringify(requests)}`
  )
  return record
}

interface BackupContext {
  /** The server, directly. */
  base: string
  /** The measured person's session, for the second client's reads and writes. */
  cookies: Cookie[]
  /** The run's app directory, where the operator token is. */
  app: string
  spaceId: string
}

/**
 * Live operator snapshots back to back (POST /internal/operator/workspace-snapshot
 * with the process's local operator token, as `worktable-server
 * workspace-snapshot` and hosted backups do), and a second client reading
 * every 100 ms and writing every second, until stopped.
 */
function startBackupLoad(context: BackupContext): {
  stop: () => Promise<
    Omit<
      BackupRecord,
      "network" | "round" | "tabFailures" | "maxClickMs" | "maxClickJourney"
    >
  >
} {
  const token = readFileSync(
    join(context.app, "operator-runtime", "token"),
    "utf8"
  ).trim()
  const started = performance.now()
  let running = true
  const snapshots: BackupRecord["snapshots"] = []
  const active: [number, number][] = []
  const reads: { at: number; ok: boolean; label: string }[] = []
  const writes: { at: number; ms: number; status: number }[] = []
  const cookie = context.cookies
    .map((item) => `${item.name}=${item.value}`)
    .join("; ")
  const space = `/api/spaces/${encodeURIComponent(context.spaceId)}`
  const readPaths = [
    "/api/spaces",
    `${space}/documents?includeArchived=false`,
    "/api/recent?sort=updated&includeTemporary=false&limit=30",
    "/api/workspace",
  ]
  const snapshotLoop = (async () => {
    let index = 0
    while (running) {
      const operationId = `perf-backup-${Date.now().toString(36)}-${index++}`
      const from = performance.now()
      let status = 0
      let error: string | undefined
      try {
        const response = await fetch(
          `${context.base}/internal/operator/workspace-snapshot`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-worktable-local-operator": token,
            },
            body: JSON.stringify({ operationId }),
          }
        )
        status = response.status
        if (!response.ok) error = (await response.text()).slice(0, 200)
        else await response.arrayBuffer()
      } catch (failure) {
        error = String(failure)
      }
      const to = performance.now()
      active.push([from, to])
      snapshots.push({
        startMs: round1(from - started),
        ms: round1(to - from),
        status,
        ...(error ? { error } : {}),
      })
      rmSync(join(context.app, "operator-snapshots", operationId), {
        recursive: true,
        force: true,
      })
      await Bun.sleep(500)
    }
  })()
  const readLoop = (async () => {
    let index = 0
    while (running) {
      const path = readPaths[index++ % readPaths.length]!
      const at = performance.now()
      let ok = false
      let label = path
      try {
        const response = await fetch(context.base + path, {
          headers: { Cookie: cookie },
          signal: AbortSignal.timeout(30_000),
        })
        await response.arrayBuffer()
        ok = response.ok
        label = `${response.status} ${path}`
      } catch (failure) {
        label = `${String(failure).slice(0, 80)} ${path}`
      }
      reads.push({ at, ok, label })
      await Bun.sleep(100)
    }
  })()
  const writeLoop = (async () => {
    let index = 0
    while (running) {
      const at = performance.now()
      let status = 0
      try {
        const response = await fetch(
          `${context.base}${space}/docs/perf/backup-load`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json", Cookie: cookie },
            body: JSON.stringify({
              content: richBlocks(`Backup load ${index++}`, 6, "backup-load"),
            }),
            signal: AbortSignal.timeout(60_000),
          }
        )
        await response.arrayBuffer()
        status = response.status
      } catch {
        status = 0
      }
      writes.push({ at, ms: performance.now() - at, status })
      await Bun.sleep(1000)
    }
  })()
  return {
    stop: async () => {
      running = false
      await Promise.all([snapshotLoop, readLoop, writeLoop])
      // Only requests that overlapped a snapshot count.
      const during = (at: number, ms = 0) =>
        active.some(([from, to]) => at <= to && at + ms >= from)
      const readsDuring = reads.filter((item) => during(item.at))
      const writesDuring = writes.filter((item) => during(item.at, item.ms))
      const waits = writesDuring.map((item) => item.ms).sort((a, b) => a - b)
      return {
        snapshots,
        reads: {
          total: readsDuring.length,
          failed: readsDuring.filter((item) => !item.ok).length,
          failures: readsDuring
            .filter((item) => !item.ok)
            .slice(0, 20)
            .map((item) => item.label),
        },
        writes: {
          total: writesDuring.length,
          // Any write that did not succeed: 503 with Retry-After, 409, 401...
          refused: writesDuring.filter(
            (item) => item.status < 200 || item.status >= 300
          ).length,
          maxMs: round1(waits.at(-1) ?? 0),
          p50Ms: round1(waits[Math.floor((waits.length - 1) / 2)] ?? 0),
        },
      }
    },
  }
}

// ── Setup: Spaces, documents and targets ──────────────────────────────

function richBlocks(title: string, count: number, prefix: string): unknown[] {
  const words =
    "plan review decision owner metric release budget risk launch timeline support customer".split(
      " "
    )
  const blocks: unknown[] = []
  const props = {
    textColor: "default",
    backgroundColor: "default",
    textAlignment: "left",
  }
  for (let index = 0; index < count; index += 1) {
    const heading = index === 0 || index % 10 === 0
    const text =
      index === 0
        ? title
        : Array.from(
            { length: heading ? 3 : 40 },
            (_, word) => words[(index * 7 + word * 3) % words.length]
          ).join(" ")
    blocks.push({
      id: `${prefix}-${index}`,
      type: heading ? "heading" : "paragraph",
      props: heading ? { ...props, level: index === 0 ? 1 : 2 } : props,
      content: [{ type: "text", text, styles: {} }],
      children: [],
    })
  }
  return blocks
}

/**
 * As the solo owner, from this process (as an agent or the CLI would write;
 * browser writes must carry the tab's content epoch): Spaces up to
 * `totalSpaces` and two typical rich documents. Returns every Space id.
 */
async function populate(
  base: string,
  owner: Cookie[],
  fixture: FixtureManifest,
  totalSpaces: number
): Promise<string[]> {
  const listed = await api<{ spaces: { id: string; name: string }[] }>(
    base,
    owner,
    "/api/spaces"
  )
  for (let index = listed.spaces.length; index < totalSpaces; index += 1) {
    const { spaceId } = await api<{ spaceId: string }>(
      base,
      owner,
      "/api/spaces",
      { method: "POST", body: { name: `Area ${index + 1}` } }
    )
    for (let doc = 0; doc < 2 + (index % 4); doc += 1)
      await api(base, owner, `/api/spaces/${spaceId}/docs`, {
        method: "POST",
        body: {
          title: `Area ${index + 1} note ${doc + 1}`,
          content: richBlocks(
            `Area ${index + 1} note ${doc + 1}`,
            12,
            `a${index}n${doc}`
          ),
        },
      })
  }
  const spaceA = fixture.spaces[0]!
  for (const [path, title, count] of [
    ["perf/rich-typical", "Rich typical", 60],
    ["perf/rich-typical-b", "Rich typical B", 60],
  ] as const)
    await api(base, owner, `/api/spaces/${spaceA}/docs/${path}`, {
      method: "PUT",
      body: { content: richBlocks(title, count, path.replace(/\W/g, "")) },
    })
  return (
    await api<{ spaces: { id: string }[] }>(base, owner, "/api/spaces")
  ).spaces.map((space) => space.id)
}

/** The click targets, as the person who clicks sees the workspace. */
async function setup(
  browser: Browser,
  base: string,
  fixture: FixtureManifest,
  outDir: string
): Promise<{ targets: Targets; spaces: number; documents: number }> {
  const cookies = sessionCookies.get(base) ?? []
  const context = await newContext(browser, base)
  const page = await context.newPage()
  // Diagnostics for a setup that never reaches the app.
  const notes: string[] = []
  const note = (line: string) => {
    if (notes.length < 60) notes.push(line)
  }
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) note(`navigated ${frame.url()}`)
  })
  let builds = 0
  page.on("response", (response) => {
    if (response.status() >= 400) note(`${response.status()} ${response.url()}`)
    const build = response.headers()["x-worktable-build"]
    if (build && builds++ < 2) note(`build ${build} from ${response.url()}`)
  })
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning")
      note(`console ${message.type()}: ${message.text().slice(0, 200)}`)
  })
  await page.goto(base + "/")
  const get = <T>(path: string) => api<T>(base, cookies, path)
  const spaceA = fixture.spaces[0]!
  const spaces = (
    await get<{ spaces: { id: string; name: string }[] }>("/api/spaces")
  ).spaces
  const nameOf = (id: string) =>
    spaces.find((space) => space.id === id)?.name ?? id
  let documents = 0
  for (const space of spaces)
    documents += (
      await get<{ documents: { kind: string }[] }>(
        `/api/spaces/${space.id}/documents?includeArchived=false`
      )
    ).documents.length
  // The warm pass opens documents not opened before: the shallowest one of
  // the format in Space A, else in the other fixture Spaces (the HTML Space
  // always has some), else the probe.
  const secondDocument = async (
    format: string,
    probe: { spaceId: string; path: string }
  ) => {
    for (const spaceId of [...fixture.spaces, fixture.htmlSpace]) {
      // A team member may not see every fixture Space.
      if (!spaces.some((space) => space.id === spaceId)) continue
      const listed = await get<{
        documents: { kind: string; path: string; format?: { id: string } }[]
      }>(`/api/spaces/${spaceId}/documents?includeArchived=false`)
      const found = listed.documents
        .filter(
          (doc) =>
            doc.kind === "document" &&
            doc.format?.id === format &&
            !doc.path.startsWith("perf/")
        )
        .sort(
          (left, right) =>
            left.path.split("/").length - right.path.split("/").length ||
            left.path.localeCompare(right.path)
        )[0]
      if (found) return { spaceId, path: found.path }
    }
    return probe
  }
  const markdownHeading = async (spaceId: string, path: string) => {
    const doc = await get<{ content: unknown }>(
      `/api/spaces/${spaceId}/docs/${path}?conversionCheck=skip`
    )
    const match =
      typeof doc.content === "string" ? /^#\s+(.+)$/m.exec(doc.content) : null
    return match?.[1]?.trim() ?? ""
  }
  const richHeading = async (spaceId: string, path: string) => {
    const doc = await get<{ content: { content?: { text?: string }[] }[] }>(
      `/api/spaces/${spaceId}/docs/${path}?conversionCheck=skip`
    )
    return (doc.content[0]?.content ?? [])
      .map((part) => part.text ?? "")
      .join("")
      .trim()
  }
  const mdB = await secondDocument(
    "worktable.markdown",
    fixture.probes.markdown
  )
  const htmlB = await secondDocument("worktable.html", fixture.probes.html)
  const docTarget = async (
    path: string,
    kind: DocTarget["kind"],
    spaceId = spaceA
  ): Promise<DocTarget> => ({
    spaceId,
    spaceName: nameOf(spaceId),
    path,
    kind,
    heading:
      kind === "md"
        ? await markdownHeading(spaceId, path)
        : kind === "rich"
          ? await richHeading(spaceId, path)
          : "",
  })

  const documentTargets = {
    mdA: await docTarget(fixture.probes.markdown.path, "md"),
    mdB: await docTarget(mdB.path, "md", mdB.spaceId),
    richA: await docTarget("perf/rich-typical", "rich"),
    richB: await docTarget("perf/rich-typical-b", "rich"),
    richLarge: await docTarget(fixture.probes.rich2000.path, "rich"),
    htmlA: await docTarget(fixture.probes.html.path, "html"),
    htmlB: await docTarget(htmlB.path, "html", htmlB.spaceId),
    file: await docTarget(fixture.probes.file.path, "file"),
    withImages: {
      ...(await docTarget(fixture.probes.withImages.path, "md")),
      images: fixture.probes.withImages.images,
    },
  }

  // Threads: the sidebar link and the first two rows of the list.
  let threadsHref: string | null = null
  let hrefs: string[] = []
  try {
    threadsHref = await page
      .locator('[data-worktable-sidebar-root] a[href^="/threads"]')
      .first()
      .getAttribute("href")
    await page.goto(base + threadsHref!)
    await page
      .locator('nav[aria-label="Threads"] [role="listitem"] a')
      .first()
      .waitFor()
    hrefs = await page
      .locator('nav[aria-label="Threads"] [role="listitem"] a')
      .evaluateAll((links) =>
        links.slice(0, 2).map((link) => link.getAttribute("href")!)
      )
  } catch (error) {
    await page
      .screenshot({
        path: join(outDir, "setup-failure.jpg"),
        type: "jpeg",
        quality: 60,
      })
      .catch(() => {})
    const state = await page
      .evaluate(async () => ({
        url: location.href,
        text: document.body.innerText.slice(0, 600),
        auth: await fetch("/auth/status")
          .then((r) => r.text())
          .catch(String),
        workspace: await fetch("/api/workspace")
          .then((r) => `${r.status}`)
          .catch(String),
      }))
      .catch(String)
    console.log(`[clicks] setup failed on ${JSON.stringify(state)}`)
    console.log(`[clicks] setup page events:\n${notes.join("\n")}`)
    throw error
  }
  const thread = (href: string): ThreadTarget => ({
    href,
    id: new URL(href, base).pathname.split("/").filter(Boolean).at(-1)!,
  })
  await context.close()

  return {
    spaces: spaces.length,
    documents,
    targets: {
      spaceA: { id: spaceA, name: nameOf(spaceA) },
      spaceB: { id: fixture.spaces[1]!, name: nameOf(fixture.spaces[1]!) },
      ...documentTargets,
      threadsHref: threadsHref!,
      threadA: thread(hrefs[0]!),
      threadB: thread(hrefs[1]!),
      searchA: fixture.searchTerms[0]!,
      searchB: fixture.searchTerms[1]!,
    },
  }
}

// ── Main ──────────────────────────────────────────────────────────────

function gitCommit(checkout: string): string {
  // click-trace-remote.sh runs from a copy without its history.
  if (process.env["PERF_COMMIT"]) return process.env["PERF_COMMIT"]
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: checkout,
      encoding: "utf8",
    }).trim()
  } catch {
    return "unknown"
  }
}

/**
 * A certificate for localhost, made for this run, and the hash of its key.
 * Chromium trusts the proxy by that hash: told to ignore certificate errors
 * instead, it keeps nothing in its HTTP cache, so a revisit or reopen would
 * download again what a browser keeps.
 */
function proxyCertificate(outDir: string): {
  cert: string
  key: string
  spki: string
} {
  const dir = join(outDir, "proxy-tls")
  mkdirSync(dir, { recursive: true })
  const cert = join(dir, "cert.pem")
  const key = join(dir, "key.pem")
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "2",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" }
  )
  const publicKey = new X509Certificate(readFileSync(cert)).publicKey
  const spki = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("base64")
  return { cert, key, spki }
}

/**
 * A local HTTP/2 TLS reverse proxy in front of the server, standing in for
 * Cloudflare: one multiplexed connection, forwarded host and protocol, the
 * server's own compression passed through. HTTP/3 is off so Chromium's
 * network emulation applies.
 */
async function startProxy(
  caddy: string,
  upstream: string,
  outDir: string,
  tls: { cert: string; key: string }
): Promise<{ base: string; stop: () => Promise<void> }> {
  const port = await freePort()
  const httpPort = await freePort()
  const config = join(outDir, "Caddyfile")
  writeFileSync(
    config,
    `{
\tadmin off
\tauto_https disable_redirects
\thttp_port ${httpPort}
\tservers {
\t\tprotocols h1 h2
\t}
}
https://localhost:${port} {
\ttls ${JSON.stringify(tls.cert)} ${JSON.stringify(tls.key)}
\treverse_proxy ${new URL(upstream).host}
}
`
  )
  const child = spawn(
    caddy,
    ["run", "--config", config, "--adapter", "caddyfile"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        XDG_DATA_HOME: join(outDir, "caddy-data"),
        XDG_CONFIG_HOME: join(outDir, "caddy-config"),
      },
    }
  )
  // Never leave the proxy behind if this process exits without stop().
  const kill = () => child.kill("SIGKILL")
  process.once("exit", kill)
  let output = ""
  child.stdout!.on("data", (chunk: Buffer) => (output += chunk.toString()))
  child.stderr!.on("data", (chunk: Buffer) => (output += chunk.toString()))
  const base = `https://localhost:${port}`
  const deadline = performance.now() + 30_000
  for (;;) {
    if (child.exitCode !== null)
      throw new Error(`caddy exited:\n${output.slice(-3000)}`)
    try {
      const response = await fetch(`${base}/health`, {
        tls: { rejectUnauthorized: false },
      } as RequestInit)
      if (response.ok) break
    } catch {
      // Starting.
    }
    if (performance.now() > deadline)
      throw new Error(
        `caddy did not answer within 30 s:\n${output.slice(-3000)}`
      )
    await Bun.sleep(200)
  }
  console.log(`[clicks] HTTP/2 proxy ${base} -> ${upstream}`)
  return {
    base,
    stop: async () => {
      writeFileSync(join(outDir, "caddy.log"), output)
      process.off("exit", kill)
      child.kill("SIGTERM")
    },
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const profile = (args.get("profile") ?? "1k") as ProfileName
  const seed = numberArg(args, "seed", 1)
  const rounds = numberArg(args, "rounds", 3)
  const idleSeconds = numberArg(args, "idle-seconds", 20)
  const totalSpaces = numberArg(args, "spaces", 28)
  CONTENT_TIMEOUT_MS = numberArg(args, "content-timeout", 45) * 1000
  const rawTraces = args.has("raw-traces")
  if (rawTraces && args.has("no-trace"))
    throw new Error("--raw-traces needs tracing; drop --no-trace")
  const trace = !args.has("no-trace")
  const networks = (args.get("networks") ?? "local,desktop,phone,phone-h1")
    .split(",")
    .map((name) => {
      const network = NETWORKS[name as Network["name"]]
      if (!network) throw new Error(`unknown network ${name}`)
      return network
    })
  const dir = fixtureDir(profile, seed)
  const fixture = readFixture(dir)
  if (!fixture)
    throw new Error(
      `no current fixture at ${dir}; run bun run perf:fixtures --profile ${profile}`
    )
  const checkout = resolve(args.get("checkout") ?? REPO_ROOT)
  const staticDir = join(checkout, "apps", "web", "dist", "client")
  if (!existsSync(join(staticDir, ".vite", "manifest.json")))
    throw new Error(
      `no web build in ${checkout}; run bun run --cwd apps/web build there`
    )
  const as = (args.get("as") ?? "solo") as Identity
  if (!["solo", "owner", "member"].includes(as))
    throw new Error("--as must be solo, owner or member")
  const churn = args.has("churn")
  const backup = args.has("backup")
  const allPasses: Pass[] = [
    "cold",
    "first",
    "warm",
    "revisit",
    "reopen",
    "idle",
  ]
  const passes = (args.get("passes")?.split(",") ?? allPasses) as Pass[]
  for (const pass of passes)
    if (!allPasses.includes(pass))
      throw new Error(`--passes takes ${allPasses.join(", ")}; not ${pass}`)
  // Warm, revisit and idle clicks only mean what they say after the tab's
  // first visits.
  if (
    !passes.includes("first") &&
    passes.some((pass) => ["warm", "revisit", "idle"].includes(pass))
  )
    throw new Error("--passes with warm, revisit or idle needs first")
  const idleWindowSeconds = args.has("idle-window")
    ? numberArg(args, "idle-window", 60)
    : 0
  if (churn && as !== "member")
    throw new Error(
      "--churn measures a member's tab while the owner changes the team; use --as member"
    )

  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const outDir = resolve(
    args.get("out") ?? join(PERF_ROOT, "results", `${stamp}-clicks-${profile}`)
  )
  for (const sub of ["", "screenshots", "traces"])
    mkdirSync(join(outDir, sub), { recursive: true })

  const { workspace, app } = restoreFixture(dir)
  const booted = performance.now()
  let server: ServerProcess | null = null
  const proxyTls = networks.some((network) => network.via === "proxy")
    ? proxyCertificate(outDir)
    : null
  const browser = await chromium.launch({
    headless: true,
    args: [
      // Keep sandboxed HTML frames in the page's renderer, so the page's
      // network and CPU emulation applies to them too.
      "--disable-features=IsolateSandboxedIframes",
      "--disable-site-isolation-trials",
      // Trust the HTTP/2 proxy's certificate; stay on TCP.
      ...(proxyTls
        ? [`--ignore-certificate-errors-spki-list=${proxyTls.spki}`]
        : []),
      "--disable-quic",
    ],
  })
  let proxy: { base: string; stop: () => Promise<void> } | null = null
  try {
    server = await startServer({
      checkout,
      workspace,
      app,
      env: { WORKTABLE_STATIC_DIR: staticDir, WORKTABLE_REQUIRE_AUTH: "1" },
    })
    const bootMs = Math.round(performance.now() - booted)
    const idleBefore = performance.now()
    const idle = await waitForIdle(server.pid, 300_000)
    if (idle === "busy") throw new Error("server still busy after 5 minutes")
    console.log(`[clicks] server ${server.url} listening, idle: ${idle}`)
    const soloOwner = await signInSoloOwner(server.url)
    if (proxyTls)
      proxy = await startProxy(
        args.get("caddy") ?? "caddy",
        server.url,
        outDir,
        proxyTls
      )
    const bases = [server.url, ...(proxy ? [proxy.base] : [])]
    const allSpaces = await populate(
      server.url,
      soloOwner,
      fixture,
      totalSpaces
    )
    let roles: TeamRoles | null = null
    let ownerCookies: Cookie[] = soloOwner
    if (as === "solo")
      for (const base of bases) sessionCookies.set(base, soloOwner)
    else {
      roles = await enableTeam(server.url, soloOwner, allSpaces, [
        fixture.spaces[0]!,
        fixture.spaces[1] ?? fixture.spaces[0]!,
        fixture.htmlSpace,
      ])
      ownerCookies = await signInTeam(server.url, roles.owner)
      for (const base of bases)
        sessionCookies.set(base, await signInTeam(base, roles[as]))
      console.log(
        `[clicks] Teams on: ${as} clicks; the member can open ${roles.memberSpaces.length} of ${allSpaces.length} Spaces`
      )
    }
    const prepared = await setup(browser, server.url, fixture, outDir)
    // Setup's writes start indexing; measure only once the server is quiet.
    if ((await waitForIdle(server.pid, 120_000)) === "busy")
      throw new Error("server still busy 2 minutes after setup")
    const idleMs =
      idle === "unknown" ? null : Math.round(performance.now() - idleBefore)
    console.log(
      `[clicks] ${prepared.spaces} Spaces, ${prepared.documents} documents; targets ${JSON.stringify(prepared.targets)}`
    )

    const extras: Extras = {
      passes: new Set(passes),
      idleWindowSeconds,
      idleWindowRecords: [],
      churn:
        churn && roles
          ? {
              base: server.url,
              owner: ownerCookies,
              roles,
              otherSpace: roles.otherSpaces[0]!,
              spare: roles.hiddenSpaces.at(-1)!,
              turn: 0,
            }
          : null,
      backup: backup
        ? {
            base: server.url,
            cookies: sessionCookies.get(server.url)!,
            app,
            spaceId: fixture.spaces[0]!,
          }
        : null,
      churnRecords: [],
      backupRecords: [],
    }
    const result: ClickTraceResult = {
      commit: gitCommit(checkout),
      profile,
      seed,
      as,
      team: roles
        ? {
            memberSpaces: roles.memberSpaces.length,
            hiddenSpaces: roles.hiddenSpaces.length,
            agents: roles.agents.length,
          }
        : null,
      churn: extras.churnRecords,
      backup: extras.backupRecords,
      idleWindows: extras.idleWindowRecords,
      startedAt: new Date().toISOString(),
      machine: {
        cpus: cpus().length,
        model: cpus()[0]?.model ?? "unknown",
        memoryGb: Math.round(totalmem() / 1024 ** 3),
        load1: loadavg()[0]!,
        platform: `${process.platform}-${process.arch}`,
        bun: Bun.version,
        chromium: browser.version(),
      },
      setup: { ...prepared, bootMs, idleMs },
      options: {
        rounds,
        networks,
        idleSeconds,
        trace,
        rawTraces,
        hoverMs: HOVER_MS,
        churn,
        backup,
        passes,
        idleWindowSeconds,
      },
      clicks: [],
    }
    for (let round = 1; round <= rounds; round += 1) {
      for (const network of networks) {
        const run: RunContext = {
          browser,
          trace,
          rawTraces,
          round,
          outDir,
          screenshots: round === 1,
        }
        result.clicks.push(
          ...(await runNetwork(
            run,
            network,
            network.via === "proxy" ? proxy!.base : server.url,
            prepared.targets,
            idleSeconds,
            extras
          ))
        )
        writeFileSync(join(outDir, "result.json"), JSON.stringify(result))
        writeReport(result, outDir)
      }
    }
    writeFileSync(join(outDir, "result.json"), JSON.stringify(result))
    writeReport(result, outDir)
    console.log(`[clicks] wrote ${outDir}`)
  } finally {
    await browser.close().catch(() => {})
    await proxy?.stop().catch(() => {})
    if (server) {
      writeFileSync(join(outDir, "server.log"), server.output())
      await server.stop()
    }
  }
}

if (import.meta.main) {
  await main()
  process.exit(0)
}
