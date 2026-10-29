import { afterAll, beforeEach, expect, mock, test } from "bun:test"

// A model of the SDK's consent state: undecided starts cookieless, opting in
// resets to a fresh cookie identity, and opting out returns to cookieless.
let optedIn = false
let registered: Record<string, unknown> = {}
const sent: Array<{
  event: string
  cookieless: boolean
  properties: Record<string, unknown>
}> = []
const init = mock(() => {})
const reset = () => {
  registered = {}
}
const posthog = {
  init,
  capture: mock((event: string, properties: Record<string, unknown>) => {
    sent.push({
      event,
      cookieless: !optedIn,
      properties: { ...registered, ...properties },
    })
  }),
  has_opted_in_capturing: () => optedIn,
  opt_in_capturing: mock(() => {
    reset()
    optedIn = true
  }),
  opt_out_capturing: mock(() => {
    reset()
    optedIn = false
  }),
  register_once: mock((properties: Record<string, unknown>) => {
    registered = { ...properties, ...registered }
  }),
  register: mock((properties: Record<string, unknown>) => {
    registered = { ...registered, ...properties }
  }),
}
mock.module("posthog-js/dist/module.slim", () => ({ default: posthog }))
const analytics = await import("./browser")

const config = {
  projectToken: "phc_test_public_token",
  siteSurface: "worktable_docs" as const,
  allowedPathnames: ["/start/install", "/agents/connections"],
  environmentVariableName: "TEST_POSTHOG_TOKEN",
  isDevelopment: false,
}

// Other test files share this process: restore the real globals afterwards.
const browserGlobals = [
  "window",
  "location",
  "navigator",
  "document",
  "localStorage",
  "sessionStorage",
]
const originals = new Map(
  browserGlobals.map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ])
)
afterAll(() => {
  for (const [key, descriptor] of originals)
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
})

// Listeners stay installed on the one window; each test loads a new document.
const sharedWindow = new EventTarget()

/** A fresh document per test; returns what the page itself stored. */
function browser(regionCookie?: string) {
  const location = {
    hostname: "docs.worktable.dev",
    pathname: "/start/install/",
    search: "?utm_source=github&email=private%40example.com",
    protocol: "https:",
    href: "https://docs.worktable.dev/start/install/",
  }
  const navigator: { doNotTrack: string; globalPrivacyControl?: boolean } = {
    doNotTrack: "0",
  }
  const storage = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  }
  const cookies = new Map<string, string>()
  if (regionCookie) cookies.set("wt_analytics_region", regionCookie)
  const document = Object.assign(new EventTarget(), {
    referrer: "https://github.com/worktable",
    visibilityState: "visible",
  })
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
  const window = Object.assign(sharedWindow, { location })
  for (const [key, value] of Object.entries({
    window,
    location,
    navigator,
    document,
    localStorage,
    sessionStorage: localStorage,
  }))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    })
  const written = () =>
    [...storage.keys(), ...cookies.keys()].filter(
      (key) => key !== "wt_analytics_region"
    )
  return { location, navigator, written }
}

beforeEach(() => {
  optedIn = false
  registered = {}
  sent.length = 0
})

test("consent regions count without storage, carry first touch into an allowed identity, and fall back after refusal", () => {
  const page = browser("consent")
  expect(analytics.getPublicAnalyticsChoice()).toMatchObject({
    enabled: false,
    decided: false,
    consentRequired: true,
  })
  expect(analytics.initializePublicAnalytics(config)).toBe(true)
  expect(init).toHaveBeenCalledWith(
    config.projectToken,
    expect.objectContaining({
      cookieless_mode: "on_reject",
      opt_out_capturing_by_default: true,
      respect_dnt: true,
      autocapture: false,
      disable_session_recording: true,
    })
  )
  analytics.capturePublicPageview()
  analytics.capturePublicPageview()
  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({
    event: "$pageview",
    cookieless: true,
    properties: {
      initial_landing_path: "/start/install",
      initial_utm_source: "github",
      initial_referring_domain: "github.com",
    },
  })
  expect(posthog.opt_in_capturing).not.toHaveBeenCalled()
  expect(page.written()).toEqual([])

  // Later pages keep the first page's labels in memory only.
  page.location.pathname = "/agents/connections/"
  page.location.search = ""
  analytics.capturePublicPageview()
  expect(sent[1]?.properties).toMatchObject({
    initial_landing_path: "/start/install",
    initial_utm_source: "github",
  })
  expect(page.written()).toEqual([])

  analytics.setPublicAnalyticsEnabled(true)
  expect(optedIn).toBe(true)
  expect(registered).toMatchObject({
    initial_landing_path: "/start/install",
    initial_utm_source: "github",
    initial_referring_domain: "github.com",
    latest_external_acquisition_source: "github",
  })

  analytics.setPublicAnalyticsEnabled(false)
  expect(optedIn).toBe(false)
  expect(registered).toEqual({})
  page.location.pathname = "/start/install/"
  analytics.capturePublicPageview()
  expect(sent.at(-1)?.cookieless).toBe(true)
})

test("other and unknown regions start with cookies, an explicit refusal wins, and DNT or excluded pages send nothing", () => {
  const page = browser()
  expect(analytics.getPublicAnalyticsChoice()).toMatchObject({
    enabled: true,
    decided: false,
    consentRequired: false,
  })
  expect(analytics.initializePublicAnalytics(config)).toBe(true)
  expect(optedIn).toBe(true)
  page.location.pathname = "/agents/connections/"
  analytics.capturePublicPageview()
  expect(sent.at(-1)?.cookieless).toBe(false)

  analytics.setPublicAnalyticsEnabled(false)
  expect(optedIn).toBe(false)
  expect(analytics.initializePublicAnalytics(config)).toBe(true)
  expect(optedIn).toBe(false)

  const count = sent.length
  page.navigator.doNotTrack = "1"
  expect(analytics.initializePublicAnalytics(config)).toBe(false)
  analytics.captureInstallCommandCopy(config, "cli_install", "docs_start")
  page.navigator.doNotTrack = "0"
  page.navigator.globalPrivacyControl = true
  expect(analytics.getPublicAnalyticsChoice()).toMatchObject({
    enabled: false,
    privacySignal: true,
  })
  expect(analytics.initializePublicAnalytics(config)).toBe(false)
  page.navigator.globalPrivacyControl = false
  page.location.hostname = "preview.example.com"
  expect(analytics.initializePublicAnalytics(config)).toBe(false)
  page.location.hostname = "docs.worktable.dev"
  page.location.pathname = "/private"
  expect(analytics.initializePublicAnalytics(config)).toBe(false)
  page.location.pathname = "/start/install/"
  expect(
    analytics.initializePublicAnalytics({ ...config, projectToken: "" })
  ).toBe(false)
  expect(sent).toHaveLength(count)
})
