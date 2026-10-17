import { useEffect, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { createdInThisTab } from "@/hooks/use-new-doc"
import { useSpaceDocumentTrees } from "@/hooks/use-space-document-trees"
import { retitleDoc } from "@/lib/docs-api"
import { docQueryKeys } from "@/lib/docs-queries"
import { documentQueryKeys } from "@/lib/documents-queries"
import { findTreeNode } from "@/lib/space-document-tree"
import { humanizeSegment } from "@/lib/tree"

/** A doc's name as the sidebar shows it: its title, or the name its path gives. */
export function useDocName(spaceId: string, docPath: string): string {
  const trees = useSpaceDocumentTrees(spaceId)
  const node = trees ? findTreeNode(trees.active, docPath) : undefined
  return node?.label ?? humanizeSegment(docPath.split("/").at(-1) ?? docPath)
}

// How many pages have each doc open, so leaving means none still do.
const open = new Map<string, number>()

/**
 * A doc this tab created as Untitled takes the name its title gives once
 * people leave it. Moving it while it is open would reload the page under the
 * person typing. Other docs keep their path until someone renames them.
 */
export function useNameFromTitleOnLeave(
  spaceId: string,
  docPath: string,
  enabled: boolean
): void {
  const queryClient = useQueryClient()
  // Becoming read-only or archived while open is not leaving the doc.
  const enabledNow = useRef(enabled)
  useEffect(() => {
    enabledNow.current = enabled
  }, [enabled])
  useEffect(() => {
    if (!createdInThisTab(spaceId, docPath)) return
    const key = `${spaceId}\0${docPath}`
    open.set(key, (open.get(key) ?? 0) + 1)
    // Closing or reloading the page leaves the doc too; this request
    // outlives the page.
    const onPageHide = () => {
      if (enabledNow.current) {
        retitleDoc(spaceId, docPath, undefined, true).catch(() => undefined)
      }
    }
    window.addEventListener("pagehide", onPageHide)
    return () => {
      window.removeEventListener("pagehide", onPageHide)
      open.set(key, (open.get(key) ?? 1) - 1)
      // A page that opens the doc again straight away has not left it.
      setTimeout(() => {
        if ((open.get(key) ?? 0) > 0) return
        open.delete(key)
        if (!enabledNow.current) return
        retitleDoc(spaceId, docPath).then(
          (result) => {
            if (!result.renamed?.some(({ from, to }) => from !== to)) return
            void queryClient.invalidateQueries({
              queryKey: docQueryKeys.docs(spaceId),
              exact: true,
            })
            void queryClient.invalidateQueries({
              queryKey: documentQueryKeys.list(spaceId),
              exact: true,
            })
          },
          // It keeps its name; the next visit tries again.
          () => undefined
        )
      }, 0)
    }
  }, [spaceId, docPath, queryClient])
}
