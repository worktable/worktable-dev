// In-process performance diagnostics: event-loop lag, per-route latency,
// named operation timings and memory. Everything stays in memory, costs a few
// array increments per sample, and is read on demand by the owner-only
// GET /api/diagnostics/perf. All durations are milliseconds.

// Four buckets per doubling (about 19% resolution) from 1/64 ms to 2^17 ms
// (about two minutes), plus one underflow and one overflow bucket.
const SUB_BUCKETS = 4
const MIN_EXPONENT = -6
const MAX_EXPONENT = 17
const BUCKETS = (MAX_EXPONENT - MIN_EXPONENT) * SUB_BUCKETS + 2

function bucketOf(ms: number): number {
  if (ms < 2 ** MIN_EXPONENT) return 0
  const index =
    Math.floor(Math.log2(ms) * SUB_BUCKETS) - MIN_EXPONENT * SUB_BUCKETS + 1
  return Math.min(index, BUCKETS - 1)
}

function bucketUpperBound(index: number): number {
  return index === BUCKETS - 1
    ? Infinity
    : 2 ** (MIN_EXPONENT + index / SUB_BUCKETS)
}

export interface LatencySummary {
  count: number
  meanMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
  maxMs: number
}

const round = (ms: number) => Math.round(ms * 100) / 100

/** A fixed-size log-bucket histogram. Recording never allocates. */
export class LatencyHistogram {
  // Float64 counts stay exact to 2^53, so a lifetime histogram never wraps.
  private readonly counts = new Float64Array(BUCKETS)
  count = 0
  sum = 0
  max = 0

  record(ms: number): void {
    const value = ms > 0 ? ms : 0
    this.counts[bucketOf(value)]! += 1
    this.count += 1
    this.sum += value
    if (value > this.max) this.max = value
  }

  /**
   * The upper bound of the bucket holding the p-th percentile sample, capped
   * at the largest sample, so a reported value is never below the truth by
   * more than one bucket and never above the observed maximum.
   */
  percentile(p: number): number {
    if (this.count === 0) return 0
    const rank = Math.max(1, Math.ceil((p / 100) * this.count))
    let seen = 0
    for (let index = 0; index < BUCKETS; index += 1) {
      seen += this.counts[index]!
      if (seen >= rank) return Math.min(bucketUpperBound(index), this.max)
    }
    return this.max
  }

  add(other: LatencyHistogram): void {
    for (let index = 0; index < BUCKETS; index += 1) {
      this.counts[index]! += other.counts[index]!
    }
    this.count += other.count
    this.sum += other.sum
    if (other.max > this.max) this.max = other.max
  }

  reset(): void {
    this.counts.fill(0)
    this.count = 0
    this.sum = 0
    this.max = 0
  }

  summary(): LatencySummary {
    return {
      count: this.count,
      meanMs: this.count ? round(this.sum / this.count) : 0,
      p50Ms: round(this.percentile(50)),
      p95Ms: round(this.percentile(95)),
      p99Ms: round(this.percentile(99)),
      maxMs: round(this.max),
    }
  }
}

/**
 * Samples from the most recent `slotMs * slots` milliseconds. Slots rotate as
 * time passes, so a read covers between (slots - 1) and `slots` slot lengths.
 */
export class RollingHistogram {
  private readonly slotMs: number
  private readonly slots: LatencyHistogram[]
  private current = 0
  private slotStartedAt: number

  constructor(slotMs: number, slotCount: number, now: number) {
    this.slotMs = slotMs
    this.slots = Array.from({ length: slotCount }, () => new LatencyHistogram())
    this.slotStartedAt = now
  }

  get windowMs(): number {
    return this.slotMs * this.slots.length
  }

  record(ms: number, now: number): void {
    this.rotate(now)
    this.slots[this.current]!.record(ms)
  }

  snapshot(now: number): LatencyHistogram {
    this.rotate(now)
    const merged = new LatencyHistogram()
    for (const slot of this.slots) merged.add(slot)
    return merged
  }

  private rotate(now: number): void {
    const elapsed = Math.floor((now - this.slotStartedAt) / this.slotMs)
    if (elapsed <= 0) return
    for (let step = 0; step < Math.min(elapsed, this.slots.length); step += 1) {
      this.current = (this.current + 1) % this.slots.length
      this.slots[this.current]!.reset()
    }
    this.slotStartedAt += elapsed * this.slotMs
  }
}

// ── Event-loop lag ──────────────────────────────────────────────────────────

const LAG_INTERVAL_MS = 50
// Lag only matters while work is happening. An idle server stops the timer so
// Desktop on battery and Cloud tenants can sleep.
const LAG_IDLE_AFTER_MS = 10_000
const eventLoopLag = new RollingHistogram(10_000, 6, performance.now())
let lagSamplerEnabled = false
let lagTimer: ReturnType<typeof setInterval> | null = null
let lastActivityAt = -Infinity

/** How late a timer tick fired: time beyond the interval since the last tick. */
export function timerDrift(
  previousTickAt: number,
  now: number,
  intervalMs: number
): number {
  return Math.max(0, now - previousTickAt - intervalMs)
}

/**
 * Measure event-loop lag as the drift of a 50 ms interval while the server is
 * active. Idempotent; the timer is unref'd so it never keeps the process alive.
 */
export function startEventLoopLagSampler(): void {
  lagSamplerEnabled = true
  noteServerActivity()
}

export function stopEventLoopLagSampler(): void {
  lagSamplerEnabled = false
  stopLagTimer()
}

/**
 * A request or socket frame arrived. Sampling runs until 10 s pass without
 * one, then stops completely until the next.
 */
export function noteServerActivity(now = performance.now()): void {
  lastActivityAt = now
  if (!lagSamplerEnabled || lagTimer) return
  let previousTickAt = now
  lagTimer = setInterval(() => {
    const tickAt = performance.now()
    eventLoopLag.record(
      timerDrift(previousTickAt, tickAt, LAG_INTERVAL_MS),
      tickAt
    )
    previousTickAt = tickAt
    if (tickAt - lastActivityAt > LAG_IDLE_AFTER_MS) stopLagTimer()
  }, LAG_INTERVAL_MS)
  lagTimer.unref?.()
}

function stopLagTimer(): void {
  if (lagTimer) clearInterval(lagTimer)
  lagTimer = null
}

// ── Route latency ───────────────────────────────────────────────────────────

// Keyed by method, then by the matched route pattern, never the raw URL, so
// the number of histograms is bounded by the registered routes.
const routeLatency = new Map<string, Map<string, LatencyHistogram>>()
const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
])

export function recordRouteLatency(
  requestMethod: string,
  route: string,
  ms: number
): void {
  // Any token is a valid method; unknown ones must not grow the map.
  const method = METHODS.has(requestMethod) ? requestMethod : "OTHER"
  let routes = routeLatency.get(method)
  if (!routes) routeLatency.set(method, (routes = new Map()))
  let histogram = routes.get(route)
  if (!histogram) routes.set(route, (histogram = new LatencyHistogram()))
  histogram.record(ms)
}

// ── Named operations ────────────────────────────────────────────────────────

/** Background work worth timing outside a request. Extend as items land. */
export type PerfOperation = "yjs.load" | "yjs.persist"

const operations = new Map<PerfOperation, LatencyHistogram>()

export function recordOperation(name: PerfOperation, ms: number): void {
  let histogram = operations.get(name)
  if (!histogram) operations.set(name, (histogram = new LatencyHistogram()))
  histogram.record(ms)
}

/** Record how long `work` takes to succeed; failures pass through unrecorded. */
export function timeOperation<T>(
  name: PerfOperation,
  work: Promise<T>
): Promise<T> {
  const startedAt = performance.now()
  return work.then((value) => {
    recordOperation(name, performance.now() - startedAt)
    return value
  })
}

// ── Snapshot ────────────────────────────────────────────────────────────────

async function memoryStats() {
  const usage = process.memoryUsage()
  let jsc:
    | {
        heapSize: number
        heapCapacity: number
        extraMemorySize: number
        objectCount: number
      }
    | undefined
  try {
    const stats = (await import("bun:jsc")).heapStats()
    jsc = {
      heapSize: stats.heapSize,
      heapCapacity: stats.heapCapacity,
      extraMemorySize: stats.extraMemorySize,
      objectCount: stats.objectCount,
    }
  } catch {
    // Not running on Bun's JavaScriptCore; process figures still apply.
  }
  return {
    rssBytes: usage.rss,
    heapTotalBytes: usage.heapTotal,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
    ...(jsc ? { jsc } : {}),
  }
}

export async function perfDiagnosticsSnapshot() {
  const now = performance.now()
  const lag = eventLoopLag.snapshot(now)
  const routes = [...routeLatency].flatMap(([method, byRoute]) =>
    [...byRoute].map(([route, histogram]) => ({
      method,
      route,
      totalMs: round(histogram.sum),
      ...histogram.summary(),
    }))
  )
  routes.sort((a, b) => b.totalMs - a.totalMs)
  return {
    uptimeMs: Math.round(process.uptime() * 1000),
    eventLoopLag: {
      intervalMs: LAG_INTERVAL_MS,
      idleAfterMs: LAG_IDLE_AFTER_MS,
      windowMs: eventLoopLag.windowMs,
      ...lag.summary(),
    },
    routes,
    operations: Object.fromEntries(
      [...operations].map(([name, histogram]) => [name, histogram.summary()])
    ),
    memory: await memoryStats(),
  }
}
