/** Content-free analytics contract. This module must remain runtime independent. */
export const ANALYTICS_SCHEMA_VERSION = 3 as const
export const ANALYTICS_CONSENT_VERSION = 1 as const
export const ANALYTICS_CONSENT_COOKIE = "wt_analytics"
export const ANALYTICS_GRANT_TTL_MS = 60_000

export interface AnalyticsPreference {
  version: typeof ANALYTICS_CONSENT_VERSION
  enabled: boolean
  updatedAt: number
}

export function parseAnalyticsPreference(
  value: unknown
): AnalyticsPreference | null {
  if (typeof value !== "object" || value === null) return null
  const preference = value as Record<string, unknown>
  if (
    preference.version !== ANALYTICS_CONSENT_VERSION ||
    typeof preference.enabled !== "boolean" ||
    typeof preference.updatedAt !== "number" ||
    !Number.isSafeInteger(preference.updatedAt) ||
    preference.updatedAt < 0
  )
    return null
  return {
    version: ANALYTICS_CONSENT_VERSION,
    enabled: preference.enabled,
    updatedAt: preference.updatedAt,
  }
}

export function parseAnalyticsCookie(
  cookie: string
): AnalyticsPreference | null {
  const value = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${ANALYTICS_CONSENT_COOKIE}=`))
    ?.slice(ANALYTICS_CONSENT_COOKIE.length + 1)
  if (!value || value.length > 512) return null
  try {
    return parseAnalyticsPreference(JSON.parse(decodeURIComponent(value)))
  } catch {
    return null
  }
}

export type AnalyticsActorType = "human" | "agent" | "multiple"

/** The app an agent connects through, read from its verified OAuth client. */
export const ANALYTICS_CLIENTS = [
  "chatgpt",
  "claude",
  "claude_code",
  "codex",
  "cursor",
  "grok",
  "hermes",
  "openclaw",
  "other",
] as const
export type AnalyticsClient = (typeof ANALYTICS_CLIENTS)[number]
export const ANALYTICS_CLIENT_NAMES: Readonly<Record<AnalyticsClient, string>> =
  {
    chatgpt: "ChatGPT",
    claude: "Claude",
    claude_code: "Claude Code",
    codex: "Codex",
    cursor: "Cursor",
    grok: "Grok",
    hermes: "Hermes",
    openclaw: "OpenClaw",
    other: "Other",
  }
export function isAnalyticsClient(value: unknown): value is AnalyticsClient {
  return (ANALYTICS_CLIENTS as readonly unknown[]).includes(value)
}
export type AnalyticsSurface = "web" | "desktop_cloud" | "mcp" | "api"
export interface AnalyticsGrant {
  /** Verified principal, never a browser supplied analytics ID. */
  distinctId: string
  consentSubject: string
  actorType: "human" | "agent"
  expiresAt: number
  surface: AnalyticsSurface
  trafficType?: "internal" | "verification"
  /** The app an agent connects through; people have none. */
  client?: AnalyticsClient
}

export function analyticsTrafficType(
  subject: string,
  internalSubjects = "",
  verificationSubjects = ""
): "internal" | "verification" | undefined {
  if (verificationSubjects.split(",").some((value) => value.trim() === subject))
    return "verification"
  if (internalSubjects.split(",").some((value) => value.trim() === subject))
    return "internal"
  return undefined
}

export const PRODUCT_ANALYTICS_EVENTS = [
  "account:created",
  "worktable:created",
  "worktable:ready",
  "product:opened",
  "product:work_saved",
  "$mcp_tool_call",
  "billing:subscription_changed",
  "billing:payment_succeeded",
] as const
export type ProductAnalyticsEvent = (typeof PRODUCT_ANALYTICS_EVENTS)[number]

/** No arbitrary strings or content may be added to this envelope. */
export interface ProductAnalyticsProperties {
  worktable_id?: string
  actor_type: AnalyticsActorType
  surface?: AnalyticsSurface
  content_type?: "document" | "html" | "record"
  operation?: string
  tool?: string
  outcome?: "success" | "error" | "denied"
  duration_ms?: number
  plan?: "solo" | "team" | "business"
  hosting?: "hosted" | "linked"
  change?: "activated" | "plan_changed" | "cancellation_requested" | "ended"
  amount?: number
  currency?: "usd"
  transaction_id?: string
  traffic_type?: "verification" | "internal"
}
