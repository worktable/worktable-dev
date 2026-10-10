import { useQuery } from "@tanstack/react-query"
import { prefetchBrowserCsrfToken } from "@/lib/http"
import { getDeploymentInfo } from "@/lib/system-api"

export const DEPLOYMENT_QUERY_KEY = ["system", "deployment"] as const

/**
 * Linked sharing can change while the local server remains online. The Cloud
 * settings refresh this while a link changes; otherwise a tab checks again
 * when it returns or reconnects, not on a timer.
 */
export function useDeploymentInfo() {
  return useQuery({
    queryKey: DEPLOYMENT_QUERY_KEY,
    queryFn: async () => {
      const deployment = await getDeploymentInfo()
      if (deployment.mode === "cloud") prefetchBrowserCsrfToken()
      return deployment
    },
    staleTime: 60_000,
    refetchOnWindowFocus: "always",
  })
}

/** Whether this deployment can publish read-only document links. */
export function useDocumentSharingAvailable(): boolean {
  return useDeploymentInfo().data?.capabilities.documentSharing === true
}
