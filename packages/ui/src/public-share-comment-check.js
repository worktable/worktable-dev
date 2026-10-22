// @ts-check
// Runs only in the trusted check page on the separate content origin.
// The page holds a public widget key and a link digest, never a link token,
// visitor key, comment, or record data.
;(() => {
  const source = document.getElementById("worktable-comment-check-config")
  const container = document.getElementById("worktable-comment-check-widget")
  if (!source || !container || window.parent === window) return
  let config
  try {
    config = JSON.parse(source.textContent || "null")
  } catch {
    return
  }
  const params = new URLSearchParams(location.hash.slice(1))
  const link = params.get("link") ?? ""
  const nonce = params.get("request") ?? ""
  if (!/^[a-f0-9]{32}$/.test(link) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce))
    return
  if (typeof config?.parentOrigin !== "string") return
  let finished = false
  const observer = new ResizeObserver(() => {
    if (finished) return
    window.parent.postMessage(
      {
        type: "worktable-comment-check",
        nonce,
        height: Math.ceil(container.getBoundingClientRect().height),
      },
      config.parentOrigin
    )
  })
  observer.observe(container)
  /** @param {string | null} token */
  const done = (token) => {
    if (finished) return
    finished = true
    observer.disconnect()
    window.parent.postMessage(
      { type: "worktable-comment-check", nonce, token },
      config.parentOrigin
    )
  }
  if (typeof config.siteKey !== "string" || !config.siteKey) {
    done(null)
    return
  }
  const script = document.createElement("script")
  script.src =
    "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
  script.async = true
  script.addEventListener("error", () => done(null))
  script.addEventListener("load", () => {
    const turnstile = /** @type {any} */ (window).turnstile
    if (typeof turnstile?.render !== "function") {
      done(null)
      return
    }
    try {
      turnstile.render(container, {
        sitekey: config.siteKey,
        action: "visitor-comment",
        cData: link,
        appearance: "interaction-only",
        size: "flexible",
        theme: "auto",
        callback: (/** @type {string} */ token) =>
          done(
            typeof token === "string" && token.length <= 2048 ? token : null
          ),
        "error-callback": () => done(null),
        "expired-callback": () => done(null),
        "timeout-callback": () => done(null),
      })
    } catch {
      done(null)
    }
  })
  document.head.append(script)
})()
