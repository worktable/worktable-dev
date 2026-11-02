import { useEffect } from "react"
import { getAnalyticsContext } from "@/lib/analytics"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"

// PUBLIC_ANALYTICS_PREFERENCE_KEY, without loading the website collector here.
const PREFERENCE_KEY = "worktable.public-analytics"

function hasStoredChoice(): boolean {
  if (document.cookie.includes("wt_analytics=")) return true
  try {
    return localStorage.getItem(PREFERENCE_KEY) !== null
  } catch {
    return false
  }
}

/**
 * A refusal this browser made, on the website or in an earlier version of the
 * app, becomes the account's choice when the account has none yet. Once per
 * load, and only when the browser holds a choice; nothing is counted here.
 */
export function BrowserAnalyticsChoice() {
  const cloud = useDeploymentInfo().data?.capabilities.analyticsChoice === true
  useEffect(() => {
    if (!cloud || !hasStoredChoice()) return
    void (async () => {
      const consent = await import("@worktable/public-analytics/consent")
      consent.migrateLegacyAnalyticsPreference()
      if (consent.getBrowserAnalyticsPreference()?.enabled !== false) return
      const account = await getAnalyticsContext()
      if (account && !account.preference)
        await getAnalyticsContext({ enabled: false, initialOnly: true })
    })().catch(() => undefined)
  }, [cloud])
  return null
}
