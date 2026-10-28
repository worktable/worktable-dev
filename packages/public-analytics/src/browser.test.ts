import { expect, mock, test } from "bun:test"

const init = mock(() => {})
let sdkOptedOut = true
let delivered = 0
const capture = mock(() => { if (!sdkOptedOut) delivered++ })
const reset = mock(() => {})
const optOut = mock(() => { sdkOptedOut = true })
const optIn = mock(() => { sdkOptedOut = false })
mock.module("posthog-js/dist/module.slim", () => ({
  default: {
    init, capture, reset, opt_out_capturing: optOut,
    opt_in_capturing: optIn, register_once: () => {}, register: () => {},
  },
}))
const analytics = await import("./browser")

test("SDK waits for consent, retains browser/site boundaries, and stops after withdrawal", () => {
  const keys = ["window", "location", "navigator", "document", "localStorage", "sessionStorage"]
  const originals = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const location = { hostname: "docs.worktable.dev", pathname: "/start/install/", search: "", protocol: "https:" }
  const navigator = { doNotTrack: "0" }
  const storage = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value) },
    removeItem: (key: string) => { storage.delete(key) },
  }
  const cookies = new Map<string, string>()
  const document = Object.assign(new EventTarget(), { referrer: "" })
  Object.defineProperty(document, "cookie", {
    get: () => [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
    set: (value: string) => {
      const pair = value.split(";", 1)[0]!
      const index = pair.indexOf("=")
      const key = pair.slice(0, index)
      if (value.includes("Max-Age=0")) cookies.delete(key)
      else cookies.set(key, pair.slice(index + 1))
    },
  })
  const window = Object.assign(new EventTarget(), { location })
  const config = {
    projectToken: "phc_test_public_token", siteSurface: "worktable_docs" as const,
    allowedPathnames: ["/start/install", "/agents/connections"],
    environmentVariableName: "TEST_POSTHOG_TOKEN", isDevelopment: false,
  }
  try {
    for (const [key, value] of Object.entries({ window, location, navigator, document, localStorage, sessionStorage: localStorage }))
      Object.defineProperty(globalThis, key, { configurable: true, value })
    expect(analytics.initializePublicAnalytics(config)).toBe(false)
    analytics.capturePublicPageview()
    expect(init).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()

    const enableFromAnotherOrigin = () => {
      globalThis.document.cookie = `wt_analytics=${encodeURIComponent(JSON.stringify({ version: 1, enabled: true, updatedAt: Date.now() }))}; Path=/`
    }
    // The shared preference can change while this origin is closed, leaving
    // the SDK's separate, persisted opt-out marker behind.
    enableFromAnotherOrigin()
    analytics.capturePublicPageview()
    expect(init).toHaveBeenCalledWith(config.projectToken, expect.objectContaining({
      persistence: "localStorage+cookie", respect_dnt: true, autocapture: false,
      capture_pageview: false, disable_session_recording: true,
    }))
    expect(capture).toHaveBeenCalledTimes(1)
    expect(delivered).toBe(1)
    analytics.capturePublicPageview()
    expect(capture).toHaveBeenCalledTimes(1)
    location.pathname = "/agents/connections/"
    analytics.capturePublicPageview()
    expect(capture).toHaveBeenCalledTimes(2)

    navigator.doNotTrack = "1"
    expect(analytics.initializePublicAnalytics(config)).toBe(false)
    analytics.captureInstallCommandCopy(config, "cli_install", "docs_start")
    expect(capture).toHaveBeenCalledTimes(2)
    navigator.doNotTrack = "0"
    location.hostname = "preview.example.com"
    expect(analytics.initializePublicAnalytics(config)).toBe(false)
    location.hostname = "docs.worktable.dev"
    location.pathname = "/private"
    expect(analytics.initializePublicAnalytics(config)).toBe(false)
    location.pathname = "/start/install/"
    expect(analytics.initializePublicAnalytics({ ...config, projectToken: "" })).toBe(false)

    analytics.setPublicAnalyticsEnabled(false)
    expect(reset).toHaveBeenCalled()
    expect(optOut).toHaveBeenCalled()
    expect(analytics.initializePublicAnalytics(config)).toBe(false)
    analytics.capturePublicPageview()
    expect(capture).toHaveBeenCalledTimes(2)
    expect(delivered).toBe(2)
    enableFromAnotherOrigin()
    analytics.capturePublicPageview()
    expect(delivered).toBe(3)
  } finally {
    for (const [key, descriptor] of originals)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
  }
})
