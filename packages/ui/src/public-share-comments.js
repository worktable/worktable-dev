// @ts-check
// The comment panel on a share page whose link takes comments. Comments go to
// the share host's `/s/<ws>/comments` with the link in a header, never in the
// path, and with the visitor's own random key for this link. The first
// comment in a while asks Turnstile whether the visitor is a person; the
// gateway answers with a pass that spares the next two hours. Everything a
// comment holds is put on the page as text.
;(() => {
  const configElement = document.querySelector(
    'script[type="application/json"]#worktable-comments-config'
  )
  const toggle = document.getElementById("worktable-comments-toggle")
  if (!configElement || !(toggle instanceof HTMLButtonElement)) return
  /** @type {{ link: string; checkUrl: string; accepting: boolean; anonymousAllowed: boolean; visitorsSee: "own" | "all" }} */
  let config
  try {
    config = JSON.parse(configElement.textContent || "")
  } catch {
    return
  }
  const envelope = /^\/s\/([^/]+)\/([A-Za-z0-9_-]{43})$/.exec(location.pathname)
  if (!envelope || !/^[a-f0-9]{32}$/.test(String(config.link))) return
  let workspaceId
  try {
    workspaceId = decodeURIComponent(envelope[1])
  } catch {
    return
  }
  if (!workspaceId) return
  const token = envelope[2]
  const endpoint = `/s/${encodeURIComponent(workspaceId)}/comments`

  const MAX_LENGTH = 2000
  // Verification (5s), routing (10s), device headers (30s) and body (30s),
  // with room for the browser to receive the gateway response.
  const REQUEST_BUDGET_MS = 90_000
  const KEY_LIFETIME = 90 * 24 * 60 * 60 * 1000
  const keyStorage = `worktable-visitor:${config.link}`
  const passStorage = `worktable-comment-pass:${config.link}`

  /** @param {number} size */
  function randomId(size) {
    const bytes = crypto.getRandomValues(new Uint8Array(size))
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")
  }

  /**
   * This browser's key for the link, kept 90 days after its last submission.
   * Before a submission it lives only in this page.
   * @type {{ key: string; name?: string; expires: number }}
   */
  const visitor = (() => {
    try {
      const saved = JSON.parse(localStorage.getItem(keyStorage) || "null")
      if (
        saved &&
        typeof saved.key === "string" &&
        /^[A-Za-z0-9_-]{43}$/.test(saved.key) &&
        typeof saved.expires === "number" &&
        saved.expires > Date.now()
      ) {
        return {
          key: saved.key,
          ...(typeof saved.name === "string" ? { name: saved.name } : {}),
          expires: saved.expires,
        }
      }
      localStorage.removeItem(keyStorage)
    } catch {
      // Storage can be off; the key then lasts as long as the page.
    }
    return { key: randomId(32), expires: 0 }
  })()

  /** @param {string | undefined} name */
  function rememberVisitor(name) {
    visitor.expires = Date.now() + KEY_LIFETIME
    if (name) visitor.name = name
    else delete visitor.name
    try {
      localStorage.setItem(
        keyStorage,
        JSON.stringify({
          key: visitor.key,
          ...(visitor.name ? { name: visitor.name } : {}),
          expires: visitor.expires,
        })
      )
    } catch {
      // Kept for this page only.
    }
  }

  /** @returns {string | null} */
  function savedPass() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(passStorage) || "null")
      if (
        saved &&
        typeof saved.pass === "string" &&
        typeof saved.expires === "number" &&
        saved.expires > Date.now()
      ) {
        return saved.pass
      }
      sessionStorage.removeItem(passStorage)
    } catch {
      // No pass: the next comment asks Turnstile.
    }
    return null
  }

  /** @param {unknown} answer */
  function keepPass(answer) {
    const reply = /** @type {{ pass?: unknown; passMaxAge?: unknown }} */ (
      answer ?? {}
    )
    if (typeof reply.pass !== "string" || typeof reply.passMaxAge !== "number")
      return
    try {
      sessionStorage.setItem(
        passStorage,
        JSON.stringify({
          pass: reply.pass,
          // A minute early, so a pass never runs out on its way.
          expires: Date.now() + (reply.passMaxAge - 60) * 1000,
        })
      )
    } catch {
      // The next comment asks Turnstile again.
    }
  }

  function forgetPass() {
    try {
      sessionStorage.removeItem(passStorage)
    } catch {
      // Nothing kept.
    }
  }

  /** @param {number} ms @param {AbortSignal} [signal] */
  const sleep = (ms, signal) =>
    new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", finish)
        resolve(undefined)
      }
      const timer = setTimeout(finish, ms)
      if (signal?.aborted) finish()
      else signal?.addEventListener("abort", finish, { once: true })
    })

  /**
   * @typedef {{ status: number; answer: any; retryAfter: number }} CallResult
   * `status` is 0 when the share host couldn't be reached.
   */

  /**
   * @param {object} [body]
   * @param {number} [remainingMs]
   * @param {AbortSignal} [cancel]
   * @param {string} [cursor]
   * @returns {Promise<CallResult>}
   */
  async function call(body, remainingMs = REQUEST_BUDGET_MS, cancel, cursor) {
    const controller = new AbortController()
    const signal = controller.signal
    const abort = () => controller.abort()
    if (cancel?.aborted) abort()
    else cancel?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(abort, Math.max(1, remainingMs))
    /** @type {Record<string, string>} */
    const headers = {
      "x-worktable-share-capability": token,
      "x-share-visitor": visitor.key,
    }
    if (cursor !== undefined) headers["x-worktable-comment-cursor"] = cursor
    if (body) headers["Content-Type"] = "application/json"
    try {
      const response = await fetch(endpoint, {
        method: body ? "POST" : "GET",
        signal,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: "no-store",
        referrerPolicy: "no-referrer",
      })
      const retryAfter = Number(response.headers.get("Retry-After"))
      const answer = await response.json().catch(() => null)
      if (signal.aborted) throw new DOMException("Aborted", "AbortError")
      return {
        status: response.status,
        answer,
        retryAfter:
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0,
      }
    } catch {
      return { status: 0, answer: null, retryAfter: 0 }
    } finally {
      clearTimeout(timer)
      cancel?.removeEventListener("abort", abort)
    }
  }

  /**
   * A call, tried again while the Worktable wakes, within one request budget.
   * A comment keeps its request id, so it is stored once.
   * @param {() => object | undefined} body
   * @param {AbortSignal} [signal]
   * @param {string} [cursor]
   */
  async function patiently(body, signal, cursor) {
    const started = Date.now()
    for (;;) {
      const remaining = REQUEST_BUDGET_MS - (Date.now() - started)
      if (signal?.aborted || remaining <= 0)
        return { status: 0, answer: null, retryAfter: 0 }
      const result = await call(body(), remaining, signal, cursor)
      keepPass(result.answer)
      const wait = (result.retryAfter || 3) * 1000
      if (
        signal?.aborted ||
        (result.status !== 503 && result.status !== 0) ||
        Date.now() - started + wait > REQUEST_BUDGET_MS
      ) {
        return result
      }
      await sleep(wait, signal)
    }
  }

  // ---- The isolated human check

  /** @type {(() => void) | null} */
  let cancelHumanCheck = null

  /** @param {HTMLElement} container @returns {Promise<string | null>} */
  function humanToken(container) {
    let url
    try {
      url = new URL(config.checkUrl)
      if (url.protocol !== "https:") return Promise.resolve(null)
    } catch {
      return Promise.resolve(null)
    }
    const nonce = randomId(16)
    url.hash = new URLSearchParams({
      link: config.link,
      request: nonce,
    }).toString()
    return new Promise((resolve) => {
      const frame = document.createElement("iframe")
      frame.className = "comment-check-frame"
      frame.title = "Human check"
      frame.referrerPolicy = "no-referrer"
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin")
      let finished = false
      /** @param {string | null} token */
      const done = (token) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        window.removeEventListener("message", receive)
        frame.remove()
        cancelHumanCheck = null
        resolve(token)
      }
      /** @param {MessageEvent} event */
      const receive = (event) => {
        if (event.source !== frame.contentWindow || event.origin !== url.origin)
          return
        const data = event.data
        if (
          !data ||
          typeof data !== "object" ||
          Array.isArray(data) ||
          data.type !== "worktable-comment-check" ||
          data.nonce !== nonce
        )
          return
        if ("token" in data) {
          done(
            typeof data.token === "string" &&
              data.token.length > 0 &&
              data.token.length <= 2048
              ? data.token
              : null
          )
        } else if (Number.isInteger(data.height) && data.height > 0) {
          frame.style.height = `${Math.max(65, Math.min(600, data.height))}px`
        }
      }
      const timer = setTimeout(() => done(null), 120_000)
      cancelHumanCheck = () => done(null)
      window.addEventListener("message", receive)
      frame.addEventListener("error", () => done(null))
      frame.src = url.href
      container.replaceChildren(frame)
    })
  }

  // ---- The panel

  /**
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} tag
   * @param {string} [className]
   * @param {string} [text]
   * @returns {HTMLElementTagNameMap[K]}
   */
  function element(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  /** Authored projection IDs never become the targets of panel labels. */
  /** @param {string} base */
  function availableId(base) {
    let id = base
    while (document.getElementById(id)) id = `${base}-${randomId(8)}`
    return id
  }

  const panel = element("aside", "comments-panel")
  panel.id = availableId("worktable-comments")
  toggle.setAttribute("aria-controls", panel.id)
  panel.hidden = true

  const head = element("div", "comments-head")
  const title = element("h2", "", "Comments")
  title.id = availableId("worktable-comments-title")
  panel.setAttribute("aria-labelledby", title.id)
  const close = element("button", "comments-close")
  close.type = "button"
  close.setAttribute("aria-label", "Close")
  close.textContent = "×"
  head.append(title, close)

  const body = element("div", "comments-body")
  panel.append(head, body)

  const closedNote = element(
    "p",
    "comment-closed",
    "This page isn't taking comments right now."
  )

  const form = element("form", "comment-form")
  form.noValidate = true

  const anonymousLabel = element("label", "comment-check")
  anonymousLabel.hidden = !config.anonymousAllowed
  const anonymous = element("input")
  anonymous.type = "checkbox"
  anonymousLabel.append(anonymous, " Comment anonymously")
  form.append(anonymousLabel)

  const nameField = element("div", "comment-field")
  const nameLabel = element("label", "", "Your name")
  const nameInput = element("input")
  nameInput.id = availableId("worktable-comment-name")
  nameLabel.htmlFor = nameInput.id
  nameInput.type = "text"
  nameInput.maxLength = 60
  nameInput.autocomplete = "name"
  nameInput.value = visitor.name ?? ""
  nameField.append(nameLabel, nameInput)
  form.append(nameField)

  const textField = element("div", "comment-field")
  const textRow = element("div", "comment-label-row")
  const textLabel = element("label", "", "Comment")
  const counter = element("span", "comment-count")
  textRow.append(textLabel, counter)
  const textInput = element("textarea")
  textInput.id = availableId("worktable-comment-text")
  textLabel.htmlFor = textInput.id
  textInput.maxLength = MAX_LENGTH
  textInput.rows = 5
  textField.append(textRow, textInput)
  form.append(textField)

  const visibilityNote = element(
    "p",
    "comment-note",
    "Other visitors can read your comments."
  )
  visibilityNote.hidden = config.visitorsSee !== "all"
  form.append(visibilityNote)
  const challenge = element("div", "comment-turnstile")
  const status = element("p", "comment-status")
  status.setAttribute("role", "status")
  const send = element("button", "comment-send", "Send")
  send.type = "submit"
  let sending = false
  function updateSend() {
    send.disabled = sending || (!readError.hidden && !retryOlder)
    send.textContent = sending ? "Sending…" : "Send"
  }
  form.append(challenge, status, send)

  const readError = element("div", "comment-read-error")
  readError.hidden = true
  const readMessage = element(
    "p",
    "comment-status comment-error",
    "Couldn't load comments."
  )
  readMessage.setAttribute("role", "status")
  const retryRead = element("button", "comment-retry", "Retry")
  retryRead.type = "button"
  let retryOlder = false
  retryRead.addEventListener("click", () => void load(retryOlder))
  readError.append(readMessage, retryRead)

  const listSection = element("section", "comment-list-section")
  listSection.hidden = true
  const listHeading = element(
    "h3",
    "",
    config.visitorsSee === "all" ? "Recent comments" : "Your recent comments"
  )
  const list = element("ul", "comment-list")
  const olderButton = element(
    "button",
    "comment-retry comment-more",
    "Older comments"
  )
  olderButton.type = "button"
  olderButton.hidden = true
  olderButton.addEventListener("click", () => void load(true))
  listSection.append(listHeading, list, olderButton)

  body.append(config.accepting ? form : closedNote, readError, listSection)
  document.body.append(panel)

  function updateCount() {
    counter.textContent = `${textInput.value.length.toLocaleString("en-US")} / ${MAX_LENGTH.toLocaleString("en-US")}`
  }
  updateCount()

  function updateName() {
    nameField.hidden = Boolean(anonymous?.checked)
  }
  anonymous?.addEventListener("change", updateName)

  /** @param {string} text @param {boolean} [error] */
  function say(text, error = false) {
    status.textContent = text
    status.classList.toggle("comment-error", error)
  }
  textInput.addEventListener("input", () => {
    updateCount()
    if (status.textContent) say("")
  })
  nameInput.addEventListener("input", () => {
    if (status.textContent) say("")
  })

  const when = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  })

  /** @param {string} value */
  function time(value) {
    const node = element("time", "comment-time")
    const date = new Date(value)
    node.dateTime = value
    node.textContent = Number.isNaN(date.getTime()) ? "" : when.format(date)
    return node
  }

  /** @param {any} comment */
  function commentItem(comment) {
    const item = element("li", "comment-item")
    const meta = element("div", "comment-meta")
    if (config.visitorsSee === "all") {
      meta.append(
        element(
          "span",
          "comment-author",
          typeof comment.name === "string" ? comment.name : "Anonymous"
        )
      )
      if (comment.mine) meta.append(element("span", "comment-you", "You"))
    }
    meta.append(time(String(comment.receivedAt)))
    item.append(meta, element("p", "comment-text", String(comment.body)))
    for (const reply of Array.isArray(comment.replies) ? comment.replies : []) {
      const block = element("div", "comment-reply")
      block.append(
        element(
          "div",
          "comment-reply-from",
          typeof reply.from === "string" && reply.from !== "The team"
            ? `Reply from ${reply.from}`
            : "Reply from the team"
        ),
        element("p", "comment-text", String(reply.body))
      )
      item.append(block)
    }
    return item
  }

  /** @type {AbortController | null} */
  let refresh = null
  /** @type {string | null} */
  let nextCursor = null
  const shownCommentIds = new Set()

  /** Refresh the visible comments and current settings while the panel is open. */
  async function load(older = false) {
    const cursor = older ? nextCursor : null
    if (older && !cursor) return
    refresh?.abort()
    if (panel.hidden) return
    const current = new AbortController()
    refresh = current
    retryRead.disabled = true
    olderButton.disabled = true
    olderButton.textContent = older ? "Loading…" : "Older comments"
    const { status: code, answer } = await patiently(
      () => undefined,
      current.signal,
      cursor ?? undefined
    )
    if (current.signal.aborted) return
    refresh = null
    retryRead.disabled = false
    olderButton.textContent = "Older comments"
    if (code !== 200 || !answer || !Array.isArray(answer.comments)) {
      retryOlder = older
      readError.hidden = false
      updateSend()
      return
    }
    readError.hidden = true
    olderButton.disabled = false
    updateSend()
    const append =
      older &&
      answer.reset !== true &&
      answer.visitorsSee === config.visitorsSee &&
      answer.nextCursor !== undefined
    config.visitorsSee = answer.visitorsSee
    config.anonymousAllowed = answer.anonymousAllowed
    config.accepting = answer.accepting
    anonymousLabel.hidden = !config.anonymousAllowed
    if (!config.anonymousAllowed) anonymous.checked = false
    updateName()
    visibilityNote.hidden = config.visitorsSee !== "all"
    listHeading.textContent =
      answer.nextCursor === undefined
        ? config.visitorsSee === "all"
          ? "Recent comments"
          : "Your recent comments"
        : config.visitorsSee === "all"
          ? "Comments on this page"
          : "Your comments"
    if (config.accepting && closedNote.isConnected) {
      closedNote.replaceWith(form)
    } else if (!config.accepting && form.isConnected) {
      form.replaceWith(closedNote)
    }
    if (!append) {
      shownCommentIds.clear()
      list.replaceChildren()
    }
    for (const comment of answer.comments) {
      if (shownCommentIds.has(comment.id)) continue
      shownCommentIds.add(comment.id)
      list.append(commentItem(comment))
    }
    nextCursor =
      typeof answer.nextCursor === "string" ? answer.nextCursor : null
    olderButton.hidden = nextCursor === null
    listSection.hidden = shownCommentIds.size === 0
  }

  /** @returns {{ name?: string; anonymous?: boolean; body: string }} */
  function commentFields() {
    return {
      ...(anonymous.checked
        ? { anonymous: true }
        : { name: nameInput.value.replace(/\s+/g, " ").trim() }),
      body: textInput.value.trim(),
    }
  }

  /** @type {string | null} */
  let requestId = null
  let submittedDraft = ""

  /** @param {string | undefined} code @param {number} httpStatus */
  function failure(code, httpStatus) {
    switch (code) {
      case "TOO_MANY_REQUESTS":
        return "Too many comments. Try again later."
      case "PAUSED":
        return "This page isn't taking comments right now."
      case "UNAVAILABLE":
        return "Comments aren't available on this page."
      case "PASSWORD_REQUIRED":
        return "Reload the page and enter its password again."
      case "VERIFICATION_REQUIRED":
        return "Couldn't confirm you're a person. Try again."
      default:
        return httpStatus === 0
          ? "Couldn't reach Worktable. Check your connection and try again."
          : "Couldn't send your comment. Try again."
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    if (send.disabled) return
    const fields = commentFields()
    if (!fields.anonymous && !fields.name) {
      say("Enter your name.", true)
      nameInput.focus()
      return
    }
    if (!fields.body) {
      say("Write a comment first.", true)
      textInput.focus()
      return
    }
    sending = true
    updateSend()
    say("")
    const draft = JSON.stringify(fields)
    if (draft !== submittedDraft) requestId = null
    submittedDraft = draft
    requestId ??= randomId(16)
    const comment = { ...fields, requestId }
    try {
      /** @type {string | null} */
      let turnstileToken = null
      let pass = savedPass()
      if (!pass) {
        turnstileToken = await humanToken(challenge)
        if (!turnstileToken) {
          say(failure("VERIFICATION_REQUIRED", 403), true)
          return
        }
      }
      // Keep access to an accepted comment even if its response is lost.
      rememberVisitor(fields.name)
      let result = await patiently(() => {
        // A pass earned on an earlier try spares the spent token.
        pass = savedPass()
        return pass
          ? { ...comment, pass }
          : { ...comment, turnstileToken: turnstileToken ?? "" }
      })
      if (
        result.status === 403 &&
        result.answer?.error?.code === "VERIFICATION_REQUIRED"
      ) {
        // A pass or one-use token was refused: check once more.
        forgetPass()
        turnstileToken = await humanToken(challenge)
        if (!turnstileToken) {
          say(failure("VERIFICATION_REQUIRED", 403), true)
          return
        }
        const fresh = turnstileToken
        result = await patiently(() => {
          const earned = savedPass()
          return earned
            ? { ...comment, pass: earned }
            : { ...comment, turnstileToken: fresh }
        })
      }
      if (result.status === 201) {
        requestId = null
        const unchanged = JSON.stringify(commentFields()) === draft
        if (unchanged) textInput.value = ""
        updateCount()
        say(unchanged ? "Sent." : "")
        void load()
        return
      }
      say(failure(result.answer?.error?.code, result.status), true)
    } finally {
      sending = false
      updateSend()
    }
  })

  // ---- Opening and closing

  /** @param {boolean} open */
  const show = (open) => {
    panel.hidden = !open
    if (!open) {
      cancelHumanCheck?.()
      refresh?.abort()
      refresh = null
    }
    toggle.setAttribute("aria-expanded", String(open))
    document.body.classList.toggle("comments-open", open)
    if (open) {
      const first = form.isConnected
        ? anonymous?.checked || nameInput.value
          ? textInput
          : nameInput
        : close
      first.focus()
      void load()
    }
  }

  toggle.addEventListener("click", () => show(panel.hidden))
  close.addEventListener("click", () => {
    show(false)
    toggle.focus()
  })
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      show(false)
      toggle.focus()
    }
  })
  toggle.hidden = false
})()
