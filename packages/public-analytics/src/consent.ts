import {
  ANALYTICS_CONSENT_COOKIE,
  ANALYTICS_CONSENT_VERSION,
  parseAnalyticsCookie,
  parseAnalyticsPreference,
  type AnalyticsPreference,
} from "@worktable/types/analytics"
import {
  isDoNotTrackEnabled,
  PUBLIC_ANALYTICS_PREFERENCE_EVENT,
  PUBLIC_ANALYTICS_PREFERENCE_KEY,
} from "./index"

let documentPreference: AnalyticsPreference | null = null

export interface AnalyticsChoice {
  enabled: boolean
  doNotTrack: boolean
  decided: boolean
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
  return stored ?? documentPreference ?? storedLocally
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

export function getPublicAnalyticsChoice(): AnalyticsChoice {
  const doNotTrack = isDoNotTrackEnabled(
    navigator,
    window as Window & { doNotTrack?: string | null }
  )
  const preference = getBrowserAnalyticsPreference()
  return {
    enabled: !doNotTrack && preference?.enabled === true,
    doNotTrack,
    decided: preference !== null,
  }
}

export function setBrowserAnalyticsPreference(
  value: AnalyticsPreference
): void {
  const preference = parseAnalyticsPreference(value)
  if (!preference) return
  documentPreference = preference
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

export function subscribeToPublicAnalyticsChoice(
  listener: () => void
): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PUBLIC_ANALYTICS_PREFERENCE_KEY) return
    documentPreference = null
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
