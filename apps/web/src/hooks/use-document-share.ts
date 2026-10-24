import { useDocumentSharingAvailable } from "@/hooks/use-deployment-info"
import type { PageShareTarget } from "@/hooks/use-page-meta"

/**
 * How the open page shares its document: by links, whose summary comes with
 * the page. Null when the page can't be shared.
 */
export function useShareMode(
  target: PageShareTarget | undefined
): "links" | null {
  const available = useDocumentSharingAvailable()
  return target && available ? "links" : null
}
