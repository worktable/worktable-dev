import { useQuery } from "@tanstack/react-query"
import { getDeploymentInfo } from "@/lib/system-api"

export const DEPLOYMENT_QUERY_KEY = ["system", "deployment"] as const

/**
 * Linked sharing can change while the local server remains online. The Cloud
 * settings refresh this while a link changes; otherwise a tab checks again
 * when it returns, not on a timer.
 */
export function useDeploymentInfo() {
  return useQuery({
    queryKey: DEPLOYMENT_QUERY_KEY,
    queryFn: () => getDeploymentInfo(),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })
}

/** Whether this deployment can publish read-only document links. */
export function useDocumentSharingAvailable(): boolean {
  return useDeploymentInfo().data?.capabilities.documentSharing === true
}
