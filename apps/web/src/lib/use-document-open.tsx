/* eslint-disable react-refresh/only-export-components -- Keep the hook and its status provider in one existing document chunk, without another blocking request. */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import { DocumentStatus } from "@worktable/ui/components/document-status"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { DocumentPageResult } from "@worktable/types"
import { HttpError } from "./http.ts"
import {
  documentPageValidated,
  documentQueryKeys,
  documentsQueryOptions,
  ensureDocumentOpen,
  forgetDocumentOpen,
  useDocumentPage,
} from "./documents-queries.ts"

// Consumers share the notice and open state through this module so the
// bundler keeps them in one existing document chunk.
export { DocumentStatus }
const DocumentCheckFailed = createContext(false)

/** The document's own sync indicator yields to the shared connection notice. */
export function useDocumentCheckFailed(): boolean {
  return useContext(DocumentCheckFailed)
}

/** Keep the renderer mounted while its background check is unavailable. */
export function DocumentCheckStatus({
  unavailable,
  children,
}: {
  unavailable: boolean
  children: ReactNode
}) {
  return (
    <DocumentCheckFailed.Provider value={unavailable}>
      {children}
      {unavailable && <DocumentStatus state="offline" />}
    </DocumentCheckFailed.Provider>
  )
}

/**
 * A Doc's page for one open of it: the page query, and the page once a check
 * validates this open. Until then a page shows what the tab already knows,
 * read-only, as the Doc route does.
 */
export function useDocumentOpen(spaceId: string, path: string) {
  const pageQuery = useDocumentPage(spaceId, path)
  const error = pageQuery.error
  const temporaryFailure =
    error instanceof TypeError ||
    (error instanceof HttpError &&
      (error.status === 408 || error.status === 429 || error.status >= 500))
  const refused = error !== null && !temporaryFailure
  // A check validates this open once its answer arrived after the open
  // began, or the live socket still proves an earlier one. The open began at
  // the navigation, or at the latest when this path first rendered (a
  // navigation can reuse a preload's route work). It then stays validated
  // while the path is open: later changes refresh the check, and the
  // editing room's own admission stays the final word.
  const openKey = `${spaceId}\0${path}`
  // Each open of a path is validated on its own: going A → B → A starts a
  // new open of A, which an earlier visit's check does not validate.
  const [open, setOpen] = useState<{ key: string; validated: boolean }>({
    key: "",
    validated: false,
  })
  if (open.key !== openKey) {
    ensureDocumentOpen(spaceId, path)
    setOpen({ key: openKey, validated: false })
  }
  useEffect(() => {
    // A remount for the same path can follow the previous cleanup.
    ensureDocumentOpen(spaceId, path)
    return () => forgetDocumentOpen(spaceId, path)
  }, [spaceId, path])
  const validatedNow =
    pageQuery.data !== undefined &&
    pageQuery.dataUpdatedAt > 0 &&
    !pageQuery.isError &&
    documentPageValidated(spaceId, path)
  const currentOpen = open.key === openKey
  if (validatedNow && currentOpen && !open.validated) {
    setOpen({ key: openKey, validated: true })
  }
  if (refused && currentOpen && open.validated) {
    setOpen({ key: openKey, validated: false })
  }
  const validated =
    !refused && (validatedNow || (currentOpen && open.validated))
  // No check validates this open yet and none is on its way (a preload's
  // answered before the open began): ask for one.
  const { isFetching: checking, isError: checkFailed, refetch } = pageQuery
  useEffect(() => {
    if (!path || validated || checking || checkFailed) return
    void refetch()
  }, [checkFailed, checking, path, refetch, validated])

  useRecheckPageAgainstCatalog(
    spaceId,
    path,
    pageQuery.data,
    pageQuery.dataUpdatedAt
  )

  const page = validated ? pageQuery.data : undefined
  // A failed refresh doesn't undo this open's successful admission. Keep
  // the renderer (and its unsaved state) through transport/server failures;
  // a refusal, missing path or conflict still replaces it as before.
  const temporarilyUnavailable = page?.kind === "document" && temporaryFailure

  return {
    pageQuery,
    page,
    openError: temporarilyUnavailable ? null : error,
    temporarilyUnavailable,
  }
}

/**
 * A change the server reports without a path (a move, archive, deletion or
 * write in the format-neutral store) reaches this page as a newer Space
 * catalog. When the catalog no longer agrees with this page's check,
 * including on the content's revision, check the path again; otherwise the
 * open document needs nothing.
 */
function useRecheckPageAgainstCatalog(
  spaceId: string,
  path: string,
  page: DocumentPageResult | undefined,
  pageUpdatedAt: number
) {
  const queryClient = useQueryClient()
  // Watch the catalog the breadcrumb already keeps loaded, without reading it.
  const { data: documents, dataUpdatedAt: documentsUpdatedAt } = useQuery({
    ...documentsQueryOptions(spaceId),
    enabled: false,
  })
  useEffect(() => {
    if (!documents || !page || page.kind === "conflict") return
    if (page.document.path !== path || documentsUpdatedAt <= pageUpdatedAt)
      return
    const listed = documents.find(
      (item) => item.kind === "document" && item.path === path
    )
    const agrees =
      listed?.kind === "document" &&
      !!listed.archived === !!page.document.archived &&
      listed.format.id === page.document.format.id &&
      (listed.revision === undefined || listed.revision === page.revision)
    if (agrees) return
    void queryClient.invalidateQueries(
      { queryKey: documentQueryKeys.page(spaceId, path), exact: true },
      { cancelRefetch: false }
    )
  }, [
    documents,
    documentsUpdatedAt,
    page,
    pageUpdatedAt,
    path,
    queryClient,
    spaceId,
  ])
}
