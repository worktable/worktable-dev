import { useEffect, useState } from "react"
import { BarChart3 } from "lucide-react"

interface AnalyticsChoice {
  enabled: boolean
  doNotTrack: boolean
  decided: boolean
}

const INITIAL_CHOICE: AnalyticsChoice = {
  enabled: false,
  doNotTrack: false,
  decided: true,
}

export function MarketingAnalyticsToggle() {
  const [choice, setChoice] = useState<AnalyticsChoice>(INITIAL_CHOICE)

  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void import("./browser").then((analytics) => {
      if (disposed) return
      const sync = () => setChoice(analytics.getPublicAnalyticsChoice())
      sync()
      unsubscribe = analytics.subscribeToPublicAnalyticsChoice(sync)
    })
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])

  const toggle = () => {
    if (choice.doNotTrack) return
    void import("./browser").then((analytics) => {
      analytics.setPublicAnalyticsEnabled(!choice.enabled)
      setChoice(analytics.getPublicAnalyticsChoice())
    })
  }

  const label = choice.doNotTrack
    ? "Analytics are off because your browser sends Do Not Track"
    : `Turn analytics ${choice.enabled ? "off" : "on"} for this site`

  return (
    <>
      {!choice.decided && !choice.doNotTrack && (
        <section
          aria-label="Analytics choice"
          className="overlay-floating fixed inset-x-4 bottom-4 z-50 mx-auto max-w-lg rounded-xl border border-border bg-card p-4 text-sm text-foreground"
        >
          <p>
            Help us improve Worktable? With your permission, we use analytics
            cookies to connect visits and product activity. We never collect
            your content.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn-key-outline rounded-lg px-3 py-2"
              onClick={() =>
                void import("./browser").then((analytics) =>
                  analytics.setPublicAnalyticsEnabled(true)
                )
              }
            >
              Allow analytics
            </button>
            <button
              type="button"
              className="btn-key-outline rounded-lg px-3 py-2"
              onClick={() =>
                void import("./browser").then((analytics) =>
                  analytics.setPublicAnalyticsEnabled(false)
                )
              }
            >
              Decline
            </button>
            <a className="text-primary-text underline" href="/privacy">
              Privacy
            </a>
          </div>
        </section>
      )}
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
    </>
  )
}
