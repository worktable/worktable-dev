import { useEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import {
  CACHED_SYSTEM_VERSION_QUERY_KEY,
  getCachedSystemVersion,
  type SystemVersion,
} from "@/lib/system-api"
import { useDeploymentInfo } from "@/hooks/use-deployment-info"

const STARTUP_POLL_MS = 10_000
const STARTUP_POLL_WINDOW_MS = 60_000
const STEADY_POLL_MS = 5 * 60_000

export function updateAvailabilityPollInterval(
  version: SystemVersion | undefined,
  startupPollStartedAt: number | null,
  now = Date.now()
): number {
  const awaitingStartupCheck = !version || version.checkStatus === "unchecked"
  return awaitingStartupCheck &&
    (startupPollStartedAt === null ||
      now - startupPollStartedAt < STARTUP_POLL_WINDOW_MS)
    ? STARTUP_POLL_MS
    : STEADY_POLL_MS
}

/**
 * Passive update-availability signal for ambient surfaces (the sidebar dot,
 * the one-time toast). Reads only the server's update-check cache — the
 * background checker keeps it warm — so mounting this app-wide never contacts
 * the release host and never overrides the auto-check preference. Distinct
 * query key from ["system","version"]: that one is the LIVE check the System
 * settings section deliberately gates.
 *
 * Returns the version info while an update is available, null otherwise.
 */
export function useUpdateAvailability(): SystemVersion | null {
  const deploymentQuery = useDeploymentInfo()
  const startupPollStartedAt = useRef<number | null>(null)
  useEffect(() => {
    startupPollStartedAt.current = Date.now()
  }, [])
  const query = useQuery({
    queryKey: CACHED_SYSTEM_VERSION_QUERY_KEY,
    queryFn: getCachedSystemVersion,
    enabled: deploymentQuery.data?.mode === "self-managed",
    staleTime: 5 * 60_000,
    // Poll briefly during the startup check, then settle into a quiet cache read.
    refetchInterval: (q) =>
      updateAvailabilityPollInterval(
        q.state.data,
        startupPollStartedAt.current
      ),
    refetchOnWindowFocus: "always",
  })
  if (deploymentQuery.data?.mode !== "self-managed") return null
  return query.data?.updateAvailable ? query.data : null
}
