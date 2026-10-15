#!/usr/bin/env bun
/**
 * File I/O and SQL per hot request (Plan 17 Speed, Plan 16a review).
 *
 *   bun scripts/perf/io-count.ts [--profile 1k] [--seed 1] [--checkout <dir>]
 *     [--team] [--requests 20] [--samples 50] [--idle-seconds 30]
 *     [--sockets 20] [--attempts 2] [--no-strace] [--no-timing] [--check]
 *     [--budgets <file>] [--out <dir>]
 *
 * Boots the server from a checkout (default this one) on a fresh copy of a
 * perf fixture, signed in as an instance behind a tunnel runs
 * (WORKTABLE_REQUIRE_AUTH=1, a session cookie). With --team it first turns
 * Worktable Teams on (see team.ts) and measures as the owner and as a member
 * with half the Spaces; without it, as the solo owner.
 *
 * Counting run: the server runs under `strace -f --seccomp-bpf` from its
 * start, with io-count-preload.ts logging SQL statements and timer callbacks.
 * Per endpoint it sends a few warm-up requests, then `--requests` sequential
 * requests, then stays idle for as long as those took; the per-request count
 * is (requests window - idle window) / requests. Reported per request:
 *
 * - stat-family calls (stat, lstat, newfstatat, statx, access, and fstat on a
 *   file) on paths under the workspace or the app directory;
 * - opens, reads and directory reads there, with SQLite file reads separate;
 * - SQL statements: the server's own, and Better Auth's (sessions) separately;
 * - the busiest paths and statements, as evidence.
 *
 * Before measuring, a calibration request that must read a file (a document
 * read through the legacy route after its file changed) has to show that
 * read; otherwise the run fails, since zero counts would mean nothing.
 *
 * Timing run (no strace): p50 and p95 per endpoint over `--samples`
 * sequential requests; the time for one Space change to reach `--sockets`
 * WebSockets; and server CPU, wake-ups and timer callbacks while idle with no
 * sockets and with `--sockets` open tabs (a Space socket and the threads
 * socket each). `--no-timing` skips it.
 *
 * Budgets are relative to a base run: `--base <result.json>` names an
 * earlier solo counting run (usually of main), and --check fails the run when
 * an endpoint costs more than io-budgets.json allows on top of the base's
 * figure for the same endpoint (solo: 3 more stat-family calls and no more
 * SQL; team: 4 more stats, 1 more statement of ours, and at most 2 of Better
 * Auth's). Writes result.json and summary.md to
 * .local-dev/perf/results/<time>-io-<profile>[-team]/ (or --out).
 */
import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { gzipSync } from "node:zlib"
import { cpus, loadavg, totalmem } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fixtureDir, readFixture, type FixtureManifest } from "./fixtures.ts"
import {
  PERF_ROOT,
  REPO_ROOT,
  markdownTable,
  numberArg,
  parseArgs,
  percentile,
  processCounters,
  restoreFixture,
  round,
  startServer,
  waitForIdle,
  type ServerProcess,
} from "./lib.ts"
import {
  api,
  cookieHeader,
  enableTeam,
  signInSoloOwner,
  signInTeam,
  type Cookie,
  type TeamRoles,
} from "./team.ts"

const PRELOAD = join(import.meta.dirname, "io-count-preload.ts")
const WARMUP = 3

type Role = "solo" | "owner" | "member"

interface Endpoint {
  name: string
  path: string
}

interface Window {
  role: Role
  name: string
  kind: "requests" | "idle"
  from: number
  to: number
  requests: number
}

// ── strace ────────────────────────────────────────────────────────────

const STAT = new Set([
  "stat",
  "lstat",
  "fstat",
  "newfstatat",
  "fstatat64",
  "statx",
  "access",
  "faccessat",
  "faccessat2",
])
const OPEN = new Set(["open", "openat", "openat2", "creat"])
const READ = new Set(["read", "pread64", "readv", "preadv", "preadv2"])
const READDIR = new Set(["getdents64", "getdents"])
const FD_FIRST = new Set([...READ, ...READDIR, "fstat"])

interface Call {
  t: number
  syscall: string
  path: string | null
}

/** Unescape strace's C-style string (paths are printed in full). */
function unquote(value: string): string {
  return value.replace(/\\(x[0-9a-f]{2}|[0-7]{1,3}|.)/gi, (_, code: string) => {
    if (code[0] === "x") return String.fromCharCode(parseInt(code.slice(1), 16))
    if (/^[0-7]+$/.test(code)) return String.fromCharCode(parseInt(code, 8))
    return code === "n" ? "\n" : code === "t" ? "\t" : code
  })
}

/** The path a traced call touched, from its arguments (`-y` decorates fds). */
function callPath(syscall: string, args: string, cwd: string): string | null {
  const fd = /^(-?\d+)<((?:[^>\\]|\\.)*)>/.exec(args)
  if (FD_FIRST.has(syscall)) return fd ? unquote(fd[2]!) : null
  let base = cwd
  let rest = args
  if (fd) {
    base = unquote(fd[2]!)
    rest = args.slice(fd[0].length)
  } else if (args.startsWith("AT_FDCWD")) rest = args.slice(8)
  const quoted = /"((?:[^"\\]|\\.)*)"/.exec(rest)
  if (!quoted) return null
  const path = unquote(quoted[1]!)
  return isAbsolute(path) ? path : resolve(base, path)
}

function parseStrace(file: string, cwd: string, from: number): Call[] {
  const calls: Call[] = []
  const text = readFileSync(file, "utf8")
  let start = 0
  while (start < text.length) {
    let end = text.indexOf("\n", start)
    if (end < 0) end = text.length
    const line = text.slice(start, end)
    start = end + 1
    // "<pid> <seconds.micros> syscall(args…" ; resumed halves are skipped.
    const match = /^\d+\s+(\d+\.\d+)\s+([a-z0-9_]+)\((.*)$/.exec(line)
    if (!match) continue
    const t = Number(match[1]) * 1000
    if (t < from) continue
    calls.push({
      t,
      syscall: match[2]!,
      path: callPath(match[2]!, match[3]!, cwd),
    })
  }
  return calls
}

// ── Counting ──────────────────────────────────────────────────────────

interface SqlEntry {
  t: number
  kind: "sql" | "timer" | "ready"
  sql?: string
  site?: string
  auth?: boolean
  timer?: string
  delay?: number
}

interface Counts {
  stat: number
  open: number
  read: number
  readdir: number
  sqliteRead: number
  otherPath: number
  /** File system calls outside the workspace and app directory. */
  elsewhere: number
  sql: number
  authSql: number
}

interface Evidence {
  /** Calls per request by syscall and path (workspace and app only). */
  paths: { call: string; path: string; perRequest: number }[]
  statements: { sql: string; site: string; auth: boolean; perRequest: number }[]
}

const ZERO: Counts = {
  stat: 0,
  open: 0,
  read: 0,
  readdir: 0,
  sqliteRead: 0,
  otherPath: 0,
  elsewhere: 0,
  sql: 0,
  authSql: 0,
}

function classify(call: Call, roots: string[]): keyof Counts | null {
  const path = call.path
  if (!path || !path.startsWith("/")) return null
  const ours = roots.some(
    (root) => path === root || path.startsWith(`${root}/`)
  )
  if (!ours) return "elsewhere"
  if (STAT.has(call.syscall)) return "stat"
  if (OPEN.has(call.syscall)) return "open"
  if (READ.has(call.syscall))
    return /\.(sqlite|db)(-wal|-shm|-journal)?$/.test(path)
      ? "sqliteRead"
      : "read"
  if (READDIR.has(call.syscall)) return "readdir"
  return "otherPath"
}

function within<T extends { t: number }>(items: T[], window: Window): T[] {
  return items.filter((item) => item.t >= window.from && item.t < window.to)
}

function countWindow(
  calls: Call[],
  sql: SqlEntry[],
  window: Window,
  roots: string[]
): {
  counts: Counts
  paths: Map<string, number>
  statements: Map<string, number>
} {
  const counts = { ...ZERO }
  const paths = new Map<string, number>()
  const statements = new Map<string, number>()
  for (const call of within(calls, window)) {
    const kind = classify(call, roots)
    if (!kind) continue
    counts[kind] += 1
    if (kind !== "elsewhere") {
      const key = `${call.syscall} ${shorten(call.path!, roots)}`
      paths.set(key, (paths.get(key) ?? 0) + 1)
    }
  }
  for (const entry of within(sql, window)) {
    if (entry.kind !== "sql") continue
    if (entry.auth) counts.authSql += 1
    else counts.sql += 1
    const key = JSON.stringify([entry.sql, entry.site, Boolean(entry.auth)])
    statements.set(key, (statements.get(key) ?? 0) + 1)
  }
  return { counts, paths, statements }
}

let ROOT_NAMES: [string, string][] = []
function shorten(path: string, roots: string[]): string {
  for (const [root, name] of ROOT_NAMES)
    if (path === root || path.startsWith(`${root}/`))
      return `${name}${path.slice(root.length)}`
  void roots
  return path
}

/** Per request: the request window minus the idle window after it. */
function perRequest(
  calls: Call[],
  sql: SqlEntry[],
  busy: Window,
  idle: Window,
  roots: string[]
): { counts: Counts; evidence: Evidence } {
  const a = countWindow(calls, sql, busy, roots)
  const b = countWindow(calls, sql, idle, roots)
  const n = busy.requests
  const counts = Object.fromEntries(
    Object.keys(ZERO).map((key) => {
      const name = key as keyof Counts
      return [name, round((a.counts[name] - b.counts[name]) / n, 2)!]
    })
  ) as unknown as Counts
  const diff = (left: Map<string, number>, right: Map<string, number>) =>
    [...new Set([...left.keys(), ...right.keys()])]
      .map((key) => ({
        key,
        perRequest: round(
          ((left.get(key) ?? 0) - (right.get(key) ?? 0)) / n,
          2
        )!,
      }))
      .filter((item) => item.perRequest > 0)
      .sort((x, y) => y.perRequest - x.perRequest)
  return {
    counts,
    evidence: {
      paths: diff(a.paths, b.paths)
        .slice(0, 15)
        .map(({ key, perRequest }) => {
          const split = key.indexOf(" ")
          return {
            call: key.slice(0, split),
            path: key.slice(split + 1),
            perRequest,
          }
        }),
      statements: diff(a.statements, b.statements)
        .slice(0, 15)
        .map(({ key, perRequest }) => {
          const [text, site, auth] = JSON.parse(key) as [
            string,
            string,
            boolean,
          ]
          return { sql: text, site, auth, perRequest }
        }),
    },
  }
}

// ── Requests ──────────────────────────────────────────────────────────

async function request(
  base: string,
  cookies: Cookie[],
  path: string
): Promise<number> {
  const started = performance.now()
  const response = await fetch(base + path, {
    headers: { Cookie: cookieHeader(cookies) },
    signal: AbortSignal.timeout(110_000),
  })
  await response.arrayBuffer()
  if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`)
  return performance.now() - started
}

async function endpointsFor(
  base: string,
  cookies: Cookie[],
  fixture: FixtureManifest
): Promise<Endpoint[]> {
  const { spaceId, path } = fixture.probes.markdown
  const space = `/api/spaces/${encodeURIComponent(spaceId)}`
  const query = new URLSearchParams({ path })
  const { page } = await api<{ page: { revision?: string } }>(
    base,
    cookies,
    `${space}/documents/page?${query}`
  )
  if (!page.revision) throw new Error(`no revision for ${path}`)
  return [
    { name: "spaces", path: "/api/spaces" },
    { name: "space", path: space },
    { name: "documents", path: `${space}/documents?includeArchived=false` },
    { name: "documents/page", path: `${space}/documents/page?${query}` },
    {
      name: "documents/content",
      path: `${space}/documents/content?${new URLSearchParams({ path, rev: page.revision })}`,
    },
    {
      name: "recent",
      path: "/api/recent?sort=updated&includeTemporary=false&limit=30",
    },
    { name: "pending", path: "/api/pending" },
    { name: "threads", path: "/api/threads" },
    {
      name: "search",
      path: `/api/search?${new URLSearchParams({
        query: fixture.searchTerms[0]!,
        documentMode: "common",
        maxResults: "20",
      })}`,
    },
    { name: "workspace", path: "/api/workspace" },
  ]
}

interface Session {
  role: Role
  cookies: Cookie[]
  /** Team member id: a member's sockets name it, as the web client does. */
  memberId?: string
}

/** Boot, sign in and (with --team) turn Teams on. */
async function boot(options: {
  checkout: string
  fixture: FixtureManifest
  dir: string
  team: boolean
  log: string
  strace: string | null
}): Promise<{
  server: ServerProcess
  sessions: Session[]
  roles: TeamRoles | null
  run: { workspace: string; app: string }
}> {
  const run = restoreFixture(options.dir)
  rmSync(options.log, { force: true })
  const server = await startServer({
    checkout: options.checkout,
    ...run,
    env: {
      WORKTABLE_REQUIRE_AUTH: "1",
      WORKTABLE_PERF_IO_LOG: options.log,
      WORKTABLE_PERF_IO_ROOT: options.checkout,
      // The timing run logs timers only: SQL logging would slow the
      // endpoints that run SQL.
      ...(options.strace ? {} : { WORKTABLE_PERF_IO_SQL: "0" }),
    },
    bunArgs: ["--preload", PRELOAD],
    ...(options.strace
      ? {
          wrapper: [
            "strace",
            "-f",
            "--seccomp-bpf",
            "-qq",
            "-ttt",
            "-y",
            "-s",
            "0",
            "-e",
            "trace=%file,%fstat,read,pread64,readv,preadv,preadv2,getdents64",
            "-e",
            "signal=none",
            "-o",
            options.strace,
          ],
        }
      : {}),
  })
  try {
    const limit = options.strace ? 900_000 : 300_000
    if ((await waitForIdle(server.pid, limit)) === "busy")
      throw new Error(`server still busy ${limit / 60_000} minutes after boot`)
    // Some boot work runs once, 30 s after start; measure after it.
    await Bun.sleep(
      Math.max(0, 35_000 - (performance.now() - server.startedAt))
    )
    if ((await waitForIdle(server.pid, 120_000)) === "busy")
      throw new Error("server still busy after its delayed boot work")
    const solo = await signInSoloOwner(server.url)
    let roles: TeamRoles | null = null
    let sessions: Session[] = [{ role: "solo", cookies: solo }]
    if (options.team) {
      const spaces = (
        await api<{ spaces: { id: string }[] }>(server.url, solo, "/api/spaces")
      ).spaces.map((space) => space.id)
      roles = await enableTeam(server.url, solo, spaces, [
        options.fixture.probes.markdown.spaceId,
      ])
      sessions = [
        {
          role: "owner",
          cookies: await signInTeam(server.url, roles.owner),
          memberId: roles.owner.memberId,
        },
        {
          role: "member",
          cookies: await signInTeam(server.url, roles.member),
          memberId: roles.member.memberId,
        },
      ]
      if ((await waitForIdle(server.pid, 120_000)) === "busy")
        throw new Error("server still busy 2 minutes after turning Teams on")
    }
    return { server, sessions, roles, run }
  } catch (error) {
    console.log(server.output().slice(-3000))
    await server.stop()
    throw error
  }
}

function readLog(file: string): SqlEntry[] {
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SqlEntry)
}

// ── Counting run ──────────────────────────────────────────────────────

interface EndpointCounts {
  role: Role
  endpoint: string
  path: string
  requests: number
  /** Calls and statements in the subtracted idle window (0 is clean). */
  idleNoise: number
  counts: Counts
  evidence: Evidence
}

interface IdleCounts {
  role: Role | "none"
  sockets: number
  seconds: number
  /** Calls per second on workspace and app paths, by syscall and path. */
  paths: { call: string; path: string; perSecond: number }[]
  counts: Counts
}

async function openTabs(
  base: string,
  session: Session,
  spaceId: string,
  tabs: number,
  withThreads: boolean
): Promise<WebSocket[]> {
  const ws = base.replace(/^http/, "ws")
  const member = session.memberId
    ? `&memberId=${encodeURIComponent(session.memberId)}`
    : ""
  const cookies = session.cookies
  const urls = Array.from({ length: tabs }, () => [
    `${ws}/ws?spaceId=${encodeURIComponent(spaceId)}${member}`,
    ...(withThreads ? [`${ws}/ws?scope=threads${member}`] : []),
  ]).flat()
  return Promise.all(
    urls.map(
      (url) =>
        new Promise<WebSocket>((resolveSocket, reject) => {
          // As a browser tab: the cookie path requires a same-origin Origin.
          const socket = new WebSocket(url, {
            headers: { Cookie: cookieHeader(cookies), Origin: base },
          } as unknown as string[])
          const timer = setTimeout(
            () => reject(new Error(`no subscription on ${url}`)),
            30_000
          )
          socket.addEventListener("message", (event) => {
            const message = JSON.parse(String(event.data)) as { type?: string }
            if (message.type === "subscribed") {
              clearTimeout(timer)
              resolveSocket(socket)
            }
          })
          socket.addEventListener("error", () =>
            reject(new Error(`socket error on ${url}`))
          )
          socket.addEventListener("close", (event) =>
            reject(new Error(`socket closed on ${url}: ${event.code}`))
          )
        })
    )
  )
}

function closeAll(sockets: WebSocket[]): void {
  for (const socket of sockets) socket.close()
}

async function countingRun(options: {
  checkout: string
  fixture: FixtureManifest
  dir: string
  team: boolean
  out: string
  requests: number
  attempts: number
  idleSeconds: number
  sockets: number
}): Promise<{
  calibration: { path: string; reads: number; opens: number; ok: boolean }
  endpoints: EndpointCounts[]
  idle: IdleCounts[]
}> {
  const log = join(options.out, "io-counting.jsonl")
  const trace = join(options.out, "strace.log")
  const { server, sessions, run } = await boot({
    ...options,
    log,
    strace: trace,
  })
  const windows: Window[] = []
  const pathsByRole = new Map<Role, Endpoint[]>()
  const roots = [run.workspace, run.app]
  ROOT_NAMES = [
    [run.workspace, "<workspace>"],
    [run.app, "<app>"],
  ]
  const probe = options.fixture.probes.markdown
  const probeFile = join(
    run.workspace,
    "spaces",
    probe.spaceId,
    "docs",
    `${probe.path}.md`
  )
  let measuredFrom = 0
  try {
    measuredFrom = Date.now()
    // Calibration: a changed file must be read again by the legacy route.
    const first = sessions[0]!
    const legacy = `/api/spaces/${probe.spaceId}/docs/${probe.path}?conversionCheck=skip`
    await request(server.url, first.cookies, legacy)
    await Bun.sleep(300)
    const now = new Date()
    if (existsSync(probeFile)) utimesSync(probeFile, now, now)
    const calibration: Window = {
      role: first.role,
      name: "calibration",
      kind: "requests",
      from: Date.now(),
      to: 0,
      requests: 1,
    }
    await request(server.url, first.cookies, legacy)
    calibration.to = Date.now()
    windows.push(calibration)
    await Bun.sleep(500)

    for (const session of sessions) {
      const endpoints = await endpointsFor(
        server.url,
        session.cookies,
        options.fixture
      )
      pathsByRole.set(session.role, endpoints)
      for (const endpoint of endpoints) {
        for (let index = 0; index < WARMUP; index += 1)
          await request(server.url, session.cookies, endpoint.path)
        // Background work (a sweep, a watcher echo) can land in either
        // window; each endpoint is measured `attempts` times and the
        // attempt with the quietest idle window, then the least request
        // activity, is reported.
        for (let attempt = 0; attempt < options.attempts; attempt += 1) {
          await Bun.sleep(200)
          const busy: Window = {
            role: session.role,
            name: endpoint.name,
            kind: "requests",
            from: Date.now(),
            to: 0,
            requests: options.requests,
          }
          for (let index = 0; index < options.requests; index += 1)
            await request(server.url, session.cookies, endpoint.path)
          // Work a request leaves running (an index update, a log append)
          // counts against it: the window closes 300 ms after the last one.
          await Bun.sleep(300)
          busy.to = Date.now()
          const idle: Window = {
            role: session.role,
            name: endpoint.name,
            kind: "idle",
            from: Date.now(),
            to: 0,
            requests: options.requests,
          }
          await Bun.sleep(Math.max(busy.to - busy.from, 50))
          idle.to = Date.now()
          windows.push(busy, idle)
          console.log(
            `[io-count] ${session.role} ${endpoint.name}: ${options.requests} requests in ${busy.to - busy.from} ms`
          )
        }
      }
    }

    // Idle: no sockets, then open tabs as the last session.
    const idleWindows: {
      window: Window
      sockets: number
      role: Role | "none"
    }[] = []
    const quiet = async (role: Role | "none", sockets: number) => {
      const window: Window = {
        role: role === "none" ? "solo" : role,
        name: `idle-${sockets}`,
        kind: "idle",
        from: Date.now(),
        to: 0,
        requests: 1,
      }
      await Bun.sleep(options.idleSeconds * 1000)
      window.to = Date.now()
      idleWindows.push({ window, sockets, role })
    }
    await Bun.sleep(1000)
    await quiet("none", 0)
    const last = sessions.at(-1)!
    const tabs = await openTabs(
      server.url,
      last,
      probe.spaceId,
      options.sockets,
      true
    )
    await Bun.sleep(2000)
    await quiet(last.role, tabs.length)
    closeAll(tabs)
    await Bun.sleep(500)
    await server.stop()

    const calls = parseStrace(
      trace,
      join(options.checkout, "packages", "server"),
      measuredFrom - 1000
    )
    if (calls.length === 0)
      throw new Error(
        `strace recorded nothing after ${measuredFrom}; is strace working?`
      )
    const sql = readLog(log)
    const calibrationCalls = within(calls, calibration).filter(
      (call) => call.path === probeFile
    )
    const result = {
      calibration: {
        path: shorten(probeFile, roots),
        reads: calibrationCalls.filter((call) => READ.has(call.syscall)).length,
        opens: calibrationCalls.filter((call) => OPEN.has(call.syscall)).length,
        ok: false,
      },
      endpoints: [] as EndpointCounts[],
      idle: [] as IdleCounts[],
    }
    result.calibration.ok =
      result.calibration.reads > 0 && result.calibration.opens > 0
    const activity = (window: Window) => {
      const { counts } = countWindow(calls, sql, window, roots)
      return Object.entries(counts)
        .filter(([name]) => name !== "elsewhere")
        .reduce((sum, [, value]) => sum + value, 0)
    }
    const pairs = new Map<
      string,
      { busy: Window; idle: Window; noise: number; busyActivity: number }
    >()
    for (let index = 0; index < windows.length; index += 1) {
      const busy = windows[index]!
      const idle = windows[index + 1]
      if (busy.kind !== "requests" || !idle || idle.kind !== "idle") continue
      const key = `${busy.role} ${busy.name}`
      const noise = activity(idle)
      // Background work only ever adds to a window. Prefer the quietest
      // idle window, since its activity is subtracted and could hide the
      // request's own work; among equally quiet ones, the attempt whose
      // requests did the least (a scan can land in that window too).
      const busyActivity = activity(busy)
      const best = pairs.get(key)
      if (
        !best ||
        noise < best.noise ||
        (noise === best.noise && busyActivity < best.busyActivity)
      )
        pairs.set(key, { busy, idle, noise, busyActivity })
    }
    for (const { busy, idle, noise } of pairs.values()) {
      const { counts, evidence } = perRequest(calls, sql, busy, idle, roots)
      result.endpoints.push({
        role: busy.role,
        endpoint: busy.name,
        path:
          pathsByRole.get(busy.role)?.find((item) => item.name === busy.name)
            ?.path ?? "",
        requests: busy.requests,
        idleNoise: noise,
        counts,
        evidence,
      })
    }
    for (const { window, sockets, role } of idleWindows) {
      const { counts, paths } = countWindow(calls, sql, window, roots)
      const seconds = (window.to - window.from) / 1000
      result.idle.push({
        role,
        sockets,
        seconds: round(seconds, 1)!,
        counts,
        paths: [...paths.entries()]
          .sort((x, y) => y[1] - x[1])
          .slice(0, 10)
          .map(([key, count]) => {
            const split = key.indexOf(" ")
            return {
              call: key.slice(0, split),
              path: key.slice(split + 1),
              perSecond: round(count / seconds, 2)!,
            }
          }),
      })
    }
    // Keep the measured windows of the trace as evidence, not the boot.
    const kept = readFileSync(trace, "utf8")
      .split("\n")
      .filter((line) => {
        const t = Number(/^\d+\s+(\d+\.\d+)/.exec(line)?.[1] ?? 0) * 1000
        return t >= measuredFrom - 1000
      })
      .join("\n")
    writeFileSync(join(options.out, "strace-measured.log.gz"), gzipSync(kept))
    rmSync(trace, { force: true })
    return result
  } finally {
    await server.stop()
    writeFileSync(join(options.out, "server-counting.log"), server.output())
  }
}

// ── Timing run ────────────────────────────────────────────────────────

interface Timing {
  role: Role
  endpoint: string
  p50: number
  p95: number
  samples: number
}

interface FanOut {
  role: Role
  sockets: number
  writes: number
  /** Write start to the last socket's message, per write. */
  allMs: { p50: number; max: number }
  /** Write start to each socket's message, over all writes. */
  eachMs: { p50: number; p95: number }
  writeMs: { p50: number; max: number }
  missed: number
}

interface IdleCost {
  role: Role | "none"
  sockets: number
  seconds: number
  cpuMs: number
  wakeups: number
  /** Timer callbacks of 100 ms or more that fired, by site and delay. */
  timers: { site: string; delay: number; fires: number }[]
}

/** Context switches of the main (JavaScript) thread: how often it woke. */
function wakeups(pid: number): number {
  try {
    const status = readFileSync(`/proc/${pid}/task/${pid}/status`, "utf8")
    return ["voluntary_ctxt_switches", "nonvoluntary_ctxt_switches"]
      .map((name) =>
        Number(new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(status)?.[1] ?? 0)
      )
      .reduce((sum, value) => sum + value, 0)
  } catch {
    return Number.NaN
  }
}

function richBlocks(text: string): unknown[] {
  return Array.from({ length: 8 }, (_, index) => ({
    id: `fanout-${index}`,
    type: index === 0 ? "heading" : "paragraph",
    props: {
      textColor: "default",
      backgroundColor: "default",
      textAlignment: "left",
      ...(index === 0 ? { level: 1 } : {}),
    },
    content: [{ type: "text", text: `${text} ${index}`, styles: {} }],
    children: [],
  }))
}

async function fanOut(
  base: string,
  session: Session,
  spaceId: string,
  sockets: number,
  writes: number
): Promise<FanOut> {
  const tabs = await openTabs(base, session, spaceId, sockets, false)
  const all: number[] = []
  const each: number[] = []
  const write: number[] = []
  let missed = 0
  const put = (index: number) =>
    api(
      base,
      session.cookies,
      `/api/spaces/${encodeURIComponent(spaceId)}/docs/perf/fan-out`,
      { method: "PUT", body: { content: richBlocks(`Fan-out ${index}`) } }
    )
  try {
    // The first write after boot loads the editor model; not measured.
    await put(-1)
    await Bun.sleep(1000)
    for (let index = 0; index < writes; index += 1) {
      const arrivals: number[] = []
      const started = performance.now()
      const done = Promise.all(
        tabs.map(
          (socket) =>
            new Promise<void>((resolveArrival) => {
              const timer = setTimeout(() => {
                missed += 1
                socket.removeEventListener("message", listener)
                resolveArrival()
              }, 10_000)
              const listener = (event: MessageEvent) => {
                const type = (
                  JSON.parse(String(event.data)) as { type?: string }
                ).type
                if (type === "subscribed") return
                clearTimeout(timer)
                arrivals.push(performance.now() - started)
                socket.removeEventListener("message", listener)
                resolveArrival()
              }
              socket.addEventListener("message", listener)
            })
        )
      )
      await put(index)
      write.push(performance.now() - started)
      await done
      if (arrivals.length > 0) all.push(Math.max(...arrivals))
      each.push(...arrivals)
      await Bun.sleep(1000)
    }
  } finally {
    closeAll(tabs)
  }
  return {
    role: session.role,
    sockets,
    writes,
    allMs: {
      p50: round(percentile(all, 0.5), 1)!,
      max: round(Math.max(...all), 1)!,
    },
    eachMs: {
      p50: round(percentile(each, 0.5), 1)!,
      p95: round(percentile(each, 0.95), 1)!,
    },
    writeMs: {
      p50: round(percentile(write, 0.5), 1)!,
      max: round(Math.max(...write), 1)!,
    },
    missed,
  }
}

async function timingRun(options: {
  checkout: string
  fixture: FixtureManifest
  dir: string
  team: boolean
  out: string
  samples: number
  idleSeconds: number
  sockets: number
}): Promise<{ timings: Timing[]; fanOut: FanOut[]; idle: IdleCost[] }> {
  const log = join(options.out, "io-timing.jsonl")
  const { server, sessions } = await boot({ ...options, log, strace: null })
  const spaceId = options.fixture.probes.markdown.spaceId
  try {
    const timings: Timing[] = []
    for (const session of sessions) {
      for (const endpoint of await endpointsFor(
        server.url,
        session.cookies,
        options.fixture
      )) {
        for (let index = 0; index < WARMUP; index += 1)
          await request(server.url, session.cookies, endpoint.path)
        const values: number[] = []
        for (let index = 0; index < options.samples; index += 1)
          values.push(await request(server.url, session.cookies, endpoint.path))
        timings.push({
          role: session.role,
          endpoint: endpoint.name,
          p50: round(percentile(values, 0.5), 2)!,
          p95: round(percentile(values, 0.95), 2)!,
          samples: values.length,
        })
      }
    }
    const fan: FanOut[] = []
    for (const session of sessions)
      fan.push(await fanOut(server.url, session, spaceId, options.sockets, 10))
    await waitForIdle(server.pid, 120_000)

    const idle: IdleCost[] = []
    const measureIdle = async (role: Role | "none", sockets: number) => {
      const before = processCounters(server.pid)
      const wakeBefore = wakeups(server.pid)
      const from = Date.now()
      await Bun.sleep(options.idleSeconds * 1000)
      const to = Date.now()
      const after = processCounters(server.pid)
      const fires = new Map<string, number>()
      for (const entry of readLog(log))
        if (entry.kind === "timer" && entry.t >= from && entry.t < to) {
          const key = JSON.stringify([entry.site, entry.delay])
          fires.set(key, (fires.get(key) ?? 0) + 1)
        }
      idle.push({
        role,
        sockets,
        seconds: round((to - from) / 1000, 1)!,
        cpuMs: before && after ? round(after.cpuMs - before.cpuMs, 0)! : -1,
        wakeups: wakeups(server.pid) - wakeBefore,
        timers: [...fires.entries()]
          .map(([key, count]) => {
            const [site, delay] = JSON.parse(key) as [string, number]
            return { site, delay, fires: count }
          })
          .sort((x, y) => y.fires - x.fires),
      })
    }
    await measureIdle("none", 0)
    const last = sessions.at(-1)!
    const tabs = await openTabs(
      server.url,
      last,
      spaceId,
      options.sockets,
      true
    )
    await Bun.sleep(2000)
    await measureIdle(last.role, tabs.length)
    closeAll(tabs)
    return { timings, fanOut: fan, idle }
  } finally {
    await server.stop()
    writeFileSync(join(options.out, "server-timing.log"), server.output())
  }
}

// ── Budgets and report ────────────────────────────────────────────────

interface Budgets {
  solo: { stat: number; sql: number }
  team: { stat: number; sql: number; authSql: number }
}

/** Endpoints over budget: the base run's figure plus the allowance. */
export function overBudget(
  rows: EndpointCounts[],
  base: EndpointCounts[],
  budgets: Budgets,
  team: boolean
): string[] {
  const failures: string[] = []
  for (const row of rows) {
    const reference = base.find((item) => item.endpoint === row.endpoint)
    if (!reference) {
      failures.push(`${row.role} ${row.endpoint}: not in the base run`)
      continue
    }
    const limits = team ? budgets.team : { ...budgets.solo, authSql: 0 }
    const check = (name: keyof Counts, limit: number, label: string) => {
      if (row.counts[name] > limit)
        failures.push(
          `${row.role} ${row.endpoint}: ${row.counts[name]} ${label} per request (base ${reference.counts[name]}, budget ${limit})`
        )
    }
    check("stat", reference.counts.stat + limits.stat, "stat-family calls")
    check("sql", reference.counts.sql + limits.sql, "SQL statements")
    // Better Auth's session statements are new with Teams: an absolute limit.
    check("authSql", limits.authSql, "Better Auth statements")
  }
  return failures
}

function writeSummary(out: string, result: Record<string, any>): void {
  const lines: string[] = [
    `# io-count: ${result.commit} ${result.team ? "team" : "solo"} (${result.profile})`,
    "",
    `${result.startedAt}, ${result.machine.cpus} CPUs, load ${result.machine.load1}, Bun ${result.machine.bun}.`,
    "",
  ]
  if (result.counting) {
    const calibration = result.counting.calibration
    lines.push(
      `Calibration: a changed \`${calibration.path}\` read by the legacy route: ${calibration.opens} opens, ${calibration.reads} reads (${calibration.ok ? "seen" : "NOT SEEN"}).`,
      "",
      "## Per hot request (workspace and app directory)",
      "",
      ...(result.base
        ? [`In brackets: the base run, \`${result.base}\`.`, ""]
        : []),
      markdownTable(
        [
          "Who",
          "Endpoint",
          "Stat",
          "Open",
          "Read",
          "Readdir",
          "SQLite reads",
          "SQL (ours)",
          "SQL (Better Auth)",
          "Other paths",
        ],
        result.counting.endpoints.map((row: EndpointCounts) => {
          // With a base run: "this (base)".
          const base = (result.baseCounts as EndpointCounts[] | null)?.find(
            (item) => item.endpoint === row.endpoint
          )
          const withBase = (name: keyof Counts) =>
            base
              ? `${row.counts[name]} (${base.counts[name]})`
              : row.counts[name]
          return [
            row.role,
            row.endpoint,
            withBase("stat"),
            withBase("open"),
            withBase("read"),
            withBase("readdir"),
            row.counts.sqliteRead,
            withBase("sql"),
            row.counts.authSql,
            row.counts.otherPath,
          ]
        })
      ),
      ""
    )
    if (result.failures?.length)
      lines.push(
        "**Over budget:**",
        "",
        ...result.failures.map((line: string) => `- ${line}`),
        ""
      )
    else if (result.check) lines.push("Within budgets.", "")
    lines.push("## Evidence", "")
    for (const row of result.counting.endpoints as EndpointCounts[]) {
      if (
        row.evidence.paths.length === 0 &&
        row.evidence.statements.length === 0
      )
        continue
      lines.push(`### ${row.role} ${row.endpoint}`, "", `\`${row.path}\``, "")
      for (const item of row.evidence.paths)
        lines.push(`- ${item.perRequest} × ${item.call} \`${item.path}\``)
      for (const item of row.evidence.statements)
        lines.push(
          `- ${item.perRequest} × SQL${item.auth ? " (Better Auth)" : ""} at \`${item.site}\`: \`${item.sql}\``
        )
      lines.push("")
    }
    lines.push("## Idle (file system calls)", "")
    for (const idle of result.counting.idle as IdleCounts[]) {
      lines.push(
        `- ${idle.sockets} sockets (${idle.role}), ${idle.seconds} s: ${idle.counts.stat} stat, ${idle.counts.open} open, ${idle.counts.read} read, ${idle.counts.sql} SQL, ${idle.counts.authSql} Better Auth SQL`
      )
      for (const item of idle.paths)
        lines.push(`  - ${item.perSecond}/s ${item.call} \`${item.path}\``)
    }
    lines.push("")
  }
  if (result.timing) {
    lines.push(
      "## Latency (no strace)",
      "",
      markdownTable(
        ["Who", "Endpoint", "p50 ms", "p95 ms", "Samples"],
        result.timing.timings.map((row: Timing) => [
          row.role,
          row.endpoint,
          row.p50,
          row.p95,
          row.samples,
        ])
      ),
      "",
      "## Fan-out",
      "",
      markdownTable(
        [
          "Who",
          "Sockets",
          "Writes",
          "All sockets p50 / max ms",
          "Each socket p50 / p95 ms",
          "Write p50 / max ms",
          "Missed",
        ],
        result.timing.fanOut.map((row: FanOut) => [
          row.role,
          row.sockets,
          row.writes,
          `${row.allMs.p50} / ${row.allMs.max}`,
          `${row.eachMs.p50} / ${row.eachMs.p95}`,
          `${row.writeMs.p50} / ${row.writeMs.max}`,
          row.missed,
        ])
      ),
      "",
      "## Idle cost",
      ""
    )
    for (const idle of result.timing.idle as IdleCost[]) {
      lines.push(
        `- ${idle.sockets} sockets (${idle.role}), ${idle.seconds} s: ${idle.cpuMs} ms CPU, ${idle.wakeups} wake-ups`
      )
      for (const timer of idle.timers)
        lines.push(
          `  - ${timer.fires} × ${timer.delay} ms timer from \`${timer.site}\``
        )
    }
    lines.push("")
  }
  writeFileSync(join(out, "summary.md"), lines.join("\n"))
}

// ── Main ──────────────────────────────────────────────────────────────

function gitCommit(checkout: string): string {
  if (process.env["PERF_COMMIT"]) return process.env["PERF_COMMIT"]
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: checkout,
    encoding: "utf8",
  })
  return result.status === 0 ? result.stdout.trim() : "unknown"
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const profile = (args.get("profile") ?? "1k") as FixtureManifest["profile"]
  const seed = numberArg(args, "seed", 1)
  const checkout = resolve(args.get("checkout") ?? REPO_ROOT)
  const team = args.has("team")
  const requests = numberArg(args, "requests", 20)
  const attempts = numberArg(args, "attempts", 2)
  const samples = numberArg(args, "samples", 50)
  const idleSeconds = numberArg(args, "idle-seconds", 30)
  const sockets = numberArg(args, "sockets", 20)
  const useStrace = !args.has("no-strace")
  const timing = !args.has("no-timing")
  if (!useStrace && !timing)
    throw new Error("--no-strace and --no-timing leave nothing to measure")
  const check = args.has("check")
  const basePath = args.get("base")
  if (check && args.has("no-strace"))
    throw new Error("--check needs the counting run; drop --no-strace")
  if (check && !basePath)
    throw new Error(
      "--check compares against a base run: pass --base <result.json> of a solo counting run"
    )
  const baseRows = basePath
    ? ((
        JSON.parse(readFileSync(basePath, "utf8")) as {
          team?: boolean
          counting?: { endpoints: EndpointCounts[] }
        }
      ).counting?.endpoints.filter((row) => row.role === "solo") ?? null)
    : null
  if (basePath && !baseRows?.length)
    throw new Error(
      `${basePath} has no solo counts (run it without --no-strace)`
    )
  const budgets = JSON.parse(
    readFileSync(
      args.get("budgets") ?? join(import.meta.dirname, "io-budgets.json"),
      "utf8"
    )
  ) as Budgets
  const dir = fixtureDir(profile, seed)
  const fixture = readFixture(dir)
  if (!fixture)
    throw new Error(
      `no current fixture at ${dir}; run bun run perf:fixtures --profile ${profile}`
    )
  if (useStrace && spawnSync("strace", ["-V"]).status !== 0)
    throw new Error("strace is not on PATH; install it or pass --no-strace")
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const out = resolve(
    args.get("out") ??
      join(PERF_ROOT, "results", `${stamp}-io-${profile}${team ? "-team" : ""}`)
  )
  mkdirSync(out, { recursive: true })

  const result: Record<string, any> = {
    commit: gitCommit(checkout),
    checkout,
    profile,
    seed,
    team,
    check,
    budgets,
    base: basePath ?? null,
    baseCounts: baseRows,
    startedAt: new Date().toISOString(),
    machine: {
      cpus: cpus().length,
      model: cpus()[0]?.model ?? "unknown",
      memoryGb: Math.round(totalmem() / 1024 ** 3),
      load1: round(loadavg()[0]!, 2),
      bun: Bun.version,
    },
    options: {
      requests,
      attempts,
      samples,
      idleSeconds,
      sockets,
      strace: useStrace,
      timing,
    },
  }
  const shared = { checkout, fixture, dir, team, out, idleSeconds, sockets }
  if (useStrace) {
    result["counting"] = await countingRun({ ...shared, requests, attempts })
    result["failures"] = [
      ...(result["counting"].calibration.ok
        ? []
        : [
            `calibration: strace did not show the read of ${result["counting"].calibration.path}`,
          ]),
      ...(baseRows
        ? overBudget(result["counting"].endpoints, baseRows, budgets, team)
        : []),
    ]
  }
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2))
  if (timing) {
    result["timing"] = await timingRun({ ...shared, samples })
    writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2))
  }
  writeSummary(out, result)
  console.log(readFileSync(join(out, "summary.md"), "utf8"))
  console.log(`[io-count] wrote ${out}`)
  // Without the calibration read the counts mean nothing, --check or not.
  if (useStrace && !result["counting"].calibration.ok) {
    console.error("[io-count] strace did not show the calibration read")
    process.exit(1)
  }
  if (check && result["failures"]?.length) {
    console.error(`[io-count] over budget:\n${result["failures"].join("\n")}`)
    process.exit(1)
  }
}

if (import.meta.main) {
  await main()
  process.exit(0)
}
