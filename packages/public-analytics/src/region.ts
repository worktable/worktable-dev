/**
 * worktable.cloud asks visitors in the shared consent regions before analytics
 * cookies are set. Vercel routing marks those locations with a non-identifying
 * cookie, re-set on every document and kept for 30 days so an expired marker or
 * a cached page never starts cookies for a visitor who should be asked. Every
 * other location, including an unknown or missing one, starts with analytics.
 */
import {
  CONSENT_REQUIRED_COUNTRIES,
  CONSENT_REQUIRED_SUBDIVISIONS,
} from "@worktable/hosted-contract/analytics-region"

export {
  CONSENT_REQUIRED_COUNTRIES,
  CONSENT_REQUIRED_SUBDIVISIONS,
  isConsentRequiredLocation,
} from "@worktable/hosted-contract/analytics-region"

export const ANALYTICS_REGION_COOKIE = "wt_analytics_region"
export const ANALYTICS_REGION_CONSENT = "consent"

/** The document cookie the routing layer writes for consent locations. */
export function analyticsRegionRequiresConsent(cookie: string): boolean {
  return cookie
    .split(";")
    .some(
      (part) =>
        part.trim() === `${ANALYTICS_REGION_COOKIE}=${ANALYTICS_REGION_CONSENT}`
    )
}

/**
 * The Vercel `headers` rules a cookie-using public site deploys. Generated into
 * its vercel.json by `bun run generate:analytics-regions`; a test fails
 * when they drift.
 */
export function analyticsRegionHeaderRules() {
  // Documents only; hashed build assets never need the signal.
  const source = "/:path((?!assets/|_astro/|pagefind/).*)"
  const headers = [
    {
      key: "Set-Cookie",
      value: `${ANALYTICS_REGION_COOKIE}=${ANALYTICS_REGION_CONSENT}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`,
    },
  ]
  return [
    {
      source,
      has: [
        {
          type: "header",
          key: "x-vercel-ip-country",
          value: { inc: [...CONSENT_REQUIRED_COUNTRIES] },
        },
      ],
      headers,
    },
    ...Object.entries(CONSENT_REQUIRED_SUBDIVISIONS).map(
      ([country, subdivisions]) => ({
        source,
        has: [
          {
            type: "header",
            key: "x-vercel-ip-country",
            value: { eq: country },
          },
          {
            type: "header",
            key: "x-vercel-ip-country-region",
            value: { inc: [...subdivisions] },
          },
        ],
        headers,
      })
    ),
  ]
}

/**
 * Sites that deploy the rules, relative to the repository root, when present.
 * Docs never use analytics cookies, so they need no region signal.
 */
export const ANALYTICS_REGION_SITES = ["apps/landing-cloud/vercel.json"]

/** Region rules are recognized in vercel.json by the cookie they set. */
export function isAnalyticsRegionHeaderRule(rule: unknown): boolean {
  return JSON.stringify(rule).includes(`${ANALYTICS_REGION_COOKIE}=`)
}
