import posthog from "posthog-js/dist/module.slim"
import { ANALYTICS_SCHEMA_VERSION } from "@worktable/types/analytics"
import { isProductAnalyticsAllowed } from "./consent"

let identity: string | null = null
let allowedUntil = 0
let initialized = false
interface ProductConfig {
  projectToken: string
  apiHost: string
  distinctId: string
  surface: "web" | "desktop_cloud"
  trafficType?: "internal" | "verification"
  worktableId?: string
}
let activeConfig: ProductConfig | null = null

export function stopProductAnalytics(): void {
  allowedUntil = 0
  if (initialized) {
    posthog.reset(true)
    posthog.opt_out_capturing()
  }
  identity = null
}

export function startProductAnalytics(config: ProductConfig): void {
  if (
    !/^workos:[a-zA-Z0-9_-]{1,200}$/.test(config.distinctId) ||
    !isProductAnalyticsAllowed()
  ) {
    stopProductAnalytics()
    return
  }
  if (identity && identity !== config.distinctId) stopProductAnalytics()
  activeConfig = config
  allowedUntil = Date.now() + 60_000
  if (!initialized) {
    posthog.init(config.projectToken, {
      api_host: config.apiHost,
      ui_host: "https://us.posthog.com",
      defaults: "2026-05-30",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_exceptions: false,
      capture_performance: false,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      rageclick: false,
      disable_session_recording: true,
      enable_recording_console_log: false,
      disable_surveys: true,
      disable_product_tours: true,
      disable_surveys_automatic_display: true,
      disable_scroll_properties: true,
      save_campaign_params: false,
      save_referrer: false,
      advanced_disable_flags: true,
      advanced_disable_feature_flags: true,
      advanced_disable_feature_flags_on_first_load: true,
      person_profiles: "identified_only",
      respect_dnt: true,
      persistence: "localStorage+cookie",
      cross_subdomain_cookie: true,
      request_batching: false,
      before_send: (event) => {
        const config = activeConfig
        if (!config) return null
        if (
          !event ||
          Date.now() >= allowedUntil ||
          !isProductAnalyticsAllowed() ||
          !["$identify", "product:opened"].includes(event.event)
        )
          return null
        const source = event.properties
        const properties: Record<string, unknown> = {
          token: config.projectToken,
          distinct_id: config.distinctId,
          analytics_schema_version: ANALYTICS_SCHEMA_VERSION,
          actor_type: "human",
          environment: "production",
          surface: config.surface,
          $geoip_disable: true,
          $process_person_profile: true,
          ...(config.trafficType === "internal" ||
          config.trafficType === "verification"
            ? { traffic_type: config.trafficType }
            : {}),
          ...(config.worktableId &&
          /^[a-zA-Z0-9_-]{1,200}$/.test(config.worktableId)
            ? { worktable_id: config.worktableId }
            : {}),
        }
        for (const key of [
          "$device_id",
          "$session_id",
          "$window_id",
          "$anon_distinct_id",
        ] as const) {
          const value = source[key]
          if (typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value))
            properties[key] = value
        }
        if (event.event === "$identify")
          properties.$set = {
            actor_type: "human",
            traffic_type: config.trafficType ?? "customer",
          }
        return { ...event, properties, $set: undefined, $set_once: undefined }
      },
    })
    initialized = true
  }
  posthog.opt_in_capturing({ captureEventName: false })
  if (identity === config.distinctId) return
  // An account switch can happen outside this tab. Never identify across two accounts.
  const persisted = posthog.get_distinct_id()
  if (persisted?.startsWith("workos:") && persisted !== config.distinctId)
    posthog.reset(true)
  posthog.identify(config.distinctId, { actor_type: "human" })
  identity = config.distinctId
  posthog.capture("product:opened", {}, { send_instantly: true })
}
