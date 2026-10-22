// @ts-check
// Runs a live tool on a public share page. The tool runs in a sandboxed frame
// on its own origin with no network access. Its data calls arrive here as
// messages, and this page sends them to the Worktable through the share
// host's bridge, with the link in a header. Nothing a call returns is ever
// put into this page: answers go back to the frame as messages.
//
// The same script keeps a waking page asking whether the Worktable is up.
;(() => {
  const configElement = document.querySelector(
    'script[type="application/json"]#worktable-live-config'
  )
  if (!configElement) return
  /** @type {{ waking?: boolean; frame?: { url?: unknown; title?: unknown }; poll?: unknown }} */
  let config
  try {
    config = JSON.parse(configElement.textContent || "{}")
  } catch {
    return
  }
  const envelope = /^\/s\/([^/]+)\/([A-Za-z0-9_-]{43})$/.exec(location.pathname)
  const shell = document.querySelector("main")
  if (!envelope || !shell) return
  let workspaceId
  try {
    workspaceId = decodeURIComponent(envelope[1])
  } catch {
    return
  }
  if (!workspaceId) return
  const token = envelope[2]
  const bridgeUrl = `/s/${encodeURIComponent(workspaceId)}/bridge`

  /** @param {number} ms */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /** @param {unknown} value @returns {Record<string, unknown> | null} */
  function plainObject(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? /** @type {Record<string, unknown>} */ (value)
      : null
  }

  /**
   * @typedef {{ status: number; answer: any; retryAfter: number }} BridgeResult
   * `status` is 0 when the bridge couldn't be reached.
   */

  /** @param {object} body @param {number} [remainingMs] @returns {Promise<BridgeResult>} */
  async function call(body, remainingMs = 10_000) {
    const signal = AbortSignal.timeout(
      Math.max(1, Math.min(10_000, remainingMs))
    )
    try {
      const response = await fetch(bridgeUrl, {
        method: "POST",
        signal,
        headers: {
          "Content-Type": "application/json",
          "x-worktable-share-capability": token,
        },
        body: JSON.stringify(body),
        cache: "no-store",
        referrerPolicy: "no-referrer",
      })
      const retryAfter = Number(response.headers.get("Retry-After"))
      const answer = await response.json().catch(() => null)
      signal.throwIfAborted()
      return {
        status: response.status,
        answer,
        retryAfter:
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter, 30)
            : 0,
      }
    } catch {
      return { status: 0, answer: null, retryAfter: 0 }
    }
  }

  /**
   * A status message in the shape of the share host's own pages.
   * @param {string} heading
   * @param {string} text
   * @param {string} [actionLabel] a button that reloads the page
   */
  function statusSection(heading, text, actionLabel) {
    const section = document.createElement("section")
    section.className = "unavailable"
    const icon = document.querySelector(".brand-mark svg")
    if (icon) {
      const mark = document.createElement("span")
      mark.className = "large-mark"
      mark.setAttribute("aria-hidden", "true")
      mark.append(icon.cloneNode(true))
      section.append(mark)
    }
    const title = document.createElement("h1")
    title.textContent = heading
    section.append(title)
    if (text) {
      const paragraph = document.createElement("p")
      paragraph.textContent = text
      section.append(paragraph)
    }
    if (actionLabel) {
      const action = document.createElement("p")
      const button = document.createElement("button")
      button.type = "button"
      button.textContent = actionLabel
      button.addEventListener("click", () => location.reload())
      action.append(button)
      section.append(action)
    }
    return section
  }

  const notAvailable = () =>
    statusSection(
      "This document isn't available right now",
      "Try again in a moment.",
      "Try again"
    )

  /**
   * Whether a bridge status means the Worktable is still starting or busy.
   * @param {number} status
   */
  const starting = (status) => status === 0 || status === 429 || status === 503

  /**
   * Ask whether the Worktable answers, backing off from one to eight seconds
   * for up to a minute. Any answer means it's up, even one saying the link
   * is gone. Resolves with that answer's status, or 0 after the minute.
   * @returns {Promise<number>}
   */
  async function wake() {
    const started = Date.now()
    const delays = [1, 2, 3, 5, 8]
    for (let attempt = 0; ; attempt += 1) {
      const delay = delays[Math.min(attempt, delays.length - 1)] * 1000
      if (Date.now() - started + delay > 60_000) return 0
      await sleep(delay)
      const { status } = await call(
        { v: 1, op: "ping" },
        60_000 - (Date.now() - started)
      )
      if (!starting(status)) return status
    }
  }

  // The waking page: reload once the Worktable answers, and the reloaded page
  // shows the link as it is. After a minute, let the visitor try again.
  if (config.waking) {
    void wake().then((status) => {
      if (status) location.reload()
      else shell.querySelector(".unavailable")?.replaceWith(notAvailable())
    })
    return
  }

  const frame = plainObject(config.frame)
  if (!frame || typeof frame.url !== "string") return
  /** @type {URL} */
  let frameUrl
  try {
    frameUrl = new URL(frame.url)
  } catch {
    return
  }
  if (frameUrl.protocol !== "https:") return

  const MAX_IN_FLIGHT = 8
  const MAX_QUEUED = 32
  const MAX_RETRIES = 4
  const RETRY_WITHIN_MS = 25_000
  const BODY_LIMIT = 16 * 1024
  const STATE_LIMIT = 256 * 1024
  const POLL_MS = Math.max(5, Number(config.poll) || 30) * 1000
  const IDLE_MS = 10 * 60 * 1000
  const BUSY = /** @type {const} */ ("busy")

  const iframe = document.createElement("iframe")
  iframe.title = typeof frame.title === "string" ? frame.title : ""
  // Scripts only: no popups, so the tool can't open a window of its own, and
  // no same-origin access, so it has no storage or cookies.
  iframe.setAttribute("sandbox", "allow-scripts")
  iframe.referrerPolicy = "no-referrer"
  iframe.src = frameUrl.href

  let loads = 0
  let handshake = false
  /** @type {string | null} */
  let navigationToken = null
  let frameInteraction = 0
  let stopped = false
  let linkGone = false
  let askingPassword = false

  /** @param {object} message */
  function post(message) {
    if (!stopped) iframe.contentWindow?.postMessage(message, "*")
  }

  // ---- Calls, capped like the member broker: 8 at once, 32 waiting.
  let inFlight = 0
  /** @type {Array<{ task: () => Promise<BridgeResult>; resolve: (result: BridgeResult) => void }>} */
  const queue = []

  function drain() {
    while (!stopped && inFlight < MAX_IN_FLIGHT && queue.length > 0) {
      const next = /** @type {(typeof queue)[number]} */ (queue.shift())
      inFlight += 1
      next
        .task()
        .then(next.resolve, () =>
          next.resolve({ status: 0, answer: null, retryAfter: 0 })
        )
        .finally(() => {
          inFlight -= 1
          drain()
        })
    }
  }

  /** @param {() => Promise<BridgeResult>} task @returns {Promise<BridgeResult | typeof BUSY>} */
  function limited(task) {
    if (inFlight >= MAX_IN_FLIGHT && queue.length >= MAX_QUEUED) {
      return Promise.resolve(BUSY)
    }
    return new Promise((resolve) => {
      queue.push({ task, resolve })
      drain()
    })
  }

  /**
   * A read, retried while the Worktable wakes or is busy, honouring
   * Retry-After, and given up in time for the tool's own 30 s timeout.
   * @param {object} body
   * @param {() => boolean} [active]
   */
  async function read(body, active = () => !stopped) {
    const started = Date.now()
    for (let attempt = 0; ; attempt += 1) {
      if (!active()) return { status: 0, answer: null, retryAfter: 0 }
      const result = await call(body, RETRY_WITHIN_MS - (Date.now() - started))
      const code = result.answer?.error?.code
      const retryable =
        result.status === 0 ||
        result.status === 503 ||
        (result.status === 429 && code === "LINK_BUSY")
      const wait = (result.retryAfter || 2) * 1000
      if (
        !retryable ||
        !active() ||
        attempt >= MAX_RETRIES ||
        Date.now() - started + wait > RETRY_WITHIN_MS
      ) {
        if (result.status === 401) void requestPassword()
        else if (result.status === 404) linkGone = true
        return result
      }
      await sleep(wait)
    }
  }

  // ---- Answers to the tool, in the member SDK's response shape.
  /** @param {string} id @param {boolean} ok @param {number} status @param {unknown} body */
  function respond(id, ok, status, body) {
    post({ type: "worktable.api.response", id, ok, status, body })
  }

  /** @param {string} id @param {number} status @param {string} code @param {string} error */
  function refuse(id, status, code, error) {
    respond(id, false, status, { error, code })
  }

  /** @param {string} id @param {BridgeResult | typeof BUSY} result @param {(value: any) => unknown} [shape] */
  function answer(id, result, shape) {
    if (result === BUSY) {
      refuse(id, 429, "LINK_BUSY", "Too many requests. Try again in a moment.")
      return
    }
    const body = result.answer
    if (result.status === 200 && body?.ok === true) {
      respond(id, true, 200, shape ? shape(body.result) : body.result)
      return
    }
    const error = plainObject(body?.error) ?? {}
    respond(id, false, result.status, {
      error:
        typeof error.message === "string"
          ? error.message
          : "Something went wrong. Try again.",
      code:
        typeof error.code === "string"
          ? error.code
          : result.status === 0
            ? "NETWORK_ERROR"
            : "BRIDGE_ERROR",
    })
  }

  /** @param {unknown} body @param {number} limit */
  function parseBody(body, limit) {
    if (body === null || body === undefined) return {}
    if (typeof body !== "string" || body.length > limit) return null
    try {
      return plainObject(JSON.parse(body))
    } catch {
      return null
    }
  }

  // ---- Visitor state: this tab's own, kept for the session and never sent.
  /** @type {Record<string, unknown>} */
  let visitorState = {}
  /** @type {string | null} */
  let stateKey = null
  const stateReady = crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(token))
    .then((digest) => {
      stateKey = `wt-live:${Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("")}`
      const saved = sessionStorage.getItem(stateKey)
      visitorState = (saved && plainObject(JSON.parse(saved))) || {}
    })
    .catch(() => undefined)

  /** @param {string} id */
  async function readState(id) {
    const result = await limited(() => read({ v: 1, op: "state.read" }))
    await stateReady
    // A link that doesn't show the team's state still has the visitor's own.
    if (result !== BUSY && result.status === 403) {
      respond(id, true, 200, {
        state: { ...visitorState },
        visitorState: { ...visitorState },
      })
      return
    }
    answer(id, result, (value) => ({
      state: { ...(plainObject(value?.state) ?? {}), ...visitorState },
      visitorState: { ...visitorState },
    }))
  }

  /** @param {string} id @param {unknown} body */
  async function writeState(id, body) {
    const state = plainObject(parseBody(body, STATE_LIMIT + 64)?.state)
    if (!state) {
      refuse(id, 400, "INVALID_QUERY", "The state isn't valid.")
      return
    }
    const serialized = JSON.stringify(state)
    if (new TextEncoder().encode(serialized).length > STATE_LIMIT) {
      refuse(id, 413, "STATE_TOO_LARGE", "The state is too large.")
      return
    }
    await stateReady
    visitorState = state
    try {
      if (stateKey) sessionStorage.setItem(stateKey, serialized)
    } catch {
      // Kept in memory for this page.
    }
    respond(id, true, 200, { state })
  }

  const RECORD_QUERY = /^\/link\/records\/([^/?#\\]+)\/query$/

  /** @param {Record<string, unknown>} data */
  function request(data) {
    const id = data.id
    if (typeof id !== "string" || id.length > 128) return
    const method =
      typeof data.method === "string" ? data.method.toUpperCase() : "GET"
    const path = typeof data.path === "string" ? data.path : ""
    const records = RECORD_QUERY.exec(path)
    if (records && method === "POST") {
      const query = parseBody(data.body, BODY_LIMIT)
      if (!query) {
        refuse(id, 400, "INVALID_QUERY", "The query isn't valid.")
        return
      }
      void limited(() =>
        read({ v: 1, op: "records.query", collection: records[1], query })
      ).then((result) => answer(id, result))
      return
    }
    if (path === "/link/state" && method === "GET") {
      void readState(id)
      return
    }
    if (path === "/link/state" && method === "PUT") {
      void writeState(id, data.body)
      return
    }
    if (path.startsWith("/link/records/")) {
      refuse(id, 403, "LINK_READ_ONLY", "This link is view only.")
      return
    }
    refuse(id, 403, "LINK_FORBIDDEN", "This link can't do that.")
  }

  // ---- Changes: a slow poll, only while the tool listens, the tab is
  // visible and someone used it in the last ten minutes.
  // Subscriptions per collection: a tool can hold several on one, and the
  // collection stays watched until the last one closes.
  /** @type {Map<string, number>} */
  const subscriptions = new Map()
  let lastInteraction = Date.now()
  /** @type {string | null} */
  let cursor = null
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let pollTimer
  let polling = false

  function watching() {
    return (
      !stopped &&
      !linkGone &&
      subscriptions.size > 0 &&
      document.visibilityState === "visible" &&
      Date.now() - lastInteraction < IDLE_MS
    )
  }

  /** @param {boolean} now */
  function schedulePoll(now) {
    clearTimeout(pollTimer)
    pollTimer = undefined
    if (!watching()) return
    pollTimer = setTimeout(
      poll,
      now ? 0 : POLL_MS * (0.8 + Math.random() * 0.4)
    )
  }

  async function poll() {
    pollTimer = undefined
    if (polling || !watching()) return
    polling = true
    try {
      const result = await limited(() =>
        read(
          { v: 1, op: "changes", ...(cursor ? { since: cursor } : {}) },
          watching
        )
      )
      if (result === BUSY || !watching()) return
      if (result.status === 401 || result.status === 404) linkGone = true
      const changes =
        result.status === 200 && plainObject(result.answer?.result)
      if (!changes || result.answer?.ok !== true) return
      const baseline = cursor === null
      if (typeof changes.cursor === "string" && changes.cursor.length <= 256) {
        cursor = changes.cursor
      }
      const changed =
        baseline || changes.reset === true
          ? [...subscriptions.keys()]
          : Array.isArray(changes.collections)
            ? changes.collections
            : []
      // The baseline can include a change after the first record read. Refresh
      // once after installing it so that change cannot fall between cursors.
      // A related collection can change a predicate, expansion or backlink.
      // Hints name only granted collections, so refresh each bounded active
      // subscription when any of those dependencies changes.
      if (changed.some((collection) => typeof collection === "string")) {
        for (const collection of subscriptions.keys()) {
          post({ type: "worktable.records.changed", collection })
        }
      }
    } finally {
      polling = false
      if (!pollTimer) schedulePoll(false)
    }
  }

  function interacted() {
    const resting = !pollTimer && !polling
    lastInteraction = Date.now()
    if (resting) schedulePoll(true)
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") schedulePoll(true)
    else {
      clearTimeout(pollTimer)
      pollTimer = undefined
    }
  })
  window.addEventListener("pointerdown", interacted, { passive: true })
  window.addEventListener("keydown", interacted)

  // ---- External links open from this page, only when the visitor clicks.
  /** @type {HTMLElement | null} */
  let linkPrompt = null

  function closeLinkPrompt() {
    if (!linkPrompt) return
    const hadFocus = linkPrompt.contains(document.activeElement)
    linkPrompt.remove()
    linkPrompt = null
    // Back to the tool, where the visitor was.
    if (hadFocus && !stopped) iframe.focus()
  }

  /** @param {unknown} value */
  function offerLink(value) {
    if (typeof value !== "string" || value.length > 2048) return
    /** @type {URL} */
    let url
    try {
      url = new URL(value)
    } catch {
      return
    }
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return
    }
    closeLinkPrompt()
    const prompt = document.createElement("div")
    prompt.className = "live-link-prompt"
    prompt.setAttribute("role", "dialog")
    prompt.setAttribute("aria-label", "Open link")
    const text = document.createElement("span")
    text.id = "worktable-live-link"
    text.textContent = `Open ${url.host}?`
    text.title = url.href
    prompt.setAttribute("aria-describedby", text.id)
    prompt.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeLinkPrompt()
    })
    const cancel = document.createElement("button")
    cancel.type = "button"
    cancel.textContent = "Cancel"
    cancel.addEventListener("click", closeLinkPrompt)
    const open = document.createElement("button")
    open.type = "button"
    open.textContent = "Open link"
    open.dataset.primary = ""
    open.addEventListener("click", () => {
      window.open(url.href, "_blank", "noopener,noreferrer")
      closeLinkPrompt()
    })
    prompt.append(text, cancel, open)
    document.body.append(prompt)
    linkPrompt = prompt
    // Focus the safe choice, so a tool asking while the visitor types can't
    // turn a keystroke into opening the link.
    cancel.focus()
  }

  // ---- The frame, and what it may ask.
  function stop() {
    stopped = true
    for (const pending of queue.splice(0))
      pending.resolve({ status: 404, answer: null, retryAfter: 0 })
    clearTimeout(pollTimer)
    window.removeEventListener("message", onMessage)
    closeLinkPrompt()
  }

  // The tool loaded a second document: it navigated itself. Show why it's
  // gone instead of brokering for a page nobody checked.
  function guard() {
    stop()
    const wrapper = document.createElement("div")
    wrapper.className = "unavailable-shell"
    wrapper.append(
      statusSection("This tool tried to open another page", "", "Reload")
    )
    shell?.replaceChildren(wrapper)
  }

  /** Reload at most once a minute, so a tool that never starts can't loop. */
  async function reloadOnce() {
    await stateReady
    const key = stateKey && `${stateKey}:reloaded`
    try {
      if (!key || Date.now() - Number(sessionStorage.getItem(key)) < 60_000) {
        return false
      }
      sessionStorage.setItem(key, String(Date.now()))
    } catch {
      return false
    }
    location.reload()
    return true
  }

  async function requestPassword() {
    if (askingPassword) return
    askingPassword = true
    linkGone = true
    stop()
    if (!(await reloadOnce())) {
      shell?.replaceChildren(
        statusSection("This document needs a password", "", "Open")
      )
    }
  }

  // The tool loaded without its runtime announcing itself, so it didn't
  // start: its Worktable was waking or busy, or the link is gone. The frame
  // can't reload itself without tripping the guard, so this page finds out
  // which and recovers.
  async function toolDidNotStart() {
    if (stopped || handshake) return
    const { status } = await call({ v: 1, op: "ping" })
    // Gone, expired or locked: the frame already says so.
    if (stopped || handshake || (!starting(status) && status !== 200)) return
    stop()
    const wrapper = document.createElement("div")
    wrapper.className = "unavailable-shell"
    wrapper.append(
      statusSection("Opening the document", "This can take a few seconds.")
    )
    shell?.replaceChildren(wrapper)
    const answered = starting(status) ? await wake() : status
    if (answered && (await reloadOnce())) return
    wrapper.replaceChildren(notAvailable())
  }

  /** @param {MessageEvent} event */
  function onMessage(event) {
    if (
      stopped ||
      event.source !== iframe.contentWindow ||
      event.origin !== "null"
    ) {
      return
    }
    const data = plainObject(event.data)
    if (!data || typeof data.type !== "string") return
    // The runtime announces itself before the tool's own scripts run. Only
    // that first document's announcement counts.
    if (!handshake) {
      if (
        data.type === "worktable.navigation.handshake" &&
        loads <= 1 &&
        typeof data.navigationToken === "string" &&
        data.navigationToken.length >= 16 &&
        data.navigationToken.length <= 128
      ) {
        handshake = true
        navigationToken = data.navigationToken
      }
      return
    }
    switch (data.type) {
      case "worktable.api.request":
        request(data)
        break
      case "worktable.subscribe":
        if (
          typeof data.collection === "string" &&
          data.collection.length > 0 &&
          (subscriptions.has(data.collection) || subscriptions.size < 64)
        ) {
          const first = subscriptions.size === 0
          subscriptions.set(
            data.collection,
            (subscriptions.get(data.collection) ?? 0) + 1
          )
          if (first || cursor === null) schedulePoll(cursor === null)
        }
        break
      case "worktable.unsubscribe":
        if (typeof data.collection === "string") {
          const remaining = (subscriptions.get(data.collection) ?? 0) - 1
          if (remaining > 0) subscriptions.set(data.collection, remaining)
          else subscriptions.delete(data.collection)
        }
        break
      case "worktable.interaction":
        if (data.navigationToken === navigationToken) {
          frameInteraction = Date.now()
          interacted()
        }
        break
      case "worktable.share.open-link":
        if (
          data.navigationToken === navigationToken &&
          Date.now() - frameInteraction <= 1500
        ) {
          offerLink(data.url)
        }
        break
      case "worktable.navigation.frame-leaving":
        if (data.navigationToken === navigationToken) stop()
        break
    }
  }

  iframe.addEventListener("load", () => {
    loads += 1
    if (loads > 1) guard()
    else setTimeout(() => void toolDidNotStart(), 1000)
  })
  window.addEventListener("message", onMessage)
  shell.replaceChildren(iframe)
})()
