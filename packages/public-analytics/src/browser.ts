import type { BeforeSendFn } from "posthog-js"
import posthog from "posthog-js/dist/module.slim"
import {
  approvedCampaignProperties,
  isApprovedCta,
  publicAcquisitionProperties,
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

const sanitizeBeforeSend: BeforeSendFn = (event) => {
  if (!event || !activeConfig || !canCapture(activeConfig)) return null
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
  migrateLegacyAnalyticsPreference()
  if (!installed) {
    installed = true
    document.addEventListener("click", captureClick, true)
    document.addEventListener("auxclick", captureClick, true)
    subscribeToPublicAnalyticsChoice(() => {
      if (!getPublicAnalyticsChoice().enabled) {
        if (initialized) {
          posthog.reset(true)
          posthog.opt_out_capturing()
        }
        if (activeConfig?.projectToken)
          clearBrowserAnalyticsIdentity(activeConfig.projectToken)
        lastPageviewKey = undefined
      } else if (activeConfig && initializePublicAnalytics(activeConfig)) {
        capturePublicPageview()
      }
    })
  }
  if (!canCapture(config)) return false
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
      persistence: "localStorage+cookie",
      cross_subdomain_cookie: true,
      internal_or_test_user_hostname: null,
      request_batching: false,
      before_send: sanitizeBeforeSend,
    })
    initialized = true
  }
  posthog.opt_in_capturing({ captureEventName: false })
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
  if (!activeConfig || !initialized || !canCapture(activeConfig)) return
  const referrer = referringDomain()
  const acquisition = publicAcquisitionProperties(location.search, referrer)
  posthog.register_once({
    initial_acquisition_source: acquisition.acquisition_source,
  })
  if (
    !["direct_or_unknown", "internal_unknown"].includes(
      acquisition.acquisition_source!
    )
  )
    posthog.register({
      latest_external_acquisition_source: acquisition.acquisition_source,
    })
  posthog.capture(
    event,
    {
      analytics_schema_version: PUBLIC_ANALYTICS_SCHEMA_VERSION,
      site_surface: activeConfig.siteSurface,
      $host: location.hostname,
      $pathname: normalizePublicAnalyticsPathname(location.pathname),
      ...(referrer ? { $referring_domain: referrer } : {}),
      ...acquisition,
      ...properties,
    },
    { send_instantly: true }
  )
}

function captureClick(event: MouseEvent): void {
  if (event.type === "auxclick" && event.button !== 1) return
  if (
    !activeConfig ||
    !canCapture(activeConfig) ||
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

function canCapture(config: PublicAnalyticsConfig): boolean {
  return (
    Boolean(config.projectToken) &&
    isPublicAnalyticsContextAllowed(config, location) &&
    getPublicAnalyticsChoice().enabled
  )
}
