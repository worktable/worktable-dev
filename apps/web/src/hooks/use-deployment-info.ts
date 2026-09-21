import { useQuery } from "@tanstack/react-query"
import { getDeploymentInfo } from "@/lib/system-api"

export const DEPLOYMENT_QUERY_KEY = ["system", "deployment"] as const

/** A running server cannot change deployment mode without restarting. */
export function useDeploymentInfo() {
  return useQuery({
    queryKey: DEPLOYMENT_QUERY_KEY,
    queryFn: getDeploymentInfo,
    staleTime: Infinity,
  })
}
