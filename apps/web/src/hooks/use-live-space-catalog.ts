import { useSpaceEvents } from "@/hooks/use-space-events"

/**
 * Keep a Space's catalog live from its event stream: document headings, HTML
 * doc names, sort settings, and record collections. The sidebar and the
 * breadcrumb both name documents from it, and either may be the only one
 * mounted for a Space. The shared socket applies each change to the cache
 * once, however many of them are mounted.
 */
export function useLiveSpaceCatalog(spaceId: string | undefined) {
  useSpaceEvents(spaceId)
}
