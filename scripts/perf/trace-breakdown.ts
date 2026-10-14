/**
 * Main-thread time from a Chrome trace, grouped the way Lighthouse groups it
 * (lighthouse-core/lib/tracehouse/task-groups.js): script parse and compile,
 * script evaluation, style and layout, paint and composite, HTML parsing,
 * garbage collection and other. Each event's self time goes to its group;
 * events with unknown names inherit their parent's group.
 */

export const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "toplevel",
  "v8.execute",
  "blink.user_timing",
]

export type Group =
  | "parseCompile"
  | "script"
  | "styleLayout"
  | "paint"
  | "parseHTML"
  | "gc"
  | "other"

export const GROUPS: Group[] = [
  "parseCompile",
  "script",
  "styleLayout",
  "paint",
  "parseHTML",
  "gc",
  "other",
]

const GROUP_BY_NAME: Record<string, Group> = {}
const assign = (group: Group, names: string[]) => {
  for (const name of names) GROUP_BY_NAME[name] = group
}
assign("parseHTML", ["ParseHTML", "ParseAuthorStyleSheet"])
assign("styleLayout", [
  "ScheduleStyleRecalculation",
  "UpdateLayoutTree",
  "RecalculateStyles",
  "InvalidateLayout",
  "Layout",
])
assign("paint", [
  "Animation",
  "HitTest",
  "PaintSetup",
  "Paint",
  "PaintImage",
  "PrePaint",
  "RasterTask",
  "ScrollLayer",
  "UpdateLayer",
  "UpdateLayerTree",
  "CompositeLayers",
  "Layerize",
  "Commit",
])
assign("parseCompile", [
  "v8.compile",
  "v8.compileModule",
  "v8.parseOnBackground",
  "V8.CompileCode",
  "v8.produceCache",
  "v8.produceModuleCache",
  "v8.deserializeOnBackground",
])
assign("script", [
  "EventDispatch",
  "EvaluateScript",
  "v8.evaluateModule",
  "FunctionCall",
  "TimerFire",
  "FireIdleCallback",
  "FireAnimationFrame",
  "RunMicrotasks",
  "V8.Execute",
  "v8.run",
  "v8.callFunction",
  "XHRReadyStateChange",
  "XHRLoad",
])
assign("gc", [
  "GCEvent",
  "MinorGC",
  "MajorGC",
  "ThreadState::performIdleLazySweep",
  "ThreadState::completeSweep",
  "BlinkGCMarking",
  "BlinkGC.AtomicPhase",
  "V8.GCScavenger",
  "V8.GCCompactor",
  "V8.GCFinalizeMC",
  "V8.GCIncrementalMarking",
  "V8.GC_MC_BACKGROUND_EVACUATE_COPY",
  "CppGC.IncrementalSweep",
])

interface TraceEvent {
  name: string
  cat: string
  ph: string
  ts: number
  dur?: number
  pid: number
  tid: number
  args?: Record<string, unknown>
}

interface Slice {
  name: string
  start: number
  end: number
  group: Group | null
  children: Slice[]
}

export interface MainThread {
  /** Converts page time (performance.now() ms) to trace time (µs). */
  toTrace: (pageMs: number) => number
  slices: Slice[]
}

export type Breakdown = Record<Group, number> & { busy: number }

export function emptyBreakdown(): Breakdown {
  return {
    parseCompile: 0,
    script: 0,
    styleLayout: 0,
    paint: 0,
    parseHTML: 0,
    gc: 0,
    other: 0,
    busy: 0,
  }
}

/**
 * Parse a trace and find the renderer main thread that recorded the page's
 * marks. `marks` are page times of performance.mark calls (name and time),
 * used to align page time with trace time.
 */
export function readMainThread(
  json: Buffer | string,
  marks: { name: string; at: number }[]
): MainThread | null {
  const parsed = JSON.parse(String(json)) as
    | { traceEvents: TraceEvent[] }
    | TraceEvent[]
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents
  const markNames = new Set(marks.map((mark) => mark.name))
  const traceMarks = events.filter(
    (event) =>
      event.cat.includes("blink.user_timing") && markNames.has(event.name)
  )
  if (traceMarks.length === 0) return null
  // Align on every mark seen in both, by order of occurrence per name.
  const offsets: number[] = []
  const seen = new Map<string, number>()
  for (const event of [...traceMarks].sort((a, b) => a.ts - b.ts)) {
    const index = seen.get(event.name) ?? 0
    seen.set(event.name, index + 1)
    const page = marks.filter((mark) => mark.name === event.name)[index]
    if (page) offsets.push(event.ts - page.at * 1000)
  }
  offsets.sort((a, b) => a - b)
  const offset = offsets[Math.floor(offsets.length / 2)]!
  const pid = traceMarks[0]!.pid
  const mainTid = events.find(
    (event) =>
      event.ph === "M" &&
      event.name === "thread_name" &&
      event.pid === pid &&
      event.args?.["name"] === "CrRendererMain"
  )?.tid
  if (mainTid === undefined) return null

  // Complete events plus begin/end pairs on the main thread.
  const raw: { name: string; start: number; end: number }[] = []
  const open: TraceEvent[] = []
  for (const event of events) {
    if (event.pid !== pid || event.tid !== mainTid) continue
    if (event.ph === "X" && event.dur !== undefined && event.dur > 0)
      raw.push({ name: event.name, start: event.ts, end: event.ts + event.dur })
    else if (event.ph === "B") open.push(event)
    else if (event.ph === "E") {
      const begin = open.pop()
      if (begin && event.ts > begin.ts)
        raw.push({ name: begin.name, start: begin.ts, end: event.ts })
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end)
  const roots: Slice[] = []
  const stack: Slice[] = []
  for (const item of raw) {
    while (stack.length > 0 && stack.at(-1)!.end <= item.start) stack.pop()
    const parent = stack.at(-1)
    // Clip children that overrun their parent (clock rounding).
    const end = parent ? Math.min(item.end, parent.end) : item.end
    if (end <= item.start) continue
    const group = GROUP_BY_NAME[item.name] ?? parent?.group ?? null
    const slice: Slice = {
      name: item.name,
      start: item.start,
      end,
      group,
      children: [],
    }
    if (parent) parent.children.push(slice)
    else roots.push(slice)
    stack.push(slice)
  }
  return { toTrace: (pageMs) => pageMs * 1000 + offset, slices: roots }
}

function overlap(start: number, end: number, from: number, to: number) {
  return Math.max(0, Math.min(end, to) - Math.max(start, from))
}

/** Self time per group inside page-time windows (ms). */
export function breakdown(
  thread: MainThread,
  windows: [number, number][]
): Breakdown {
  const result = emptyBreakdown()
  const ranges = windows
    .filter(([from, to]) => to > from)
    .map(([from, to]) => [thread.toTrace(from), thread.toTrace(to)] as const)
  if (ranges.length === 0) return result
  const inside = (start: number, end: number) =>
    ranges.reduce((sum, [from, to]) => sum + overlap(start, end, from, to), 0)
  const visit = (slice: Slice, depth: number) => {
    const total = inside(slice.start, slice.end)
    if (total <= 0) return
    if (depth === 0) result.busy += total / 1000
    // Self time: the slice's span minus its children's spans.
    let self = 0
    let cursor = slice.start
    for (const child of slice.children) {
      if (child.start > cursor) self += inside(cursor, child.start)
      cursor = Math.max(cursor, child.end)
    }
    if (slice.end > cursor) self += inside(cursor, slice.end)
    result[slice.group ?? "other"] += self / 1000
    for (const child of slice.children) visit(child, depth + 1)
  }
  for (const slice of thread.slices) visit(slice, 0)
  for (const key of Object.keys(result) as (keyof Breakdown)[])
    result[key] = Math.round(result[key] * 10) / 10
  return result
}
