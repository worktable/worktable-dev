import { useEffect, useState } from "react"
import {
  documentPageValidated,
  ensureDocumentOpen,
  forgetDocumentOpen,
  useDocumentPage,
} from "./documents-queries.ts"

/**
 * A Doc's page for one open of it: the page query, and the page once a check
 * validates this open. Until then a page shows what the tab already knows,
 * read-only, as the Doc route does.
 */
export function useDocumentOpen(spaceId: string, path: string) {
  const pageQuery = useDocumentPage(spaceId, path)
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
  const validated = validatedNow || (currentOpen && open.validated)
  // No check validates this open yet and none is on its way (a preload's
  // answered before the open began): ask for one.
  const { isFetching: checking, isError: checkFailed, refetch } = pageQuery
  useEffect(() => {
    if (!path || validated || checking || checkFailed) return
    void refetch()
  }, [checkFailed, checking, path, refetch, validated])

  return { pageQuery, page: validated ? pageQuery.data : undefined }
}
