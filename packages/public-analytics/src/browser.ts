import type { BeforeSendFn } from "posthog-js"
import posthog from "posthog-js/dist/module.slim"
import {
  publicAcquisitionProperties,
  isDoNotTrackEnabled,
  isPublicAnalyticsContextAllowed,
  normalizePublicAnalyticsPathname,
  PUBLIC_ANALYTICS_API_HOST,
  PUBLIC_ANALYTICS_SCHEMA_VERSION,
  sanitizePublicAnalyticsEvent,
  type PublicAnalyticsConfig,
  type PublicInstallCommandId,
  type PublicInstallCopyPlacement,
} from "./index"

let activeConfig: PublicAnalyticsConfig | undefined
let initialized = false
let lastPageviewKey: string | undefined

const sanitizeBeforeSend: BeforeSendFn = (event) => {
  if (!event || !activeConfig) return null
  const sanitized = sanitizePublicAnalyticsEvent(
    event,
    activeConfig,
    window.location
  )
  if (!sanitized) return null
  return {
    ...event,
    event: sanitized.event,
    properties: sanitized.properties ?? {},
    $set: undefined,
    $set_once: undefined,
  }
}

export function initializePublicAnalytics(
  config: PublicAnalyticsConfig
): boolean {
  activeConfig = config

  if (!config.projectToken) {
    if (config.isDevelopment) {
      console.error(
        `${config.environmentVariableName} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${config.environmentVariableName} is configured`
      )
    }
    return false
  }

  if (!canCapture(config)) return false
  if (initialized) return true

  posthog.init(config.projectToken, {
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
    person_profiles: "never",
    cookieless_mode: "always",
    respect_dnt: true,
    persistence: "memory",
    disable_persistence: true,
    cross_subdomain_cookie: false,
    internal_or_test_user_hostname: null,
    request_batching: false,
    before_send: sanitizeBeforeSend,
  })

  initialized = true
  return true
}

export function capturePublicPageview(): void {
  const pathname = normalizePublicAnalyticsPathname(window.location.pathname)
  const key = `${window.location.hostname}${pathname}`
  const windowWithEarlyPageview = window as typeof window & {
    __worktablePublicAnalyticsEarlyPageviewKey?: string
  }
  const earlyPageviewKey =
    windowWithEarlyPageview.__worktablePublicAnalyticsEarlyPageviewKey
  if (earlyPageviewKey !== undefined) {
    delete windowWithEarlyPageview.__worktablePublicAnalyticsEarlyPageviewKey
    if (earlyPageviewKey === key) {
      lastPageviewKey = key
      return
    }
  }

  if (key === lastPageviewKey) return
  lastPageviewKey = key

  if (!canCaptureActiveConfig()) return
  capture("$pageview", {})
}

export function captureInstallCommandCopy(
  config: PublicAnalyticsConfig,
  commandId: PublicInstallCommandId,
  placement: PublicInstallCopyPlacement
): void {
  // The copy control can hydrate before the root analytics effect. Initialize
  // on demand so a successful early copy is not silently dropped.
  if (!initializePublicAnalytics(config) || !canCaptureActiveConfig()) return
  capture("marketing:install_command_copy", {
    command_id: commandId,
    placement,
  })
}

function capture(
  event: "$pageview" | "marketing:install_command_copy",
  properties: Record<string, string>
) {
  if (!activeConfig) return
  const pathname = normalizePublicAnalyticsPathname(window.location.pathname)

  posthog.capture(
    event,
    {
      analytics_schema_version: PUBLIC_ANALYTICS_SCHEMA_VERSION,
      site_surface: activeConfig.siteSurface,
      $host: window.location.hostname,
      $pathname: pathname,
      ...referringDomainProperty(),
      ...publicAcquisitionProperties(
        window.location.search,
        referringDomainProperty().$referring_domain
      ),
      ...properties,
    },
    {
      send_instantly: true,
    }
  )
}

function referringDomainProperty(): Record<string, string> {
  if (!document.referrer) return {}
  try {
    const hostname = new URL(document.referrer).hostname.toLowerCase()
    return hostname.length > 0 && hostname.length <= 253
      ? { $referring_domain: hostname }
      : {}
  } catch {
    return {}
  }
}

function canCaptureActiveConfig(): boolean {
  return activeConfig !== undefined && initialized && canCapture(activeConfig)
}

function canCapture(config: PublicAnalyticsConfig): boolean {
  return (
    Boolean(config.projectToken) &&
    isPublicAnalyticsContextAllowed(config, window.location) &&
    !isDoNotTrackEnabled(
      navigator as Navigator & { msDoNotTrack?: string | null },
      window as typeof window & { doNotTrack?: string | null }
    )
  )
}
