import { describe, expect, test } from "bun:test"
import {
  approvedCampaignProperties,
  isApprovedCta,
  isDoNotTrackEnabled,
  isPublicAnalyticsContextAllowed,
  normalizePublicAnalyticsPathname,
  PUBLIC_ANALYTICS_API_HOST,
  sanitizePublicAnalyticsEvent,
  type PublicAnalyticsConfig,
  type PublicAnalyticsEvent,
  type PublicSiteSurface,
} from "./index"

const PROJECT_TOKEN = "phc_test_public_token"

function config(siteSurface: PublicSiteSurface): PublicAnalyticsConfig {
  return {
    projectToken: PROJECT_TOKEN,
    siteSurface,
    allowedPathnames:
      siteSurface === "worktable_docs"
        ? ["/", "/start/desktop", "/whats-new"]
        : ["/"],
    environmentVariableName: "TEST_POSTHOG_TOKEN",
    isDevelopment: false,
  }
}

function location(hostname: string, pathname = "/", search = "") {
  return { hostname, pathname, search }
}

function pageviewEvent(
  siteSurface: PublicSiteSurface,
  hostname: string,
  pathname = "/"
): PublicAnalyticsEvent {
  return {
    event: "$pageview",
    properties: {
      token: "untrusted-token",
      distinct_id: "persistent-visitor-id",
      analytics_schema_version: 1,
      site_surface: siteSurface,
      $host: hostname,
      $pathname: pathname,
      $current_url: `https://${hostname}${pathname}?email=private@example.com#secret`,
      $referrer: "https://example.com/private/path",
      $referring_domain: "Example.COM",
      $raw_user_agent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      $os: "Mac OS X",
      $os_version: "15.4.1",
      $device_type: "Desktop",
      $screen_width: 1728,
      $timezone: "America/Los_Angeles",
      title: "A private page title",
    },
    $set: { email: "private@example.com" },
    $set_once: { initial_url: "https://example.com/private" },
  }
}

describe("public analytics collection boundary", () => {
  test("uses the managed first-party ingestion host", () => {
    expect(PUBLIC_ANALYTICS_API_HOST).toBe("https://edge.worktable.dev")
  })

  test("allows only canonical production surfaces and eligible paths", () => {
    const cases = [
      ["worktable_dev", "www.worktable.dev", "/", "", true],
      ["worktable_dev", "worktable.dev", "/", "", false],
      ["worktable_dev", "www.worktable.dev", "/privacy", "", false],
      ["worktable_dev", "localhost", "/", "", false],
      ["worktable_cloud", "www.worktable.cloud", "/", "", true],
      ["worktable_cloud", "www.worktable.cloud", "/", "?from=logout", false],
      [
        "worktable_cloud",
        "www.worktable.cloud",
        "/",
        "?environment=staging",
        false,
      ],
      ["worktable_cloud", "app.worktable.cloud", "/", "", false],
      ["worktable_docs", "docs.worktable.dev", "/start/desktop/", "", true],
      ["worktable_docs", "docs.worktable.dev", "/whats-new", "", true],
      [
        "worktable_docs",
        "docs.worktable.dev",
        "/invite/private_token",
        "",
        false,
      ],
      ["worktable_docs", "docs.worktable.dev", "/private.html", "", false],
      ["worktable_docs", "preview.vercel.app", "/start/desktop/", "", false],
    ] as const

    for (const [surface, host, path, search, expected] of cases) {
      expect(
        isPublicAnalyticsContextAllowed(
          config(surface),
          location(host, path, search)
        )
      ).toBe(expected)
    }
  })

  test("normalizes eligible trailing slashes to one analytics pathname", () => {
    expect(normalizePublicAnalyticsPathname("/start/desktop/")).toBe(
      "/start/desktop"
    )

    const event = sanitizePublicAnalyticsEvent(
      pageviewEvent("worktable_docs", "docs.worktable.dev", "/start/desktop"),
      config("worktable_docs"),
      location("docs.worktable.dev", "/start/desktop/")
    )

    expect(event?.properties?.$pathname).toBe("/start/desktop")
  })

  test("recognizes browser Do Not Track variants", () => {
    expect(isDoNotTrackEnabled({ doNotTrack: "1" }, { doNotTrack: null })).toBe(
      true
    )
    expect(
      isDoNotTrackEnabled(
        { doNotTrack: null, msDoNotTrack: "yes" },
        { doNotTrack: null }
      )
    ).toBe(true)
    expect(isDoNotTrackEnabled({ doNotTrack: "0" }, { doNotTrack: "0" })).toBe(
      false
    )
  })

  test("accepts only the contract's CTA and placement pairs", () => {
    expect(isApprovedCta("macos_download", "hero")).toBe(true)
    expect(isApprovedCta("macos_download", "docs_start")).toBe(true)
    expect(isApprovedCta("cloud_signup_open", "pricing_card")).toBe(true)
    expect(isApprovedCta("cloud_signup_open", "faq")).toBe(false)
    expect(isApprovedCta("sign_in", "hero")).toBe(false)
  })

  test("does not accept arbitrary campaign query values", () => {
    expect(
      approvedCampaignProperties(
        "?utm_source=someone%40example.com&utm_medium=cpc&utm_campaign=private"
      )
    ).toEqual({})
  })
})

describe("public analytics event sanitizer", () => {
  test("keeps the bounded schema and strips default context and person data", () => {
    const event = sanitizePublicAnalyticsEvent(
      pageviewEvent("worktable_dev", "www.worktable.dev"),
      config("worktable_dev"),
      location("www.worktable.dev")
    )

    expect(event).not.toBeNull()
    expect(event?.properties).toEqual({
      token: PROJECT_TOKEN,
      distinct_id: "$posthog_cookieless",
      $cookieless_mode: true,
      $process_person_profile: false,
      $geoip_disable: true,
      analytics_schema_version: 1,
      site_surface: "worktable_dev",
      $host: "www.worktable.dev",
      $pathname: "/",
      $raw_user_agent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      $referring_domain: "example.com",
      $os: "Mac OS X",
      $device_type: "Desktop",
    })
    expect(event?.$set).toBeUndefined()
    expect(event?.$set_once).toBeUndefined()

    const oversizedUserAgentEvent = pageviewEvent(
      "worktable_dev",
      "www.worktable.dev"
    )
    oversizedUserAgentEvent.properties!.$raw_user_agent = "x".repeat(1_001)
    expect(
      sanitizePublicAnalyticsEvent(
        oversizedUserAgentEvent,
        config("worktable_dev"),
        location("www.worktable.dev")
      )?.properties?.$raw_user_agent
    ).toBe(`${"x".repeat(997)}...`)
  })

  test("drops unknown events, invalid properties, and excluded contexts", () => {
    const valid = pageviewEvent("worktable_dev", "www.worktable.dev")
    expect(
      sanitizePublicAnalyticsEvent(
        { ...valid, event: "$autocapture" },
        config("worktable_dev"),
        location("www.worktable.dev")
      )
    ).toBeNull()
    expect(
      sanitizePublicAnalyticsEvent(
        {
          event: "marketing:cta_click",
          properties: {
            ...valid.properties,
            cta_id: "cloud_signup_open",
            placement: "faq",
          },
        },
        config("worktable_dev"),
        location("www.worktable.dev")
      )
    ).toBeNull()
    expect(
      sanitizePublicAnalyticsEvent(
        valid,
        config("worktable_dev"),
        location("www.worktable.dev", "/privacy")
      )
    ).toBeNull()
    const propertiesWithoutUserAgent = { ...valid.properties }
    delete propertiesWithoutUserAgent.$raw_user_agent
    expect(
      sanitizePublicAnalyticsEvent(
        { ...valid, properties: propertiesWithoutUserAgent },
        config("worktable_dev"),
        location("www.worktable.dev")
      )
    ).toBeNull()
  })
})
