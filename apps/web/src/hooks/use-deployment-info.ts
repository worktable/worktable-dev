import { useQuery } from "@tanstack/react-query"
import { getDeploymentInfo } from "@/lib/system-api"

export const DEPLOYMENT_QUERY_KEY = ["system", "deployment"] as const

/** Linked sharing can change while the local server remains online. */
export function useDeploymentInfo() {
  return useQuery({
    queryKey: DEPLOYMENT_QUERY_KEY,
    queryFn: getDeploymentInfo,
    staleTime: 5000,
    refetchInterval: (query) =>
      query.state.data?.mode === "self-managed" ? 5000 : false,
  })
}
