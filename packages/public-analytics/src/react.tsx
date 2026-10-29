import { useEffect, useId, useRef, useState } from "react"
import type { AnalyticsChoice } from "./consent"

const INITIAL_CHOICE: AnalyticsChoice = {
  enabled: false,
  privacySignal: false,
  decided: true,
  consentRequired: false,
}

/** The visitor's current choice, kept in step with other tabs and settings. */
function useAnalyticsChoice() {
  const [choice, setChoice] = useState<AnalyticsChoice>(INITIAL_CHOICE)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void import("./browser").then((analytics) => {
      if (disposed) return
      const sync = () => setChoice(analytics.getPublicAnalyticsChoice())
      sync()
      setReady(true)
      unsubscribe = analytics.subscribeToPublicAnalyticsChoice(sync)
    })
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [])
  const choose = (enabled: boolean) =>
    void import("./browser").then((analytics) => {
      analytics.setPublicAnalyticsEnabled(enabled)
      setChoice(analytics.getPublicAnalyticsChoice())
    })
  return { choice, ready, choose }
}

/** Asks visitors in consent regions until they choose. Renders nothing otherwise. */
export function AnalyticsConsentBanner({
  choiceButtonClassName = "inline-flex h-9 items-center justify-center rounded-lg border border-border bg-card px-3 text-sm font-medium",
  privacyHref = "/privacy",
}: {
  /** The site's own outline button style for Allow and Decline. */
  choiceButtonClassName?: string
  privacyHref?: string
}) {
  const { choice, choose } = useAnalyticsChoice()
  const prompt = useRef<HTMLElement>(null)
  const asking =
    choice.consentRequired && !choice.decided && !choice.privacySignal

  // Reserve room below the page so the prompt never hides the footer.
  useEffect(() => {
    const element = prompt.current
    if (!asking || !element) return
    const reserve = () =>
      document.body.style.setProperty(
        "padding-bottom",
        `${element.offsetHeight + 24}px`
      )
    const observer = new ResizeObserver(reserve)
    observer.observe(element)
    reserve()
    return () => {
      observer.disconnect()
      document.body.style.removeProperty("padding-bottom")
    }
  }, [asking])

  if (!asking) return null
  return (
    <section
      ref={prompt}
      aria-label="Analytics choice"
      className="overlay-floating fixed inset-x-3 bottom-3 z-50 rounded-xl border border-border bg-card p-4 text-sm text-foreground sm:right-auto sm:bottom-4 sm:left-4 sm:max-w-sm"
    >
      <p className="leading-relaxed">
        We use analytics cookies to see how people find and use Worktable.
        Analytics never sees your content.
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className={choiceButtonClassName}
          onClick={() => choose(true)}
        >
          Allow
        </button>
        <button
          type="button"
          className={choiceButtonClassName}
          onClick={() => choose(false)}
        >
          Decline
        </button>
        <a
          className="ml-1 text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
          href={privacyHref}
        >
          Privacy
        </a>
      </div>
    </section>
  )
}

/**
 * The lasting control for this browser's analytics cookies: change or
 * withdraw a choice at any time. Visits are still counted without cookies.
 */
export function AnalyticsCookieSetting({ className }: { className?: string }) {
  const { choice, ready, choose } = useAnalyticsChoice()
  const id = useId()
  const status = choice.privacySignal
    ? "Off because your browser sends a privacy signal."
    : choice.enabled
      ? "On in this browser."
      : "Off in this browser."
  return (
    <div
      className={`flex items-center justify-between gap-4 rounded-xl border border-border bg-card p-4 ${className ?? ""}`}
    >
      <div className="min-w-0">
        <span
          id={`${id}-label`}
          className="text-base font-medium text-foreground"
        >
          Analytics cookies
        </span>
        <p
          id={`${id}-status`}
          className="text-[0.98rem] leading-7 text-muted-foreground"
          aria-live="polite"
        >
          {ready ? status : " "}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={choice.enabled}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-status`}
        disabled={!ready || choice.privacySignal}
        data-checked={choice.enabled ? "" : undefined}
        onClick={() => choose(!choice.enabled)}
        className="group well switch-track inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-input px-0.5 transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-checked:border-primary"
      >
        <span className="block size-4 rounded-full bg-primary transition-transform group-data-checked:translate-x-3.5" />
      </button>
    </div>
  )
}
