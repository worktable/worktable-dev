import { useQuery } from "@tanstack/react-query"
import {
  useDeploymentInfo,
  useDocumentSharingAvailable,
} from "@/hooks/use-deployment-info"
import type { PageShareTarget } from "@/hooks/use-page-meta"
import { getDocumentShare, shareQueryKey } from "@/lib/share-api"

/**
 * How the open page shares its document: by several links, whose summary
 * comes with the page, or by today's single link, read with its own request.
 * Once links v2 is on, a page read before it was (which has no summary)
 * still shares by links, never through the old routes.
 */
export function useShareMode(
  target: PageShareTarget | undefined
): "links" | "legacy" | null {
  const available = useDocumentSharingAvailable()
  const linksActive = useDeploymentInfo().data?.capabilities.shareLinks === true
  if (!target || !available) return null
  return target.links || linksActive ? "links" : "legacy"
}

/** A document's public link, shared by the share dialog and its triggers. */
export function useDocumentShareStatus(target: PageShareTarget | undefined) {
  const legacy = useShareMode(target) === "legacy"
  return useQuery({
    queryKey: target ? shareQueryKey(target) : ["document-share", "none"],
    queryFn: () => getDocumentShare(target!),
    enabled: legacy && target !== undefined,
    staleTime: 10_000,
  })
}
