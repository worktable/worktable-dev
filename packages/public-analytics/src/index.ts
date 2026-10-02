export const PUBLIC_ANALYTICS_SCHEMA_VERSION = 2 as const
export const PUBLIC_ANALYTICS_API_HOST = "https://edge.worktable.dev"
export const PUBLIC_ANALYTICS_PREFERENCE_KEY = "worktable.public-analytics"
export const PUBLIC_ANALYTICS_PREFERENCE_EVENT =
  "worktable:public-analytics-preference"

export const PUBLIC_ANALYTICS_CTA_ATTRIBUTE = "data-public-analytics-cta"
export const PUBLIC_ANALYTICS_PLACEMENT_ATTRIBUTE =
  "data-public-analytics-placement"

export type PublicSiteSurface =
  | "worktable_dev"
  | "worktable_cloud"
  | "worktable_docs"

export type PublicAnalyticsCtaId =
  | "install_guide_open"
  | "macos_download"
  | "cloud_app_open"
  | "cloud_site_open"
  | "cloud_signup_open"
  | "local_site_open"
  | "documentation_open"
  | "source_code_open"

export type PublicAnalyticsPlacement =
  | "header"
  | "footer_cta"
  | "footer"
  | "hero"
  | "deployment_card"
  | "pricing_card"
  | "faq"
  | "docs_start"

type PublicAnalyticsCampaignProperty =
  | "utm_source"
  | "utm_medium"
  | "utm_campaign"

export interface PublicAnalyticsConfig {
  projectToken: string | undefined
  siteSurface: PublicSiteSurface
  allowedPathnames: readonly string[]
  apiHost?: string
  environmentVariableName: string
  isDevelopment: boolean
}

export interface PublicAnalyticsEvent {
  uuid?: string
  event: string
  properties?: Record<string, unknown>
  $set?: Record<string, unknown>
  $set_once?: Record<string, unknown>
  timestamp?: Date
}

const PRODUCTION_HOST_BY_SURFACE: Readonly<Record<PublicSiteSurface, string>> =
  {
    worktable_dev: "www.worktable.dev",
    worktable_cloud: "www.worktable.cloud",
    worktable_docs: "docs.worktable.dev",
  }

const CTA_PLACEMENTS: Readonly<
  Record<PublicAnalyticsCtaId, readonly PublicAnalyticsPlacement[]>
> = {
  install_guide_open: [
    "header",
    "hero",
    "deployment_card",
    "footer_cta",
    "footer",
    "docs_start",
  ],
  macos_download: [
    "header",
    "hero",
    "deployment_card",
    "footer_cta",
    "footer",
    "docs_start",
  ],
  cloud_app_open: ["hero"],
  cloud_site_open: ["hero", "deployment_card", "footer"],
  cloud_signup_open: ["hero", "pricing_card", "footer_cta", "footer"],
  local_site_open: ["hero", "pricing_card", "footer"],
  documentation_open: ["hero", "faq", "footer"],
  source_code_open: ["header", "hero", "footer", "pricing_card"],
}

// A bounded starter vocabulary for public campaign links. Add new campaign
// names here before publishing them; never collect arbitrary query values.
const ACTIVE_CAMPAIGN_VALUES: Readonly<
  Record<PublicAnalyticsCampaignProperty, readonly string[]>
> = {
  utm_source: [
    "github",
    "hackernews",
    "reddit",
    "x",
    "linkedin",
    "producthunt",
    "newsletter",
    "google",
  ],
  utm_medium: ["social", "community", "email", "referral", "cpc"],
  utm_campaign: ["launch"],
}

const REFERRAL_SOURCES: Readonly<Record<string, string>> = {
  "github.com": "github",
  "news.ycombinator.com": "hackernews",
  "reddit.com": "reddit",
  "x.com": "x",
  "t.co": "x",
  "twitter.com": "x",
  "linkedin.com": "linkedin",
  "producthunt.com": "producthunt",
  "google.com": "google",
}
const ACQUISITION_SOURCES = [
  ...ACTIVE_CAMPAIGN_VALUES.utm_source,
  "other_referral",
  "direct_or_unknown",
  "internal_unknown",
]

export function publicAcquisitionProperties(
  search: string,
  referringDomain: string | undefined
): Record<string, string> {
  const campaign = approvedCampaignProperties(search)
  const params = new URLSearchParams(search)
  const inherited = params.get("wt_source") ?? ""
  const domain = referringDomain?.toLowerCase().replace(/^www\./, "") ?? ""
  const referral =
    (Object.hasOwn(REFERRAL_SOURCES, domain)
      ? REFERRAL_SOURCES[domain]
      : undefined) ??
    (!domain
      ? "direct_or_unknown"
      : ["worktable.dev", "worktable.cloud", "docs.worktable.dev"].includes(
            domain
          )
        ? "internal_unknown"
        : "other_referral")
  return {
    ...campaign,
    acquisition_source:
      campaign.utm_source ??
      (ACQUISITION_SOURCES.includes(inherited) ? inherited : referral),
    ...(params.get("wt_test") === "1" ? { traffic_type: "verification" } : {}),
  }
}

export function publicAnalyticsCta(
  ctaId: PublicAnalyticsCtaId,
  placement: PublicAnalyticsPlacement
) {
  return {
    [PUBLIC_ANALYTICS_CTA_ATTRIBUTE]: ctaId,
    [PUBLIC_ANALYTICS_PLACEMENT_ATTRIBUTE]: placement,
  }
}

export type PublicInstallCommandId = "self_host_install" | "cli_install"
export type PublicInstallCopyPlacement = "deployment_card" | "docs_start"

export const PUBLIC_INSTALL_COMMAND =
  "curl -fsSL https://worktable.dev/install | sh"

export function isApprovedInstallCopy(
  commandId: unknown,
  placement: unknown,
  surface: PublicSiteSurface,
  pathname: string
): boolean {
  return (
    (commandId === "self_host_install" &&
      placement === "deployment_card" &&
      surface === "worktable_dev" &&
      pathname === "/") ||
    (commandId === "cli_install" &&
      placement === "docs_start" &&
      surface === "worktable_docs" &&
      pathname === "/start/install")
  )
}

const SAFE_PATH = /^\/(?:[a-z0-9][a-z0-9/_-]*\/?)?$/
const MAX_RAW_USER_AGENT_LENGTH = 1000

export function normalizePublicAnalyticsPathname(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname
}

export function productionHostForSurface(
  siteSurface: PublicSiteSurface
): string {
  return PRODUCTION_HOST_BY_SURFACE[siteSurface]
}

export function isPublicAnalyticsPathAllowed(
  config: Pick<PublicAnalyticsConfig, "allowedPathnames">,
  pathname: string
): boolean {
  if (
    pathname.length === 0 ||
    pathname.length > 256 ||
    !SAFE_PATH.test(pathname)
  ) {
    return false
  }

  const normalized = normalizePublicAnalyticsPathname(pathname)
  return config.allowedPathnames.includes(normalized)
}

export function isPublicAnalyticsContextAllowed(
  config: Pick<PublicAnalyticsConfig, "siteSurface" | "allowedPathnames">,
  location: Pick<Location, "hostname" | "pathname" | "search">
): boolean {
  if (location.hostname !== productionHostForSurface(config.siteSurface)) {
    return false
  }
  if (!isPublicAnalyticsPathAllowed(config, location.pathname)) {
    return false
  }

  if (config.siteSurface === "worktable_cloud") {
    const search = new URLSearchParams(location.search)
    if (search.get("from") === "logout") return false
    const environment = search.get("environment")
    if (environment !== null && environment !== "production") return false
  }

  return true
}

export function isDoNotTrackEnabled(
  navigatorLike: Pick<Navigator, "doNotTrack"> & {
    msDoNotTrack?: string | null
  },
  windowLike: { doNotTrack?: string | null }
): boolean {
  return [
    navigatorLike.doNotTrack,
    navigatorLike.msDoNotTrack,
    windowLike.doNotTrack,
  ].some((value) => value === "1" || value === "yes")
}

export function isApprovedCta(
  ctaId: string,
  placement: string
): ctaId is PublicAnalyticsCtaId {
  if (!Object.hasOwn(CTA_PLACEMENTS, ctaId)) return false
  return CTA_PLACEMENTS[ctaId as PublicAnalyticsCtaId].includes(
    placement as PublicAnalyticsPlacement
  )
}

export function createPublicAnalyticsEarlyCtaScript(
  config: Pick<
    PublicAnalyticsConfig,
    "projectToken" | "siteSurface" | "allowedPathnames" | "apiHost"
  >
): string {
  if (!config.projectToken) return ""

  const runtimeConfig = serializeForInlineScript({
    projectToken: config.projectToken,
    siteSurface: config.siteSurface,
    productionHost: productionHostForSurface(config.siteSurface),
    allowedPathnames: [...new Set(config.allowedPathnames)],
    apiHost: (config.apiHost ?? PUBLIC_ANALYTICS_API_HOST).replace(/\/+$/, ""),
  })
  const ctaPlacements = serializeForInlineScript(CTA_PLACEMENTS)
  const activeCampaignValues = serializeForInlineScript(ACTIVE_CAMPAIGN_VALUES)
  const preferenceKey = serializeForInlineScript(
    PUBLIC_ANALYTICS_PREFERENCE_KEY
  )
  const ctaAttribute = serializeForInlineScript(PUBLIC_ANALYTICS_CTA_ATTRIBUTE)
  const placementAttribute = serializeForInlineScript(
    PUBLIC_ANALYTICS_PLACEMENT_ATTRIBUTE
  )

  return `(() => {
    "use strict";
    if (window.__worktablePublicAnalyticsCtaInstalled) return;
    window.__worktablePublicAnalyticsCtaInstalled = true;

    const config = ${runtimeConfig};
    const ctaPlacements = ${ctaPlacements};
    const activeCampaignValues = ${activeCampaignValues};
    const referralSources = ${serializeForInlineScript(REFERRAL_SOURCES)};
    const acquisitionSources = ${serializeForInlineScript(ACQUISITION_SOURCES)};
    const preferenceKey = ${preferenceKey};
    const ctaAttribute = ${ctaAttribute};
    const placementAttribute = ${placementAttribute};

    function normalizedPathname() {
      const pathname = window.location.pathname;
      return pathname.length > 1 ? pathname.replace(/\\/+$/, "") : pathname;
    }

    function doNotTrackEnabled() {
      return [navigator.doNotTrack, navigator.msDoNotTrack, window.doNotTrack]
        .some((value) => value === "1" || value === "yes");
    }

    function optedOut() {
      if (window.__worktablePublicAnalyticsDocumentOptOut === true) return true;
      try {
        return window.localStorage.getItem(preferenceKey) === "off";
      } catch {
        return false;
      }
    }

    function contextAllowed() {
      if (window.location.hostname !== config.productionHost) return false;
      if (!config.allowedPathnames.includes(normalizedPathname())) return false;
      if (config.siteSurface === "worktable_cloud") {
        const search = new URLSearchParams(window.location.search);
        if (search.get("from") === "logout") return false;
        const environment = search.get("environment");
        if (environment !== null && environment !== "production") return false;
      }
      return !doNotTrackEnabled() && !optedOut();
    }

    function referringDomain() {
      if (!document.referrer) return undefined;
      try {
        const hostname = new URL(document.referrer).hostname.toLowerCase();
        if (hostname.length === 0 || hostname.length > 253) return undefined;
        if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)) return undefined;
        if (hostname.split(".").some((label) => label.length === 0 || label.length > 63)) {
          return undefined;
        }
        return hostname;
      } catch {
        return undefined;
      }
    }

    function commonProperties() {
      const rawUserAgent = navigator.userAgent;
      if (typeof rawUserAgent !== "string" || rawUserAgent.length === 0) return undefined;
      const properties = {
        token: config.projectToken,
        distinct_id: "$posthog_cookieless",
        $cookieless_mode: true,
        $process_person_profile: false,
        $geoip_disable: true,
        analytics_schema_version: ${PUBLIC_ANALYTICS_SCHEMA_VERSION},
        site_surface: config.siteSurface,
        $host: window.location.hostname,
        $pathname: normalizedPathname(),
        // PostHog uses this transiently for its cookieless server hash and
        // removes it before the event is retained.
        $raw_user_agent: rawUserAgent.length > ${MAX_RAW_USER_AGENT_LENGTH}
          ? rawUserAgent.slice(0, ${MAX_RAW_USER_AGENT_LENGTH - 3}) + "..."
          : rawUserAgent,
      };
      const referrer = referringDomain();
      if (referrer) properties.$referring_domain = referrer;
      const search = new URLSearchParams(window.location.search);
      for (const key of Object.keys(activeCampaignValues)) {
        const value = search.get(key);
        if (value && value.length <= 100 && activeCampaignValues[key].includes(value)) {
          properties[key] = value;
        }
      }
      const inherited = search.get("wt_source");
      const domain = (referrer || "").replace(/^www\\./, "");
      const referral = (Object.hasOwn(referralSources, domain) ? referralSources[domain] : undefined) || (!domain ? "direct_or_unknown" :
        ["worktable.dev", "worktable.cloud", "docs.worktable.dev"].includes(domain)
          ? "internal_unknown" : "other_referral");
      properties.acquisition_source = properties.utm_source ||
        (acquisitionSources.includes(inherited) ? inherited : referral);
      if (search.get("wt_test") === "1") properties.traffic_type = "verification";
      return properties;
    }

    function sendEvent(event, properties) {
      const captured = {
        event,
        properties,
        timestamp: new Date().toISOString(),
      };
      if (typeof crypto.randomUUID === "function") captured.uuid = crypto.randomUUID();
      const body = {
        api_key: config.projectToken,
        batch: [captured],
        sent_at: new Date().toISOString(),
      };

      try {
        const encoded = btoa(JSON.stringify(body));
        const beaconBody = new Blob(["data=" + encodeURIComponent(encoded)], {
          type: "application/x-www-form-urlencoded",
        });
        return navigator.sendBeacon(config.apiHost + "/e/?compression=base64", beaconBody);
      } catch {
        // Analytics must never interfere with the page or destination action.
        return false;
      }
    }

    if (contextAllowed()) {
      const properties = commonProperties();
      if (properties) {
        const pageviewKey = window.location.hostname + normalizedPathname();
        if (sendEvent("$pageview", properties)) {
          window.__worktablePublicAnalyticsEarlyPageviewKey = pageviewKey;
        }
      }
    }

    function captureClick(event) {
      if (event.type === "auxclick" && event.button !== 1) return;
      if (!contextAllowed() || !(event.target instanceof Element)) return;
      const common = commonProperties();
      if (!common) return;
      // Preserve only bounded, non-identifying labels through public navigation.
      // Download artifacts and same-page anchors must retain their original URLs.
      const anchor = event.target.closest("a[href]");
      if (anchor instanceof HTMLAnchorElement) {
        const destination = new URL(anchor.href, window.location.href);
        const publicPage =
          ["www.worktable.dev", "www.worktable.cloud", "docs.worktable.dev"].includes(destination.hostname) &&
          !destination.pathname.startsWith("/releases/") &&
          !["/install", "/install-skills"].includes(destination.pathname);
        const signup = destination.hostname === "app.worktable.cloud" &&
          destination.pathname.replace(/\\/+$/, "") === "/signup";
        const samePage = destination.origin === window.location.origin &&
          destination.pathname === window.location.pathname && destination.hash;
        if (destination.protocol === "https:" && !samePage && (publicPage || signup)) {
          // Explicit destination campaigns take precedence over inherited ones.
          if (!destination.searchParams.has("utm_source")) {
            for (const key of Object.keys(activeCampaignValues)) {
              if (common[key] && !destination.searchParams.has(key)) destination.searchParams.set(key, common[key]);
            }
            destination.searchParams.set("wt_source", common.acquisition_source);
          }
          if (common.traffic_type === "verification") destination.searchParams.set("wt_test", "1");
          anchor.href = destination.href;
        }
      }
      const tracked = event.target.closest("[" + ctaAttribute + "]");
      if (!tracked) return;
      const ctaId = tracked.getAttribute(ctaAttribute);
      const placement = tracked.getAttribute(placementAttribute);
      if (!ctaId || !placement || !Object.hasOwn(ctaPlacements, ctaId) || !ctaPlacements[ctaId].includes(placement)) return;
      const properties = { ...common, cta_id: ctaId, placement };
      sendEvent("marketing:cta_click", properties);
    }
    document.addEventListener("click", captureClick, true);
    document.addEventListener("auxclick", captureClick, true);
  })();`
}

export function approvedCampaignProperties(
  search: string
): Record<string, string> {
  const params = new URLSearchParams(search)
  const properties: Record<string, string> = {}

  for (const key of Object.keys(ACTIVE_CAMPAIGN_VALUES) as Array<
    keyof typeof ACTIVE_CAMPAIGN_VALUES
  >) {
    const value = params.get(key)
    if (
      value &&
      value.length <= 100 &&
      ACTIVE_CAMPAIGN_VALUES[key].includes(value)
    ) {
      properties[key] = value
    }
  }

  return properties
}

export function sanitizePublicAnalyticsEvent(
  event: PublicAnalyticsEvent | null,
  config: Pick<
    PublicAnalyticsConfig,
    "projectToken" | "siteSurface" | "allowedPathnames"
  >,
  location: Pick<Location, "hostname" | "pathname" | "search">
): PublicAnalyticsEvent | null {
  if (!event || !config.projectToken) return null
  if (!isPublicAnalyticsContextAllowed(config, location)) return null
  if (
    event.event !== "$pageview" &&
    event.event !== "marketing:cta_click" &&
    event.event !== "marketing:install_command_copy"
  ) {
    return null
  }

  const pathname = normalizePublicAnalyticsPathname(location.pathname)
  const source = event.properties ?? {}
  if (
    source.analytics_schema_version !== PUBLIC_ANALYTICS_SCHEMA_VERSION ||
    source.site_surface !== config.siteSurface ||
    source.$host !== location.hostname ||
    source.$pathname !== pathname
  ) {
    return null
  }

  const properties: Record<string, unknown> = {
    token: config.projectToken,
    distinct_id: "$posthog_cookieless",
    $cookieless_mode: true,
    $process_person_profile: false,
    $geoip_disable: true,
    analytics_schema_version: PUBLIC_ANALYTICS_SCHEMA_VERSION,
    site_surface: config.siteSurface,
    $host: location.hostname,
    $pathname: pathname,
  }

  const rawUserAgent = source.$raw_user_agent
  if (typeof rawUserAgent !== "string" || rawUserAgent.length === 0) {
    return null
  }
  // This is required by PostHog's cookieless ingestion protocol. PostHog
  // removes it before retaining the event, so it is not an analytics dimension.
  properties.$raw_user_agent =
    rawUserAgent.length > MAX_RAW_USER_AGENT_LENGTH
      ? `${rawUserAgent.slice(0, MAX_RAW_USER_AGENT_LENGTH - 3)}...`
      : rawUserAgent

  copyHostname(source, properties, "$referring_domain")
  const acquisitionSource = source.acquisition_source
  if (
    typeof acquisitionSource === "string" &&
    ACQUISITION_SOURCES.includes(acquisitionSource)
  ) {
    properties.acquisition_source = acquisitionSource
  }
  if (source.traffic_type === "verification")
    properties.traffic_type = "verification"
  copyExactString(source, properties, "$os", 64)
  copyExactString(source, properties, "$device_type", 64)
  copyExactString(source, properties, "$lib", 64)
  copyExactString(source, properties, "$lib_version", 32)
  copyExactString(source, properties, "$config_defaults", 32)

  for (const key of Object.keys(ACTIVE_CAMPAIGN_VALUES) as Array<
    keyof typeof ACTIVE_CAMPAIGN_VALUES
  >) {
    const value = source[key]
    if (
      typeof value === "string" &&
      ACTIVE_CAMPAIGN_VALUES[key].includes(value)
    ) {
      properties[key] = value
    }
  }

  if (event.event === "marketing:cta_click") {
    const ctaId = source.cta_id
    const placement = source.placement
    if (
      typeof ctaId !== "string" ||
      typeof placement !== "string" ||
      !isApprovedCta(ctaId, placement)
    ) {
      return null
    }
    properties.cta_id = ctaId
    properties.placement = placement
  }

  if (event.event === "marketing:install_command_copy") {
    if (
      !isApprovedInstallCopy(
        source.command_id,
        source.placement,
        config.siteSurface,
        pathname
      )
    ) {
      return null
    }
    properties.command_id = source.command_id
    properties.placement = source.placement
  }

  return {
    uuid: event.uuid,
    event: event.event,
    properties,
    timestamp: event.timestamp,
  }
}

function copyHostname(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string
) {
  const value = source[key]
  if (typeof value !== "string") return
  const hostname = value.toLowerCase()
  if (hostname.length === 0 || hostname.length > 253) return
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(hostname)) return
  if (
    hostname.split(".").some((label) => label.length === 0 || label.length > 63)
  )
    return
  target[key] = hostname
}

function copyExactString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  maxLength: number
) {
  const value = source[key]
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
  ) {
    target[key] = value
  }
}

function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
}
