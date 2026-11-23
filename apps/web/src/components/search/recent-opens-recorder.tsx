import { useEffect } from "react"
import { useRouterState } from "@tanstack/react-router"
import { useBreadcrumbs } from "@/hooks/use-breadcrumbs"
import { useWorkspace } from "@/lib/queries"
import {
  isRecentOpenRole,
  noteRecentRoute,
  recordRecentOpen,
} from "@/lib/recent-opens"

/**
 * Notes each Doc, file, Record, thread and skill a person opens, under the
 * name the header shows for it, for search to offer as Recent. The name can
 * arrive after the page does; the entry is rewritten when it changes.
 */
export function RecentOpensRecorder() {
  const worktableId = useWorkspace().data?.id
  const path = useRouterState({ select: (s) => s.location.pathname })
  const page = useBreadcrumbs().at(-1)
  const role = page?.role
  const title = page?.label
  const formatId = page?.node?.format?.id
  // Every page counts as leaving the last, even one Recent doesn't list.
  useEffect(() => {
    noteRecentRoute(path)
  }, [path])
  useEffect(() => {
    if (!worktableId || !title || !role || !isRecentOpenRole(role)) return
    recordRecentOpen(worktableId, {
      path,
      title,
      role,
      ...(formatId ? { formatId } : {}),
      at: Date.now(),
    })
  }, [worktableId, path, role, title, formatId])
  return null
}
