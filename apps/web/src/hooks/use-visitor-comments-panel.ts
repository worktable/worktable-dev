import { useEffect } from "react"
import { useLocation } from "@tanstack/react-router"
import type { DocumentSharingSummary } from "@worktable/types"

/** Pending and notices open Visitors without changing the document's route. */
export function useVisitorCommentsPanel(
  summary: DocumentSharingSummary["visitorComments"],
  openComments: (open: boolean) => void,
  openHistory: (open: boolean) => void
): void {
  const location = useLocation()
  const documentId = summary?.documentId
  const available = Boolean(summary && summary.available !== false)
  useEffect(() => {
    if (location.hash !== "visitors" || !available) return
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
