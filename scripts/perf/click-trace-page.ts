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
}

export interface ArmedResult {
  armedAt: number
  results: Record<string, { at: number; paint: number } | null>
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

  const observeMutations = () => {
    new MutationObserver(() => {
      wt.lastMutation = performance.now()
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
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
    // Markdown: the rendered article shows the document's first heading.
    markdown: (args) =>
      all("article.worktable-markdown h1, article.worktable-markdown h2").some(
        (heading) =>
          outsideOpening(heading) && text(heading) === args["heading"]
      ),
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
    expectation: { name: string; key: string; args: Rec },
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
      const check = () => {
        if (done) return
        let ok = false
        try {
          ok = predicate(expectation.args)
        } catch {
          ok = false
        }
        if (ok) {
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
