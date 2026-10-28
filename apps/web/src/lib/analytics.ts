import {
  parseAnalyticsPreference,
  type AnalyticsPreference,
} from "@worktable/types/analytics"
import { authenticatedFetch, BASE_URL } from "./http"

export interface CloudAnalyticsContext {
  preference: AnalyticsPreference | null
  distinctId: string
  projectToken?: string
  apiHost?: string
  surface: "web" | "desktop_cloud"
  trafficType?: "internal" | "verification"
  worktableId?: string
}

export async function getAnalyticsContext(change?: {
  enabled: boolean
  initialOnly?: boolean
}): Promise<CloudAnalyticsContext | null> {
  const response = await authenticatedFetch(
    `${BASE_URL}/api/analytics/preference`,
    change
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(change),
        }
      : { cache: "no-store" }
  )
  if (!response.ok) return null
  const body = await response.json()
  if (
    typeof body.distinctId !== "string" ||
    !body.distinctId.startsWith("workos:")
  )
    return null
  return { ...body, preference: parseAnalyticsPreference(body.preference) }
}
