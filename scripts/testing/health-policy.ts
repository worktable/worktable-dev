// Increment when canonical suite membership or execution scheduling changes
// enough that historical health samples are no longer comparable.
export const CANONICAL_PORTFOLIO_REVISION = "foundation-v2"

export interface HealthPortfolio {
  revision?: string
  profile: string
  durationMs: number
  peakRssMb?: number
  targeted?: boolean
  status?: "passed" | "failed"
  schedule?: string
  startedAt?: string
}

export interface BrowserHealthSample {
  passed: boolean
  complete: boolean
}

export function partitionPortfolioRevisionSamples<
  T extends { revision?: string },
>(samples: T[], revision: string): { current: T[]; excluded: number } {
  const current = samples.filter((sample) => sample.revision === revision)
  return { current, excluded: samples.length - current.length }
}

export function isBroadRequiredHealthPortfolio(
  portfolio: HealthPortfolio | undefined
): boolean {
  return portfolio?.targeted !== true
}

export function isCompleteBrowserSample(
  observedBrowserSuites: number,
  expectedBrowserSuites: number,
  portfolio: HealthPortfolio | undefined
): boolean {
  if (portfolio?.profile !== "full" || portfolio.targeted === true) {
    return false
  }
  if (observedBrowserSuites === expectedBrowserSuites) return true
  return (
    portfolio.status === "failed" &&
    (observedBrowserSuites > 0 || portfolio.schedule === "distributed-ci")
  )
}

export function isPassingCompleteBrowserSample(
  observedBrowserSuites: number,
  expectedBrowserSuites: number,
  everyObservedSuitePassed: boolean
): boolean {
  return (
    observedBrowserSuites === expectedBrowserSuites && everyObservedSuitePassed
  )
}

export function isPeakRssWithinBudget(
  peakRssMb: number,
  maximumPeakRssMb: number
): boolean {
  return peakRssMb <= maximumPeakRssMb
}

/**
 * A full portfolio continues into heavy lanes after deterministic tests finish,
 * so only a required portfolio's own wall time is comparable to required CI.
 */
export function comparableRequiredDuration(
  portfolio: HealthPortfolio | undefined,
  requiredLaneWallMs: number
): number {
  return portfolio?.profile === "required"
    ? portfolio.durationMs
    : requiredLaneWallMs
}

/**
 * Selected partial browser runs are useful evidence but are not full-browser
 * portfolios. They neither advance nor reset the full-browser observation
 * streak.
 */
export function completeBrowserCleanStreak(
  samples: BrowserHealthSample[]
): number {
  let streak = 0
  for (const sample of samples
    .filter((candidate) => candidate.complete)
    .toReversed()) {
    if (!sample.passed) break
    streak += 1
  }
  return streak
}
