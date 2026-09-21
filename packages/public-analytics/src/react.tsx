import { useEffect, useState } from "react"
import { BarChart3 } from "lucide-react"

interface AnalyticsChoice {
  enabled: boolean
  doNotTrack: boolean
}

const INITIAL_CHOICE: AnalyticsChoice = { enabled: true, doNotTrack: false }

export function MarketingAnalyticsToggle() {
  const [choice, setChoice] = useState<AnalyticsChoice>(INITIAL_CHOICE)

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    void import("./browser").then((analytics) => {
      const sync = () => setChoice(analytics.getPublicAnalyticsChoice())
      sync()
      unsubscribe = analytics.subscribeToPublicAnalyticsChoice(sync)
    })
    return () => unsubscribe?.()
  }, [])

  const toggle = () => {
    if (choice.doNotTrack) return
    void import("./browser").then((analytics) => {
      analytics.setPublicAnalyticsEnabled(!choice.enabled)
      setChoice(analytics.getPublicAnalyticsChoice())
    })
  }

  const label = choice.doNotTrack
    ? "Anonymous analytics are off because your browser sends Do Not Track"
    : `Turn anonymous analytics ${choice.enabled ? "off" : "on"} for this site`

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={choice.doNotTrack}
      aria-pressed={choice.enabled}
      aria-label={label}
      title={label}
      className="inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-xs text-muted-foreground transition-colors hover:bg-surface-tint hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
    >
      <BarChart3 className="size-4" />
      Analytics {choice.enabled ? "on" : "off"}
    </button>
  )
}
