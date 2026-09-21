import type { BeforeSendFn } from "posthog-js"
import posthog from "posthog-js/dist/module.slim"
import {
  approvedCampaignProperties,
  isDoNotTrackEnabled,
  isPublicAnalyticsContextAllowed,
  normalizePublicAnalyticsPathname,
  PUBLIC_ANALYTICS_API_HOST,
  PUBLIC_ANALYTICS_PREFERENCE_EVENT,
  PUBLIC_ANALYTICS_PREFERENCE_KEY,
  PUBLIC_ANALYTICS_SCHEMA_VERSION,
  sanitizePublicAnalyticsEvent,
  type PublicAnalyticsConfig,
} from "./index"

let activeConfig: PublicAnalyticsConfig | undefined
let initialized = false
let lastPageviewKey: string | undefined
let documentOptOut = false

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

export function captureInstallCommandCopy(config: PublicAnalyticsConfig): void {
  // The copy control can hydrate before the root analytics effect. Initialize
  // on demand so a successful early copy is not silently dropped.
  if (!initializePublicAnalytics(config) || !canCaptureActiveConfig()) return
  capture("marketing:install_command_copy", {
    command_id: "self_host_install",
    placement: "deployment_card",
  })
}

export function getPublicAnalyticsChoice(): {
  enabled: boolean
  doNotTrack: boolean
} {
  const windowWithDnt = window as typeof window & {
    doNotTrack?: string | null
  }
  const doNotTrack = isDoNotTrackEnabled(
    navigator as Navigator & { msDoNotTrack?: string | null },
    { doNotTrack: windowWithDnt.doNotTrack }
  )
  return {
    enabled: !doNotTrack && !hasStoredOptOut(),
    doNotTrack,
  }
}

export function setPublicAnalyticsEnabled(enabled: boolean): void {
  setDocumentOptOut(!enabled)
  try {
    if (enabled) {
      window.localStorage.removeItem(PUBLIC_ANALYTICS_PREFERENCE_KEY)
    } else {
      window.localStorage.setItem(PUBLIC_ANALYTICS_PREFERENCE_KEY, "off")
    }
  } catch {
    // Storage can be unavailable in hardened browsers. Capture remains gated by
    // the in-memory state for this document even if persistence fails.
  }

  window.dispatchEvent(new Event(PUBLIC_ANALYTICS_PREFERENCE_EVENT))

  if (enabled) initializeAndCaptureActivePage()
}

export function subscribeToPublicAnalyticsChoice(
  listener: () => void
): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === PUBLIC_ANALYTICS_PREFERENCE_KEY) {
      setDocumentOptOut(event.newValue === "off")
      listener()
      if (event.oldValue === "off" && event.newValue !== "off") {
        initializeAndCaptureActivePage()
      }
    }
  }
  window.addEventListener(PUBLIC_ANALYTICS_PREFERENCE_EVENT, listener)
  window.addEventListener("storage", onStorage)
  return () => {
    window.removeEventListener(PUBLIC_ANALYTICS_PREFERENCE_EVENT, listener)
    window.removeEventListener("storage", onStorage)
  }
}

function initializeAndCaptureActivePage(): void {
  if (!activeConfig || !initializePublicAnalytics(activeConfig)) return
  lastPageviewKey = undefined
  capturePublicPageview()
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
      ...approvedCampaignProperties(window.location.search),
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
    getPublicAnalyticsChoice().enabled
  )
}

function hasStoredOptOut(): boolean {
  if (documentOptOut) return true
  try {
    return (
      window.localStorage.getItem(PUBLIC_ANALYTICS_PREFERENCE_KEY) === "off"
    )
  } catch {
    return false
  }
}

function setDocumentOptOut(optedOut: boolean): void {
  documentOptOut = optedOut
  ;(
    window as typeof window & {
      __worktablePublicAnalyticsDocumentOptOut?: boolean
    }
  ).__worktablePublicAnalyticsDocumentOptOut = optedOut
}
