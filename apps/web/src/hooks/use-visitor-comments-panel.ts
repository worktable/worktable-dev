import { useEffect, useRef } from "react"
import { useLocation, useNavigate } from "@tanstack/react-router"
import type { DocumentSharingSummary } from "@worktable/types"

/**
 * Pending and notices open Visitors, and Home's Try Next opens Comments,
 * without changing the document's route.
 */
export function useVisitorCommentsPanel(
  summary: DocumentSharingSummary["visitorComments"],
  openComments: (open: boolean) => void,
  openHistory: (open: boolean) => void,
  commentsOpen: boolean
): void {
  const location = useLocation()
  const navigate = useNavigate()
  const documentId = summary?.documentId
  const available = Boolean(summary && summary.available !== false)
  const previous = useRef({
    open: commentsOpen,
    path: location.pathname,
    documentId,
  })
  useEffect(() => {
    const before = previous.current
    previous.current = {
      open: commentsOpen,
      path: location.pathname,
      documentId,
    }
    if (
      before.open &&
      !commentsOpen &&
      before.path === location.pathname &&
      before.documentId === documentId &&
      (location.hash === "visitors" || location.hash === "comments")
    )
      void navigate({ hash: "", replace: true, resetScroll: false })
  }, [commentsOpen, documentId, location.hash, location.pathname, navigate])
  useEffect(() => {
    const wanted =
      location.hash === "comments" ||
      (location.hash === "visitors" && available)
    if (!wanted) return
    openHistory(false)
    openComments(true)
  }, [
    location.hash,
    location.pathname,
    documentId,
    available,
    openComments,
    openHistory,
  ])
}
