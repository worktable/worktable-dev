import {
  ANALYTICS_CONSENT_COOKIE,
  ANALYTICS_CONSENT_VERSION,
  parseAnalyticsCookie,
  parseAnalyticsPreference,
  type AnalyticsPreference,
} from "@worktable/types/analytics"
import {
  isPrivacySignalEnabled,
  PUBLIC_ANALYTICS_PREFERENCE_EVENT,
  PUBLIC_ANALYTICS_PREFERENCE_KEY,
} from "./index"
import { analyticsRegionRequiresConsent } from "./region"

// This document's latest choice, for browsers that refuse cookies and storage.
const documentPreferences = new WeakMap<Document, AnalyticsPreference>()
const locationAllowsDefault = new WeakMap<Document, boolean>()

export interface AnalyticsChoice {
  /** Analytics cookies and a persistent visitor ID are allowed. */
  enabled: boolean
  /** The browser sends Do Not Track or Global Privacy Control. */
  privacySignal: boolean
  /** The visitor has made an explicit choice. */
  decided: boolean
  /** The visitor's location requires a choice before analytics cookies. */
  consentRequired: boolean
}

export function getBrowserAnalyticsPreference(): AnalyticsPreference | null {
  let storedLocally: AnalyticsPreference | null = null
  // Keep an old explicit opt-out authoritative until a new choice is made.
  try {
    const value = localStorage.getItem(PUBLIC_ANALYTICS_PREFERENCE_KEY)
    if (value === "off") {
      return {
        version: ANALYTICS_CONSENT_VERSION,
        enabled: false,
        updatedAt: 0,
      }
    }
    if (value && value.length <= 512)
      storedLocally = parseAnalyticsPreference(JSON.parse(value))
  } catch {
    /* Storage is optional. */
  }
  const stored = parseAnalyticsCookie(document.cookie)
  // The shared cookie reflects the latest choice on another Cloud subdomain.
  // Local storage and memory preserve a choice when cookies are unavailable.
  return stored ?? documentPreferences.get(document) ?? storedLocally
}

export function migrateLegacyAnalyticsPreference(): void {
  try {
    if (localStorage.getItem(PUBLIC_ANALYTICS_PREFERENCE_KEY) === "off") {
      setBrowserAnalyticsPreference({
        version: ANALYTICS_CONSENT_VERSION,
        enabled: false,
        updatedAt: Date.now(),
      })
    }
  } catch {
    /* Storage is optional; the legacy refusal is still read above. */
  }
}

function privacySignalEnabled(): boolean {
  return isPrivacySignalEnabled(
    navigator as Navigator & { globalPrivacyControl?: unknown },
    window as Window & { doNotTrack?: string | null }
  )
}

/**
 * Public sites. An explicit choice always wins; without one, cookies start
 * unless the routing layer marked the location as requiring consent.
 * Read the signal once per document so a long visit cannot change modes.
 */
export function getPublicAnalyticsChoice(): AnalyticsChoice {
  const privacySignal = privacySignalEnabled()
  const preference = getBrowserAnalyticsPreference()
  let allowsDefault = locationAllowsDefault.get(document)
  if (allowsDefault === undefined) {
    allowsDefault = !analyticsRegionRequiresConsent(document.cookie)
    locationAllowsDefault.set(document, allowsDefault)
  }
  return {
    enabled:
      !privacySignal && (preference ? preference.enabled : allowsDefault),
    privacySignal,
    decided: preference !== null,
    consentRequired: !allowsDefault,
  }
}

/** Cloud product analytics is on unless this browser refused it or sends a privacy signal. */
export function isProductAnalyticsAllowed(): boolean {
  return (
    !privacySignalEnabled() &&
    getBrowserAnalyticsPreference()?.enabled !== false
  )
}

export function setBrowserAnalyticsPreference(
  value: AnalyticsPreference
): void {
  const preference = parseAnalyticsPreference(value)
  if (!preference) return
  documentPreferences.set(document, preference)
  const domain =
    location.hostname === "worktable.cloud" ||
    location.hostname.endsWith(".worktable.cloud")
      ? "; Domain=worktable.cloud"
      : ""
  document.cookie = `${ANALYTICS_CONSENT_COOKIE}=${encodeURIComponent(JSON.stringify(preference))}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}${domain}`
  try {
    localStorage.setItem(
      PUBLIC_ANALYTICS_PREFERENCE_KEY,
      JSON.stringify(preference)
    )
  } catch {
    /* The document choice still works when storage is unavailable. */
  }
  window.dispatchEvent(new Event(PUBLIC_ANALYTICS_PREFERENCE_EVENT))
}

export function setPublicAnalyticsEnabled(enabled: boolean): void {
  setBrowserAnalyticsPreference({
    version: ANALYTICS_CONSENT_VERSION,
    enabled,
    updatedAt: Date.now(),
  })
}

export function clearBrowserAnalyticsIdentity(projectToken: string): void {
  const key = `ph_${projectToken}_posthog`
  try {
    for (const storage of [localStorage, sessionStorage]) {
      for (const storedKey of Object.keys(storage))
        if (storedKey.startsWith(`ph_${projectToken}`))
          storage.removeItem(storedKey)
    }
  } catch {
    /* Optional storage. */
  }
  for (const domain of [
    "",
    "; Domain=worktable.cloud",
    "; Domain=worktable.dev",
  ]) {
    document.cookie = `${key}=; Path=/; Max-Age=0; SameSite=Lax${domain}`
  }
}

/** Removes every analytics value a cookie-using version of a site stored. */
export function clearStoredAnalytics(projectToken: string): void {
  clearBrowserAnalyticsIdentity(projectToken)
  try {
    for (const storage of [localStorage, sessionStorage])
      for (const key of [
        PUBLIC_ANALYTICS_PREFERENCE_KEY,
        `__ph_opt_in_out_${projectToken}`,
      ])
        storage.removeItem(key)
  } catch {
    /* Optional storage. */
  }
  for (const key of [
    ANALYTICS_CONSENT_COOKIE,
    `__ph_opt_in_out_${projectToken}`,
  ])
    document.cookie = `${key}=; Path=/; Max-Age=0; SameSite=Lax`
}

export function subscribeToPublicAnalyticsChoice(
  listener: () => void
): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PUBLIC_ANALYTICS_PREFERENCE_KEY) return
    documentPreferences.delete(document)
    listener()
  }
  const onVisibility = () => {
    if (document.visibilityState === "visible") listener()
  }
  window.addEventListener(PUBLIC_ANALYTICS_PREFERENCE_EVENT, listener)
  window.addEventListener("storage", onStorage)
  document.addEventListener("visibilitychange", onVisibility)
  return () => {
    window.removeEventListener(PUBLIC_ANALYTICS_PREFERENCE_EVENT, listener)
    window.removeEventListener("storage", onStorage)
    document.removeEventListener("visibilitychange", onVisibility)
  }
}
