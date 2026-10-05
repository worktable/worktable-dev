import { expect, mock, test } from "bun:test"

const init = mock(() => {})
const capture = mock(() => {})
mock.module("posthog-js/dist/module.slim", () => ({
  default: { init, capture },
}))

const analytics = await import("./browser")

test("SDK collection ignores retired preferences and retains browser and site boundaries", () => {
  const originals = new Map(
    ["window", "navigator", "document"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  )
  const location = {
    hostname: "docs.worktable.dev",
    pathname: "/start/install/",
    search: "",
  }
  const navigator = { doNotTrack: "0" }
  const config = {
    projectToken: "phc_test_public_token",
    siteSurface: "worktable_docs" as const,
    allowedPathnames: ["/start/install", "/agents/connections"],
    environmentVariableName: "TEST_POSTHOG_TOKEN",
    isDevelopment: false,
  }

  try {
    for (const [key, value] of Object.entries({
      window: {
        location,
        localStorage: { getItem: () => "off" },
        __worktablePublicAnalyticsDocumentOptOut: true,
      },
      navigator,
      document: { referrer: "" },
    })) {
      Object.defineProperty(globalThis, key, { configurable: true, value })
    }

    expect(analytics.initializePublicAnalytics(config)).toBe(true)
    expect(init).toHaveBeenCalledWith(
      config.projectToken,
      expect.objectContaining({
        cookieless_mode: "always",
        persistence: "memory",
        disable_persistence: true,
        respect_dnt: true,
      })
    )
    analytics.capturePublicPageview()
    analytics.capturePublicPageview()
    expect(capture).toHaveBeenCalledTimes(1)

    location.pathname = "/agents/connections/"
    analytics.capturePublicPageview()
    expect(capture).toHaveBeenCalledTimes(2)

    navigator.doNotTrack = "1"
    expect(analytics.initializePublicAnalytics(config)).toBe(false)
    location.pathname = "/start/install/"
    analytics.capturePublicPageview()
    analytics.captureInstallCommandCopy(config, "cli_install", "docs_start")
    expect(capture).toHaveBeenCalledTimes(2)

    navigator.doNotTrack = "0"
    location.hostname = "preview.example.com"
    expect(analytics.initializePublicAnalytics(config)).toBe(false)
    location.hostname = "docs.worktable.dev"
    location.pathname = "/private"
    expect(analytics.initializePublicAnalytics(config)).toBe(false)
    location.pathname = "/start/install/"
    expect(
      analytics.initializePublicAnalytics({ ...config, projectToken: "" })
    ).toBe(false)
    expect(capture).toHaveBeenCalledTimes(2)
  } finally {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})
