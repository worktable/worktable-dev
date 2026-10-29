import type { BeforeSendFn } from "posthog-js"
import posthog from "posthog-js/dist/module.slim"
import {
  approvedCampaignProperties,
  isApprovedCta,
  publicAcquisitionProperties,
  publicFirstTouchProperties,
  isPublicAnalyticsContextAllowed,
  normalizePublicAnalyticsPathname,
  PUBLIC_ANALYTICS_API_HOST,
  PUBLIC_ANALYTICS_CTA_ATTRIBUTE,
  PUBLIC_ANALYTICS_PLACEMENT_ATTRIBUTE,
  PUBLIC_ANALYTICS_SCHEMA_VERSION,
  sanitizePublicAnalyticsEvent,
  type PublicAnalyticsConfig,
  type PublicInstallCommandId,
  type PublicInstallCopyPlacement,
} from "./index"
import {
  clearBrowserAnalyticsIdentity,
  clearStoredAnalytics,
  migrateLegacyAnalyticsPreference,
  getPublicAnalyticsChoice,
  subscribeToPublicAnalyticsChoice,
} from "./consent"
export {
  getPublicAnalyticsChoice,
  setPublicAnalyticsEnabled,
  subscribeToPublicAnalyticsChoice,
} from "./consent"

let activeConfig: PublicAnalyticsConfig | undefined
let initialized = false
let installed = false
let lastPageviewKey: string | undefined
// Memory only: carried from the cookieless phase to the cookie identity.
let firstTouch: Record<string, string> | undefined
let latestExternalSource: string | undefined

const sanitizeBeforeSend: BeforeSendFn = (event) => {
  if (!event || !activeConfig || !canCount(activeConfig)) return null
  // Identified events need the current choice; a stale tab cannot send them.
  if (
    event.properties?.$cookieless_mode !== true &&
    (activeConfig.cookieless || !getPublicAnalyticsChoice().enabled)
  )
    return null
  const sanitized = sanitizePublicAnalyticsEvent(
    event,
    activeConfig,
    window.location
  )
  return sanitized
    ? {
        ...event,
        properties: sanitized.properties ?? {},
        $set: undefined,
        $set_once: undefined,
      }
    : null
}

export function initializePublicAnalytics(
  config: PublicAnalyticsConfig
): boolean {
  activeConfig = config
  if (config.cookieless) {
    // Nothing persists here, so anything stored by an earlier version goes.
    if (config.projectToken && !initialized)
      clearStoredAnalytics(config.projectToken)
  } else migrateLegacyAnalyticsPreference()
  if (!installed) {
    installed = true
    document.addEventListener("click", captureClick, true)
    document.addEventListener("auxclick", captureClick, true)
    subscribeToPublicAnalyticsChoice(() => {
      if (!activeConfig || activeConfig.cookieless) return
      const choice = getPublicAnalyticsChoice()
      // Only a refusal clears the shared identity; an open choice is not one.
      if (!choice.enabled && choice.decided && activeConfig.projectToken) {
        if (initialized && posthog.has_opted_in_capturing())
          posthog.opt_out_capturing()
        clearBrowserAnalyticsIdentity(activeConfig.projectToken)
      }
      if (initializePublicAnalytics(activeConfig)) capturePublicPageview()
    })
  }
  if (!canCount(config)) return false
  if (!initialized) {
    posthog.init(config.projectToken!, {
      api_host: config.apiHost ?? PUBLIC_ANALYTICS_API_HOST,
      ui_host: "https://us.posthog.com",
      defaults: "2026-05-30",
      autocapture: false,
      rageclick: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_exceptions: false,
      capture_performance: false,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      disable_session_recording: true,
      enable_recording_console_log: false,
      disable_surveys: true,
      disable_surveys_automatic_display: true,
      disable_product_tours: true,
      disable_scroll_properties: true,
      disable_capture_url_hashes: true,
      save_campaign_params: false,
      save_referrer: false,
      advanced_disable_flags: true,
      advanced_disable_feature_flags: true,
      advanced_disable_feature_flags_on_first_load: true,
      person_profiles: "identified_only",
      respect_dnt: true,
      ...(config.cookieless
        ? {
            cookieless_mode: "always" as const,
            persistence: "memory" as const,
            disable_persistence: true,
          }
        : {
            // Until analytics cookies are allowed, count without cookies or
            // storage. Starting rejected rather than calling
            // opt_out_capturing() keeps the SDK's own consent marker
            // unwritten before the visitor chooses.
            cookieless_mode: "on_reject" as const,
            opt_out_capturing_by_default: true,
            persistence: "localStorage+cookie" as const,
          }),
      cross_subdomain_cookie: true,
      internal_or_test_user_hostname: null,
      request_batching: false,
      before_send: sanitizeBeforeSend,
    })
    initialized = true
  }
  if (config.cookieless) return true
  if (getPublicAnalyticsChoice().enabled) {
    // Opting in resets the cookieless identity, so the two are never linked.
    if (!posthog.has_opted_in_capturing())
      posthog.opt_in_capturing({ captureEventName: false })
    registerJourney()
  } else if (posthog.has_opted_in_capturing()) {
    posthog.opt_out_capturing()
    clearBrowserAnalyticsIdentity(config.projectToken!)
  }
  return true
}

export function capturePublicPageview(): void {
  const key = `${location.hostname}${normalizePublicAnalyticsPathname(location.pathname)}`
  if (
    activeConfig &&
    !isPublicAnalyticsContextAllowed(activeConfig, location)
  ) {
    lastPageviewKey = key
    return
  }
  if (!activeConfig || !initializePublicAnalytics(activeConfig)) return
  if (key === lastPageviewKey) return
  lastPageviewKey = key
  capture("$pageview", {})
}

export function captureInstallCommandCopy(
  config: PublicAnalyticsConfig,
  commandId: PublicInstallCommandId,
  placement: PublicInstallCopyPlacement
): void {
  if (!initializePublicAnalytics(config)) return
  capture("marketing:install_command_copy", {
    command_id: commandId,
    placement,
  })
}

function capture(
  event: "$pageview" | "marketing:install_command_copy" | "marketing:cta_click",
  properties: Record<string, string>
) {
  if (!activeConfig || !initialized || !canCount(activeConfig)) return
  const referrer = referringDomain()
  const pathname = normalizePublicAnalyticsPathname(location.pathname)
  const acquisition = publicAcquisitionProperties(location.search, referrer)
  firstTouch ??= publicFirstTouchProperties(acquisition, pathname, referrer)
  if (
    !["direct_or_unknown", "internal_unknown"].includes(
      acquisition.acquisition_source!
    )
  )
    latestExternalSource = acquisition.acquisition_source
  const identified = posthog.has_opted_in_capturing()
  if (identified) registerJourney()
  posthog.capture(
    event,
    {
      analytics_schema_version: PUBLIC_ANALYTICS_SCHEMA_VERSION,
      site_surface: activeConfig.siteSurface,
      $host: location.hostname,
      $pathname: pathname,
      ...(referrer ? { $referring_domain: referrer } : {}),
      ...acquisition,
      // Without cookies the journey travels on each event instead.
      ...(identified ? {} : journey()),
      ...properties,
    },
    { send_instantly: true }
  )
}

function journey(): Record<string, string> {
  return {
    ...firstTouch,
    ...(latestExternalSource
      ? { latest_external_acquisition_source: latestExternalSource }
      : {}),
  }
}

/** First touch is kept by the cookie identity; later visits never replace it. */
function registerJourney(): void {
  if (firstTouch) posthog.register_once(firstTouch)
  if (latestExternalSource)
    posthog.register({
      latest_external_acquisition_source: latestExternalSource,
    })
}

function captureClick(event: MouseEvent): void {
  if (event.type === "auxclick" && event.button !== 1) return
  if (
    !activeConfig ||
    !canCount(activeConfig) ||
    !(event.target instanceof Element)
  )
    return
  const anchor = event.target.closest("a[href]")
  if (anchor instanceof HTMLAnchorElement) {
    const destination = new URL(anchor.href, location.href)
    const publicPage = ["www.worktable.cloud", "docs.worktable.dev"].includes(
      destination.hostname
    )
    const signup =
      destination.hostname === "app.worktable.cloud" &&
      destination.pathname.replace(/\/+$/, "") === "/signup"
    const samePage =
      destination.origin === location.origin &&
      destination.pathname === location.pathname &&
      destination.hash
    if (
      destination.protocol === "https:" &&
      !samePage &&
      (publicPage || signup)
    ) {
      if (!destination.searchParams.has("utm_source")) {
        for (const [key, value] of Object.entries(
          approvedCampaignProperties(location.search)
        )) {
          if (!destination.searchParams.has(key))
            destination.searchParams.set(key, value)
        }
        const acquisition = publicAcquisitionProperties(
          location.search,
          referringDomain()
        )
        destination.searchParams.set(
          "wt_source",
          acquisition.acquisition_source!
        )
        if (acquisition.traffic_type === "verification")
          destination.searchParams.set("wt_test", "1")
      }
      anchor.href = destination.href
    }
  }
  const tracked = event.target.closest(`[${PUBLIC_ANALYTICS_CTA_ATTRIBUTE}]`)
  const ctaId = tracked?.getAttribute(PUBLIC_ANALYTICS_CTA_ATTRIBUTE)
  const placement = tracked?.getAttribute(PUBLIC_ANALYTICS_PLACEMENT_ATTRIBUTE)
  if (ctaId && placement && isApprovedCta(ctaId, placement))
    capture("marketing:cta_click", { cta_id: ctaId, placement })
}

function referringDomain(): string | undefined {
  try {
    return document.referrer
      ? new URL(document.referrer).hostname.toLowerCase()
      : undefined
  } catch {
    return undefined
  }
}

/** Counting runs with or without cookies; a privacy signal stops it entirely. */
function canCount(config: PublicAnalyticsConfig): boolean {
  return (
    Boolean(config.projectToken) &&
    isPublicAnalyticsContextAllowed(config, location) &&
    !getPublicAnalyticsChoice().privacySignal
  )
}
