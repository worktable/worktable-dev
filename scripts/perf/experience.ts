/**
 * What a person sees between an action and its settle, for click-trace.ts:
 * content that pops in after the screen's content showed, layout shifts,
 * loading indicators and their flashes, input delay, and (with --frames)
 * the screen itself from CDP screencast frames: when it first responded,
 * when it was visually complete, how many separate visible changes it went
 * through, and a strip of those frames to look at.
 *
 * The DOM counts depend on the fixture and the app, not the machine, so
 * perf-smoke budgets them. Frame times and step counts move with the
 * machine's speed: compare them paired, never against a fixed number.
 */

import { writeFileSync } from "node:fs"
import type { Browser, BrowserContext, CDPSession, Page } from "playwright-core"
import type { ExperienceData } from "./click-trace-page.ts"

/** A frame adds this much of the viewport or more to count as visible change. */
export const MIN_AREA = 0.001
/** An indicator shown for less than this reads as flicker. */
export const FLASH_MS = 200
/** Grid cells that differ by more than this (0 to 255) count as changed. */
const PIXEL_DELTA = 24
/** A frame differs from another when this share of cells changed. */
const FRAME_DELTA = 0.003
/** Changed frames closer than this belong to one visible step (an animation). */
const STEP_GAP_MS = 120

export interface VisualSummary {
  frames: number
  /** First frame after the action that differs from the screen before it. */
  firstChangeMs: number | null
  /** From when on every frame matches the final screen. */
  completeMs: number | null
  /** Separate visible changes, an animation counted once. */
  steps: number
  /** The first changed frame already shows the final screen. */
  firstFrameFinal: boolean | null
  /** Contact sheet of the frames around each step, in the run's frames/. */
  strip?: string
}

export interface ExperienceSummary {
  /** Frames in which content became visible after the content showed: pop-in. */
  popin: number
  /** Frames in which content became visible from the action until content. */
  stepsToContent: number
  /** Viewport share added after content. */
  lateArea: number
  /** The largest late additions. */
  late: { ms: number; area: number; largest: string }[]
  shifts: { count: number; score: number; afterContent: number }
  /**
   * Loading episodes: indicators that appear in the same frame are one (a
   * skeleton drawn as many bars), lasting as long as its longest part.
   */
  indicators: {
    count: number
    flashes: number
    totalMs: number
    items: {
      kind: string
      path: string
      startMs: number
      ms: number
      parts: number
    }[]
  }
  /** Input to its handlers starting, and input to the next paint (Event Timing, over 16 ms). */
  inputDelayMs: number | null
  inputToPaintMs: number | null
  /** At settle the content predicate still held (the completion contract). */
  contentHeld: boolean
  /** Loading indicators still on screen at settle. */
  loadingAtSettle: string[]
  visual: VisualSummary | null
}

const round1 = (value: number) => Math.round(value * 10) / 10

/**
 * Summarizes the page's records for one action. `t0` is the action in page
 * time, `contentPaint` the frame after content first held (page time, null
 * when it never did), `end` the settle in page time.
 */
export function summarizeExperience(
  data: ExperienceData,
  t0: number,
  contentPaint: number | null,
  end: number
): Omit<ExperienceSummary, "visual" | "contentHeld" | "loadingAtSettle"> {
  const inWindow = (at: number) => at >= t0 - 1 && at <= end
  const frames = data.frames.filter(
    (frame) => inWindow(frame.at) && frame.added > 0 && frame.area >= MIN_AREA
  )
  const after = frames.filter(
    (frame) => contentPaint !== null && frame.at > contentPaint
  )
  const before = frames.filter(
    (frame) => contentPaint === null || frame.at <= contentPaint
  )
  const shifts = data.shifts.filter((shift) => inWindow(shift.at))
  const indicators = data.indicators
    .filter(
      (item) =>
        item.start <= end && (item.end === null || item.end >= t0 - 1)
    )
    .map((item) => {
      const start = Math.max(item.start, t0)
      const stop = item.end ?? end
      return {
        kind: item.kind,
        path: item.path,
        startMs: round1(start - t0),
        ms: round1(Math.max(0, stop - start)),
        ended: item.end !== null,
      }
    })
  const episodes: (typeof indicators[number] & { parts: number })[] = []
  for (const item of [...indicators].sort((a, b) => a.startMs - b.startMs)) {
    const last = episodes.at(-1)
    if (last && Math.abs(item.startMs - last.startMs) < 1) {
      last.parts++
      last.ms = Math.max(last.ms, item.ms)
      last.ended = last.ended && item.ended
    } else episodes.push({ ...item, parts: 1 })
  }
  const events = data.events.filter((event) => inWindow(event.at))
  const first = events[0]
  return {
    popin: after.length,
    stepsToContent: before.length,
    lateArea: round1(after.reduce((sum, frame) => sum + frame.area, 0) * 1000) / 1000,
    late: [...after]
      .sort((left, right) => right.area - left.area)
      .slice(0, 5)
      .map((frame) => ({
        ms: round1(frame.at - t0),
        area: frame.area,
        largest: frame.largest,
      })),
    shifts: {
      count: shifts.length,
      score: Math.round(shifts.reduce((sum, shift) => sum + shift.value, 0) * 1e4) / 1e4,
      afterContent: shifts.filter(
        (shift) => contentPaint !== null && shift.at > contentPaint
      ).length,
    },
    indicators: {
      count: episodes.length,
      flashes: episodes.filter((item) => item.ended && item.ms < FLASH_MS)
        .length,
      totalMs: round1(episodes.reduce((sum, item) => sum + item.ms, 0)),
      items: episodes.map(({ ended: _ended, ...item }) => item),
    },
    inputDelayMs: first ? round1(first.processingStart - first.at) : null,
    inputToPaintMs:
      events.length > 0
        ? round1(Math.max(...events.map((event) => event.duration)))
        : null,
  }
}

// ── Frames ─────────────────────────────────────────────────────────────

/** Stands for the blank screen before a new page first paints. */
const BLANK_FRAME = ""

interface Frame {
  data: string
  /** Wall time, ms since the epoch. */
  wallMs: number
}

/** Starts a screencast; the returned function stops it and hands the frames over. */
export async function startFrames(
  cdp: CDPSession,
  phone: boolean
): Promise<() => Promise<Frame[]>> {
  const frames: Frame[] = []
  const onFrame = (event: {
    data: string
    sessionId: number
    metadata: { timestamp?: number }
  }) => {
    frames.push({
      data: event.data,
      wallMs: (event.metadata.timestamp ?? Date.now() / 1000) * 1000,
    })
    void cdp
      .send("Page.screencastFrameAck", { sessionId: event.sessionId })
      .catch(() => {})
  }
  cdp.on("Page.screencastFrame", onFrame)
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    maxWidth: phone ? 412 : 720,
    maxHeight: phone ? 915 : 450,
    everyNthFrame: 1,
  })
  return async () => {
    await cdp.send("Page.stopScreencast").catch(() => {})
    cdp.off("Page.screencastFrame", onFrame)
    return frames
  }
}

/** One unthrottled page per browser that decodes and compares frames. */
const analyzers = new WeakMap<Browser, Promise<{ context: BrowserContext; page: Page }>>()

async function analyzer(browser: Browser): Promise<Page> {
  let pending = analyzers.get(browser)
  if (!pending) {
    pending = (async () => {
      const context = await browser.newContext({ viewport: { width: 400, height: 300 } })
      const page = await context.newPage()
      await page.setContent("<!doctype html><title>frames</title>")
      return { context, page }
    })()
    analyzers.set(browser, pending)
  }
  return (await pending).page
}

/**
 * Compares each frame with the one before and with the last, on a small
 * grayscale grid, and returns which frames to put in the strip.
 */
async function diffFrames(
  page: Page,
  frames: string[]
): Promise<{ prev: number[]; final: number[] }> {
  return page.evaluate(
    async ({ frames, pixelDelta }) => {
      const W = 96
      const grays: (Uint8Array | null)[] = []
      for (const frame of frames) {
        if (frame === "") {
          grays.push(null)
          continue
        }
        const blob = await (await fetch(`data:image/jpeg;base64,${frame}`)).blob()
        const bitmap = await createImageBitmap(blob)
        const H = Math.max(1, Math.round((bitmap.height * W) / bitmap.width))
        const canvas = new OffscreenCanvas(W, H)
        const context = canvas.getContext("2d")!
        context.drawImage(bitmap, 0, 0, W, H)
        const pixels = context.getImageData(0, 0, W, H).data
        const gray = new Uint8Array(W * H)
        for (let index = 0; index < gray.length; index++)
          gray[index] =
            (pixels[index * 4]! * 299 +
              pixels[index * 4 + 1]! * 587 +
              pixels[index * 4 + 2]! * 114) /
            1000
        grays.push(gray)
      }
      const diff = (left: Uint8Array, right: Uint8Array) => {
        if (left.length !== right.length) return 1
        let changed = 0
        for (let index = 0; index < left.length; index++)
          if (Math.abs(left[index]! - right[index]!) > pixelDelta) changed++
        return changed / left.length
      }
      const size = grays.find((gray) => gray !== null)?.length ?? 1
      for (let index = 0; index < grays.length; index++)
        if (grays[index] === null) grays[index] = new Uint8Array(size).fill(255)
      const filled = grays as Uint8Array[]
      const last = filled.at(-1)!
      return {
        prev: filled.map((gray, index) =>
          index === 0 ? 0 : diff(gray, filled[index - 1]!)
        ),
        final: filled.map((gray) => diff(gray, last)),
      }
    },
    { frames, pixelDelta: PIXEL_DELTA }
  )
}

async function contactSheet(
  page: Page,
  frames: { data: string; label: string }[]
): Promise<Buffer> {
  const dataUrl = await page.evaluate(async (frames) => {
    const decoded = await Promise.all(
      frames.map(async (frame) =>
        frame.data === ""
          ? null
          : createImageBitmap(
              await (await fetch(`data:image/jpeg;base64,${frame.data}`)).blob()
            )
      )
    )
    const sample = decoded.find((bitmap) => bitmap !== null)
    const bitmaps = decoded.map((bitmap) => {
      if (bitmap) return bitmap
      const blank = new OffscreenCanvas(sample?.width ?? 100, sample?.height ?? 100)
      const context = blank.getContext("2d")!
      context.fillStyle = "#fff"
      context.fillRect(0, 0, blank.width, blank.height)
      return blank
    })
    const height = 360
    const widths = bitmaps.map((bitmap) =>
      Math.round((bitmap.width * height) / bitmap.height)
    )
    const gap = 6
    const label = 22
    const canvas = document.createElement("canvas")
    canvas.width = widths.reduce((sum, width) => sum + width + gap, gap)
    canvas.height = height + label + gap * 2
    const context = canvas.getContext("2d")!
    context.fillStyle = "#777"
    context.fillRect(0, 0, canvas.width, canvas.height)
    let x = gap
    bitmaps.forEach((bitmap, index) => {
      context.drawImage(bitmap, x, gap + label, widths[index]!, height)
      context.fillStyle = "#fff"
      context.font = "14px sans-serif"
      context.fillText(frames[index]!.label, x + 2, gap + 15)
      x += widths[index]! + gap
    })
    return canvas.toDataURL("image/jpeg", 0.7)
  }, frames)
  return Buffer.from(dataUrl.split(",")[1]!, "base64")
}

/**
 * Turns the action's frames into its visual timeline. `wallOffset` maps
 * the page's clock to wall time (Date.now() - performance.now(), read once
 * the action settled: a long-lived page's timeOrigin drifts from the wall
 * clock); `t0` and `end` are page times.
 */
export async function analyzeFrames(
  browser: Browser,
  frames: Frame[],
  wallOffset: number,
  t0: number,
  end: number,
  stripPath: string | null
): Promise<VisualSummary | null> {
  const timed = frames
    .map((frame) => ({ ...frame, ms: frame.wallMs - wallOffset - t0 }))
    .filter((frame) => frame.ms <= end - t0 + 50)
  if (timed.length === 0)
    return { frames: 0, firstChangeMs: null, completeMs: null, steps: 0, firstFrameFinal: null }
  // The screen as the action met it: the last frame at or before it (the
  // screencast sends the current screen when it starts). A new page has
  // none until it first paints: it starts from a blank frame.
  const baseIndex = timed.reduce(
    (found, frame, index) => (frame.ms <= 0 ? index : found),
    -1
  )
  const used =
    baseIndex >= 0
      ? timed.slice(baseIndex)
      : [{ data: BLANK_FRAME, wallMs: 0, ms: 0 }, ...timed]
  if (used.length === 1)
    return { frames: 1, firstChangeMs: null, completeMs: 0, steps: 0, firstFrameFinal: null }
  const page = await analyzer(browser)
  const { prev, final } = await diffFrames(
    page,
    used.map((frame) => frame.data)
  )
  let firstChange: number | null = null
  let steps = 0
  let lastChangeMs = -Infinity
  const stepEdges: number[] = []
  for (let index = 1; index < used.length; index++) {
    if (prev[index]! <= FRAME_DELTA) continue
    if (firstChange === null) firstChange = index
    if (used[index]!.ms - lastChangeMs > STEP_GAP_MS) {
      steps++
      stepEdges.push(index)
    }
    lastChangeMs = used[index]!.ms
  }
  let complete = 0
  for (let index = used.length - 1; index >= 0; index--)
    if (final[index]! > FRAME_DELTA) {
      complete = index + 1
      break
    }
  const summary: VisualSummary = {
    frames: used.length,
    firstChangeMs: firstChange === null ? null : round1(Math.max(0, used[firstChange]!.ms)),
    completeMs:
      complete >= used.length ? null : round1(Math.max(0, used[complete]!.ms)),
    steps,
    firstFrameFinal:
      firstChange === null ? null : final[firstChange]! <= FRAME_DELTA,
  }
  if (stripPath) {
    // Before, each step's first frame, and the final screen; at most 9.
    const picks = [0, ...stepEdges, used.length - 1]
      .filter((index, position, list) => list.indexOf(index) === position)
      .slice(0, 8)
    if (!picks.includes(used.length - 1)) picks.push(used.length - 1)
    const sheet = await contactSheet(
      page,
      picks.map((index) => ({
        data: used[index]!.data,
        label:
          index === 0
            ? "before"
            : index === used.length - 1
              ? `final ${Math.round(used[index]!.ms)} ms`
              : `${Math.round(used[index]!.ms)} ms`,
      }))
    )
    writeFileSync(stripPath, sheet)
    summary.strip = stripPath.split("/").at(-1)!
  }
  return summary
}
