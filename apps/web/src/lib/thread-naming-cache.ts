import type { QueryClient } from "@tanstack/react-query"
import { threadQueryKeys } from "./threads-queries"

/** A preview-setting change can change capabilities without changing content. */
export function refreshThreadNamingCapabilities(
  queryClient: QueryClient
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: [...threadQueryKeys.root, "detail"],
  })
}

