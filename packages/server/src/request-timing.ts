// Per-request timing spans, reported in the Server-Timing response header.
//
// Code anywhere below a request records into that request's spans through
// `timing`; outside a request the calls cost one AsyncLocalStorage lookup.
// The same middleware feeds the per-route latency histograms and logs slow or
// failed requests, with the Cloud gateway's request id when it sent one.

import { AsyncLocalStorage } from "node:async_hooks"
import { randomBytes } from "node:crypto"
import {
  REQUEST_ID_HEADER,
  REQUEST_ID_PATTERN,
} from "@worktable/hosted-contract"
import type { Context, MiddlewareHandler, Next } from "hono"
import { routePath } from "hono/route"
import { debugLogging, logError } from "./debug-log.ts"
import { gatewayAdmits, isHosted } from "./hosted.ts"
import { noteServerActivity, recordRouteLatency } from "./perf-diagnostics.ts"

/**
 * Spans in header order. `lock-wait` is time spent waiting for a space lock,
 * not holding it. `wait` is deliberate long-polling, which is excluded from
 * the slow-request threshold.
 */
const SPANS = [
  "auth",
  "lock-wait",
  "catalog",
  "revalidate",
  "db",
  "wait",
  "serialize",
  "br",
  "gzip",
] as const
export type TimingSpan = (typeof SPANS)[number]

const SPAN_INDEX = Object.fromEntries(
  SPANS.map((name, index) => [name, index])
) as Record<TimingSpan, number>

const SLOW_REQUEST_MS = 500

class RequestTiming {
  readonly startedAt = performance.now()
  // Allocated on the first span; most static requests record none.
  durations: Float64Array | null = null
  counts: Uint32Array | null = null

  add(name: TimingSpan, ms: number): void {
    if (!this.durations) {
      this.durations = new Float64Array(SPANS.length)
      this.counts = new Uint32Array(SPANS.length)
    }
    const index = SPAN_INDEX[name]
    this.durations[index]! += ms
    this.counts![index]! += 1
  }

  duration(name: TimingSpan): number {
    return this.durations?.[SPAN_INDEX[name]] ?? 0
  }

  header(totalMs: number): string {
    let header = ""
    if (this.durations && this.counts) {
      for (let index = 0; index < SPANS.length; index += 1) {
        const count = this.counts[index]!
        if (count === 0) continue
        const name = SPANS[index]!
        header += `${name};dur=${this.durations[index]!.toFixed(1)}`
        if (count > 1) header += `;desc="${name} (${count})"`
        header += ", "
      }
    }
    return `${header}total;dur=${totalMs.toFixed(1)}`
  }

  summary(): string {
    let summary = ""
    if (this.durations && this.counts) {
      for (let index = 0; index < SPANS.length; index += 1) {
        if (this.counts[index] === 0) continue
        summary += ` ${SPANS[index]}=${this.durations[index]!.toFixed(0)}ms`
      }
    }
    return summary
  }
}

const requestTiming = new AsyncLocalStorage<RequestTiming>()

export const timing = {
  /**
   * Time `work` as a span of the current request. Overlapping or repeated
   * spans of one name add up, so a span can exceed the request total.
   */
  span<T>(name: TimingSpan, work: () => T): T {
    const current = requestTiming.getStore()
    if (!current) return work()
    const startedAt = performance.now()
    let result: T
    try {
      result = work()
    } catch (error) {
      current.add(name, performance.now() - startedAt)
      throw error
    }
    if (result instanceof Promise) {
      return result.finally(() =>
        current.add(name, performance.now() - startedAt)
      ) as T
    }
    current.add(name, performance.now() - startedAt)
    return result
  },

  /** Allocation-free form: `const t = performance.now(); ...; timing.end(name, t)`. */
  end(name: TimingSpan, startedAt: number): void {
    requestTiming.getStore()?.add(name, performance.now() - startedAt)
  },
}

/** Time a middleware's own work, excluding the handlers after it. */
export function timedMiddleware(
  name: TimingSpan,
  middleware: MiddlewareHandler
): MiddlewareHandler {
  return async (c, next) => {
    const current = requestTiming.getStore()
    if (!current) return middleware(c, next)
    const startedAt = performance.now()
    let ended = false
    try {
      return await middleware(c, () => {
        ended = true
        current.add(name, performance.now() - startedAt)
        return next()
      })
    } finally {
      if (!ended) current.add(name, performance.now() - startedAt)
    }
  }
}

/**
 * The Cloud gateway's id for this request, so a log line can be matched to
 * the gateway's record of it. The gateway generates the id, so it is logged
 * only for a request the gateway admitted on a hosted tenant. Anywhere else a
 * client could have set it. Admission is checked here because this runs
 * before the admission guard, and earlier middleware can already answer.
 */
function requestIdOf(c: Context): string {
  const id = c.req.header(REQUEST_ID_HEADER)
  return id &&
    REQUEST_ID_PATTERN.test(id) &&
    isHosted() &&
    gatewayAdmits(c.req.raw)
    ? ` request=${id}`
    : ""
}

function isMcpPath(path: string): boolean {
  return (
    path === "/mcp" ||
    path.startsWith("/mcp/") ||
    path === "/api/mcp" ||
    path.startsWith("/api/mcp/")
  )
}

async function timeRequest(
  c: Context,
  next: Next,
  current: RequestTiming
): Promise<void> {
  const json = c.json
  c.json = ((object: unknown, arg?: unknown, headers?: unknown) => {
    const startedAt = performance.now()
    try {
      return (json as (...args: unknown[]) => Response)(object, arg, headers)
    } finally {
      current.add("serialize", performance.now() - startedAt)
    }
  }) as typeof c.json

  await next()

  const totalMs = performance.now() - current.startedAt
  const { method, path } = c.req
  const status = c.res.status
  // Logs name the matched route, never the URL: paths carry Space and
  // document names.
  const route = routePath(c)
  recordRouteLatency(method, route, totalMs)
  // Only an authenticated caller sees the breakdown: span durations would let
  // anyone else time workspace size and activity. MCP responses stay exactly
  // as the MCP transport produced them.
  if (c.get("identity") && !isMcpPath(path)) {
    try {
      c.res.headers.set("Server-Timing", current.header(totalMs))
    } catch {
      // A response with immutable headers keeps its own.
    }
  }
  if (status >= 500) {
    console.error(
      `[http] ${method} ${route} ${status} ${totalMs.toFixed(0)}ms${current.summary()}${requestIdOf(c)}`
    )
  } else if (totalMs - current.duration("wait") > SLOW_REQUEST_MS) {
    console.warn(
      `[http] slow ${method} ${route} ${status} ${totalMs.toFixed(0)}ms${current.summary()}${requestIdOf(c)}`
    )
  } else if (debugLogging) {
    console.debug(
      `[http] ${method} ${route} ${status} ${totalMs.toFixed(0)}ms${current.summary()}${requestIdOf(c)} ${path}`
    )
  }
}

/**
 * Register before response compression so the header and the total include
 * it. Logs the matched route template; only debug logging adds the path.
 */
export const serverTiming: MiddlewareHandler = (c, next) => {
  const current = new RequestTiming()
  noteServerActivity(current.startedAt)
  return requestTiming.run(current, timeRequest, c, next, current)
}

/**
 * Answer an error no route handled. The client gets a generic message and an
 * id; the log gets the same id, the route template and the error without its
 * message (`logError`).
 */
export function unexpectedErrorResponse(c: Context, error: Error): Response {
  const errorId = randomBytes(4).toString("hex")
  console.error(
    `[server] unexpected error ${errorId} in ${c.req.method} ${routePath(c)}${requestIdOf(c)}: ${logError(error)}`
  )
  return c.json(
    {
      error: `Something went wrong (error ${errorId}).`,
      code: "INTERNAL_ERROR",
      errorId,
    },
    500
  )
}
