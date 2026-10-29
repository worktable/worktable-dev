import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import {
  ANALYTICS_REGION_SITES,
  analyticsRegionHeaderRules,
  analyticsRegionRequiresConsent,
  ANALYTICS_REGION_COOKIE,
  isAnalyticsRegionHeaderRule,
} from "./region"
import {
  approvedCampaignProperties,
  COOKIELESS_DISTINCT_ID,
  publicAcquisitionProperties,
  isApprovedCta,
  isPrivacySignalEnabled,
  isPublicAnalyticsContextAllowed,
  normalizePublicAnalyticsPathname,
  PUBLIC_ANALYTICS_API_HOST,
  PUBLIC_ANALYTICS_SCHEMA_VERSION,
  publicFirstTouchProperties,
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
        ? ["/", "/start/desktop", "/start/install", "/whats-new"]
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
      analytics_schema_version: PUBLIC_ANALYTICS_SCHEMA_VERSION,
      site_surface: siteSurface,
      $host: hostname,
      $pathname: pathname,
      $current_url: `https://${hostname}${pathname}?email=private@example.com#secret`,
      $referrer: "https://example.com/private/path",
      $referring_domain: "Example.COM",
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

  test("recognizes Do Not Track variants and Global Privacy Control", () => {
    for (const [navigator, window] of [
      [{ doNotTrack: "1" }, { doNotTrack: null }],
      [{ doNotTrack: null, msDoNotTrack: "yes" }, { doNotTrack: null }],
      [{ doNotTrack: null, globalPrivacyControl: true }, {}],
    ] as const)
      expect(isPrivacySignalEnabled(navigator, window)).toBe(true)
    for (const [navigator, window] of [
      [{ doNotTrack: "0" }, { doNotTrack: "0" }],
      [{ globalPrivacyControl: false }, {}],
      [{ globalPrivacyControl: "true" }, {}],
    ] as const)
      expect(isPrivacySignalEnabled(navigator, window)).toBe(false)
  })

  test("accepts only the contract's CTA and placement pairs", () => {
    expect(isApprovedCta("install_guide_open", "footer")).toBe(true)
    expect(isApprovedCta("cloud_signup_open", "footer_cta")).toBe(true)
    expect(isApprovedCta("macos_download", "hero")).toBe(true)
    expect(isApprovedCta("macos_download", "docs_start")).toBe(true)
    expect(isApprovedCta("documentation_open", "hero")).toBe(true)
    expect(isApprovedCta("cloud_signup_open", "pricing_card")).toBe(true)
    expect(isApprovedCta("cloud_signup_open", "faq")).toBe(false)
    expect(isApprovedCta("sign_in", "hero")).toBe(false)
  })

  test("accepts published campaign labels using PostHog UTM properties", () => {
    expect(
      approvedCampaignProperties(
        "?utm_source=github&utm_medium=referral&utm_campaign=launch&email=private@example.com"
      )
    ).toEqual({
      utm_source: "github",
      utm_medium: "referral",
      utm_campaign: "launch",
    })
  })

  test("preserves bounded acquisition labels without identifying visitors", () => {
    expect(publicAcquisitionProperties("", "news.ycombinator.com")).toEqual({
      acquisition_source: "hackernews",
    })
    expect(
      publicAcquisitionProperties(
        "?wt_source=reddit&wt_test=1",
        "docs.worktable.dev"
      )
    ).toEqual({ acquisition_source: "reddit", traffic_type: "verification" })
    for (const inherited of ["direct_or_unknown", "reddit"]) {
      expect(
        publicAcquisitionProperties(
          `?wt_source=${inherited}&wt_test=1`,
          "news.ycombinator.com"
        )
      ).toEqual({ acquisition_source: "hackernews" })
    }
    expect(
      publicAcquisitionProperties("?wt_source=reddit", "example.com")
    ).toEqual({ acquisition_source: "other_referral" })
    expect(
      publicAcquisitionProperties(
        "?wt_source=reddit&utm_source=github",
        undefined
      )
    ).toEqual({ acquisition_source: "github", utm_source: "github" })
    expect(
      publicAcquisitionProperties("?wt_source=private%40example.com", undefined)
    ).toEqual({ acquisition_source: "direct_or_unknown" })
    expect(publicAcquisitionProperties("", "www.worktable.cloud")).toEqual({
      acquisition_source: "internal_unknown",
    })
    for (const domain of [
      "app.worktable.cloud",
      "polar.sh",
      "checkout.polar.sh",
    ]) {
      expect(publicAcquisitionProperties("", domain)).toEqual({
        acquisition_source: "internal_unknown",
      })
    }
    const event = pageviewEvent("worktable_dev", "www.worktable.dev")
    event.properties!.acquisition_source = "private@example.com"
    event.properties!.traffic_type = "arbitrary"
    const sanitized = sanitizePublicAnalyticsEvent(
      event,
      config("worktable_dev"),
      location("www.worktable.dev")
    )
    expect(sanitized?.properties).not.toHaveProperty("acquisition_source")
    expect(sanitized?.properties).not.toHaveProperty("traffic_type")
  })

  test("does not accept arbitrary campaign query values", () => {
    expect(
      approvedCampaignProperties(
        "?utm_source=someone%40example.com&utm_medium=private&utm_campaign=private"
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
      distinct_id: "persistent-visitor-id",
      $process_person_profile: false,
      $geoip_disable: true,
      analytics_schema_version: PUBLIC_ANALYTICS_SCHEMA_VERSION,
      environment: "production",
      site_surface: "worktable_dev",
      $host: "www.worktable.dev",
      $pathname: "/",
      $referring_domain: "example.com",
      $os: "Mac OS X",
      $device_type: "Desktop",
    })
    expect(event?.$set).toBeUndefined()
    expect(event?.$set_once).toBeUndefined()

    expect(event?.properties).not.toHaveProperty("$raw_user_agent")
    expect(event?.properties).not.toHaveProperty("$cookieless_mode")
  })

  test("accepts installer copies only at their declared acquisition surfaces", () => {
    const cases = [
      [
        "worktable_dev",
        "www.worktable.dev",
        "/",
        "self_host_install",
        "deployment_card",
        true,
      ],
      [
        "worktable_docs",
        "docs.worktable.dev",
        "/start/install",
        "cli_install",
        "docs_start",
        true,
      ],
      [
        "worktable_docs",
        "docs.worktable.dev",
        "/start/desktop",
        "cli_install",
        "docs_start",
        false,
      ],
      [
        "worktable_cloud",
        "www.worktable.cloud",
        "/",
        "self_host_install",
        "deployment_card",
        true,
      ],
      [
        "worktable_cloud",
        "www.worktable.cloud",
        "/support",
        "self_host_install",
        "deployment_card",
        false,
      ],
      [
        "worktable_dev",
        "www.worktable.dev",
        "/",
        "private-command",
        "deployment_card",
        false,
      ],
    ] as const
    for (const [surface, host, path, commandId, placement, allowed] of cases) {
      const base = pageviewEvent(surface, host, path)
      const event = sanitizePublicAnalyticsEvent(
        {
          ...base,
          event: "marketing:install_command_copy",
          properties: {
            ...base.properties,
            command_id: commandId,
            placement,
            command: "private text",
          },
        },
        config(surface),
        location(host, path)
      )
      expect(event !== null).toBe(allowed)
      expect(event?.properties).not.toHaveProperty("command")
    }
  })

  test("counts cookieless visits without browser identifiers and keeps first-touch labels", () => {
    const valid = pageviewEvent("worktable_docs", "docs.worktable.dev")
    const firstTouch = publicFirstTouchProperties(
      publicAcquisitionProperties(
        "?utm_source=github&utm_campaign=secret",
        "github.com"
      ),
      "/start/install/",
      "github.com"
    )
    const cookieless = {
      ...valid.properties,
      ...firstTouch,
      $pathname: "/start/install",
      distinct_id: COOKIELESS_DISTINCT_ID,
      $cookieless_mode: true,
      $raw_user_agent: "Mozilla/5.0 Test",
      $device_id: "device-should-not-leave",
      $session_id: "session-should-not-leave",
    }
    const surface = config("worktable_docs")
    const page = location("docs.worktable.dev", "/start/install/")
    const event = sanitizePublicAnalyticsEvent(
      { ...valid, properties: cookieless },
      surface,
      page
    )
    expect(event?.properties).toMatchObject({
      distinct_id: COOKIELESS_DISTINCT_ID,
      $cookieless_mode: true,
      $raw_user_agent: "Mozilla/5.0 Test",
      $process_person_profile: false,
      initial_acquisition_source: "github",
      initial_landing_path: "/start/install",
      initial_utm_source: "github",
      initial_referring_domain: "github.com",
    })
    for (const key of ["$device_id", "$session_id", "initial_utm_campaign"])
      expect(event?.properties).not.toHaveProperty(key)
    // A cookieless event can never carry a browser identity or omit the hash input.
    for (const properties of [
      { ...cookieless, distinct_id: "persistent-visitor-id" },
      { ...cookieless, $raw_user_agent: undefined },
    ])
      expect(
        sanitizePublicAnalyticsEvent({ ...valid, properties }, surface, page)
      ).toBeNull()
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
    const propertiesWithoutIdentity = { ...valid.properties }
    delete propertiesWithoutIdentity.distinct_id
    expect(
      sanitizePublicAnalyticsEvent(
        { ...valid, properties: propertiesWithoutIdentity },
        config("worktable_dev"),
        location("www.worktable.dev")
      )
    ).toBeNull()
  })
})

describe("analytics consent regions", () => {
  test("reads only the routing layer's consent marker", () => {
    expect(analyticsRegionRequiresConsent("")).toBe(false)
    expect(
      analyticsRegionRequiresConsent(`a=1; ${ANALYTICS_REGION_COOKIE}=consent`)
    ).toBe(true)
    expect(
      analyticsRegionRequiresConsent(`${ANALYTICS_REGION_COOKIE}=consented`)
    ).toBe(false)
  })

  test("worktable.cloud deploys the shared region rules and docs deploy none", () => {
    const root = new URL("../../../", import.meta.url)
    const rules = (path: string) => {
      const site = new URL(path, root)
      if (!existsSync(site)) return undefined
      return (
        (JSON.parse(readFileSync(site, "utf8")) as { headers?: unknown[] })
          .headers ?? []
      ).filter(isAnalyticsRegionHeaderRule)
    }
    for (const site of ANALYTICS_REGION_SITES) {
      const deployed = rules(site)
      if (deployed)
        expect(
          deployed,
          `${site} is out of date; run \`bun run generate:analytics-regions\``
        ).toEqual(analyticsRegionHeaderRules())
    }
    expect(rules("apps/docs/vercel.json") ?? []).toEqual([])
  })
})
