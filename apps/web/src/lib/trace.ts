// Opt-in client tracing for performance work. Run
// `localStorage.worktableTrace = "1"` and reload; remove the key to stop.
//
// The console then shows each query fetch with what started it and how long
// it took, the render commits of the sidebar, header and page (development
// builds only: production React does not time Profilers), the page's
// interaction latency (INP) and long animation frames. Entries name route
// templates and query keys, never content, and nothing leaves the browser.
import { focusManager, onlineManager } from "@tanstack/react-query"
import type { Query, QueryClient } from "@tanstack/react-query"
import type { ProfilerOnRenderCallback } from "react"

const TRACE_KEY = "worktableTrace"

let enabled: boolean | undefined

/** Read once per page load, so tracing never toggles under a mounted tree. */
export function traceEnabled(): boolean {
  if (enabled === undefined) {
    try {
      enabled =
        typeof localStorage !== "undefined" &&
        localStorage.getItem(TRACE_KEY) === "1"
    } catch {
      enabled = false
    }
  }
  return enabled
}

function log(...parts: unknown[]): void {
  console.debug("[trace]", ...parts)
}

function ms(value: number): string {
  return `${Math.round(value)}ms`
}

export type FetchTrigger =
  | "mount"
  | "invalidate"
  | "interval"
  | "reconnect"
  | "focus"
  | "prefetch"
  | "refetch"

let taskTrigger: FetchTrigger | null = null

/**
 * Attribute fetches that start during the current task, including its
 * microtasks, to `trigger`. Socket reconnects call this before revalidating.
 */
export function traceTrigger(trigger: FetchTrigger): void {
  if (!traceEnabled()) return
  taskTrigger = trigger
  setTimeout(() => {
    if (taskTrigger === trigger) taskTrigger = null
  }, 0)
}

export const traceRender: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration
) => {
  log(`render ${id} ${phase} ${ms(actualDuration)} (tree ${ms(baseDuration)})`)
}

function fetchTrigger(
  query: Query,
  observedThisTask: Set<Query>
): FetchTrigger {
  if (taskTrigger) return taskTrigger
  if (query.state.isInvalidated) return "invalidate"
  const observed = query.getObserversCount() > 0
  if (observedThisTask.has(query) || query.state.dataUpdateCount === 0) {
    return observed ? "mount" : "prefetch"
  }
  if (!observed) return "prefetch"
  if (query.observers.some((observer) => observer.options.refetchInterval)) {
    return "interval"
  }
  return "refetch"
}

function traceQueries(queryClient: QueryClient): void {
  const started = new WeakMap<Query, { at: number; trigger: FetchTrigger }>()
  const observedThisTask = new Set<Query>()
  focusManager.subscribe((focused) => {
    if (focused) traceTrigger("focus")
  })
  onlineManager.subscribe((online) => {
    if (online) traceTrigger("reconnect")
  })
  queryClient.getQueryCache().subscribe((event) => {
    const query = event.query
    if (event.type === "observerAdded") {
      if (observedThisTask.size === 0) {
        setTimeout(() => observedThisTask.clear(), 0)
      }
      observedThisTask.add(query)
      return
    }
    if (event.type !== "updated") return
    if (event.action.type === "fetch") {
      if (!started.has(query)) {
        started.set(query, {
          at: performance.now(),
          trigger: fetchTrigger(query, observedThisTask),
        })
      }
      return
    }
    const fetch = started.get(query)
    if (!fetch || query.state.fetchStatus !== "idle") return
    started.delete(query)
    const outcome =
      event.action.type === "success"
        ? "ok"
        : event.action.type === "error"
          ? "failed"
          : "cancelled"
    log(
      `query ${JSON.stringify(query.queryKey)} ${fetch.trigger} ${ms(performance.now() - fetch.at)} ${outcome}`
    )
  })
}

function traceVitals(routeTemplate: () => string): void {
  void import("web-vitals").then(({ onINP }) =>
    onINP(
      (metric) =>
        log(
          `INP ${ms(metric.value)} ${metric.rating} ${metric.entries[0]?.name ?? ""} on ${routeTemplate()}`
        ),
      { reportAllChanges: true }
    )
  )
  if (
    typeof PerformanceObserver === "undefined" ||
    !PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame")
  ) {
    return
  }
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const blocking = (
        entry as PerformanceEntry & { blockingDuration?: number }
      ).blockingDuration
      log(
        `long animation frame ${ms(entry.duration)}${blocking === undefined ? "" : `, blocking ${ms(blocking)}`} on ${routeTemplate()}`
      )
    }
  }).observe({ type: "long-animation-frame", buffered: true })
}

let installed = false

/** Start tracing when the page opted in. */
export function installTrace(
  queryClient: QueryClient,
  routeTemplate: () => string
): void {
  if (installed || typeof window === "undefined" || !traceEnabled()) return
  installed = true
  log("tracing on; remove localStorage.worktableTrace to stop")
  traceQueries(queryClient)
  traceVitals(routeTemplate)
}
