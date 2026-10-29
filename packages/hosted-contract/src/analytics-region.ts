/**
 * Where people are asked before analytics cookies are set, and where a new
 * Cloud account starts with product analytics off. Shared by the public sites,
 * the Cloud gateway and the control plane so there is one list.
 *
 * After editing the list, run `bun run generate:analytics-regions` to rewrite
 * the worktable.cloud vercel.json rules.
 */
export const CONSENT_REQUIRED_COUNTRIES = [
  // European Union, including territories GeoIP reports under their own code.
  "AT",
  "AX",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GF",
  "GP",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MF",
  "MQ",
  "MT",
  "NL",
  "PL",
  "PT",
  "RE",
  "RO",
  "SE",
  "SI",
  "SK",
  "YT",
  // Rest of the European Economic Area, the United Kingdom and Switzerland.
  "IS",
  "LI",
  "NO",
  "GB",
  "CH",
  // Crown Dependencies and Gibraltar, with their own data protection laws.
  "GG",
  "GI",
  "IM",
  "JE",
] as const

/** Subdivisions that require a choice inside an otherwise open country. */
export const CONSENT_REQUIRED_SUBDIVISIONS: Readonly<
  Record<string, readonly string[]>
> = { CA: ["QC"] }

export function isConsentRequiredLocation(
  country: string | null | undefined,
  subdivision?: string | null
): boolean {
  if ((CONSENT_REQUIRED_COUNTRIES as readonly string[]).includes(country ?? ""))
    return true
  return (
    !!country &&
    !!subdivision &&
    Object.hasOwn(CONSENT_REQUIRED_SUBDIVISIONS, country) &&
    CONSENT_REQUIRED_SUBDIVISIONS[country]!.includes(subdivision)
  )
}

/**
 * The Cloud gateway forwards a person's coarse location to the control plane
 * in this header, so a new account in a consent region starts with product
 * analytics off. Country and subdivision codes only; never stored.
 */
export const ANALYTICS_LOCATION_HEADER = "X-Worktable-Location"
/**
 * Set by the gateway to "1" when the request that may create an account sends
 * Do Not Track or Global Privacy Control. Never accepted from a client.
 */
export const ANALYTICS_PRIVACY_SIGNAL_HEADER = "X-Worktable-Privacy-Signal"

export interface AnalyticsLocation {
  country: string
  region?: string
}

export function formatAnalyticsLocation(
  country: unknown,
  region: unknown
): string | undefined {
  if (typeof country !== "string" || !/^[A-Z]{2}$/.test(country))
    return undefined
  return typeof region === "string" && /^[A-Z0-9]{1,3}$/.test(region)
    ? `${country}-${region}`
    : country
}

export function parseAnalyticsLocation(
  value: string | null | undefined
): AnalyticsLocation | undefined {
  const match = value ? /^([A-Z]{2})(?:-([A-Z0-9]{1,3}))?$/.exec(value) : null
  if (!match) return undefined
  return match[2]
    ? { country: match[1]!, region: match[2] }
    : { country: match[1]! }
}
