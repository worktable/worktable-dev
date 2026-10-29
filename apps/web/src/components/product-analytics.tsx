import { useEffect } from "react"
import { getAnalyticsContext } from "@/lib/analytics"
import { onBrowserLogout } from "@/lib/auth-events"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"

/** The SDK is loaded only after authenticated Cloud configuration is present. */
export function ProductAnalytics() {
  const cloud = useDeploymentInfo().data?.capabilities.analyticsChoice === true
  useEffect(() => {
    if (!cloud) return
    let disposed = false
    let busy = false
    let stop: (() => void) | undefined
    let eligible = false
    const stopAnalytics = () => {
      eligible = false
      stop?.()
    }
    const sync = async () => {
      if (busy || disposed || document.visibilityState !== "visible") return
      busy = true
      try {
        let context = await getAnalyticsContext()
        if (!context || disposed) {
          stopAnalytics()
          return
        }
        const consent = await import("@worktable/public-analytics/consent")
        consent.migrateLegacyAnalyticsPreference()
        const local = consent.getBrowserAnalyticsPreference()
        if (!context.preference && local)
          context = await getAnalyticsContext({
            enabled: local.enabled,
            initialOnly: true,
          })
        if (!context || disposed) return
        if (
          context.preference?.enabled === false ||
          (context.preference &&
            (!local || context.preference.updatedAt > local.updatedAt))
        )
          consent.setBrowserAnalyticsPreference(context.preference)
        // On unless the account refused it or the browser sends Do Not Track
        // or Global Privacy Control.
        if (
          context.preference?.enabled === false ||
          !context.projectToken ||
          !context.apiHost ||
          !consent.isProductAnalyticsAllowed()
        ) {
          stopAnalytics()
          if (context.projectToken)
            consent.clearBrowserAnalyticsIdentity(context.projectToken)
          return
        }
        const analytics = await import("@worktable/public-analytics/product")
        stop = analytics.stopProductAnalytics
        if (!disposed) {
          analytics.startProductAnalytics({
            ...context,
            projectToken: context.projectToken,
            apiHost: context.apiHost,
          })
          if (!eligible) {
            eligible = true
            window.dispatchEvent(new Event("worktable:analytics-enabled"))
          }
        }
      } catch {
        stopAnalytics()
      } finally {
        busy = false
      }
    }
    void sync()
    const timer = setInterval(() => void sync(), 45_000)
    const visible = () => void sync()
    window.addEventListener("worktable:analytics-stop", stopAnalytics)
    window.addEventListener("worktable:account-analytics-preference", visible)
    document.addEventListener("visibilitychange", visible)
    const unsubscribe = onBrowserLogout(stopAnalytics)
    return () => {
      disposed = true
      clearInterval(timer)
      unsubscribe()
      stopAnalytics()
      window.removeEventListener("worktable:analytics-stop", stopAnalytics)
      document.removeEventListener("visibilitychange", visible)
      window.removeEventListener(
        "worktable:account-analytics-preference",
        visible
      )
    }
  }, [cloud])
  return null
}
