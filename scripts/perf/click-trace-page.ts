/**
 * In-page instrumentation for click-trace.ts. Playwright serializes
 * `installInstrumentation` into every page before the app's scripts run, so it
 * must not reference anything outside its own body.
 *
 * It records, in page time (performance.now()):
 * - click, input and pointerover events, so a measured action has a start;
 * - long tasks and long animation frames;
 * - the last DOM mutation, for the settle check;
 * - every WebSocket: created, open, first message, and the first Yjs sync
 *   step 2 (message type 0, sync type 1), which is when y-websocket marks the
 *   provider synced;
 * - "expectations": named predicates over the DOM that define meaningful
 *   content per screen. Each resolves with the time it first held.
 */

export interface Expectation {
  /** Predicate name, see `predicates` below. */
  name: string
  /** Key the result is stored under (one predicate can be armed twice). */
  key: string
  args: Record<string, unknown>
  /** Recorded if it happens before the required ones; never waited for. */
  optional?: boolean
  /**
   * Counts only as a change after the action: if the predicate already holds
   * when armed, it resolves null at once.
   */
  edge?: boolean
}

export interface ArmedResult {
  armedAt: number
  results: Record<string, { at: number; paint: number } | null>
}

/**
 * What the screen did between an action and its settle, in page time. See
 * `installInstrumentation` for how each is detected.
 */
export interface ExperienceData {
  /** Frames in which visible content was inserted, removed or revealed. */
  frames: {
    at: number
    /** Visible nodes added or revealed this frame (top-most only). */
    added: number
    /** Visible nodes removed this frame. */
    removed: number
    /** Viewport fraction covered by what was added, 0 to 1. */
    area: number
    /** The largest addition, as a short selector path. */
    largest: string
  }[]
  /** Every layout shift, including those within 500 ms of input. */
  shifts: { at: number; value: number; recentInput: boolean }[]
  /** Visible loading indicators: skeletons, spinners, busy regions. */
  indicators: { kind: string; path: string; start: number; end: number | null }[]
  /** Event Timing entries for discrete input (click, pointer, key). */
  events: {
    name: string
    at: number
    duration: number
    processingStart: number
    processingEnd: number
  }[]
}

export function installInstrumentation(): void {
  type Rec = Record<string, unknown>
  const w = window as unknown as Rec
  // Frames (HTML documents) get the script too; only the app is measured.
  if (w["__wt"] || window.top !== window) return

  const wt = {
    long: [] as { start: number; dur: number }[],
    loaf: [] as Rec[],
    ws: [] as Rec[],
    clicks: [] as number[],
    pointerdowns: [] as number[],
    inputs: [] as number[],
    hovers: [] as number[],
    lastMutation: 0,
    armedAt: 0,
    armed: null as Promise<Rec> | null,
    marks: [] as { name: string; at: number }[],
  }
  w["__wt"] = wt

  try {
    performance.setResourceTimingBufferSize(100_000)
  } catch {
    // Older engines; the default buffer still holds 250 entries.
  }

  const mark = (name: string) => {
    const at = performance.now()
    try {
      performance.mark(name)
    } catch {
      // Marks only help the trace; timings never depend on them.
    }
    wt.marks.push({ name, at })
    return at
  }

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries())
        wt.long.push({ start: entry.startTime, dur: entry.duration })
    }).observe({ type: "longtask", buffered: true })
  } catch {
    // Not supported.
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as Rec[]) {
        const scripts = (entry["scripts"] as Rec[] | undefined) ?? []
        wt.loaf.push({
          start: entry["startTime"],
          dur: entry["duration"],
          blocking: entry["blockingDuration"],
          renderStart: entry["renderStart"],
          styleStart: entry["styleAndLayoutStart"],
          scripts: scripts.map((script) => ({
            src: script["sourceURL"],
            fn: script["sourceFunctionName"],
            invoker: script["invoker"],
            type: script["invokerType"],
            start: script["startTime"],
            dur: script["duration"],
            forced: script["forcedStyleAndLayoutDuration"],
          })),
        })
      }
    }).observe({ type: "long-animation-frame", buffered: true })
  } catch {
    // Not supported.
  }

  addEventListener(
    "click",
    (event) => {
      wt.clicks.push(event.timeStamp)
      mark("wt:click")
    },
    true
  )
  addEventListener(
    "pointerdown",
    (event) => {
      wt.pointerdowns.push(event.timeStamp)
    },
    true
  )
  addEventListener(
    "input",
    (event) => {
      wt.inputs.push(event.timeStamp)
      mark("wt:input")
    },
    true
  )
  addEventListener(
    "pointerover",
    (event) => {
      wt.hovers.push(event.timeStamp)
    },
    true
  )

  // ── What the screen does: pop-in, shifts, loading indicators ─────────
  // Counts content when it becomes visible, not when it is inserted.
  // Mutations are batched per animation frame. In the frame callback, a
  // node counts when it is connected, rendered (checkVisibility with
  // opacity and visibility, outside inert regions) and intersects the
  // viewport. One that is not visible yet (inserted at opacity 0, in a
  // closed panel, below a hidden ancestor) waits in a pending set that is
  // checked every frame until it shows, so a fade or a class flip that
  // reveals it counts in the frame it appears. Only the top-most node of a
  // change counts, so a list rendering at once is one addition, and its
  // area says how much of the screen it covers.
  const exp = {
    frames: [] as Rec[],
    shifts: [] as Rec[],
    indicators: [] as Rec[],
    events: [] as Rec[],
  }
  ;(wt as Rec)["exp"] = exp
  const INDICATOR =
    '[data-slot="skeleton"], .animate-pulse, .animate-spin, [aria-busy="true"], [role="progressbar"]'
  const pathOf = (element: Element) => {
    const parts: string[] = []
    let node: Element | null = element
    while (node && node !== document.body && parts.length < 4) {
      const label =
        node.getAttribute("aria-label") ??
        node.getAttribute("data-slot") ??
        (node.id ? `#${node.id}` : null)
      parts.unshift(
        `${node.tagName.toLowerCase()}${label ? `[${label.slice(0, 32)}]` : ""}`
      )
      node = node.parentElement
    }
    return parts.join(">")
  }
  const shown = (element: Element) => {
    if (!element.isConnected) return null
    if (element.closest("[inert]")) return null
    const check = (
      element as Element & {
        checkVisibility?: (options: Record<string, boolean>) => boolean
      }
    ).checkVisibility
    if (
      check &&
      !check.call(element, { opacityProperty: true, visibilityProperty: true })
    )
      return null
    const box = element.getBoundingClientRect()
    const width =
      Math.min(box.right, innerWidth) - Math.max(box.left, 0)
    const height =
      Math.min(box.bottom, innerHeight) - Math.max(box.top, 0)
    if (width <= 0 || height <= 0) return null
    return (width * height) / (innerWidth * innerHeight)
  }
  // Indicators currently on screen, so each appearance is one record.
  const liveIndicators = new Map<Element, Rec>()
  const scanIndicators = (now: number) => {
    const seen = new Set<Element>()
    for (const element of Array.from(document.querySelectorAll(INDICATOR))) {
      // A nested indicator inside another is the same one.
      if (element.parentElement?.closest(INDICATOR)) continue
      if (shown(element) === null) continue
      seen.add(element)
      if (!liveIndicators.has(element)) {
        const kind = element.matches('[data-slot="skeleton"], .animate-pulse')
          ? "skeleton"
          : element.matches(".animate-spin")
            ? "spinner"
            : "busy"
        const rec: Rec = { kind, path: pathOf(element), start: now, end: null }
        liveIndicators.set(element, rec)
        exp.indicators.push(rec)
      }
    }
    for (const [element, rec] of liveIndicators)
      if (!seen.has(element)) {
        rec["end"] = now
        liveIndicators.delete(element)
      }
  }
  let pendingAdded = new Set<Node>()
  let pendingRemoved = 0
  // Inserted or changed but not visible yet; checked each frame.
  const waiting = new Map<Element, number>()
  const WAIT_LIMIT = 4000
  const WAIT_MS = 10_000
  // Whether an element was visible when last checked.
  const wasShown = new WeakMap<Element, boolean>()
  let frameScheduled = false
  let indicatorCheck = false
  const flushFrame = () => {
    frameScheduled = false
    const now = performance.now()
    const added = pendingAdded
    const removed = pendingRemoved
    pendingAdded = new Set()
    pendingRemoved = 0
    const elements = new Set<Element>()
    for (const node of added) {
      const element =
        node.nodeType === Node.ELEMENT_NODE
          ? (node as Element)
          : node.parentElement
      if (element) elements.add(element)
    }
    for (const [element, since] of waiting)
      if (!element.isConnected || now - since > WAIT_MS) waiting.delete(element)
      else elements.add(element)
    let count = 0
    let area = 0
    let largest = ""
    let largestArea = 0
    for (const element of elements) {
      // Counted through its changed ancestor.
      let parent = element.parentElement
      let nested = false
      while (parent) {
        if (elements.has(parent)) {
          nested = true
          break
        }
        parent = parent.parentElement
      }
      if (nested) continue
      // The harness's own nodes and HTML document frames' insides don't count.
      if (element.closest("#worktable-opening-preview")) continue
      const fraction = shown(element)
      if (fraction === null) {
        wasShown.set(element, false)
        if (!waiting.has(element) && waiting.size < WAIT_LIMIT)
          waiting.set(element, now)
        continue
      }
      waiting.delete(element)
      // Already on screen: a re-render or a style change, not new content.
      const before = wasShown.get(element)
      wasShown.set(element, true)
      if (before === true) continue
      count++
      area += fraction
      if (fraction > largestArea) {
        largestArea = fraction
        largest = pathOf(element)
      }
    }
    if (waiting.size > 0) schedule()
    if (count > 0 || removed > 0)
      exp.frames.push({
        at: now,
        added: count,
        removed,
        area: Math.min(1, Math.round(area * 1e4) / 1e4),
        largest,
      })
    if (indicatorCheck || count > 0 || removed > 0) scanIndicators(now)
    indicatorCheck = false
  }
  const schedule = () => {
    if (frameScheduled) return
    frameScheduled = true
    requestAnimationFrame(flushFrame)
  }
  const recordMutations = (records: MutationRecord[]) => {
    for (const record of records) {
      if (record.type === "childList") {
        for (const node of Array.from(record.addedNodes))
          if (
            node.nodeType === Node.ELEMENT_NODE ||
            (node.nodeType === Node.TEXT_NODE &&
              (node.textContent ?? "").trim() !== "")
          )
            pendingAdded.add(node)
        for (const node of Array.from(record.removedNodes))
          if (
            node.nodeType === Node.ELEMENT_NODE ||
            (node.nodeType === Node.TEXT_NODE &&
              (node.textContent ?? "").trim() !== "")
          )
            pendingRemoved++
      } else if (record.type === "characterData") {
        if (record.target.parentElement)
          pendingAdded.add(record.target.parentElement)
      } else if (record.type === "attributes") {
        // A class or state change can reveal or hide what was already in
        // the DOM; the indicator scan and a frame diff catch those.
        indicatorCheck = true
        const name = record.attributeName ?? ""
        const old = record.oldValue
        const target = record.target as Element
        // A state change that can reveal what was already in the DOM: it
        // counts if the element shows afterwards. Style and class changes
        // count only on an element last seen hidden, so hover states and
        // re-renders of what is on screen are not new content.
        const revealing =
          (name === "hidden" && old !== null) ||
          (name === "inert" && old !== null) ||
          (name === "aria-hidden" && old === "true") ||
          (name === "open" && old === null) ||
          (name === "data-state" &&
            (old === "closed" || old === "hidden" || old === "inactive")) ||
          ((name === "class" || name === "style") &&
            wasShown.get(target) === false)
        if (revealing) {
          wasShown.set(target, false)
          pendingAdded.add(target)
        }
      }
    }
    schedule()
  }

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as Rec[])
        exp.shifts.push({
          at: entry["startTime"],
          value: entry["value"],
          recentInput: entry["hadRecentInput"],
        })
    }).observe({ type: "layout-shift", buffered: true })
  } catch {
    // Not supported.
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as Rec[]) {
        const name = String(entry["name"])
        if (
          !/^(click|pointerdown|pointerup|keydown|keyup|keypress|input|touchstart|touchend)$/.test(
            name
          )
        )
          continue
        exp.events.push({
          name,
          at: entry["startTime"],
          duration: entry["duration"],
          processingStart: entry["processingStart"],
          processingEnd: entry["processingEnd"],
        })
      }
    }).observe({
      type: "event",
      buffered: true,
      durationThreshold: 16,
    } as PerformanceObserverInit)
  } catch {
    // Not supported.
  }

  const observeMutations = () => {
    new MutationObserver((records) => {
      wt.lastMutation = performance.now()
      recordMutations(records)
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeOldValue: true,
    })
  }
  if (document.documentElement) observeMutations()
  else
    document.addEventListener("readystatechange", observeMutations, {
      once: true,
    })

  const NativeWebSocket = window.WebSocket
  class TracedWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      const rec: Rec = {
        url: String(url),
        created: performance.now(),
        open: null,
        firstMessage: null,
        syncStep2: null,
        messages: 0,
        bytesIn: 0,
        closed: null,
        closeCode: null,
      }
      wt.ws.push(rec)
      this.addEventListener("open", () => {
        rec["open"] = performance.now()
      })
      this.addEventListener("message", (event) => {
        const now = performance.now()
        rec["messages"] = (rec["messages"] as number) + 1
        if (rec["firstMessage"] === null) rec["firstMessage"] = now
        const data = event.data as unknown
        if (data instanceof ArrayBuffer) {
          rec["bytesIn"] = (rec["bytesIn"] as number) + data.byteLength
          const head = new Uint8Array(data, 0, Math.min(2, data.byteLength))
          if (rec["syncStep2"] === null && head[0] === 0 && head[1] === 1)
            rec["syncStep2"] = now
        } else if (typeof data === "string") {
          rec["bytesIn"] = (rec["bytesIn"] as number) + data.length
        } else if (data instanceof Blob) {
          rec["bytesIn"] = (rec["bytesIn"] as number) + data.size
        }
      })
      this.addEventListener("close", (event) => {
        rec["closed"] = performance.now()
        rec["closeCode"] = event.code
      })
    }
  }
  window.WebSocket = TracedWebSocket as unknown as typeof WebSocket

  // ── Meaningful content per screen ────────────────────────────────────
  const text = (element: Element | null | undefined) =>
    (element?.textContent ?? "").replace(/\s+/g, " ").trim()
  const all = (selector: string, root: ParentNode = document) =>
    Array.from(root.querySelectorAll(selector))
  const outsideOpening = (element: Element) =>
    !element.closest("#worktable-opening-preview")
  // On screen: rendered, not transparent or hidden, with a size. Content
  // that is still at opacity 0 (a panel about to fade in) is not shown yet.
  const seen = (element: Element | null | undefined) => {
    if (!element || element.getBoundingClientRect().height <= 0) return false
    const check = (
      element as Element & {
        checkVisibility?: (options: Record<string, boolean>) => boolean
      }
    ).checkVisibility
    return check
      ? check.call(element, { opacityProperty: true, visibilityProperty: true })
      : true
  }
  const recentRows = () =>
    all('section[aria-labelledby="recent-heading"] a[href*="/documents/"]')
  const predicates: Record<string, (args: Rec) => boolean> = {
    // Home: Recent rows under the Home-only Space filter.
    home: () =>
      location.pathname === "/" &&
      document.querySelector('[aria-label="Filter by Space"]') !== null &&
      recentRows().length > 0,
    // A Space overview: its name as the page title and its Recent rows.
    space: (args) =>
      location.pathname === `/spaces/${args["spaceId"]}` &&
      all("main h1").some((h1) => text(h1) === args["name"]) &&
      recentRows().length > 0,
    // A Space opened in the sidebar: its Space Home row and its docs show.
    sidebarSpace: (args) => {
      const root = document.querySelector("[data-worktable-sidebar-root]")
      const id = String(args["spaceId"])
      const doc = root?.querySelector(`a[href^="/spaces/${id}/documents/"]`)
      return (
        root?.querySelector(`a[href="/spaces/${id}"]`) != null && seen(doc)
      )
    },
    // Markdown: the rendered article shows the document's first heading.
    markdown: (args) =>
      all("article.worktable-markdown h1, article.worktable-markdown h2").some(
        (heading) =>
          outsideOpening(heading) && text(heading) === args["heading"]
      ),
    // Images of files, on a file's page or in a Doc: every one has loaded,
    // and the Doc's first heading shows when one is given.
    images: (args) => {
      const loaded = all("article.worktable-markdown img")
        .filter(outsideOpening)
        .filter((image) => {
          const element = image as HTMLImageElement
          return element.complete && element.naturalWidth > 0
        })
        .map((image) => image.getAttribute("src") ?? "")
      return (
        (args["heading"] === undefined ||
          all(
            "article.worktable-markdown h1, article.worktable-markdown h2"
          ).some(
            (heading) =>
              outsideOpening(heading) && text(heading) === args["heading"]
          )) &&
        (args["srcParts"] as string[]).every((part) =>
          loaded.some((src) => src.includes(part))
        )
      )
    },
    // Rich text, readable: the static preview or the editor shows the
    // document's first heading.
    rich: (args) =>
      all("[data-document-preview] [data-preview-block]")
        .filter(outsideOpening)
        .slice(0, 5)
        .some((block) => text(block) === args["heading"]) ||
      all(".ProseMirror").some(
        (editor) =>
          !editor.closest("[inert]") &&
          text(editor).startsWith(String(args["heading"]))
      ),
    // The server's display-only snapshot in the page HTML (deep links).
    opening: (args) =>
      all("#worktable-opening-preview *").some(
        (element) =>
          element.children.length === 0 && text(element) === args["heading"]
      ),
    // Rich text, editable: the editor accepts input and holds the content.
    richEditable: (args) =>
      all('.ProseMirror[contenteditable="true"]').some(
        (editor) =>
          !editor.closest("[inert]") &&
          text(editor).startsWith(String(args["heading"]))
      ),
    // HTML: the document's frame has loaded (the app removes its skeleton
    // overlay on the frame's load event).
    html: (args) =>
      all("iframe[data-worktable-widget-frame]").some((frame) => {
        const src = frame.getAttribute("src") ?? ""
        if (!src.includes(String(args["srcPart"]))) return false
        const overlay = frame.parentElement?.querySelector(
          ":scope > .pointer-events-none.absolute"
        )
        return !overlay
      }),
    // A Space overview with this name on screen, wherever the URL is: armed
    // on document clicks to catch the overview rendering on the way.
    overview: (args) =>
      all("main h1").some((h1) => text(h1) === args["name"]) &&
      document.querySelector('section[aria-labelledby="recent-heading"]') !==
        null,
    threads: () =>
      location.pathname.startsWith("/threads") &&
      all('nav[aria-label="Threads"] [role="listitem"]').length > 0,
    thread: (args) =>
      location.pathname.includes(String(args["threadId"])) &&
      all(
        '[aria-label="Thread conversation"] [data-slot="message-scroller-item"]'
      ).length >= 3,
    // Settings: the named section is selected and shows its own content,
    // not its loading fallback.
    settings: (args) => {
      const dialog = document.querySelector('[role="dialog"]')
      if (!dialog) return false
      const label = String(args["label"])
      const selected =
        all("h3", dialog).some((heading) => text(heading) === label) ||
        all('button[aria-pressed="true"]', dialog).some(
          (button) => text(button) === label
        )
      const panel = dialog.querySelector(
        "[data-settings-section]:not([hidden])"
      )
      return (
        selected &&
        seen(panel) &&
        panel !== null &&
        // Its loading fallback is a skeleton; a status message the section
        // shows for good (a connection's state) is content.
        panel.querySelector('[data-slot="skeleton"]') === null &&
        text(panel).length > 0
      )
    },
    // Search: highlighted matches for the current query in the sidebar.
    search: (args) => {
      const tokens = (args["tokens"] as string[]).map((token) =>
        token.toLowerCase()
      )
      return all(
        "[data-worktable-sidebar-root] a span.bg-surface-selected"
      ).some((span) => tokens.includes(text(span).toLowerCase()))
    },
  }

  const waitFor = (
    expectation: { name: string; key: string; args: Rec; edge?: boolean },
    timeoutMs: number,
    cancelled: () => boolean = () => false
  ) =>
    new Promise<{ at: number; paint: number } | null>((resolve) => {
      const predicate = predicates[expectation.name]
      if (!predicate) throw new Error(`unknown predicate ${expectation.name}`)
      const started = performance.now()
      let done = false
      let observer: MutationObserver | null = null
      let interval = 0
      const finish = (value: { at: number; paint: number } | null) => {
        done = true
        observer?.disconnect()
        clearInterval(interval)
        resolve(value)
      }
      let first = true
      const check = () => {
        if (done) return
        let ok = false
        try {
          ok = predicate(expectation.args)
        } catch {
          ok = false
        }
        const already = first && ok && expectation.edge
        first = false
        if (already) finish(null)
        else if (ok) {
          const at = mark(`wt:${expectation.key}`)
          done = true
          observer?.disconnect()
          clearInterval(interval)
          requestAnimationFrame(() => resolve({ at, paint: performance.now() }))
        } else if (cancelled() || performance.now() - started > timeoutMs)
          finish(null)
      }
      const start = () => {
        observer = new MutationObserver(check)
        observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
        })
        interval = window.setInterval(check, 50)
        check()
      }
      if (document.documentElement) start()
      else document.addEventListener("readystatechange", start, { once: true })
    })

  const arm = (expectations: Expectation[], timeoutMs: number) => {
    wt.armedAt = mark("wt:armed")
    const optional: Record<string, unknown> = {}
    let done = false
    for (const expectation of expectations.filter((item) => item.optional)) {
      optional[expectation.key] = null
      // Stops at the timeout or when the required ones are in.
      void waitFor(expectation, timeoutMs, () => done).then((value) => {
        if (value) optional[expectation.key] = value
      })
    }
    wt.armed = Promise.all(
      expectations
        .filter((item) => !item.optional)
        .map(async (expectation) => [
          expectation.key,
          await waitFor(expectation, timeoutMs),
        ])
    ).then((entries) => {
      done = true
      return { ...optional, ...Object.fromEntries(entries) }
    })
  }
  ;(wt as Rec)["arm"] = arm
  // The completion contract at settle: content still holds, nothing loading.
  ;(wt as Rec)["holds"] = (expectation: { name: string; args: Rec }) => {
    let ok = false
    try {
      ok = predicates[expectation.name]?.(expectation.args) ?? false
    } catch {
      ok = false
    }
    const loading = Array.from(document.querySelectorAll(INDICATOR))
      .filter((element) => !element.parentElement?.closest(INDICATOR))
      .filter((element) => shown(element) !== null)
      .map(pathOf)
    return { ok, loading }
  }

  // A page load is armed by another init script that sets __wtExpect, so it
  // starts before the app's own scripts (see click-trace.ts). Playwright does
  // not order init scripts: take a value set before this one ran, and arm on
  // one set after.
  type Pending = { expectations: Expectation[]; timeoutMs: number }
  const pending = w["__wtExpect"] as Pending | undefined
  Object.defineProperty(window, "__wtExpect", {
    configurable: true,
    set(value: Pending) {
      arm(value.expectations, value.timeoutMs)
    },
  })
  if (pending) arm(pending.expectations, pending.timeoutMs)
}
