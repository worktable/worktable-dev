import { useQuery } from "@tanstack/react-query"
import { useDocumentSharingAvailable } from "@/hooks/use-deployment-info"
import type { PageShareTarget } from "@/hooks/use-page-meta"
import { getDocumentShare, shareQueryKey } from "@/lib/share-api"

/** A document's public link, shared by the share dialog and its triggers. */
export function useDocumentShareStatus(target: PageShareTarget | undefined) {
  const available = useDocumentSharingAvailable()
  return useQuery({
    queryKey: target ? shareQueryKey(target) : ["document-share", "none"],
    queryFn: () => getDocumentShare(target!),
    enabled: available && target !== undefined,
    staleTime: 10_000,
  })
}
